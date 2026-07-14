// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title HaloVault
/// @notice Immutable per-consumer vault for metered payments in a configured six-decimal ERC20.
/// @dev Cycles and key epochs prevent replay; custody and fail-open sequencer constraints are documented externally.
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

    IERC20 public immutable usdc;
    address public immutable guardian; // can halt new deposits/reserves only
    uint64 public immutable redeemGrace; // operator redemption window past expiry
    uint64 public immutable withdrawTimelock; // delay between requestWithdraw and withdraw
    uint64 public immutable maxReserveTtl; // max lifetime of a reservation cycle
    uint64 public immutable maxPauseDuration; // a pause auto-expires after this
    /// @notice Optional sequencer feed; zero disables it. Fresh outages delay release,
    ///         while feed malfunction fails open to keep consumer funds reclaimable.
    address public immutable sequencerUptimeFeed;
    /// @notice After this down duration, release fails open so a frozen feed cannot trap funds.
    uint64 public constant SEQ_DOWN_MAX_AGE = 3 days;
    /// @notice Gas cap for the sequencer-feed staticcall; exhaustion makes the gate fail open.
    uint256 private constant SEQ_FEED_GAS = 200_000;

    /// @notice Immutable fee ceiling. Changes are timelocked; cycles never pay above their opening rate.
    uint16 public constant MAX_FEE_BPS = 5000;
    uint64 public immutable feeTimelock; // delay between proposeFee and applyFee
    address public feeAdmin; // governs fee and recipient; never moves user funds
    address public feeRecipient; // treasury sink for accrued fees (swept via collectFees)
    uint16 public feeBps; // current protocol fee in basis points (10000 = 100%)
    uint256 public feesAccrued; // protocol fees captured but not yet swept (own solvency bucket)
    uint16 public pendingFeeBps; // staged fee awaiting the timelock
    uint64 public feeEffectiveAt; // 0 = nothing pending; else applyFee allowed once now >= this
    address public pendingFeeRecipient; // staged treasury awaiting the timelock
    uint64 public feeRecipientEffectiveAt; // 0 = nothing pending
    address public pendingFeeAdmin; // two-step handoff: must be accepted by the new admin

    mapping(address => uint256) public balance; // configured asset held for a consumer
    uint256 public totalBalance; // O(1) sum of consumer balances
    mapping(address => address) public sessionKey; // EOA authorized to sign for a consumer
    mapping(address => uint256) public keyEpoch; // bumped on rotation; bound into signed msgs
    mapping(address => uint256) public lockedTotal; // Σ_op locked[c][op]
    mapping(address => uint256) public reserveNonce; // monotonic reservation nonce
    mapping(address => uint64) public withdrawRequestedAt; // withdrawal timelock start
    mapping(address => uint256) public withdrawAuthorized; // free balance snapshotted at requestWithdraw; caps the withdraw
    uint64 public pausedUntil; // 0 = not paused; else paused while now < pausedUntil

    struct OperatorState {
        uint256 locked; // reserved-and-unredeemed funds, payable only to this operator
        uint256 redeemed; // cumulative captured in the current cycle
        uint64 expiry; // after expiry + redeemGrace, consumer may reclaim `locked`
        uint64 created; // start of the current reservation cycle (bounds absolute lifetime)
        uint64 cycle; // reservation generation; bound into the receipt (anti cross-cycle)
    }

    mapping(address => mapping(address => OperatorState)) public ops;
    /// @notice Opening fee ceiling for a live pair cycle; redeem charges the lower live rate.
    /// @dev Stale between cycles; read `feeBps` before a new cycle opens.
    mapping(address => mapping(address => uint16)) public cycleFeeBps;
    /// @notice Consumer kill-switch for new/top-up reservations; existing cycles remain redeemable.
    mapping(address => bool) public reservesFrozen;

    bytes32 private constant RESERVE_TYPEHASH = keccak256(
        "Reserve(address consumer,address operator,uint256 amount,uint64 expiry,uint256 nonce,uint256 keyEpoch)"
    );
    bytes32 private constant RECEIPT_TYPEHASH =
        keccak256("Receipt(address consumer,address operator,uint256 cumulative,uint256 keyEpoch,uint64 cycle)");

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
        // Reject code-less and non-six-decimal assets. This does not validate token semantics;
        // the repository deploy script separately selects canonical USDC for supported chains.
        require(IERC20Metadata(_usdc).decimals() == 6, "usdc decimals != 6");
        // Withdrawal cannot mature before an operator's redemption window closes.
        require(_withdrawTimelock >= _redeemGrace, "timelock < grace");
        // Prevent zero lifetimes and timestamp addition overflow in reserve().
        require(_maxReserveTtl > 0 && _maxReserveTtl <= 365 days, "bad ttl");
        // Keep the halt finite and prevent uint64 timestamp overflow in setPaused().
        require(_maxPauseDuration > 0 && _maxPauseDuration <= 30 days, "bad pause");
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        // Preserve a meaningful notice window without making governance permanently unusable.
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

    function withdrawable(address consumer) public view returns (uint256) {
        return balance[consumer] - lockedTotal[consumer]; // maintained solvency invariant
    }

    /// @notice True while the halt-only pause is active (auto-expires at pausedUntil).
    function paused() public view returns (bool) {
        return pausedUntil != 0 && block.timestamp < pausedUntil;
    }

    function deposit(uint256 amount, address _sessionKey) external nonReentrant {
        if (paused()) revert Paused();
        if (amount == 0) revert BadAmount();
        address consumer = msg.sender;

        if (sessionKey[consumer] == address(0)) {
            if (_sessionKey == address(0)) revert NoSessionKey();
            sessionKey[consumer] = _sessionKey;
            emit SessionKeySet(consumer, _sessionKey, keyEpoch[consumer]);
        }

        // Balance-delta accounting requires the transfer first; nonReentrant protects this order.
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(consumer, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - before;
        if (received == 0) revert BadAmount();
        balance[consumer] += received;
        totalBalance += received;
        // Deposited funds need a fresh withdrawal timelock, even if an older request matured.
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

    /// @notice Freeze new reserves without invalidating receipts; after live reserves drain,
    ///         rotate the session key and unfreeze. Authority remains the consumer wallet.
    function setReservesFrozen(bool frozen) external {
        if (reservesFrozen[msg.sender] == frozen) return; // no-op: don't emit a misleading event
        reservesFrozen[msg.sender] = frozen;
        emit ReservesFrozenSet(msg.sender, frozen);
    }

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
            // A new cycle resets cumulative redemption and snapshots its maximum fee.
            s.cycle += 1;
            s.redeemed = 0;
            s.created = uint64(block.timestamp);
            cycleFeeBps[consumer][operator] = feeBps;
        }
        lockedTotal[consumer] += amount;
        s.locked += amount;
        // Released reservations must not inherit a withdrawal request that predates the lock.
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

    function redeem(address consumer, address operator, uint256 cumulative, bytes calldata sig) external nonReentrant {
        OperatorState storage s = ops[consumer][operator];
        // Verify the cycle- and epoch-bound signature before exposing later validation results.
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

        // Use the lower of the cycle snapshot and live fee: no cycle pays above its opening rate,
        // and live decreases apply immediately. Fees accrue instead of being pushed to a possibly
        // blocked recipient; integer division rounds in the operator's favor.
        uint16 snap = cycleFeeBps[consumer][operator];
        uint16 rate = feeBps < snap ? feeBps : snap;
        uint256 fee = (pay * rate) / 10_000;
        if (fee != 0) feesAccrued += fee;
        uint256 opPay = pay - fee;

        usdc.safeTransfer(operator, opPay);
        emit Redeemed(consumer, operator, pay, fee, s.redeemed);
    }

    function releaseExpired(address consumer, address operator) external {
        OperatorState storage s = ops[consumer][operator];
        if (s.locked == 0) return; // idempotent no-op (racing keepers don't revert)
        if (block.timestamp <= uint256(s.expiry) + redeemGrace) revert NotExpired();
        // Preserve the operator's redemption window across a sequencer outage.
        _requireSequencerHealthy();
        uint256 amount = s.locked;
        lockedTotal[consumer] -= amount;
        s.locked = 0;
        // The next reserve to this operator (locked 0→>0) starts a fresh cycle and resets
        // `redeemed`, so leaving `redeemed` here is harmless; the cycle binding is the guard.
        emit ReleasedExpired(consumer, operator, amount);
    }

    /// @notice Start or restart the timelock over a snapshot of current withdrawable funds.
    /// @dev Reverts on a zero snapshot so later-free funds cannot use a pre-aged request.
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

    /// @notice After the timelock, drain the requested snapshot in one or more withdrawals.
    /// @dev `to` changes only the sink; authority stays with the consumer and reserves remain untouched.
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
        // The authorization only decreases; clear its timestamp after the snapshot is exhausted.
        withdrawAuthorized[consumer] -= amount;
        if (withdrawAuthorized[consumer] == 0) withdrawRequestedAt[consumer] = 0;
        usdc.safeTransfer(to, amount);
        emit Withdrawn(consumer, to, amount);
    }

    function setPaused(bool _paused) external {
        if (msg.sender != guardian) revert NotGuardian();
        pausedUntil = _paused ? uint64(block.timestamp) + maxPauseDuration : 0;
        emit PausedSet(pausedUntil);
    }

    /// @notice Anyone may sweep accrued fees, but funds can go only to `feeRecipient`.
    /// @dev Isolated from redeem so a blocked treasury cannot stop operator payment capture.
    function collectFees() external nonReentrant {
        uint256 amount = feesAccrued;
        if (amount == 0) revert NoFees();
        feesAccrued = 0; // effect before interaction (CEI)
        usdc.safeTransfer(feeRecipient, amount);
        emit FeesCollected(feeRecipient, amount);
    }

    /// @notice Stage a new fee. Bounded by MAX_FEE_BPS and only effective after `feeTimelock`.
    ///         Rejected while a change is pending; cancel the old proposal before replacing it.
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
        delete pendingFeeBps;
        emit FeeSet(feeBps);
    }

    /// @notice Stage a nonzero treasury address, rejected while another change is pending.
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
        delete pendingFeeRecipient;
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

    /// @dev Bounded low-level decoding catches malformed successful responses that typed try/catch cannot.
    ///      Any feed failure fails open because this is the consumer's stale-reservation reclaim path.
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
        // A down feed freezes startedAt, so its age is the outage duration. Very old down states
        // fail open to avoid a permanent lock, at the cost of weakening the outage guard after 3 days.
        if (block.timestamp - startedAt <= SEQ_DOWN_MAX_AGE) revert SequencerDown();
    }
}
