/**
 * Operator-side credit-window ledger (HaloVault, operator-driven redeem).
 *
 * Problem this solves: in vault mode the operator serves a request and pays its
 * upstream BEFORE it is paid on-chain. Payment only lands when a consumer-signed
 * cumulative receipt is redeemed. If a redeem never arrives (consumer clamp,
 * a dropped fire-and-forget redeem, or the tail of a burst), the operator ate
 * real upstream cost for nothing. See issue #369.
 *
 * The fix moves collection to the operator (it holds the receipts and redeems
 * them itself, with retry) and BOUNDS how much un-receipted work it will float.
 * This module is that bound: a per-(consumer, operator) credit window, tracked
 * for the CURRENT reservation cycle.
 *
 *   outstanding = served + inflight − max(heldReceiptCumulative, redeemed)
 *
 *   - `served`   cumulative ACTUAL cost the operator has served this cycle
 *   - `inflight` sum of the CEILINGS of admitted-but-not-yet-settled requests
 *                (pessimistic: reserved at admit, trued-up to actual on settle)
 *   - `held`     highest receipt cumulative the operator holds for this cycle
 *
 * Credit-window bound (issue #369; single-request rule relaxed in #395): the
 * window caps the ACCUMULATION of un-receipted work across requests — NOT the
 * size of a single request. `admit()` refuses a new request only when work is
 * ALREADY outstanding AND its ceiling would push the total past `window`; a
 * request arriving with nothing outstanding is ALWAYS admitted, even if its own
 * ceiling exceeds `window` (e.g. a premium model whose one-request cost tops a
 * small default window). That lone request is already hard-capped by the on-chain
 * reservation — the serve gate verified `ceiling ≤ locked` (see
 * cli/src/commands/serve.ts: `checkReservationCached` runs before `admit`) — so
 * the operator never floats value beyond funds that exist on-chain. Worst-case
 * un-receipted exposure (`outstanding`) is therefore bounded by max(`window`, one
 * request's ceiling) — the window caps *accumulated* un-receipted work, and the
 * single-request bypass is bounded instead by the on-chain reservation. (This
 * bounds the EXPOSURE value, not the count of in-flight over-window requests: a
 * consumer that over-signs a receipt can get a second admitted, but the receipt
 * covers it, so `outstanding` stays within the bound.) Because `admit()` does its
 * read-check-reserve SYNCHRONOUSLY (no
 * `await` between reading `outstanding` and adding to `inflight`), concurrent
 * admits on Node's single thread can never both pass on the same headroom — no
 * lock needed, and no window undercount.
 *
 * Receipts are cumulative + monotonic per cycle, so one receipt covering
 * cumulative R makes the operator whole for everything up to R regardless of the
 * order requests completed in (addition commutes). A reservation top-up keeps the
 * same cycle (HaloVault.reserve only bumps cycle from locked==0), so a held
 * receipt stays valid across a burst; only a fresh generation (cycle++) resets
 * this ledger.
 *
 * In-memory + per-process: the operator's exposure is its own runtime state. A
 * restart seeds the ledger from the on-chain `redeemed` counter before admitting
 * work. This durable cumulative baseline prevents old cumulative receipts from
 * being mistaken for fresh credit after a restart.
 */

/** A consumer-signed cumulative receipt the operator can submit to `redeem`. */
export interface HeldReceipt {
  /** Cumulative base units this receipt authorizes (monotonic per cycle). */
  cumulative: bigint;
  /** EIP-712 Receipt signature (recovers to the consumer's session key). */
  signature: string;
  /** Reservation cycle the receipt was signed against (binds the digest). */
  cycle: bigint;
}

interface Entry {
  cycle: bigint;
  served: bigint;
  inflight: bigint;
  /** Highest receipt cumulative we hold a signature for, this cycle. */
  held: bigint;
  /** The actual signed receipt for `held` (what the redeem driver submits). */
  receipt: HeldReceipt | null;
  /** Highest cumulative we've CONFIRMED redeemed on-chain (this cycle). */
  redeemed: bigint;
}

export interface AdmitResult {
  ok: boolean;
  /** Why the request was refused (only when !ok). */
  reason?: string;
  /** Un-receipted work currently floated for this pair (base units). */
  outstanding: bigint;
  /** Set when the refusal is because the caller's reservation cycle is OLDER
   *  than the generation the ledger has already advanced to (a cache-vs-chain
   *  race). The caller must refresh its reservation read and re-gate against the
   *  current cycle, not serve on the stale view. */
  stale?: boolean;
}

const key = (consumer: string, operator: string): string =>
  `${consumer.toLowerCase()}:${operator.toLowerCase()}`;

export class VaultCreditLedger {
  private readonly entries = new Map<string, Entry>();

