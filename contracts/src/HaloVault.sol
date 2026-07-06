// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title HaloVault
 * @notice Per-consumer USDC deposit vault for metered, unknown-cost inference payment
 *         (docs/PAYMENTS_RFC.md). Adds the `reserved` money-state: deposit once; funds are
 *         reserved exclusively per operator and captured against the consumer's own EIP-712
 *         receipts. Operators never serve value they can't collect; consumers can't be
 *         charged without signing.
 *
 * @dev    Immutable, USDC-only, EOA session keys. Hardened across an internal 5-lens audit
 *         AND an 8-domain deep audit (docs/CONTRACT_AUDIT.md). Key properties:
 *         - Per-operator **reservation cycles**: each contiguous reservation (locked 0→>0
 *           until back to 0) is a generation. `cycle` is bound into the receipt and `redeemed`
 *           resets per cycle, so a receipt can NEVER settle against a different reservation
 *           generation — closing both the stale-ceiling strand (GEN-1) and the cross-cycle
 *           double-pay (SIG-1).
 *         - Bounded reservation lifetime: a cycle expires by `created + maxReserveTtl`,
 *           re-reserves can't ratchet it (AA-2). `releaseExpired` + rotation are always
 *           reachable in finite time.
 *         - `keyEpoch` (bumped on rotation) bound into every signed message → stale-epoch
 *           signatures invalid by construction.
 *         - nonReentrant + strict CEI on every fund path; SafeERC20; EOA-only verification
 *           (`ecrecover`, no external call → no 1271 reentrancy).
 *         - Auto-expiring halt-only pause (a rogue/lost guardian can't freeze new business
 *           forever; never moves funds or blocks redeem/withdraw).
 *         - Blocklist escape: `withdraw(amount, to)` lets a USDC-blocklisted consumer exit to
 *           a fresh address (authority still `msg.sender`).
 *         - `totalBalance` O(1) accumulator (solvency bound). No deposit/TVL caps: deposit
 *           size is the consumer's choice (v2.2).
 *
 *         Solvency invariant (I1): for all c, lockedTotal[c] <= balance[c]; Σ_op locked ==
 *         lockedTotal; totalBalance == Σ_c balance[c] <= USDC.balanceOf(this).
 *
 *         RESIDUAL RISKS (no on-chain fix; see docs/CONTRACT_AUDIT.md): a USDC blocklist of
 *         THIS vault address freezes all funds permanently (inherent to pooled USDC custody
 *         in an immutable contract — monitored off-chain, clones in a future version). With the
 *         deposit/TVL caps removed (v2.2) total custody is unbounded, so the off-chain solvency +
 *         blocklist monitor is the primary control. Deploy `usdc` as canonical Base USDC.
 *
 *         PROTOCOL FEE (v2): a take-rate skimmed from each `redeem` payout and accrued to the
 *         contract (NOT pushed to the treasury inline — a USDC-blocklisted treasury must never
 *         be able to brick redeem). The consumer is still debited exactly the amount they
 *         signed; the fee only splits the operator's side, so every solvency invariant holds
 *         with the bucket extended to `totalBalance + feesAccrued <= USDC.balanceOf(this)`.
 *         Adjustability is the ONLY mutable surface and is bounded on every axis: an immutable
 *         `MAX_FEE_BPS` hard ceiling the setter can never exceed, a propose→apply timelock
 *         (floored/capped in the ctor; re-propose-while-pending rejected, cancellable) and a
 *         `feeAdmin` role (deploy as a multisig) strictly separate from `guardian`. `feeAdmin`
 *         can NEVER move consumer funds.
 *
 *         The fee charged at `redeem` is min(rate snapshotted when the cycle opened, live
 *         `feeBps`): a fee INCREASE is never retroactive on already-served value (M-1), a
 *         DECREASE benefits the operator immediately (GOV-2). Operators read `cycleFeeBps`
 *         (or `feeBps` before serving) and can never be charged more than the rate they priced.
 *
 *         v2.1 audit hardening: per-cycle fee snapshot (M-1); consumer `setReservesFrozen`
 *         kill-switch to bound a leaked session key's blast radius without orphaning honest
 *         in-flight receipts (M-2); optional Chainlink L2 sequencer-uptime gate on
 *         `releaseExpired` that FAILS OPEN (a reverting/deprecated/codeless/stuck feed degrades
 *         to the no-feed baseline, never a permanent fund lock) so an L2 outage can't let a
 *         consumer reclaim inside the operator's redeem grace (H-1).
 */
