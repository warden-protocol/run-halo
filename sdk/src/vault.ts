/**
 * HaloVault (RFC v2) consumer client — SDK / pay side.
 *
 * Inference on Halo is settled through the HaloVault, which charges the protocol
 * fee on redeem. Paying an operator directly with the `exact` x402 scheme
 * bypasses the vault (and the fee), so for INFERENCE the SDK defaults to the
 * vault rail. (Tools/data x402 are unaffected — they pay external providers, not
 * Halo operators; use `fetchWithX402` for those.)
 *
 * Mechanism (mirrors cli/src/vault-consume.ts + frontend/src/lib/vaultPay.ts,
 * which run this live in prod):
 *   1. deposit USDC into the vault once (on-chain, registers a session key),
 *   2. reserve funds for the operator we route to (EIP-712 Reserve, the
 *      facilitator submits it + pays gas),
 *   3. send the inference with `x-halo-payment-mode: vault` — the operator gates
 *      on the reservation, serves, and reports the ACTUAL cost,
 *   4. advance a cumulative receipt (EIP-712 Receipt) and redeem it in the
 *      background (facilitator submits → operator paid for exactly what it served).
 *
 * Headless flow: there are no wallet popups, so by DEFAULT the SDK signer IS the
 * session key (it signs reserve + receipts directly). A distinct session signer
 * may be supplied (e.g. the browser-compatible derived sub-wallet) so one wallet
 * serves both the CLI and the web app (#426) — see the constructor's sessionSigner.
 * EIP-712 field order/types MUST match contracts/src/HaloVault.sol byte-for-byte or
 * the on-chain verify reverts.
 */
import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  Signer,
  isAddress,
  parseUnits,
} from "ethers";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
  ERC20_ABI,
  MAX_VAULT_RESERVATION_ATTEMPTS,
  RECEIPT_TYPES,
  RESERVE_TYPES,
  VAULT_ABI,
  VAULT_ADDRESS,
  advanceCumulativeReceipt,
  classifyRedeemError,
  classifySessionKey,
  computeReserveAmount,
  estimateTokens,
  formatUsdcBase,
  meterVaultResponse,
  priceTokens,
  requiredVaultReservationBase,
  selectVaultOperatorFromList,
  vaultDomain,
  withReservationMargin,
  type OpsState,
  type SessionKeyStatus,
  type VaultState,
} from "@halo/vault-core";
import { getChain } from "./chains";

export {
  VAULT_ADDRESS,
  classifyRedeemError,
  classifySessionKey,
  computeReserveAmount,
  estimateTokens,
  parseVaultSettlement,
  priceTokens,
  reportedUsageTokens,
  requiredVaultReservationBase,
  usageTokensFromSseBody,
} from "@halo/vault-core";
export type {
  OpsState,
  ParsedVaultSettlement,
  SessionKeyStatus,
  VaultState,
} from "@halo/vault-core";

const USDC_DECIMALS = 6;

const READ_TIMEOUT_MS = 8_000;
const REDEEM_RETRY_INTERVAL_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}


export interface VaultConfig {
  facilitatorUrl: string;
  rpcUrl: string;
  chainId: number;
  /** Relay base URL for best-effort operator-driven receipt delivery. The
   *  facilitator self-redeem path remains authoritative when omitted. */
  relayUrl?: string;
  /** Reservation lifetime (s). Default 3600. */
  reserveTtlSec?: number;
  /** Reserve this many estimated-requests worth at once (batch). Default 5. */
  reserveMultiple?: bigint;
  /** Preserve roughly this many free-liquidity slices when batching across
   *  operators. Default 8. The current request may exceed one slice. */
  reserveLiquiditySlots?: bigint;
  /** Auto-top-up target (USD). When the vault can't cover a request's reservation
   *  and this is > 0, the client deposits more from the signer's USDC mid-run (up
   *  to this balance) instead of failing — so an agent doesn't fall off the Halo
   *  rail. 0/unset = never auto-deposit. */
  autoTopUpUsd?: number;
  /** File path to persist the pending-redeem queue so a RESTART resumes settling
   *  the served tail instead of abandoning it (issue #369 follow-up). Unset ⇒
   *  in-memory only (lost on restart). Node/CLI only (uses the filesystem). */
  pendingStorePath?: string;
  /** Optional progress/diagnostic sink. Defaults to no-op (an SDK shouldn't spam
   *  stdout). */
  log?: (msg: string) => void;
}