  /** Fetch the entry for the CURRENT cycle, resetting it when the cycle has
   *  advanced (a fresh reservation generation zeroes served/inflight/held —
   *  prior-cycle receipts can no longer settle on-chain, so they're worthless
   *  here). A request carrying an OLDER cycle than we've seen is stale (reorg /
   *  slow read); we keep the newer state and evaluate against it. */
  private entryFor(consumer: string, operator: string, cycle: bigint): Entry {
    const k = key(consumer, operator);
    let e = this.entries.get(k);
    if (!e) {
      e = { cycle, served: 0n, inflight: 0n, held: 0n, receipt: null, redeemed: 0n };
      this.entries.set(k, e);
      return e;
    }
    if (cycle > e.cycle) {
      e.cycle = cycle;
      e.served = 0n;
      e.inflight = 0n;
      e.held = 0n;
      e.receipt = null;
      e.redeemed = 0n;
    }
    return e;
  }

  private static outstanding(e: Entry): bigint {
    const covered = e.held > e.redeemed ? e.held : e.redeemed;
    const o = e.served + e.inflight - covered;
    return o > 0n ? o : 0n;
  }

  /** Synchronize the durable cumulative baseline read from `ops()`. This must
   * run before admission. Both values are monotonic within a cycle. */
  syncOnchain(consumer: string, operator: string, cycle: bigint, redeemed: bigint): void {
    const e = this.entryFor(consumer, operator, cycle);
    if (cycle < e.cycle) return;
    if (redeemed > e.redeemed) e.redeemed = redeemed;
    if (redeemed > e.served) e.served = redeemed;
  }

  /**
   * Admit a request whose worst-case (ceiling) cost is `ceilingBase`. Refused
   * ONLY when work is already outstanding AND this ceiling would push the total
   * past `windowBase`; a request arriving with nothing outstanding is always
   * admitted (even if its ceiling alone exceeds `windowBase` — it is bounded
   * instead by the on-chain reservation the serve gate already verified). On
   * success the ceiling is RESERVED as in-flight; the caller MUST later call
   * exactly one of `settleServed` (served ok) or `releaseInflight` (serve failed)
   * with the SAME ceiling so the reservation is trued-up or returned.
   *
   * Synchronous on purpose: read-check-reserve is one atomic step on Node's
   * single thread, so concurrent admits can't both consume the same headroom.
   */
  admit(
    consumer: string,
    operator: string,
    cycle: bigint,
    ceilingBase: bigint,
    windowBase: bigint
  ): AdmitResult {
    const e = this.entryFor(consumer, operator, cycle);
    // Stale-cycle guard: the ledger has already advanced to a newer generation
    // (e.g. a receipt for the new cycle landed via the uncached verify path while
    // this request rode the gate cache). Reserving against the new cycle's window
    // with stale coverage would (a) let the operator serve on a reservation that
    // no longer exists, and (b) strand this ceiling — the matching settle/release
    // carries the OLD cycle and now no-ops, never returning the inflight. Refuse
    // WITHOUT mutating; the caller refreshes its reservation read and re-gates.
    if (cycle < e.cycle) {
      return {
        ok: false,
        stale: true,
        reason: `stale reservation cycle (${cycle} < ${e.cycle}); refresh and re-gate`,
        outstanding: VaultCreditLedger.outstanding(e),
      };
    }
    const outstanding = VaultCreditLedger.outstanding(e);
    const projected = outstanding + ceilingBase;
    // Refuse ONLY when there is ALREADY un-receipted work outstanding AND this
    // request would push the total past the window. A request is NEVER blocked
    // when nothing is outstanding (outstanding === 0n) — even if its ceiling
    // alone exceeds the window: it's already bounded by the on-chain reservation
    // (the serve gate verified ceiling ≤ locked), and the window's purpose is to
    // cap ACCUMULATION of un-receipted work across requests, not to reject a
    // single request larger than the window (e.g. a premium model like Claude
    // Sonnet, whose one-request ceiling easily exceeds a small default window).
    // Worst-case un-receipted exposure is then one request's ceiling — the
    // irreducible floor — after which the next request waits for a receipt.
    if (outstanding > 0n && projected > windowBase) {
      return {
        ok: false,
        reason: `credit window exceeded (floating ${outstanding} + ${ceilingBase} > ${windowBase}); awaiting a receipt for prior work`,
        outstanding,
      };
    }
    e.inflight += ceilingBase;
    // Report POST-reserve floated work, matching AdmitResult.outstanding's
    // "currently floated" contract — this request's ceiling is now in-flight.
    return { ok: true, outstanding: VaultCreditLedger.outstanding(e) };
  }

  /** Convert an admitted request's reserved ceiling into ACTUAL served cost. */
  settleServed(
    consumer: string,
    operator: string,
    cycle: bigint,
    ceilingBase: bigint,
    actualBase: bigint
  ): void {
    const e = this.entryFor(consumer, operator, cycle);
    // A settle for an OLDER cycle than we've advanced to (the reservation bumped
    // generation while this request was in flight) must NOT mutate the current
    // entry — subtracting this dead cycle's ceiling from the new generation's
    // inflight, or adding its served cost, corrupts the live window. The work it
    // accounts for is already gone with the prior cycle. (Matches syncOnchain /
    // recordReceipt, which guard the same way.)
    if (cycle < e.cycle) return;
    e.inflight = e.inflight > ceilingBase ? e.inflight - ceilingBase : 0n;
    if (actualBase > 0n) e.served += actualBase;
  }