interface ISequencerUptimeFeed {
    /// @dev Chainlink L2 Sequencer Uptime Feed (AggregatorV3 subset). `answer`: 0 = up, 1 = down.
    ///      `startedAt` is when the current up/down status began.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

contract HaloVault is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Immutable config ──────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public immutable guardian; // can halt new deposits/reserves only; never moves funds
    uint64 public immutable redeemGrace; // operator redemption window past expiry (H3)
    uint64 public immutable withdrawTimelock; // delay between requestWithdraw and withdraw
    uint64 public immutable maxReserveTtl; // max lifetime of a reservation cycle
    uint64 public immutable maxPauseDuration; // a pause auto-expires after this (anti-brick)
    /// @notice Optional Chainlink L2 sequencer-uptime feed. address(0) disables the gate
    ///         (testnets / non-OP-Stack). When set, `releaseExpired` is blocked while the
    ///         sequencer is down or within `redeemGrace` of recovery, preserving the operator's
    ///         redeem window across an outage (H-1). The gate FAILS OPEN on any feed malfunction.
    address public immutable sequencerUptimeFeed;
    /// @notice Max sequencer-down duration the gate enforces. Once an outage has lasted longer
    ///         than this (measured from the feed's `startedAt`, i.e. when the sequencer went
    ///         down), `releaseExpired` fails open — far longer than any Base outage on record,
    ///         but finite so neither a genuine multi-day outage nor a feed frozen-at-down can
    ///         permanently trap consumer funds. Accepted cost: re-opens the H-1 race only after
    ///         a 3-day total outage.
    uint64 public constant SEQ_DOWN_MAX_AGE = 3 days;
    /// @notice Gas stipend for the sequencer-feed staticcall in `_requireSequencerHealthy`. Ample
    ///         for a Chainlink `latestRoundData` read (well under this), but bounded so a
    ///         gas-burning/buggy feed can't drain the caller — the gate then simply fails open.
    uint256 private constant SEQ_FEED_GAS = 200_000;

    // ── Protocol fee config ─────────────────────────────────────────────────────
    /// @notice Hard ceiling the fee can NEVER exceed, regardless of feeAdmin. Immutable.
    ///         50% = 5000 bps. The ceiling is high, but it can only ever apply to reservation
    ///         cycles opened AFTER it takes effect (fees are snapshotted per cycle, see
    ///         `cycleFeeBps`), and only via a timelocked change by the multisig feeAdmin — so it
    ///         can never be applied retroactively to value an operator already served.
    uint16 public constant MAX_FEE_BPS = 5000;
    uint64 public immutable feeTimelock; // delay between proposeFee and applyFee
    address public feeAdmin; // governs fee + recipient (deploy as multisig); never moves user funds
    address public feeRecipient; // treasury sink for accrued fees (swept via collectFees)
    uint16 public feeBps; // current protocol fee in basis points (10000 = 100%)
    uint256 public feesAccrued; // protocol fees captured but not yet swept (own solvency bucket)
    uint16 public pendingFeeBps; // staged fee awaiting the timelock
    uint64 public feeEffectiveAt; // 0 = nothing pending; else applyFee allowed once now >= this
    address public pendingFeeRecipient; // staged treasury awaiting the timelock
    uint64 public feeRecipientEffectiveAt; // 0 = nothing pending
    address public pendingFeeAdmin; // two-step handoff: must be accepted by the new admin

    // ── State ─────────────────────────────────────────────────────────────────
    mapping(address => uint256) public balance; // USDC held for a consumer
    uint256 public totalBalance; // O(1) Σ balance[c] — solvency bound + global cap
    mapping(address => address) public sessionKey; // EOA authorized to sign for a consumer
    mapping(address => uint256) public keyEpoch; // bumped on rotation; bound into signed msgs
    mapping(address => uint256) public lockedTotal; // Σ_op locked[c][op]
    mapping(address => uint256) public reserveNonce; // monotonic reservation nonce
    mapping(address => uint64) public withdrawRequestedAt; // withdrawal timelock start
    mapping(address => uint256) public withdrawAuthorized; // free balance snapshotted at requestWithdraw; caps the withdraw
    uint64 public pausedUntil; // 0 = not paused; else paused while now < pausedUntil

    struct OperatorState {
        uint256 locked; // reserved-and-unredeemed funds, payable only to this operator
        uint256 redeemed; // cumulative captured THIS cycle (reset on a fresh cycle)
        uint64 expiry; // after expiry + redeemGrace, consumer may reclaim `locked`
        uint64 created; // start of the current reservation cycle (bounds absolute lifetime)
        uint64 cycle; // reservation generation; bound into the receipt (anti cross-cycle)
    }