function fmtUsd(base: bigint): string {
  return formatUsdcBase(base);
}
function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Per-process vault client. Holds the value signer (the main wallet: deposits +
 * IS the consumer) and a session signer that signs reserve+receipts. By default
 * they're the SAME wallet (headless: the wallet is its own session key). Supplying
 * a distinct session signer — e.g. the browser-compatible derived sub-wallet — lets
 * ONE wallet serve both the CLI and the web app (#426). Also holds the cumulative
 * receipt ledger per `${operator}:${cycle}` and a serialized reservation queue so
 * concurrent requests don't double-reserve on the same nonce. Reuse one instance
 * across many `chat()` calls to amortize reservations.
 */
export class HaloVaultClient {
  private readonly signer: Signer;
  // Signs reserve+receipts; its address MUST equal on-chain sessionKey[consumer].
  // Defaults to `signer` (the wallet is its own session key).
  private readonly sessionSigner: Signer;
  private readonly cfg: Required<Omit<VaultConfig, "log">> & { log: (m: string) => void };
  private readonly provider: JsonRpcProvider;
  // One read-only Contract, built once and reused by every view read (readOps runs
  // ~50×/reservation in waitForReservation's poll loop, and once per tracked
  // operator in releaseExpiredReservations). Rebuilding it per call re-parses all
  // ABI fragments each time for no benefit. The deposit paths need a signer-bound
  // Contract and build their own.
  private readonly vault: Contract;
  private readonly cumulative = new Map<string, bigint>();
  // Highest reservation ceiling (locked+redeemed) seen per `${operator}:${cycle}`.
  // locked+redeemed is monotonic non-decreasing within a cycle (top-ups raise
  // locked; redeem moves locked→redeemed; a release bumps the cycle), so a fresh
  // top-up by one request must not be clamped away by another request's older,
  // lower ops snapshot — recordAndRedeem clamps to this high-water mark instead.
  private readonly ceilingByKey = new Map<string, bigint>();
  private ensureQueue: Promise<unknown> = Promise.resolve();
  private redeemQueue: Promise<void> = Promise.resolve();
  private readonly pendingRedeems = new Map<
    string,
    {
      operator: string;
      cumulative: bigint;
      signature: string;
      cycle: bigint;
      inFlight: boolean;
    }
  >();
  private redeemRetryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reservedOperators = new Set<string>();
  private readonly releaseAttemptedAt = new Map<string, number>();
  private redeemGraceCache: bigint | null = null;
  private readonly autoTopUpBase: bigint;
  private addr: string | undefined;
  private sessionAddr: string | undefined;

  constructor(signer: Signer, cfg: VaultConfig, sessionSigner?: Signer) {
    this.signer = signer;
    // The session-key signer signs reserve+receipts. Defaults to the value signer
    // (headless: the wallet IS the session key). A distinct signer (e.g. the
    // browser-compatible derived sub-wallet) lets one wallet serve both surfaces —
    // its address is what deposit registers and what receipts must recover to.
    this.sessionSigner = sessionSigner ?? signer;
    this.cfg = {
      ...cfg,
      relayUrl: cfg.relayUrl ?? "",
      reserveTtlSec: cfg.reserveTtlSec ?? 3600,
      reserveMultiple: cfg.reserveMultiple ?? 5n,
      reserveLiquiditySlots:
        cfg.reserveLiquiditySlots && cfg.reserveLiquiditySlots > 0n
          ? cfg.reserveLiquiditySlots
          : 8n,
      autoTopUpUsd: cfg.autoTopUpUsd ?? 0,
      pendingStorePath: cfg.pendingStorePath ?? "",
      log: cfg.log ?? (() => {}),
    };
    this.autoTopUpBase = BigInt(Math.round((cfg.autoTopUpUsd ?? 0) * 1_000_000));
    this.provider = new JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
    this.vault = new Contract(VAULT_ADDRESS, VAULT_ABI, this.provider);
  }

  /** The consumer (value signer / main wallet) address, memoized. This is the key
   *  of the on-chain balance/session-key mappings. */
  async consumer(): Promise<string> {
    if (!this.addr) this.addr = await this.signer.getAddress();
    return this.addr;
  }

  /** The session-key signer's address (memoized) — the address that signs
   *  reserve+receipts and MUST equal on-chain `sessionKey[consumer]`. Equals the
   *  consumer in default headless mode; differs when a distinct session signer was
   *  supplied (e.g. the browser-compatible derived sub-wallet). */
  async sessionAddress(): Promise<string> {
    if (!this.sessionAddr) this.sessionAddr = await this.sessionSigner.getAddress();
    return this.sessionAddr;
  }

  private facBase(): string {
    return this.cfg.facilitatorUrl.replace(/\/+$/, "");
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  async readVaultState(): Promise<VaultState> {
    const consumer = await this.consumer();
    // Prefer the facilitator (batched); fall back to direct RPC.
    try {
      const res = await fetch(`${this.facBase()}/vault/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumer }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const s = (await res.json()) as Record<string, string>;
        // Trust the facilitator's batched read only when it carries a REAL session
        // key. A response that omits it would otherwise coerce to the zero address
        // and read as "unregistered", failing the #426 guard OPEN (absent must not
        // be mistaken for genuinely-unset). On a missing/garbled key, fall through
        // to the authoritative on-chain read below.
        if (isAddress(s.sessionKey)) {
          return {
            balance: BigInt(s.balance ?? "0"),
            lockedTotal: BigInt(s.lockedTotal ?? "0"),
            withdrawable: BigInt(s.withdrawable ?? "0"),
            sessionKey: s.sessionKey,
            reserveNonce: BigInt(s.reserveNonce ?? "0"),
            keyEpoch: BigInt(s.keyEpoch ?? "0"),
          };
        }
      }
    } catch {
      /* fall through to on-chain */
    }
    const [balance, lockedTotal, withdrawable, sessionKey, reserveNonce, keyEpoch] =
      await withTimeout(
        Promise.all([
          this.vault.balance(consumer),
          this.vault.lockedTotal(consumer),
          this.vault.withdrawable(consumer),
          this.vault.sessionKey(consumer),
          this.vault.reserveNonce(consumer),
          this.vault.keyEpoch(consumer),
        ]),
        READ_TIMEOUT_MS,
        "vault state read"
      );
    return {
      balance: BigInt(balance),
      lockedTotal: BigInt(lockedTotal),
      withdrawable: BigInt(withdrawable),
      sessionKey: String(sessionKey),
      reserveNonce: BigInt(reserveNonce),
      keyEpoch: BigInt(keyEpoch),
    };
  }

  async readOps(operator: string): Promise<OpsState> {
    const consumer = await this.consumer();
    const r = await withTimeout(this.vault.ops(consumer, operator), READ_TIMEOUT_MS, "ops() read");
    return {
      locked: BigInt(r.locked ?? r[0]),
      redeemed: BigInt(r.redeemed ?? r[1]),
      expiry: BigInt(r.expiry ?? r[2]),
      created: BigInt(r.created ?? r[3]),
      cycle: BigInt(r.cycle ?? r[4]),
    };
  }

  /**
   * Session-key preflight (#426): read the on-chain `sessionKey[consumer]` and
   * classify it against `sessionAddress()` — the address that actually signs
   * reserves + receipts (the wallet itself by default, or a supplied session
   * signer such as the browser-compatible derived sub-wallet), NOT necessarily the
   * consumer. A read; it never throws, so callers (a CLI startup banner,
   * `halo vault status`) can surface it however they like. The fail-closed
   * enforcement lives in `ensureColdReservation`, which classifies the state it
   * already reads before it reserves — no extra read, and re-checked every time.
   */
  async checkSessionKey(): Promise<{
    status: SessionKeyStatus;
    registered: string;
    expected: string;
  }> {
    const expected = await this.sessionAddress();
    const { sessionKey } = await this.readVaultState();
    return {
      status: classifySessionKey(sessionKey, expected),
      registered: sessionKey,
      expected,
    };
  }

  /**
   * The error thrown when the on-chain session key isn't the address this client
   * signs with (#426). Reserve + receipts are signed by the session signer (the
   * wallet itself by default, or a supplied session signer), so a receipt only
   * redeems when `sessionKey[consumer] == that signer`. If a DIFFERENT key is
   * registered — classically the browser's in-browser sub-wallet on the SAME
   * wallet, since `deposit` registers a session key only ONCE (HaloVault.sol) —
   * the request would still be SERVED (the relay is payment-blind; the operator
   * gates on the reservation, not a per-request signature), but its receipt
   * reverts BadSignature forever, so the operator does real work it can never
   * collect (#426, the #369 money-loss class). ensureColdReservation refuses to
   * reserve with this error instead of getting unpayable work served.
   */
  private sessionKeyMismatchError(registered: string, expected: string, consumer: string): Error {
    return new Error(
      `Vault session-key mismatch — refusing to serve unpayable work. This wallet ` +
        `(${consumer}) has session key ${registered} registered on-chain, but this client ` +
        `signs receipts with ${expected}. Every receipt would revert on-chain as BadSignature ` +
        `and the operator could never be paid for what it serves. Usual causes: using the SAME ` +
        `wallet across the Halo browser app and the CLI, or switching --session-key modes. Fix: ` +
        `match the surface/mode (browser ⇄ CLI \`--session-key browser\`), use a DEDICATED ` +
        `wallet, or rotate the on-chain key via setSessionKey(${expected}) (needs lockedTotal == 0).`
    );
  }

  // ── signing ──────────────────────────────────────────────────────────────
  private async signReserve(p: {
    operator: string;
    amount: bigint;
    expiry: bigint;
    nonce: bigint;
    keyEpoch: bigint;
  }): Promise<string> {
    return this.sessionSigner.signTypedData(vaultDomain(this.cfg.chainId), RESERVE_TYPES, {
      consumer: await this.consumer(),
      operator: p.operator,
      amount: p.amount,
      expiry: p.expiry,
      nonce: p.nonce,
      keyEpoch: p.keyEpoch,
    });
  }
  private async signReceipt(p: {
    operator: string;
    cumulative: bigint;
    keyEpoch: bigint;
    cycle: bigint;
  }): Promise<string> {
    return this.sessionSigner.signTypedData(vaultDomain(this.cfg.chainId), RECEIPT_TYPES, {
      consumer: await this.consumer(),
      operator: p.operator,
      cumulative: p.cumulative,
      keyEpoch: p.keyEpoch,
      cycle: p.cycle,
    });
  }

  // ── facilitator submits (it pays gas) ──────────────────────────────────────
  private async postReserve(
    p: { operator: string; amount: bigint; expiry: bigint; nonce: bigint },
    signature: string
  ): Promise<string> {
    const res = await fetch(`${this.facBase()}/vault/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consumer: await this.consumer(),
        operator: p.operator,
        amount: p.amount.toString(),
        expiry: p.expiry.toString(),
        nonce: p.nonce.toString(),
        signature,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `reserve failed (HTTP ${res.status})`);
    return body.hash;
  }
  private async postRedeem(operator: string, cumulative: bigint, signature: string): Promise<string> {
    const res = await fetch(`${this.facBase()}/vault/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        consumer: await this.consumer(),
        operator,
        cumulative: cumulative.toString(),
        signature,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `redeem failed (HTTP ${res.status})`);
    return body.hash;
  }

  private async pushReceipt(
    operator: string,
    cumulative: bigint,
    signature: string
  ): Promise<boolean> {
    const relay = this.cfg.relayUrl.replace(/\/+$/, "");
    if (!relay) return false;
    try {
      const res = await fetch(`${relay}/v1/receipt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-halo-operator": operator },
        body: JSON.stringify({
          consumer: await this.consumer(),
          operator,
          cumulative: cumulative.toString(),
          signature,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.status === 202;
    } catch {
      return false;
    }
  }

  private async redeemGrace(): Promise<bigint> {
    if (this.redeemGraceCache !== null) return this.redeemGraceCache;
    this.redeemGraceCache = BigInt(
      await withTimeout(this.vault.redeemGrace(), READ_TIMEOUT_MS, "redeemGrace read")
    );
    return this.redeemGraceCache;
  }

  private async postRelease(operator: string): Promise<string> {
    const res = await fetch(`${this.facBase()}/vault/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumer: await this.consumer(), operator }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `release failed (HTTP ${res.status})`);
    return body.hash;
  }

  /** Best-effort reclaim of tracked reservations that are past expiry plus the
   *  contract grace period. Operators remain tracked until an on-chain read
   *  confirms the locked balance reached zero, so dropped release txs retry. */
  async releaseExpiredReservations(skipOperator?: string): Promise<boolean> {
    let grace: bigint;
    try {
      grace = await this.redeemGrace();
    } catch {
      return false;
    }
    const now = BigInt(nowSec());
    const nowMs = Date.now();
    const retryCooldownMs = 60_000;
    const skip = skipOperator?.toLowerCase();
    let released = false;
    for (const operator of this.reservedOperators) {
      if (operator === skip) continue;
      try {
        const ops = await this.readOps(operator);
        if (ops.locked === 0n) {
          this.reservedOperators.delete(operator);
          this.releaseAttemptedAt.delete(operator);
          continue;
        }
        const eligible = ops.expiry !== 0n && now > ops.expiry + grace;
        const coolingDown =
          (this.releaseAttemptedAt.get(operator) ?? 0) > nowMs - retryCooldownMs;
        if (eligible && !coolingDown) {
          await this.postRelease(operator);
          this.releaseAttemptedAt.set(operator, nowMs);
          this.cfg.log(
            `releasing expired vault reservation to ${operator.slice(0, 8)}… ($${fmtUsd(ops.locked)}; frees on confirmation)`
          );
          released = true;
        }
      } catch {
        // A flaky read or broadcast must not remove the reclaim hint.
      }
    }
    return released;
  }

  // ── reservation ────────────────────────────────────────────────────────────
  /**
   * Ensure a live reservation to `operator` covers `estCost`. Serialized through
   * a queue so concurrent requests don't reserve on a stale nonce. Reserves a
   * batch (reserveMultiple × estCost) to amortize the on-chain tx. Returns the
   * fresh ops + keyEpoch for receipt signing.
   */
  ensureReservation(operator: string, estCost: bigint): Promise<{ ops: OpsState; keyEpoch: bigint }> {
    // ensureColdReservation runs the #426 session-key gate against the state it
    // already reads, before it reserves/serves — so a mismatch rejects here and
    // the request is never sent (see ensureColdReservation).
    const job = this.ensureQueue.catch(() => {}).then(() => this.ensureColdReservation(operator, estCost));
    this.ensureQueue = job.then(
      () => {},
      () => {}
    );
    return job;
  }

  private async ensureColdReservation(
    operator: string,
    estCost: bigint
  ): Promise<{ ops: OpsState; keyEpoch: bigint }> {
    const REFRESH_MARGIN = 120;
    const target = estCost * this.cfg.reserveMultiple;
    let [state, ops] = await Promise.all([this.readVaultState(), this.readOps(operator)]);
    // Fail-closed session-key gate (#426), reusing the state we just read. Reserve
    // + receipts are signed by the session signer, so a registered key that isn't
    // that signer means the operator would serve work it can never redeem
    // (BadSignature). Refuse before reserving/serving. Re-evaluated every
    // reservation (no stale latch), so a mid-process key rotation is caught here
    // too. "unregistered" (zero) is fine — the deposit path below registers the
    // session signer on the first deposit.
    const consumerAddr = await this.consumer();
    const sessionAddr = await this.sessionAddress();
    if (classifySessionKey(state.sessionKey, sessionAddr) === "mismatch") {
      throw this.sessionKeyMismatchError(state.sessionKey, sessionAddr, consumerAddr);
    }
    const sec = nowSec();
    const live = () => ops.expiry === 0n || BigInt(sec + REFRESH_MARGIN) < ops.expiry;

    if (ops.locked < estCost || !live()) {
      if (ops.locked + state.withdrawable < estCost) {
        if (await this.releaseExpiredReservations(operator)) {
          [state, ops] = await Promise.all([this.readVaultState(), this.readOps(operator)]);
        }
      }
      // The free balance can't cover even this one request → try to refill the
      // vault from the signer's USDC mid-run, then re-read. This is what keeps an
      // agent ON the Halo rail instead of erroring out.
      if (ops.locked + state.withdrawable < estCost && this.autoTopUpBase > 0n) {
        // Re-read after the attempt regardless of its boolean outcome: a partial
        // deposit or a concurrent lock can move state even when the top-up didn't
        // fully cover the need, so always refresh before sizing the reservation.
        await this.autoTopUp(target);
        [state, ops] = await Promise.all([this.readVaultState(), this.readOps(operator)]);
      }
      const amount = computeReserveAmount({
        estCost,
        locked: ops.locked,
        withdrawable: state.withdrawable,
        reserveMultiple: this.cfg.reserveMultiple,
        liquiditySlots: this.cfg.reserveLiquiditySlots,
        live: live(),
      });
      // Only hard-fail when the request genuinely can't be covered. A near-expiry
      // reservation (`!live()`) that STILL covers estCost is served against as-is: the
      // operator gates on the actual on-chain expiry, not the 120s refresh margin, so
      // it serves it. computeReserveAmount adds a small refresh reserve only when free
      // balance exists (withdrawable > 0); with the whole balance locked it returns 0,
      // and we proceed on the existing, still-valid reservation instead of throwing a
      // misleading "can't cover" or attempting a 1n reserve that reverts InsufficientFree.
      if (ops.locked + amount < estCost) {
        throw new Error(this.insufficientMsg(state.withdrawable, estCost));
      }
      if (amount > 0n) {
        const expiry = BigInt(sec + this.cfg.reserveTtlSec);
        const sig = await this.signReserve({
          operator,
          amount,
          expiry,
          nonce: state.reserveNonce,
          keyEpoch: state.keyEpoch,
        });
        await this.postReserve({ operator, amount, expiry, nonce: state.reserveNonce }, sig);
        ops = await this.waitForReservation(operator, ops);
      }
    }
    this.reservedOperators.add(operator.toLowerCase());
    return { ops, keyEpoch: state.keyEpoch };
  }

  /** Refill the vault from the signer's USDC so `neededFreeBase` is collectible. */
  private async autoTopUp(neededFreeBase: bigint): Promise<boolean> {
    if (this.autoTopUpBase <= 0n) return false;
    try {
      const s = await this.readVaultState();
      if (s.withdrawable >= neededFreeBase) return true; // a concurrent top-up covered it
      const targetBalance =
        s.lockedTotal + (neededFreeBase > this.autoTopUpBase ? neededFreeBase : this.autoTopUpBase);
      const tx = await this.ensureDeposit(targetBalance);
      // Re-read before claiming success: ensureDeposit may have been a no-op
      // (already funded) or a concurrent reservation may have locked the fresh
      // balance. Only return true (and log the win) when free liquidity actually
      // covers the need, so the return value and logs aren't optimistically wrong.
      const after = await this.readVaultState();
      const covered = after.withdrawable >= neededFreeBase;
      if (tx && covered) {
        this.cfg.log(`vault auto-topped-up (deposit ${tx.slice(0, 10)}…) — staying on the Halo rail`);
      }
      return covered;
    } catch (e) {
      this.cfg.log(`vault auto-top-up failed (signer likely out of USDC/ETH): ${errStr(e)}`);
      return false;
    }
  }

  private insufficientMsg(freeBase: bigint, estCost: bigint): string {
    const base = `Vault can't cover this request (needs ~$${fmtUsd(estCost)} reserved, $${fmtUsd(freeBase)} free in the vault).`;
    return this.autoTopUpBase > 0n
      ? `${base} Auto-top-up couldn't refill it — the signer is likely out of USDC (it also needs a little ETH on Base for the deposit tx).`
      : `${base} Deposit more with HaloVaultClient.deposit(usd), or set autoTopUpUsd to refill from the signer automatically.`;
  }

  private async waitForReservation(operator: string, before: OpsState): Promise<OpsState> {
    const deadline = Date.now() + 30_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const now = await this.readOps(operator);
        if (now.cycle > before.cycle || now.locked > before.locked) return now;
      } catch {
        /* transient RPC — keep polling to the deadline */
      }
      if (Date.now() > deadline) throw new Error("Reservation didn't confirm on-chain in time — retry shortly.");
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  /**
   * Record the operator-reported actual cost against the cumulative receipt and
   * redeem it in the BACKGROUND (the answer never waits on an on-chain tx).
   * Receipts are cumulative + monotonic per cycle; the queue keeps them ordered.
   */
  recordAndRedeem(
    operator: string,
    ops: OpsState,
    keyEpoch: bigint,
    cost: bigint
  ): void {
    if (cost <= 0n) return;
    const key = `${operator.toLowerCase()}:${ops.cycle}`;
    const prev = this.cumulative.get(key) ?? ops.redeemed;
    const { cumulative, ceiling } = advanceCumulativeReceipt({
      previous: prev,
      cost,
      locked: ops.locked,
      redeemed: ops.redeemed,
      priorCeiling: this.ceilingByKey.get(key),
    });
    this.ceilingByKey.set(key, ceiling);
    this.cumulative.set(key, cumulative);
    if (cumulative <= ops.redeemed) return;
    this.redeemQueue = this.redeemQueue.then(async () => {
      try {
        const signature = await this.signReceipt({
          operator,
          cumulative,
          keyEpoch,
          cycle: ops.cycle,
        });
        // Cumulative receipts supersede earlier receipts for the same cycle, so
        // retaining only the highest target preserves the entire unpaid tail.
        this.pendingRedeems.set(key, {
          operator,
          cumulative,
          signature,
          cycle: ops.cycle,
          inFlight: false,
        });
        this.persistPending(); // durable: survive a restart (issue #369 follow-up)
        await this.pushReceipt(operator, cumulative, signature).catch(() => false);
        await this.attemptRedeem(key);
      } catch (e) {
        // A signing failure cannot be retried with the same receipt. A later
        // cumulative receipt will sign and cover this amount again.
        this.cfg.log(`vault receipt signing failed (next receipt covers it): ${errStr(e)}`);
        if (this.pendingRedeems.size === 0 && this.redeemRetryTimer) {
          clearInterval(this.redeemRetryTimer);
          this.redeemRetryTimer = null;
        }
      }
    });
    this.startRedeemRetry();
  }

  private async attemptRedeem(key: string): Promise<void> {
    const pending = this.pendingRedeems.get(key);
    if (!pending || pending.inFlight) return;
    pending.inFlight = true;
    const clearIfCurrent = () => {
      if (this.pendingRedeems.get(key) === pending) {
        this.pendingRedeems.delete(key);
        this.persistPending();
      }
    };
    try {
      // Stale-cycle guard. A receipt's signature binds its reservation `cycle`
      // (the contract hashes the CURRENT on-chain cycle into the redeem digest),
      // so once a reservation is released/expired and the cycle bumps, a receipt
      // for the old cycle can NEVER redeem — it reverts BadSignature by
      // construction. Without this, such a receipt is retried forever, the queue
      // never drains, and (worse) the operator's un-receipted "floating" credit
      // fills up until it stops serving this consumer. Drop it once the chain has
      // moved past its cycle. Also drop a same-cycle receipt already covered by
      // on-chain `redeemed` (the operator-driven path beat us to it). Best-effort:
      // an RPC hiccup falls through to the normal attempt + error classification.
      try {
        const onchain = await this.readOps(pending.operator);
        if (onchain.cycle > pending.cycle) {
          clearIfCurrent();
          this.cfg.log(
            `vault receipt for cycle ${pending.cycle} superseded on-chain by cycle ${onchain.cycle}; abandoning (uncollectable)`
          );
          return;
        }
        if (onchain.cycle === pending.cycle && pending.cumulative <= onchain.redeemed) {
          clearIfCurrent(); // already collected (e.g. via the operator-driven redeem)
          return;
        }
      } catch {
        /* RPC blip — proceed to attempt; the retry loop re-checks next tick */
      }

      await this.postRedeem(pending.operator, pending.cumulative, pending.signature);
      clearIfCurrent();
    } catch (e) {
      const cls = classifyRedeemError(errStr(e));
      if (cls === "collected") {
        clearIfCurrent();
      } else if (cls === "uncollectable") {
        clearIfCurrent();
        this.cfg.log(`vault receipt is uncollectable; abandoning: ${errStr(e)}`);
      } else {
        this.cfg.log(`vault redeem failed; retained for retry: ${errStr(e)}`);
      }
    } finally {
      pending.inFlight = false;
      if (this.pendingRedeems.size === 0 && this.redeemRetryTimer) {
        clearInterval(this.redeemRetryTimer);
        this.redeemRetryTimer = null;
      }
    }
  }

  private startRedeemRetry(): void {
    if (this.redeemRetryTimer) return;
    this.redeemRetryTimer = setInterval(() => {
      for (const key of [...this.pendingRedeems.keys()]) void this.attemptRedeem(key);
    }, REDEEM_RETRY_INTERVAL_MS);
    this.redeemRetryTimer.unref?.();
  }

  /** Await queued work, make one final attempt at every retained receipt, and
   *  stop the retry timer. Call during graceful shutdown. */
  async flushRedeems(): Promise<void> {
    await this.redeemQueue.catch(() => {});
    await Promise.allSettled([...this.pendingRedeems.keys()].map((key) => this.attemptRedeem(key)));
    if (this.redeemRetryTimer) {
      clearInterval(this.redeemRetryTimer);
      this.redeemRetryTimer = null;
    }
  }

  get pendingRedeemCount(): number {
    return this.pendingRedeems.size;
  }

  /** Persist the pending-redeem queue to disk (atomic write-then-rename, so a
   *  crash mid-write can't truncate it), best-effort, so a restart can resume
   *  settling. Signatures are public redeem authorizations (submitted on-chain
   *  anyway), not secrets. The transient `inFlight` flag is never persisted.
   *  No-op when no `pendingStorePath` is configured. */
  private persistPending(): void {
    const f = this.cfg.pendingStorePath;
    if (!f) return;
    try {
      const arr = [...this.pendingRedeems.entries()].map(([key, v]) => ({
        key,
        operator: v.operator,
        cumulative: v.cumulative.toString(),
        signature: v.signature,
        cycle: v.cycle.toString(),
      }));
      mkdirSync(dirname(f), { recursive: true });
      const tmp = `${f}.tmp`;
      writeFileSync(tmp, JSON.stringify(arr), "utf-8");
      renameSync(tmp, f); // atomic replace on the same filesystem
    } catch {
      /* durability is best-effort — never break a serve on a write error */
    }
  }

  /**
   * Reload the pending-redeem queue persisted by a prior process and resume
   * settling it (issue #369 follow-up). Call once at startup. Stale entries (the
   * cycle moved on since) fail their next redeem with a terminal revert and are
   * dropped, so the file self-heals. No-op when no store path / nothing pending.
   */
  resumePendingRedeems(): void {
    const f = this.cfg.pendingStorePath;
    if (!f) return;
    let raw: string;
    try {
      raw = readFileSync(f, "utf-8");
    } catch {
      return; // no prior pending file — normal fresh start
    }
    let arr: Array<{
      key: string;
      operator: string;
      cumulative: string;
      signature: string;
      cycle: string;
    }>;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      // The file exists but is corrupt — surface it rather than silently abandon
      // receipts (funds may be owed). Atomic persist makes this rare.
      this.cfg.log(`pending vault-redeem file unreadable, cannot resume (${errStr(e)}): ${f}`);
      return;
    }
    if (!Array.isArray(arr) || arr.length === 0) return;
    for (const e of arr) {
      try {
        this.pendingRedeems.set(e.key, {
          operator: e.operator,
          cumulative: BigInt(e.cumulative),
          signature: e.signature,
          cycle: BigInt(e.cycle),
          inFlight: false,
        });
      } catch {
        /* skip a malformed entry */
      }
    }
    if (this.pendingRedeems.size === 0) return;
    this.cfg.log(`resuming ${this.pendingRedeems.size} pending vault redeem(s) from a prior session`);
    this.startRedeemRetry();
    // Attempt promptly, but enqueue on the redeem queue (which flushRedeems awaits
    // first) so a caller that resumes then flushes actually waits for these to
    // settle — attemptRedeem's in-flight guard would otherwise make flush's own
    // pass return before this fire-and-forget attempt finished.
    this.redeemQueue = this.redeemQueue.then(async () => {
      await Promise.allSettled(
        [...this.pendingRedeems.keys()].map((key) => this.attemptRedeem(key))
      );
    });
  }

  // ── deposit (on-chain, signer pays gas) ────────────────────────────────────
  /**
   * Ensure the vault holds at least `targetBase` for this consumer, depositing
   * the shortfall from the signer's USDC balance (approving first if needed).
   * Registers the session-key signer (the wallet itself by default) as the session
   * key on the first deposit. Requires a little ETH for gas. Returns the deposit tx
   * hash, or null when already funded.
   */
  async ensureDeposit(targetBase: bigint): Promise<string | null> {
    const consumer = await this.consumer();
    const state = await this.readVaultState();
    if (state.balance >= targetBase) return null;
    const shortfall = targetBase - state.balance;
    const w = this.signer.connect(this.provider);
    const usdcAddr = getChain(this.cfg.chainId).usdcToken;
    const usdc = new Contract(usdcAddr, ERC20_ABI, w);
    const bal: bigint = await usdc.balanceOf(consumer);
    if (bal < shortfall) {
      throw new Error(
        `signer USDC ($${fmtUsd(bal)}) is less than the vault top-up needed ($${fmtUsd(shortfall)}). Fund ${consumer} with USDC on Base.`
      );
    }
    const allowance: bigint = await usdc.allowance(consumer, VAULT_ADDRESS);
    if (allowance < shortfall) {
      const aTx = await usdc.approve(VAULT_ADDRESS, MaxUint256);
      await aTx.wait();
    }
    const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, w);
    // Register the session-key signer (the wallet itself by default, or a supplied
    // session signer, e.g. the browser-compatible derived sub-wallet). `deposit`
    // sets it only on the FIRST deposit; later deposits ignore this arg.
    const tx = await vault.deposit(shortfall, await this.sessionAddress());
    await tx.wait();
    return tx.hash as string;
  }

  /** Deposit an explicit USD amount. */
  async deposit(amountUsd: number): Promise<string> {
    const consumer = await this.consumer();
    const amount = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
    const w = this.signer.connect(this.provider);
    const usdcAddr = getChain(this.cfg.chainId).usdcToken;
    const usdc = new Contract(usdcAddr, ERC20_ABI, w);
    const allowance: bigint = await usdc.allowance(consumer, VAULT_ADDRESS);
    if (allowance < amount) {
      const aTx = await usdc.approve(VAULT_ADDRESS, MaxUint256);
      await aTx.wait();
    }
    const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, w);
    // Register the session-key signer (defaults to the wallet) on the first deposit.
    const tx = await vault.deposit(amount, await this.sessionAddress());
    await tx.wait();
    return tx.hash as string;
  }
}

// ── operator selection ───────────────────────────────────────────────────────
export interface VaultOperatorPin {
  address: string;
  priceUsdPerMtok: number;
  encryptionPubkey: string | null;
}

/**
 * Pick the cheapest VAULT-CAPABLE operator for `model` to RESERVE against. Vault
 * needs a price (to size the reservation + meter) and pins ONE operator so the
 * reservation, the request, and the receipt all line up. Filters to TEE operators
 * when `teeOnly` (confidential). Pricing uses the relay's exact resolution rule
 * (see resolveModelPriceUsdPerMtok) so the pinned price matches what the relay
 * will compute. Only operators advertising vault payments qualify — never falls
 * back to a legacy operator (its on-chain reservation gate can't honor a vault
 * reservation), matching the relay's preferVaultCapable. Returns null when no
 * vault-capable, in-price operator qualifies, so the caller fails fast.
 */
export async function selectVaultOperator(
  relayUrl: string,
  model: string,
  opts: { teeOnly?: boolean; maxPriceUsdPerMtok?: number } = {}
): Promise<VaultOperatorPin | null> {
  const relayBase = relayUrl.replace(/\/+$/, "");
  const { teeOnly = false, maxPriceUsdPerMtok } = opts;
  try {
    const url = `${relayBase}/v1/operators` + (teeOnly ? "?tee=1" : "");
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const { operators } = (await res.json()) as {
      operators: Array<{
        address: string;
        models: string[];
        encryptionPubkey?: string | null;
        pricing?: Record<string, number>;
        tee?: boolean;
        teeModels?: string[];
        vaultPayments?: boolean;
      }>;
    };
    const selection = selectVaultOperatorFromList(operators, model, {
      teeOnly,
      maxPriceUsdPerMtok,
    });
    if (!selection.selected) return null;
    const { operator, priceUsdPerMtok } = selection.selected;
    return {
      address: operator.address,
      priceUsdPerMtok,
      encryptionPubkey: operator.encryptionPubkey ?? null,
    };
  } catch {
    return null;
  }
}

// ── high-level inference ───────────────────────────────────────────────────────
export interface InferenceResult {
  status: number;
  /** Raw response body text (OpenAI-compatible JSON, or an error envelope). */
  body: string;
  /** True when a successful response produced a non-zero reported or fallback charge. */
  paid: boolean;
  /** Actual metered charge in USDC base units (6 decimals), when paid. */
  chargedBase?: string;
  /** The operator that served the request. */
  operator?: string;
  headers: Headers;
  /** Vault mode only: await queued and retained redeem attempts before exiting
   *  a short-lived process. Normal long-lived callers need not call this. */
  flushRedeems?: () => Promise<void>;
}

export interface PayInferenceOptions {
  signer: Signer;
  relayUrl: string;
  facilitatorUrl: string;
  rpcUrl: string;
  /** OpenAI-compatible chat-completions body. `model` is required. */
  body: Record<string, unknown>;
  chainId?: number;
  /** Default 8453's USDC; only "vault" is fee-compliant for inference. "exact" is
   *  an explicit escape hatch that pays the operator directly and BYPASSES the
   *  protocol fee — dev / non-vault stacks only. */
  mode?: "vault" | "exact";
  teeOnly?: boolean;
  maxPriceUsdPerMtok?: number;
  reserveTtlSec?: number;
  reserveMultiple?: bigint;
  reserveLiquiditySlots?: bigint;
  autoTopUpUsd?: number;
  /** Supply a client when you want explicit lifecycle control. When omitted,
   *  the SDK reuses a managed client for this signer and vault configuration. */
  client?: HaloVaultClient;
  /** Distinct signer for reserve+receipts (its address is what deposit registers
   *  and what receipts must recover to). Omit to sign with `signer` itself (the
   *  wallet is its own session key). Supply the browser-compatible derived
   *  sub-wallet to let one wallet serve both the CLI and the web app (#426).
   *  NOTE: the managed-client cache keys on this signer's OBJECT IDENTITY — derive
   *  the sub-wallet ONCE and reuse the same instance across calls, or the client
   *  (reservation ledger, pending-redeem queue) is rebuilt per call. Pass an
   *  explicit `client` if you need lifecycle control. */
  sessionSigner?: Signer;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

// Keyed by value signer → session signer → config string, so one wallet paired
// with different session signers gets distinct clients (object identity).
const managedVaultClients = new WeakMap<Signer, WeakMap<Signer, Map<string, HaloVaultClient>>>();

function managedVaultClient(opts: PayInferenceOptions, chainId: number): HaloVaultClient {
  const sessionSigner = opts.sessionSigner ?? opts.signer;
  let bySession = managedVaultClients.get(opts.signer);
  if (!bySession) {
    bySession = new WeakMap();
    managedVaultClients.set(opts.signer, bySession);
  }
  let clients = bySession.get(sessionSigner);
  if (!clients) {
    clients = new Map();
    bySession.set(sessionSigner, clients);
  }
  const key = JSON.stringify([
    opts.facilitatorUrl.replace(/\/+$/, ""),
    opts.relayUrl.replace(/\/+$/, ""),
    opts.rpcUrl,
    chainId,
    opts.reserveTtlSec ?? 3600,
    String(opts.reserveMultiple ?? 5n),
    String(opts.reserveLiquiditySlots ?? 8n),
    opts.autoTopUpUsd ?? 0,
  ]);
  let client = clients.get(key);
  if (!client) {
    client = new HaloVaultClient(
      opts.signer,
      {
        facilitatorUrl: opts.facilitatorUrl,
        relayUrl: opts.relayUrl,
        rpcUrl: opts.rpcUrl,
        chainId,
        reserveTtlSec: opts.reserveTtlSec,
        reserveMultiple: opts.reserveMultiple,
        reserveLiquiditySlots: opts.reserveLiquiditySlots,
        autoTopUpUsd: opts.autoTopUpUsd,
        log: opts.log,
      },
      opts.sessionSigner
    );
    clients.set(key, client);
  }
  return client;
}

/**
 * Pay for one inference over Halo. Defaults to the HaloVault rail (fee-compliant);
 * `mode: "exact"` is an explicit, fee-bypassing escape hatch for dev/non-vault
 * stacks. Ensures a reservation covers the request, sends with vault headers
 * (operator gates + serves, reporting the ACTUAL cost), then advances + redeems
 * the cumulative receipt in the background. Short-lived callers should await
 * the returned `flushRedeems?.()` before process exit.
 */
export async function payInference(opts: PayInferenceOptions): Promise<InferenceResult> {
  const chainId = opts.chainId ?? 8453;
  const mode = opts.mode ?? "vault";
  const relayBase = opts.relayUrl.replace(/\/+$/, "");
  const url = `${relayBase}/v1/chat/completions`;
  const model = typeof opts.body.model === "string" ? opts.body.model : "";
  if (!model) throw new Error("payInference: body.model is required");
  if (opts.body.stream === true) {
    throw new Error(
      "payInference: stream:true is not supported; request a buffered response or use a streaming API"
    );
  }

  if (mode === "exact") {
    // Escape hatch: direct x402 EIP-3009 to the operator. Bypasses the vault (and
    // the protocol fee) — intentionally NOT the default for inference.
    const { fetchWithX402 } = await import("./x402-client");
    const r = await fetchWithX402(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts.body),
        signal: opts.signal,
      },
      opts.signer
    );
    const text = await r.response.text();
    return {
      status: r.response.status,
      body: text,
      paid: r.paid,
      // Only report a charge when the payment actually settled (r.paid = retry.ok).
      // A 402 gate or a failed retry can carry paymentAmount without any charge landing.
      chargedBase: r.paid ? r.paymentAmount?.toString() : undefined,
      operator: r.response.headers.get("X-Halo-Operator") ?? undefined,
      headers: r.response.headers,
    };
  }

  const pin = await selectVaultOperator(relayBase, model, {
    teeOnly: opts.teeOnly,
    maxPriceUsdPerMtok: opts.maxPriceUsdPerMtok,
  });
  if (!pin) {
    throw new Error(
      `No priced operator for model "${model}"${opts.teeOnly ? " (confidential)" : ""} within the price limit — vault routing needs a priced operator.`
    );
  }

  const client = opts.client ?? managedVaultClient(opts, chainId);

  const maxTokens =
    typeof opts.body.max_tokens === "number" ? (opts.body.max_tokens as number) : 1024;
  const estTokens = estimateTokens(opts.body.messages, maxTokens);
  const estCost = withReservationMargin(priceTokens(pin.priceUsdPerMtok, estTokens));
  let { ops, keyEpoch } = await client.ensureReservation(pin.address, estCost);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-halo-payment-mode": "vault",
    "x-halo-operator": pin.address,
    "x-halo-vault-consumer": await client.consumer(),
    "x-halo-max-price": String(pin.priceUsdPerMtok),
  };
  if (opts.teeOnly) headers["x-halo-tee"] = "1";

  const requestBody = JSON.stringify(opts.body);
  const send = () =>
    fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal: opts.signal,
    });
  let res = await send();
  let text = await res.text();

  // A reservation rejection happens before the operator serves, so it is safe to
  // enlarge the SAME operator-bound reservation and replay. The exact required
  // ceiling comes from the typed error body (use that exact floor so a consumer
  // with precisely enough free balance is not rejected by a heuristic). The gate
  // price can advance more than once (rapid catalog updates), so retry up to
  // MAX_VAULT_RESERVATION_ATTEMPTS total instead of a single shot; bounded so a
  // gate that advances every round can't loop forever.
  for (
    let attempt = 1;
    attempt < MAX_VAULT_RESERVATION_ATTEMPTS && res.status === 402;
    attempt++
  ) {
    const required = requiredVaultReservationBase(text);
    if (required === null) break;
    opts.log?.(
      `vault reservation was below the operator ceiling; reserving ${required} base units and retrying (attempt ${attempt + 1}/${MAX_VAULT_RESERVATION_ATTEMPTS})`
    );
    ({ ops, keyEpoch } = await client.ensureReservation(pin.address, required));
    res = await send();
    text = await res.text();
  }

  // Meter the served response with the shared, content-type-independent rule
  // (settlement → reported body usage → unmeterable). No operator-controlled
  // header may decide whether the operator gets paid (invariants #2/#3/#4); an
  // unmeterable response is left unmetered rather than charged the estimate.
  const meter = meterVaultResponse(res.headers, text, pin.priceUsdPerMtok);
  const cost = meter.cost;
  if (res.ok && !meter.metered) {
    opts.log?.(
      "vault response had no settlement and no readable usage; leaving it unmetered (the operator must report usage or a settlement)"
    );
  }
  if (res.ok && cost > 0n) {
    client.recordAndRedeem(pin.address, ops, keyEpoch, cost);
  }

  return {
    status: res.status,
    body: text,
    paid: res.ok && cost > 0n,
    // Gate on res.ok too: a non-2xx response can still carry a PAYMENT-RESPONSE
    // header with amountUsdc > 0 (settlement.amount → cost), but nothing is redeemed
    // for it (recordAndRedeem runs only on res.ok). chargedBase must track `paid` so a
    // caller recording spend never shows a charge for a request that wasn't collected.
    chargedBase: res.ok && cost > 0n ? cost.toString() : undefined,
    operator: pin.address,
    headers: res.headers,
    flushRedeems: () => client.flushRedeems(),
  };
}