  /** Return an admitted request's reserved ceiling when the serve produced no
   *  charge (upstream error, refusal) — no served value is recorded. */
  releaseInflight(consumer: string, operator: string, cycle: bigint, ceilingBase: bigint): void {
    const e = this.entryFor(consumer, operator, cycle);
    // Stale-cycle guard (see settleServed): never release a dead cycle's ceiling
    // against the current generation's inflight.
    if (cycle < e.cycle) return;
    e.inflight = e.inflight > ceilingBase ? e.inflight - ceilingBase : 0n;
  }

  /**
   * Record a consumer-signed cumulative receipt. Keeps only the HIGHEST
   * cumulative per cycle (it supersedes every lower one). Returns true when this
   * advanced the held cumulative (i.e. it's worth redeeming). A receipt for a
   * stale cycle, or not higher than what we already hold, is ignored.
   */
  recordReceipt(
    consumer: string,
    operator: string,
    receipt: HeldReceipt
  ): boolean {
    const e = this.entryFor(consumer, operator, receipt.cycle);
    // entryFor advanced to receipt.cycle only if it was NEWER; if the receipt's
    // cycle is older than our current cycle, it can't settle on-chain — drop it.
    if (receipt.cycle < e.cycle) return false;
    if (receipt.cumulative <= e.held) return false;
    e.held = receipt.cumulative;
    e.receipt = { ...receipt };
    return true;
  }

  /** The receipt the redeem driver should submit next: the highest held one that
   *  hasn't been confirmed redeemed on-chain yet. Null when nothing is owed. */
  redeemable(consumer: string, operator: string): HeldReceipt | null {
    const e = this.entries.get(key(consumer, operator));
    if (!e || !e.receipt) return null;
    return e.receipt.cumulative > e.redeemed ? e.receipt : null;
  }

  /** Mark a cumulative as confirmed redeemed on-chain (idempotent, monotonic),
   *  so the redeem driver won't resubmit an already-settled receipt. */
  noteRedeemed(consumer: string, operator: string, cumulative: bigint, cycle: bigint): void {
    const e = this.entryFor(consumer, operator, cycle);
    // Stale-cycle guard: a delayed redeem (or a StaleReceipt/uncollectable
    // classification) for a PRIOR cycle's receipt must not write that old
    // cumulative into the current generation's `redeemed` — doing so over-credits
    // `covered`, so `outstanding` under-counts and the operator floats more than
    // the window of un-receipted work this cycle. The old cumulative doesn't
    // authorize current-cycle work on-chain anyway.
    if (cycle < e.cycle) return;
    if (cumulative > e.redeemed) e.redeemed = cumulative;
  }

  /** Every (consumer, operator) pair that still holds a receipt not yet confirmed
   *  redeemed on-chain — drives the periodic redeem sweep. */
  pairsWithRedeemable(): Array<{ consumer: string; operator: string }> {
    const out: Array<{ consumer: string; operator: string }> = [];
    for (const [k, e] of this.entries) {
      if (e.receipt && e.receipt.cumulative > e.redeemed) {
        const [consumer, operator] = k.split(":");
        out.push({ consumer, operator });
      }
    }
    return out;
  }

  /** Current floated, un-receipted exposure for a pair (base units). */
  outstandingFor(consumer: string, operator: string): bigint {
    const e = this.entries.get(key(consumer, operator));
    return e ? VaultCreditLedger.outstanding(e) : 0n;
  }

  /** Snapshot for logging/metrics. */
  snapshot(consumer: string, operator: string): {
    cycle: bigint;
    served: bigint;
    inflight: bigint;
    held: bigint;
    redeemed: bigint;
    outstanding: bigint;
  } | null {
    const e = this.entries.get(key(consumer, operator));
    if (!e) return null;
    return {
      cycle: e.cycle,
      served: e.served,
      inflight: e.inflight,
      held: e.held,
      redeemed: e.redeemed,
      outstanding: VaultCreditLedger.outstanding(e),
    };
  }
}

/**
 * Resolve the operator's credit window (base units, 6-dp USDC). The window caps
 * the ACCUMULATION of un-receipted work across requests; worst-case loss to a
 * ghosting consumer is max(window, a single request's ceiling), since one request
 * larger than the window is still admitted when nothing is outstanding (see
 * admit()). Sized to cover normal agent concurrency so the gate ~never refuses in
 * steady state; the on-chain `locked` reservation is the hard ceiling regardless
 * (callers should min() with it — serve.ts does).
 *
 * Default: $0.10 (100_000 base). Tunable via HALO_VAULT_CREDIT_WINDOW_BASE.
 */
export function creditWindowBase(): bigint {
  const raw = (process.env.HALO_VAULT_CREDIT_WINDOW_BASE || "").trim();
  if (raw) {
    try {
      const v = BigInt(raw);
      if (v > 0n) return v;
    } catch {
      /* fall through to default */
    }
  }
  return 100_000n;
}