    mapping(address => mapping(address => OperatorState)) public ops;
    /// @notice Fee rate (bps) snapshotted when each (consumer,operator) cycle opened. `redeem`
    ///         charges min(cycleFeeBps, live feeBps): an increase is never retroactive (M-1), a
    ///         decrease benefits the operator immediately (GOV-2). Authoritative only while the
    ///         cycle is live (ops[c][op].locked > 0); stale between cycles — read `feeBps` for
    ///         not-yet-opened cycles.
    mapping(address => mapping(address => uint16)) public cycleFeeBps;
    /// @notice Consumer kill-switch: when true, no new `reserve` may open for this consumer.
    ///         Lets a consumer who suspects session-key compromise stop NEW/top-up reservations
    ///         immediately, without bumping `keyEpoch` (which would orphan honest in-flight
    ///         receipts). Existing reservations stay redeemable and drain/expire normally (M-2).
    mapping(address => bool) public reservesFrozen;

    // ── EIP-712 typed data ────────────────────────────────────────────────────
    bytes32 private constant RESERVE_TYPEHASH = keccak256(
        "Reserve(address consumer,address operator,uint256 amount,uint64 expiry,uint256 nonce,uint256 keyEpoch)"
    );
    bytes32 private constant RECEIPT_TYPEHASH =
        keccak256("Receipt(address consumer,address operator,uint256 cumulative,uint256 keyEpoch,uint64 cycle)");

    // ── Events ────────────────────────────────────────────────────────────────
    event Deposited(address indexed consumer, uint256 amount, address sessionKey);
    event SessionKeySet(address indexed consumer, address sessionKey, uint256 keyEpoch);
    event Reserved(address indexed consumer, address indexed operator, uint256 amount, uint64 expiry, uint64 cycle);
    // `paid` is the GROSS amount the consumer was debited (the league/earnings basis). `fee` is
    // the protocol skim retained in the vault; the operator received `paid - fee`.
    event Redeemed(address indexed consumer, address indexed operator, uint256 paid, uint256 fee, uint256 cumulative);
    event ReleasedExpired(address indexed consumer, address indexed operator, uint256 amount);
    event WithdrawRequested(address indexed consumer, uint64 at, uint256 authorized);
    // A pending withdraw request was cancelled as a side effect (a deposit, or a reservation that
    // consumed all free funds) — distinct from the request being fully drained by withdraws. UIs
    // watch this to warn that a matured/ready request was invalidated and must be re-issued.
    event WithdrawRequestCancelled(address indexed consumer);
    event Withdrawn(address indexed consumer, address indexed to, uint256 amount);
    event PausedSet(uint64 pausedUntil);
    event FeeProposed(uint16 feeBps, uint64 effectiveAt);
    event FeeSet(uint16 feeBps);
    event FeeRecipientProposed(address recipient, uint64 effectiveAt);
    event FeeRecipientSet(address recipient);
    event FeeAdminTransferStarted(address indexed pendingFeeAdmin);
    event FeeAdminTransferred(address indexed newFeeAdmin);
    event FeesCollected(address indexed recipient, uint256 amount);
    event FeeChangeCancelled();
    event FeeRecipientChangeCancelled();
    event ReservesFrozenSet(address indexed consumer, bool frozen);

    error Paused();
    error NotGuardian();
    error NotFeeAdmin();
    error FeeTooHigh();
    error NothingPending();
    error ChangePending();
    error NoFees();
    error ReservesAreFrozen();
    error SequencerDown();
    error GracePeriodNotOver();
    error BadAmount();
    error BadAddress();
    error NoSessionKey();
    error SameSessionKey();
    error SessionKeyInUse();
    error BadSignature();
    error BadNonce();
    error BadExpiry();
    error BadOperator();
    error InsufficientFree();
    error StaleReceipt();
    error ExceedsReservation();
    error NotExpired();
    error WithdrawNotRequested();
    error TimelockActive();
    error InsufficientWithdrawable();

