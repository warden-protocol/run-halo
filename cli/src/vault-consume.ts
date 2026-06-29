/**
 * HaloVault (RFC v2) consumer client — CLI / `halo consume` side.
 *
 * The vault rail bills the ACTUAL tokens a request used, not a prompt-blind
 * per-request quote. Mechanism (mirrors frontend/src/lib/vaultPay.ts +
 * useVaultPay.ts, which run this live in prod):
 *   1. deposit USDC into the vault once (on-chain, registers a session key),
 *   2. reserve funds for the operator we route to (EIP-712 Reserve, the
 *      facilitator submits it + pays gas),
 *   3. send the inference with `x-halo-payment-mode: vault` — the operator gates
 *      on the reservation, serves, and reports the ACTUAL cost,
 *   4. advance a cumulative receipt (EIP-712 Receipt) and redeem it in the
 *      background (facilitator submits → operator paid for exactly what it served).
 *
 * Headless differences from the browser flow: there are no wallet popups, so the
 * keystore wallet IS the session key (it signs reserve + receipts directly) — no
 * derived sub-wallet needed. EIP-712 field order/types MUST match
 * contracts/src/HaloVault.sol byte-for-byte or the on-chain verify reverts.
 */
import { Contract, JsonRpcProvider, MaxUint256, TypedDataDomain, Wallet, HDNodeWallet, parseUnits } from "ethers";
import { VAULT_ADDRESS } from "./vault-address";

// Pinned, NOT env-overridable — must match the operator + facilitator. See
// vault-address.ts. Re-exported so `halo vault` can display it.
export { VAULT_ADDRESS };

const USDC_BY_CHAIN: Record<number, string> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const USDC_DECIMALS = 6;

const VAULT_ABI = [
  "function deposit(uint256 amount, address sessionKey)",
  "function requestWithdraw()",
  "function withdraw(uint256 amount)",
  "function balance(address) view returns (uint256)",
  "function lockedTotal(address) view returns (uint256)",
  "function withdrawable(address) view returns (uint256)",
  "function sessionKey(address) view returns (address)",
  "function reserveNonce(address) view returns (uint256)",
  "function keyEpoch(address) view returns (uint256)",
  "function ops(address,address) view returns (uint256 locked,uint256 redeemed,uint64 expiry,uint64 created,uint64 cycle)",
];
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const READ_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// ── EIP-712 (must match HaloVault.sol) ───────────────────────────────────────
function vaultDomain(chainId: number): TypedDataDomain {
  return { name: "Halo", version: "2", chainId, verifyingContract: VAULT_ADDRESS };
}
const RESERVE_TYPES = {
  Reserve: [
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "keyEpoch", type: "uint256" },
  ],
};
const RECEIPT_TYPES = {
  Receipt: [
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "cumulative", type: "uint256" },
    { name: "keyEpoch", type: "uint256" },
    { name: "cycle", type: "uint64" },
  ],
};

export interface OpsState {
  locked: bigint;
  redeemed: bigint;
  expiry: bigint;
  created: bigint;
  cycle: bigint;
}
export interface VaultState {
  balance: bigint;
  lockedTotal: bigint;
  withdrawable: bigint;
  sessionKey: string;
  reserveNonce: bigint;
  keyEpoch: bigint;
}

type SignerWallet = Wallet | HDNodeWallet;

/** USD-per-1M-tokens → base-unit cost for `tokens`, rounded up (operator-favoring). */
export function priceTokens(usdPerMtok: number, tokens: number): bigint {
  const PRICE_DP = 12;
  const priceBase = parseUnits(usdPerMtok.toFixed(PRICE_DP), PRICE_DP);
  const microUsd = BigInt(Math.max(0, Math.ceil(tokens))) * priceBase;
  const denom = 10n ** BigInt(PRICE_DP);
  return (microUsd + denom - 1n) / denom;
}