    constructor(
        address _usdc,
        address _guardian,
        uint64 _redeemGrace,
        uint64 _withdrawTimelock,
        uint64 _maxReserveTtl,
        uint64 _maxPauseDuration,
        address _feeAdmin,
        address _feeRecipient,
        uint16 _feeBps,
        uint64 _feeTimelock,
        address _sequencerUptimeFeed
    ) EIP712("Halo", "2") {
        if (_usdc.code.length == 0 || _guardian == address(0)) revert BadAddress();
        if (_feeAdmin == address(0) || _feeRecipient == address(0)) revert BadAddress();
        // Reject an obviously-wrong asset (the whole "USDC-only, no weird-token surface"
        // safety argument rests on this). USDC is 6 decimals.
        require(IERC20Metadata(_usdc).decimals() == 6, "usdc decimals != 6");
        // withdrawTimelock >= redeemGrace so a consumer can't reclaim out from under an
        // operator's still-redeemable receipt (I4/H3).
        require(_withdrawTimelock >= _redeemGrace, "timelock < grace");
        // Bound the reservation lifetime away from both degenerate ends (MATH-2: a near-max
        // _maxReserveTtl would make created + maxReserveTtl revert and brick reserve).
        require(_maxReserveTtl > 0 && _maxReserveTtl <= 365 days, "bad ttl");
        // Bound the pause duration the same way (MATH-2): > 0, and small enough that
        // `block.timestamp + maxPauseDuration` can't overflow uint64 and brick setPaused. Also
        // keeps the halt-only pause a SHORT auto-expiring emergency halt — a lost guardian can't
        // freeze new deposits/reserves beyond this window (anti-brick).
        require(_maxPauseDuration > 0 && _maxPauseDuration <= 30 days, "bad pause");
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        // Floor the fee timelock so the "exit/notice before a change" window can't be voided by
        // a zero/near-zero deploy value (L-1); cap it so a change can't be locked out forever.
        require(_feeTimelock >= 1 days && _feeTimelock <= 30 days, "bad fee timelock");
        usdc = IERC20(_usdc);
        guardian = _guardian;
        redeemGrace = _redeemGrace;
        withdrawTimelock = _withdrawTimelock;
        maxReserveTtl = _maxReserveTtl;
        maxPauseDuration = _maxPauseDuration;
        feeAdmin = _feeAdmin;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        feeTimelock = _feeTimelock;
        sequencerUptimeFeed = _sequencerUptimeFeed; // address(0) = gate disabled
    }

    // ── Views ─────────────────────────────────────────────────────────────────
    function withdrawable(address consumer) public view returns (uint256) {
        return balance[consumer] - lockedTotal[consumer]; // I1 ⇒ no underflow
    }

    /// @notice True while the halt-only pause is active (auto-expires at pausedUntil).
    function paused() public view returns (bool) {
        return pausedUntil != 0 && block.timestamp < pausedUntil;
    }

    // ── Deposit / session key (value IN — main wallet = msg.sender) ─────────────
    function deposit(uint256 amount, address _sessionKey) external nonReentrant {
        if (paused()) revert Paused();
        if (amount == 0) revert BadAmount();
        address consumer = msg.sender;

        if (sessionKey[consumer] == address(0)) {
            if (_sessionKey == address(0)) revert NoSessionKey();
            sessionKey[consumer] = _sessionKey;
            emit SessionKeySet(consumer, _sessionKey, keyEpoch[consumer]);
        }

        // Interaction-then-effect is unavoidable (balance-delta accounting; can't know
        // `received` until the transfer lands). Reentrancy is barred by `nonReentrant`, not
        // ordering; standard USDC has no payer-side hook. Caps are checked on RECEIVED.
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(consumer, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received == 0) revert BadAmount();
        balance[consumer] += received;
        totalBalance += received;
        // New funds must serve their own timelock: cancel any pending withdraw request so a
        // (possibly pre-aged) request can never reach freshly deposited funds (GEN-3). This also
        // cancels a MATURED request — load-bearing against fungibility laundering, so it is NOT
        // scoped to unmatured-only — and is surfaced via WithdrawRequestCancelled so UIs can warn.
        if (withdrawRequestedAt[consumer] != 0) {
            withdrawRequestedAt[consumer] = 0;
            withdrawAuthorized[consumer] = 0;
            emit WithdrawRequestCancelled(consumer);
        }
        emit Deposited(consumer, received, sessionKey[consumer]);
    }

    /// @notice Rotate the session key. Only when nothing is reserved (so honest in-flight
    ///         receipts aren't orphaned and a consumer can't rotate to rug an operator).
    ///         Bumping `keyEpoch` invalidates every prior-epoch signature by construction.
    function setSessionKey(address _sessionKey) external {
        if (_sessionKey == address(0)) revert NoSessionKey();
        if (_sessionKey == sessionKey[msg.sender]) revert SameSessionKey(); // no-op epoch grief
        if (lockedTotal[msg.sender] != 0) revert SessionKeyInUse();
        sessionKey[msg.sender] = _sessionKey;
        uint256 epoch = ++keyEpoch[msg.sender];
        emit SessionKeySet(msg.sender, _sessionKey, epoch);
    }

    /// @notice Consumer kill-switch for NEW reservations (M-2). If a consumer suspects their
    ///         session key is compromised, freezing stops the leaked key from opening any new
    ///         (or top-up) reservation immediately — bounding the blast radius to funds already
    ///         locked, which then drain or expire normally without orphaning honest receipts (no
    ///         `keyEpoch` bump). Recovery: freeze → let live reservations release → `setSessionKey`
    ///         (reachable once `lockedTotal == 0`) → unfreeze. Authority is the main wallet.
    function setReservesFrozen(bool frozen) external {
        if (reservesFrozen[msg.sender] == frozen) return; // no-op: don't emit a misleading event
        reservesFrozen[msg.sender] = frozen;
        emit ReservesFrozenSet(msg.sender, frozen);
    }