/** Rough token estimate from a chat body (chars/4 + max_tokens), to size a reservation. */
export function estimateTokens(messages: unknown, maxTokens: number): number {
  let chars = 0;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      const c = (m as { content?: unknown })?.content;
      if (typeof c === "string") chars += c.length;
      else if (Array.isArray(c)) for (const p of c) chars += JSON.stringify(p).length;
    }
  }
  return Math.ceil(chars / 4) + maxTokens;
}

// How many operators the consumer aims to keep enough free balance to fund.
// A single reservation never locks more than ~1/this of the current free balance
// beyond the minimum to serve the request — so fanning out across many operators
// (random routing) can't lock the whole deposit (#367). Tunable via env.
const RESERVE_LIQUIDITY_SLOTS = (() => {
  const v = Number(process.env.HALO_VAULT_RESERVE_SLOTS ?? "8");
  return Number.isFinite(v) && v >= 1 ? BigInt(Math.floor(v)) : 8n;
})();

/**
 * Decide how much to (re)reserve to an operator. Batches up to
 * `reserveMultiple × estCost` to amortize the on-chain reserve tx, but caps a
 * single reservation at ~1/`slots` of the free balance so a wide fan-out can't
 * lock the entire deposit (#367) — while ALWAYS covering at least this request's
 * cost so it still serves. Pure (no I/O) so it's unit-testable.
 *
 * @returns base units to add to the reservation (0 = already covered & live).
 */
export function computeReserveAmount(p: {
  estCost: bigint;
  /** Current on-chain `locked` for this operator. */
  locked: bigint;
  /** Consumer's free (withdrawable) balance. */
  withdrawable: bigint;
  reserveMultiple: bigint;
  slots: bigint;
  /** Whether the existing reservation is still live (not near expiry). */
  live: boolean;
}): bigint {
  const target = p.estCost * p.reserveMultiple;
  let amount = target > p.locked ? target - p.locked : 0n;
  // The bare minimum this request needs reserved (on top of what's already there).
  const needed = p.locked >= p.estCost ? 0n : p.estCost - p.locked;
  // Liquidity cap: don't sink more than a slice of free balance into batching.
  const cap = p.slots > 0n ? p.withdrawable / p.slots : p.withdrawable;
  if (amount > cap) amount = cap;
  if (amount < needed) amount = needed; // never under-reserve the request itself
  if (amount > p.withdrawable) amount = p.withdrawable;
  if (amount === 0n && !p.live) amount = 1n; // minimal bump to refresh expiry
  return amount;
}

export interface VaultConfig {
  facilitatorUrl: string;
  rpcUrl: string;
  chainId: number;
  /** Relay base URL — where signed receipts are PUSHED to the operator that
   *  served the work (operator-driven redeem, issue #369). Empty ⇒ the consumer
   *  falls back to submitting the redeem itself (legacy behaviour). */
  relayUrl?: string;
  /** Reservation lifetime (s). */
  reserveTtlSec?: number;
  /** Reserve this many estimated-requests worth at once (batch). */
  reserveMultiple?: bigint;
  /** Auto-top-up target (USD). When the vault can't cover a request's reservation
   *  and this is > 0, consume deposits more from the wallet's USDC mid-run (up to
   *  this balance) instead of failing — so the agent doesn't fall back off Halo.
   *  0/unset = never auto-deposit. */
  autoTopUpUsd?: number;
}

/**
 * Per-process vault client for the consume sidecar. Holds the keystore wallet
 * (signs reserve+receipts directly — it IS the session key), the cumulative
 * receipt ledger per `${operator}:${cycle}`, and a serialized reservation queue
 * so concurrent agent requests don't double-reserve on the same nonce.
 */
export class VaultConsumeClient {
  private readonly wallet: SignerWallet;
  private readonly cfg: Required<VaultConfig>;
  private readonly provider: JsonRpcProvider;
  private readonly cumulative = new Map<string, bigint>();
  private ensureQueue: Promise<unknown> = Promise.resolve();
  private redeemQueue: Promise<void> = Promise.resolve();
  // Operators we've reserved to this session, so expired headroom can be
  // reclaimed back to the free balance (#367). The vault can't enumerate them.
  // An operator is dropped only once a read confirms it's fully drained
  // (locked==0) — never on an unconfirmed release broadcast — so a dropped
  // release is retried and a settled operator stops being re-read.
  private readonly reservedOperators = new Set<string>();
  // operator → epoch ms of the last release we broadcast for it, so we don't
  // re-broadcast every short-balance request during the ~1-block window before
  // it mines; after the cooldown a still-locked operator is retried.
  private readonly releaseAttemptedAt = new Map<string, number>();
  private redeemGraceCache: bigint | null = null;

  private readonly autoTopUpBase: bigint;

  constructor(wallet: SignerWallet, cfg: VaultConfig) {
    this.wallet = wallet;
    this.cfg = {
      reserveTtlSec: 3600,
      reserveMultiple: 5n,
      autoTopUpUsd: 0,
      relayUrl: "",
      ...cfg,
    };
    this.autoTopUpBase = BigInt(Math.round((cfg.autoTopUpUsd ?? 0) * 1_000_000));
    this.provider = new JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
  }

  get consumer(): string {
    return this.wallet.address;
  }

  private facBase(): string {
    return this.cfg.facilitatorUrl.replace(/\/+$/, "");
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  async readVaultState(): Promise<VaultState> {
    // Prefer the facilitator (batched); fall back to direct RPC.
    try {
      const res = await fetch(`${this.facBase()}/vault/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumer: this.consumer }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const s = (await res.json()) as Record<string, string>;
        return {
          balance: BigInt(s.balance ?? "0"),
          lockedTotal: BigInt(s.lockedTotal ?? "0"),
          withdrawable: BigInt(s.withdrawable ?? "0"),
          sessionKey: s.sessionKey ?? "0x0000000000000000000000000000000000000000",
          reserveNonce: BigInt(s.reserveNonce ?? "0"),
          keyEpoch: BigInt(s.keyEpoch ?? "0"),
        };
      }
    } catch {
      /* fall through to on-chain */
    }
    const c = new Contract(VAULT_ADDRESS, VAULT_ABI, this.provider);
    const [balance, lockedTotal, withdrawable, sessionKey, reserveNonce, keyEpoch] = await withTimeout(
      Promise.all([
        c.balance(this.consumer),
        c.lockedTotal(this.consumer),
        c.withdrawable(this.consumer),
        c.sessionKey(this.consumer),
        c.reserveNonce(this.consumer),
        c.keyEpoch(this.consumer),
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
    const c = new Contract(VAULT_ADDRESS, VAULT_ABI, this.provider);
    const r = await withTimeout(c.ops(this.consumer, operator), READ_TIMEOUT_MS, "ops() read");
    return {
      locked: BigInt(r.locked ?? r[0]),
      redeemed: BigInt(r.redeemed ?? r[1]),
      expiry: BigInt(r.expiry ?? r[2]),
      created: BigInt(r.created ?? r[3]),
      cycle: BigInt(r.cycle ?? r[4]),
    };
  }

  // ── signing ──────────────────────────────────────────────────────────────
  private signReserve(p: {
    operator: string;
    amount: bigint;
    expiry: bigint;
    nonce: bigint;
    keyEpoch: bigint;
  }): Promise<string> {
    return this.wallet.signTypedData(vaultDomain(this.cfg.chainId), RESERVE_TYPES, {
      consumer: this.consumer,
      operator: p.operator,
      amount: p.amount,
      expiry: p.expiry,
      nonce: p.nonce,
      keyEpoch: p.keyEpoch,
    });
  }
  private signReceipt(p: { operator: string; cumulative: bigint; keyEpoch: bigint; cycle: bigint }): Promise<string> {
    return this.wallet.signTypedData(vaultDomain(this.cfg.chainId), RECEIPT_TYPES, {
      consumer: this.consumer,
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
        consumer: this.consumer,
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
  /**
   * Push a signed cumulative receipt to the operator that served the work, via
   * the relay (operator-driven redeem, issue #369). The operator verifies it
   * against on-chain state and redeems it ITSELF — so served work is collected
   * by the party owed the money, not left to the consumer's goodwill. Returns
   * true when the relay accepted it (202) for delivery. No relay URL, an offline
   * operator, or an old relay ⇒ false, and the caller self-redeems instead.
   */
  private async pushReceipt(operator: string, cumulative: bigint, signature: string): Promise<boolean> {
    const relay = (this.cfg.relayUrl || "").replace(/\/+$/, "");
    if (!relay) return false;
    try {
      const res = await fetch(`${relay}/v1/receipt`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-halo-operator": operator },
        body: JSON.stringify({
          consumer: this.consumer,
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

  private async postRedeem(operator: string, cumulative: bigint, signature: string): Promise<string> {
    const res = await fetch(`${this.facBase()}/vault/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumer: this.consumer, operator, cumulative: cumulative.toString(), signature }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `redeem failed (HTTP ${res.status})`);
    return body.hash;
  }

  // ── reservation reclaim (#367) ───────────────────────────────────────────────
  /** Contract `redeemGrace` — the window AFTER a reservation's expiry during which
   *  only the operator may still redeem; release is permitted only past it. */
  private async redeemGrace(): Promise<bigint> {
    if (this.redeemGraceCache !== null) return this.redeemGraceCache;
    const c = new Contract(VAULT_ADDRESS, ["function redeemGrace() view returns (uint64)"], this.provider);
    this.redeemGraceCache = BigInt(await withTimeout(c.redeemGrace(), READ_TIMEOUT_MS, "redeemGrace read"));
    return this.redeemGraceCache;
  }

  /** Ask the facilitator to release an expired reservation (permissionless on-chain;
   *  it relays + pays gas). The contract enforces `expiry + redeemGrace`. */
  private async postRelease(operator: string): Promise<string> {
    const res = await fetch(`${this.facBase()}/vault/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumer: this.consumer, operator }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `release failed (HTTP ${res.status})`);
    return body.hash;
  }

  /**
   * Reclaim expired reservations to OTHER operators back to the free balance
   * (#367). Best-effort and ASYNC: the facilitator broadcasts the release and
   * returns before it mines, so the freed funds land on a SUBSEQUENT request, not
   * the one that triggered this — we never delete an operator on an unconfirmed
   * broadcast (a dropped release would otherwise strand its headroom for the
   * session). An operator is dropped only once a read confirms it's fully drained
   * (`locked==0`); a still-locked one past grace is (re)released, throttled by a
   * cooldown so we don't re-broadcast every request while a release is in flight.
   * Returns true if a release was broadcast this pass. Skips `skipOperator`.
   */
  async releaseExpiredReservations(skipOperator?: string): Promise<boolean> {
    let grace: bigint;
    try {
      grace = await this.redeemGrace();
    } catch {
      // Can't read the grace window → skip reclaim this pass. grace=0 would be the
      // WIDEST (least safe) window: we'd broadcast releases the contract reverts as
      // NotExpired during the real on-chain grace. Wait for a readable grace.
      return false;
    }
    const RELEASE_RETRY_COOLDOWN_MS = 60_000;
    const now = BigInt(Math.floor(toUnixSeconds()));
    const nowMs = Date.now();
    const skip = skipOperator?.toLowerCase();
    let released = false;
    for (const op of this.reservedOperators) {
      if (op === skip) continue;
      try {
        const o = await this.readOps(op);
        // Fully drained/released (mined) → nothing to reclaim; stop tracking it.
        if (o.locked === 0n) {
          this.reservedOperators.delete(op);
          this.releaseAttemptedAt.delete(op);
          continue;
        }
        const eligible = o.expiry !== 0n && now > o.expiry + grace;
        const onCooldown = (this.releaseAttemptedAt.get(op) ?? 0) > nowMs - RELEASE_RETRY_COOLDOWN_MS;
        if (eligible && !onCooldown) {
          await this.postRelease(op); // broadcast only — frees on confirmation
          this.releaseAttemptedAt.set(op, nowMs);
          console.log(`  ♻ releasing expired vault reservation to ${op.slice(0, 8)}… ($${fmtUsd(o.locked)}, frees on confirmation)`);
          released = true;
        }
      } catch {
        /* best-effort — a stuck reservation is retried on the next pass */
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
    const sec = Math.floor(toUnixSeconds());
    const live = () => ops.expiry === 0n || BigInt(sec + REFRESH_MARGIN) < ops.expiry;

    if (ops.locked < estCost || !live()) {
      // Free balance can't cover this request. Before depositing more, kick off
      // RECLAIM of any expired reservations to OTHER operators back to the free
      // balance (#367): a fan-out strands headroom per operator until its TTL, so
      // a sustained run can starve itself even though funds aren't lost. Release
      // is async (broadcast now, mines ~a block later), so the re-read below
      // usually still shows it locked — the freed funds land on a SUBSEQUENT
      // request; this pass falls through to top-up/serve as before.
      if (ops.locked + state.withdrawable < estCost) {
        if (await this.releaseExpiredReservations(operator)) {
          [state, ops] = await Promise.all([this.readVaultState(), this.readOps(operator)]);
        }
      }
      // Still short → try to refill the vault from the wallet mid-run, then
      // re-read. This is what keeps the agent ON the Halo rail instead of
      // erroring → falling back to another provider.
      if (ops.locked + state.withdrawable < estCost && this.autoTopUpBase > 0n) {
        if (await this.autoTopUp(target)) {
          [state, ops] = await Promise.all([this.readVaultState(), this.readOps(operator)]);
        }
      }
      const amount = computeReserveAmount({
        estCost,
        locked: ops.locked,
        withdrawable: state.withdrawable,
        reserveMultiple: this.cfg.reserveMultiple,
        slots: RESERVE_LIQUIDITY_SLOTS,
        live: live(),
      });
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
    // Remember operators we've reserved to so their expired headroom can be
    // reclaimed later (#367).
    this.reservedOperators.add(operator.toLowerCase());
    return { ops, keyEpoch: state.keyEpoch };
  }

  /** Refill the vault from the wallet's USDC so `neededFreeBase` is collectible.
   *  Tops the balance up so free (= balance − locked) covers the need, at least
   *  to the configured target. Returns false (with a warning) if the wallet can't
   *  cover it — the caller then surfaces a fund-me error. */
  private async autoTopUp(neededFreeBase: bigint): Promise<boolean> {
    if (this.autoTopUpBase <= 0n) return false;
    try {
      const s = await this.readVaultState();
      if (s.withdrawable >= neededFreeBase) return true; // a concurrent top-up covered it
      const targetBalance =
        s.lockedTotal + (neededFreeBase > this.autoTopUpBase ? neededFreeBase : this.autoTopUpBase);
      const tx = await this.ensureDeposit(targetBalance);
      if (tx) console.log(`  ℹ vault auto-topped-up (deposit ${tx.slice(0, 10)}…) — staying on the Halo rail`);
      return true;
    } catch (e) {
      console.warn(`  ⚠ vault auto-top-up failed (wallet likely out of USDC/ETH): ${errStr(e)}`);
      return false;
    }
  }

  private insufficientMsg(freeBase: bigint, estCost: bigint): string {
    const base = `Vault can't cover this request (needs ~$${fmtUsd(estCost)} reserved, $${fmtUsd(freeBase)} free in the vault).`;
    return this.autoTopUpBase > 0n
      ? `${base} Auto-top-up couldn't refill it — the consumer wallet ${this.consumer} is likely out of USDC (it also needs a little ETH on Base for the deposit tx). Fund it to stay on Halo.`
      : `${base} Run consume with --vault-deposit <usd> to auto-refill from the wallet, or top up now: halo vault deposit <usd>.`;
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
  recordAndRedeem(operator: string, ops: OpsState, keyEpoch: bigint, cost: bigint): void {
    if (cost <= 0n) return;
    const key = `${operator}:${ops.cycle}`;
    const prev = this.cumulative.get(key) ?? ops.redeemed;
    let cumulative = prev + cost;
    const ceiling = ops.locked + ops.redeemed; // reservation ceiling
    if (cumulative > ceiling) cumulative = ceiling;
    this.cumulative.set(key, cumulative);
    if (cumulative <= ops.redeemed) return;
    this.redeemQueue = this.redeemQueue.then(async () => {
      try {
        const sig = await this.signReceipt({ operator, cumulative, keyEpoch, cycle: ops.cycle });
        // Operator-driven redeem (issue #369): hand the receipt to the operator
        // so the party owed the money collects it (with retry). Self-redeem only
        // as a fallback when delivery isn't possible (no relay configured, an old
        // relay, or the operator offline) — preserving the legacy guarantee.
        const delivered = await this.pushReceipt(operator, cumulative, sig);
        if (!delivered) await this.postRedeem(operator, cumulative, sig);
      } catch (e) {
        // Operator already served; the next (higher) cumulative receipt covers it.
        // eslint-disable-next-line no-console
        console.warn(`  ⚠ vault redeem/receipt-push failed (operator served; next receipt covers it): ${errStr(e)}`);
      }
    });
  }

  /** Await any in-flight background redeems (called on graceful shutdown). */
  async flushRedeems(): Promise<void> {
    await this.redeemQueue.catch(() => {});
  }

  // ── deposit / withdraw (on-chain, wallet pays gas) ─────────────────────────
  /**
   * Ensure the vault holds at least `targetBase` for this consumer, depositing
   * the shortfall from the wallet's USDC balance (approving first if needed).
   * Registers the wallet itself as the session key. Requires a little ETH for
   * gas. Returns the deposit tx hash, or null when already funded.
   */
  async ensureDeposit(targetBase: bigint): Promise<string | null> {
    const state = await this.readVaultState();
    if (state.balance >= targetBase) {
      // Already funded. If no session key is registered yet (balance from a prior
      // deposit with a different key), that's a separate concern; here we no-op.
      return null;
    }
    const shortfall = targetBase - state.balance;
    const w = this.wallet.connect(this.provider);
    const usdcAddr = USDC_BY_CHAIN[this.cfg.chainId];
    if (!usdcAddr) throw new Error(`no USDC address for chain ${this.cfg.chainId}`);
    const usdc = new Contract(usdcAddr, ERC20_ABI, w);
    const bal: bigint = await usdc.balanceOf(this.consumer);
    if (bal < shortfall) {
      throw new Error(
        `wallet USDC ($${fmtUsd(bal)}) is less than the vault top-up needed ($${fmtUsd(shortfall)}). Fund ${this.consumer} with USDC on Base.`
      );
    }
    const allowance: bigint = await usdc.allowance(this.consumer, VAULT_ADDRESS);
    if (allowance < shortfall) {
      const aTx = await usdc.approve(VAULT_ADDRESS, MaxUint256);
      await aTx.wait();
    }
    const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, w);
    // sessionKey = the wallet itself (headless: it signs reserve+receipts directly).
    const tx = await vault.deposit(shortfall, this.consumer);
    await tx.wait();
    return tx.hash as string;
  }

  /** Deposit an explicit USD amount (for the `halo vault deposit` command). */
  async deposit(amountUsd: number): Promise<string> {
    const amount = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
    const w = this.wallet.connect(this.provider);
    const usdcAddr = USDC_BY_CHAIN[this.cfg.chainId];
    if (!usdcAddr) throw new Error(`no USDC address for chain ${this.cfg.chainId}`);
    const usdc = new Contract(usdcAddr, ERC20_ABI, w);
    const allowance: bigint = await usdc.allowance(this.consumer, VAULT_ADDRESS);
    if (allowance < amount) {
      const aTx = await usdc.approve(VAULT_ADDRESS, MaxUint256);
      await aTx.wait();
    }
    const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, w);
    const tx = await vault.deposit(amount, this.consumer);
    await tx.wait();
    return tx.hash as string;
  }
}

export function fmtUsd(base: bigint): string {
  return (Number(base) / 1_000_000).toFixed(4);
}
function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
// Date.now is fine in the CLI (unlike workflow scripts); isolate it for clarity.
function toUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