    // ── Reserve (allocate within the deposit — session key authority) ───────────
    function reserve(
        address consumer,
        address operator,
        uint256 amount,
        uint64 expiry,
        uint256 nonce,
        bytes calldata sig
    ) external nonReentrant {
        if (paused()) revert Paused();
        if (reservesFrozen[consumer]) revert ReservesAreFrozen();
        if (amount == 0) revert BadAmount();
        if (operator == address(0) || operator == address(this) || operator == address(usdc)) {
            revert BadOperator();
        }
        if (nonce != reserveNonce[consumer]) revert BadNonce();
        // Bounded, non-degenerate lifetime: must be in the future and within maxReserveTtl.
        if (expiry <= block.timestamp || expiry > block.timestamp + maxReserveTtl) revert BadExpiry();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RESERVE_TYPEHASH, consumer, operator, amount, expiry, nonce, keyEpoch[consumer]))
        );
        _requireSessionKey(consumer, digest, sig);

        if (amount > withdrawable(consumer)) revert InsufficientFree();

        reserveNonce[consumer] = nonce + 1;
        OperatorState storage s = ops[consumer][operator];
        bool fresh = s.locked == 0;
        if (fresh) {
            // New reservation generation: reset the redeemed ceiling, start the lifetime
            // clock, bump the cycle so prior-cycle receipts can never settle here, and SNAPSHOT
            // the fee in force now so a later fee change can't apply retroactively to this
            // cycle's payouts (M-1). The operator priced against this rate when it agreed to serve.
            s.cycle += 1;
            s.redeemed = 0;
            s.created = uint64(block.timestamp);
            cycleFeeBps[consumer][operator] = feeBps;
        }
        lockedTotal[consumer] += amount;
        s.locked += amount;
        // A reservation removes funds from the free pool, so shrink any pending withdraw
        // authorization to what remains continuously free. Keeps the timelock honest (GEN-3):
        // funds reserved AFTER a request (then later released) can't ride the pre-reservation
        // request — they need a fresh request + fresh timelock. `reserve` is session-key-gated and
        // `releaseExpired` never re-grows the authorization, so no third party can shrink a request.
        if (withdrawRequestedAt[consumer] != 0) {
            uint256 freeAfter = withdrawable(consumer);
            if (withdrawAuthorized[consumer] > freeAfter) {
                withdrawAuthorized[consumer] = freeAfter;
                if (freeAfter == 0) {
                    withdrawRequestedAt[consumer] = 0; // nothing left free → cancel
                    emit WithdrawRequestCancelled(consumer);
                }
            }
        }
        // Absolute lifetime cap: re-reserves can't ratchet expiry past created + maxReserveTtl.
        uint64 cap = s.created + maxReserveTtl;
        uint64 eff = expiry < cap ? expiry : cap;
        if (fresh || eff > s.expiry) s.expiry = eff;
        emit Reserved(consumer, operator, amount, s.expiry, s.cycle);
    }

    // ── Redeem (capture — operator pulls against a consumer receipt) ────────────
    function redeem(address consumer, address operator, uint256 cumulative, bytes calldata sig) external nonReentrant {
        OperatorState storage s = ops[consumer][operator];
        // Signature verified FIRST (binds the current cycle + epoch) — no state-probing via
        // revert reasons, and an old-cycle/old-epoch receipt fails here by construction.
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIPT_TYPEHASH, consumer, operator, cumulative, keyEpoch[consumer], s.cycle))
        );
        _requireSessionKey(consumer, digest, sig);

        if (cumulative <= s.redeemed) revert StaleReceipt();
        uint256 pay = cumulative - s.redeemed;
        // Clamp-and-capture: a late operator still collects what remains rather than reverting
        // to zero if part was already released/redeemed.
        if (pay > s.locked) pay = s.locked;
        if (pay == 0) revert ExceedsReservation();

        // Effects before interaction (CEI). Do NOT reorder — withdrawable()/ops() must never
        // be read mid-update (read-only-reentrancy safety).
        s.redeemed += pay;
        s.locked -= pay;
        lockedTotal[consumer] -= pay;
        balance[consumer] -= pay;
        totalBalance -= pay;

        // Protocol fee: skim from the operator's side only, at the LOWER of the rate snapshotted
        // when this cycle opened (cycleFeeBps) and the current live `feeBps`. Using the min means
        // a mid-cycle fee INCREASE never applies retroactively to already-earned payout (M-1),
        // while a mid-cycle DECREASE benefits the operator immediately (GOV-2) — the operator can
        // never be charged more than it priced against, only less. The consumer is debited the
        // full `pay` (exactly what they signed); `fee` stays in the vault as `feesAccrued` (its
        // own solvency bucket), swept later via collectFees — never pushed inline, so a
        // blocklisted treasury can never brick redeem. Round DOWN → favors the operator.
        uint16 snap = cycleFeeBps[consumer][operator];
        uint16 rate = feeBps < snap ? feeBps : snap;
        uint256 fee = (pay * rate) / 10_000;
        if (fee != 0) feesAccrued += fee;
        uint256 opPay = pay - fee;

        usdc.safeTransfer(operator, opPay);
        emit Redeemed(consumer, operator, pay, fee, s.redeemed);
    }

    // ── Release expired reservation (consumer reclaims locked-but-stale funds) ───
    function releaseExpired(address consumer, address operator) external {
        OperatorState storage s = ops[consumer][operator];
        if (s.locked == 0) return; // idempotent no-op (racing keepers don't revert)
        if (block.timestamp <= uint256(s.expiry) + redeemGrace) revert NotExpired();
        // H-1: on an L2 (Base/OP-Stack), a sequencer outage straddling expiry+redeemGrace would
        // otherwise let the consumer reclaim while the operator was unable to submit `redeem`.
        // When a sequencer feed is configured, block release while the sequencer is down or
        // within one redeemGrace of recovery, so the operator gets a full grace window post-outage.
        _requireSequencerHealthy();
        uint256 amount = s.locked;
        lockedTotal[consumer] -= amount;
        s.locked = 0;
        // The next reserve to this operator (locked 0→>0) starts a fresh cycle and resets
        // `redeemed`, so leaving `redeemed` here is harmless; the cycle binding is the guard.
        emit ReleasedExpired(consumer, operator, amount);
    }

    // ── Withdraw (value OUT — main wallet = msg.sender, timelocked) ──────────────
    /// @notice Start the withdrawal timelock. Snapshots the amount withdrawable RIGHT NOW and
    ///         binds the timelock to exactly that amount: a later `withdraw` can take at most
    ///         `min(snapshot, withdrawable)`. Funds that enter the free pool AFTER the request
    ///         (a deposit, or a `releaseExpired`) are excluded, so they can never ride a
    ///         pre-aged request — they require their own request + a fresh timelock (GEN-3).
    ///         Reverts if nothing is withdrawable (arming a timelock over zero funds is the
    ///         pre-age-at-zero-balance vector). Re-calling re-snapshots and restarts the clock.
    function requestWithdraw() external {
        uint256 free = withdrawable(msg.sender);
        if (free == 0) revert InsufficientWithdrawable();
        withdrawRequestedAt[msg.sender] = uint64(block.timestamp);
        withdrawAuthorized[msg.sender] = free;
        emit WithdrawRequested(msg.sender, uint64(block.timestamp), free);
    }

    /// @notice Withdraw to self. See withdraw(amount, to).
    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(amount, msg.sender);
    }

    /// @notice Withdraw up to the requested snapshot to `to` after the timelock. `to` lets a
    ///         USDC-blocklisted consumer exit to a fresh address — authority is still
    ///         `msg.sender`, only the sink changes (no new theft surface). Reserved funds are
    ///         never touched. A withdraw takes at most `min(withdrawAuthorized, withdrawable)` and
    ///         draws the authorization down; the request stays usable until that snapshot is fully
    ///         spent (so the authorized amount can be drained across several txs under ONE
    ///         timelock — L-1). Later-deposited funds cancel the request, and reserved funds shrink
    ///         it, so nothing beyond the request-time snapshot is ever withdrawable on it (GEN-3).
    function withdraw(uint256 amount, address to) external nonReentrant {
        _withdraw(amount, to);
    }

    function _withdraw(uint256 amount, address to) private {
        if (to == address(0)) revert BadAddress();
        address consumer = msg.sender;
        uint64 req = withdrawRequestedAt[consumer];
        if (req == 0) revert WithdrawNotRequested();
        if (block.timestamp < uint256(req) + withdrawTimelock) revert TimelockActive();
        if (amount == 0) revert BadAmount();
        // Bound to the amount that was withdrawable WHEN the request was made (snapshot), and
        // never above what is withdrawable now. Excludes funds deposited/released after the
        // request, so a pre-aged request can't drain them without its own fresh timelock.
        uint256 cap = withdrawAuthorized[consumer];
        uint256 free = withdrawable(consumer);
        if (free < cap) cap = free;
        if (amount > cap) revert InsufficientWithdrawable();

        balance[consumer] -= amount;
        totalBalance -= amount;
        // Draw down the authorization (effect before interaction, CEI); clear the request only
        // once it is fully spent. This lets an honest consumer withdraw the authorized amount
        // across several txs under ONE timelock (L-1), while still bounding total withdrawals to
        // the request-time snapshot (GEN-3): withdrawAuthorized only ever decreases — here, and on
        // reserve — never grows, and a deposit cancels the request outright.
        withdrawAuthorized[consumer] -= amount;
        if (withdrawAuthorized[consumer] == 0) withdrawRequestedAt[consumer] = 0;
        usdc.safeTransfer(to, amount);
        emit Withdrawn(consumer, to, amount);
    }

    // ── Guardian: auto-expiring halt-only pause (can NEVER move funds) ───────────
    function setPaused(bool _paused) external {
        if (msg.sender != guardian) revert NotGuardian();
        pausedUntil = _paused ? uint64(block.timestamp) + maxPauseDuration : 0;
        emit PausedSet(pausedUntil);
    }

    // ── Protocol fee governance (feeAdmin; can NEVER move consumer funds) ────────
    /// @notice Sweep accrued protocol fees to the treasury. Callable by ANYONE (incentive-
    ///         neutral — funds can only ever go to `feeRecipient`). Isolated from `redeem` so a
    ///         USDC-blocklisted treasury can't brick captures; if the treasury is blocked, fees
    ///         simply accrue until the recipient is rotated to a fresh address.
    function collectFees() external nonReentrant {
        uint256 amount = feesAccrued;
        if (amount == 0) revert NoFees();
        feesAccrued = 0; // effect before interaction (CEI)
        usdc.safeTransfer(feeRecipient, amount);
        emit FeesCollected(feeRecipient, amount);
    }

    /// @notice Stage a new fee. Bounded by MAX_FEE_BPS and only effective after `feeTimelock`.
    ///         Rejected while a change is already pending (L-2) so the value operators saw and
    ///         reacted to can't be swapped under a fresh clock — `cancelPendingFee` first to retry.
    function proposeFee(uint16 newFeeBps) external onlyFeeAdmin {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeEffectiveAt != 0) revert ChangePending();
        pendingFeeBps = newFeeBps;
        feeEffectiveAt = uint64(block.timestamp) + feeTimelock;
        emit FeeProposed(newFeeBps, feeEffectiveAt);
    }

    /// @notice Cancel a pending fee change before it applies.
    function cancelPendingFee() external onlyFeeAdmin {
        if (feeEffectiveAt == 0) revert NothingPending();
        feeEffectiveAt = 0;
        delete pendingFeeBps;
        emit FeeChangeCancelled();
    }

    /// @notice Apply a staged fee once its timelock has elapsed. Callable by anyone.
    function applyFee() external {
        if (feeEffectiveAt == 0) revert NothingPending();
        if (block.timestamp < feeEffectiveAt) revert TimelockActive();
        feeBps = pendingFeeBps;
        feeEffectiveAt = 0;
        delete pendingFeeBps; // clear staging (GEN-2)
        emit FeeSet(feeBps);
    }

    /// @notice Stage a new treasury. Timelocked like fees; never address(0); rejected while a
    ///         recipient change is already pending (L-2).
    function proposeFeeRecipient(address newRecipient) external onlyFeeAdmin {
        if (newRecipient == address(0)) revert BadAddress();
        if (feeRecipientEffectiveAt != 0) revert ChangePending();
        pendingFeeRecipient = newRecipient;
        feeRecipientEffectiveAt = uint64(block.timestamp) + feeTimelock;
        emit FeeRecipientProposed(newRecipient, feeRecipientEffectiveAt);
    }

    /// @notice Cancel a pending treasury change before it applies.
    function cancelPendingFeeRecipient() external onlyFeeAdmin {
        if (feeRecipientEffectiveAt == 0) revert NothingPending();
        feeRecipientEffectiveAt = 0;
        delete pendingFeeRecipient;
        emit FeeRecipientChangeCancelled();
    }

    /// @notice Apply a staged treasury once its timelock has elapsed. Callable by anyone.
    function applyFeeRecipient() external {
        if (feeRecipientEffectiveAt == 0) revert NothingPending();
        if (block.timestamp < feeRecipientEffectiveAt) revert TimelockActive();
        feeRecipient = pendingFeeRecipient;
        feeRecipientEffectiveAt = 0;
        delete pendingFeeRecipient; // clear staging (GEN-2)
        emit FeeRecipientSet(feeRecipient);
    }

    /// @notice Two-step feeAdmin handoff (no timelock — it grants no fund-moving power and a
    ///         fee change still has to clear its own timelock under the new admin).
    function transferFeeAdmin(address newFeeAdmin) external onlyFeeAdmin {
        if (newFeeAdmin == address(0)) revert BadAddress();
        pendingFeeAdmin = newFeeAdmin;
        emit FeeAdminTransferStarted(newFeeAdmin);
    }

    function acceptFeeAdmin() external {
        if (msg.sender != pendingFeeAdmin) revert NotFeeAdmin();
        feeAdmin = msg.sender;
        pendingFeeAdmin = address(0);
        emit FeeAdminTransferred(msg.sender);
    }

    // ── Internal ─────────────────────────────────────────────────────────────
    modifier onlyFeeAdmin() {
        if (msg.sender != feeAdmin) revert NotFeeAdmin();
        _;
    }

    function _requireSessionKey(address consumer, bytes32 digest, bytes calldata sig) private view {
        address key = sessionKey[consumer];
        if (key == address(0)) revert NoSessionKey();
        // EOA session key → ECDSA.tryRecover (precompile, no external call → no reentrancy).
        // OZ 5.x enforces low-s malleability + v∈{27,28} + 65-byte length.
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != key) revert BadSignature();
    }

    /// @dev H-1 sequencer-uptime gate for `releaseExpired`. No-op when no feed is configured.
    ///      FAILS OPEN on ANY feed malfunction: `releaseExpired` is the consumer's ONLY path to
    ///      reclaim locked-but-stale funds, so the gate must NEVER be a stronger lock than no feed
    ///      at all. A typed `try/catch` does NOT trap an ABI-decode revert when the call SUCCEEDS
    ///      but returns malformed/short data (only a revert of the call itself is caught) — a feed
    ///      returning < 160 bytes would then brick reclaim (fail-CLOSED). So we use a bounded
    ///      low-level staticcall: a capped gas stipend (a gas-burning feed can't drain the caller),
    ///      an explicit 160-byte return copy (a giant return blob can't OOG the caller via memory
    ///      expansion), and `success && returndatasize >= 160` + field-range checks. Every
    ///      reverting / codeless / short / gas-burning / out-of-range response degrades to the
    ///      no-feed baseline. View-only call to a trusted immutable feed (no reentrancy surface;
    ///      `releaseExpired` moves no funds).
    function _requireSequencerHealthy() private view {
        address feed = sequencerUptimeFeed;
        if (feed == address(0) || feed.code.length == 0) return; // unset/codeless → fail open

        // latestRoundData() → (uint80 roundId, int256 answer, uint256 startedAt, uint256, uint80).
        bytes4 sel = ISequencerUptimeFeed.latestRoundData.selector;
        bool ok;
        int256 answer;
        uint256 startedAt;
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, sel)
            // staticcall(gas, addr, argsOffset, argsSize, retOffset, retSize); retSize 0 → don't
            // auto-copy. Cap gas and copy AT MOST 160 bytes ourselves to bound a return-data bomb.
            let success := staticcall(SEQ_FEED_GAS, feed, ptr, 0x04, 0x00, 0x00)
            if and(success, iszero(lt(returndatasize(), 160))) {
                returndatacopy(ptr, 0x00, 160)
                answer := mload(add(ptr, 0x20)) // word 1 (word 0 = roundId)
                startedAt := mload(add(ptr, 0x40)) // word 2
                ok := 1
            }
        }
        // Reverted, codeless, or fewer than 160 returned bytes → can't trust it → fail open.
        if (!ok) return;
        // Out-of-range fields (unknown answer; uninitialised or future-dated startedAt) → fail
        // open. The startedAt bound also guards the `block.timestamp - startedAt` math below.
        if (answer != 0 && answer != 1) return;
        if (startedAt == 0 || startedAt > block.timestamp) return;

        if (answer == 0) {
            // Sequencer up: hold the consumer off for one redeemGrace after recovery so the
            // operator gets a full redeem window. A feed frozen-at-up with an old `startedAt`
            // has grace already elapsed → allows release (correct fail-open).
            if (block.timestamp - startedAt <= redeemGrace) revert GracePeriodNotOver();
            return;
        }
        // answer == 1: sequencer reported down. `startedAt` is when it went down (the feed freezes
        // its timestamps during an outage — CHAIN-1), so `now - startedAt` is the outage duration.
        // Block while within SEQ_DOWN_MAX_AGE; past that — a genuine multi-day outage OR a feed
        // frozen-at-down — DELIBERATELY fail open so funds are never permanently trapped. Accepted:
        // re-opens the H-1 race only after a 3-day outage.
        if (block.timestamp - startedAt <= SEQ_DOWN_MAX_AGE) revert SequencerDown();
    }
}
