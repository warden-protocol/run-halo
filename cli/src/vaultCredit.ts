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
 *   outstanding = served + inflight − min(max(held, redeemed), collectable)
 *
 *   - `served`      cumulative ACTUAL cost the operator has served this cycle
 *   - `inflight`    sum of the CEILINGS of admitted-but-not-yet-settled requests
 *                   (pessimistic: reserved at admit, trued-up to actual on settle)
 *   - `held`        highest receipt cumulative the operator holds for this cycle
 *   - `collectable` the on-chain redeem ceiling this cycle = `redeemed + locked`
 *                   (the MOST a receipt can ever redeem — `redeem` pays
 *                   `cumulative − redeemed`, clamped to `locked`). Coverage —
 *                   whether from `held` or from a cumulative the redeem driver
 *                   marked `redeemed` — frees the window only up to this ceiling:
 *                   cumulative beyond it reverts on `redeem` (ExceedsReservation
 *                   tail) and is UN-collectable, so it must NOT count as coverage
 *                   or the operator over-serves work it can never collect (issue
 *                   #437). Mirrors the consumer's own receipt cap (@halo/vault-core
 *                   `advanceCumulativeReceipt`, ceiling = `locked + redeemed`).
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
 * cumulative R makes the operator whole for everything up to min(R, collectable)
 * regardless of the order requests completed in (addition commutes) — the tail of
 * R above the on-chain reservation is uncollectable and does not count (#437). A
 * reservation top-up keeps the same cycle (HaloVault.reserve only bumps cycle from
 * locked==0) and RAISES `collectable`, so a held receipt stays valid across a
 * burst and a previously-uncollectable tail becomes redeemable once the consumer
 * tops up; only a fresh generation (cycle++) resets this ledger.
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
  /** On-chain collectable ceiling this cycle = `redeemed + locked` (the highest
   *  cumulative a receipt can ever redeem). Monotonic non-decreasing within a
   *  cycle (grows only on a consumer top-up); caps how much a held receipt frees
   *  the credit window (#437). `-1` until the first on-chain read has been synced,
   *  meaning "ceiling unknown → don't cap" (a fresh read via syncOnchain always
   *  precedes admission on the serve path, so coverage is bounded when it matters). */
  ceiling: bigint;
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
      e = { cycle, served: 0n, inflight: 0n, held: 0n, receipt: null, redeemed: 0n, ceiling: -1n };
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
      // A fresh generation has its own on-chain reservation; the prior cycle's
      // collectable ceiling is meaningless here. Reset to "unknown" until the
      // next syncOnchain reads this cycle's redeemed + locked.
      e.ceiling = -1n;
    }
    return e;
  }

  private static outstanding(e: Entry): bigint {
    // Coverage = the highest cumulative the operator holds a receipt for OR has
    // confirmed redeemed — but it can NEVER exceed what is collectable on-chain this
    // cycle. `redeem` pays `cumulative − redeemed` clamped to `locked`, so the
    // ceiling `redeemed + locked` is the hard cap on how much a receipt makes the
    // operator whole. `held` can run past it (a receipt signed beyond the
    // reservation); that uncollectable tail must NOT free the window or the operator
    // over-serves work it can never collect (issue #437). So cap the final coverage
    // at `ceiling`. (`redeemed` is kept ≤ ceiling by noteRedeemed, so it's the `held`
    // term the cap actually bites.) `ceiling < 0` means no chain read yet → leave
    // uncapped (a fresh read precedes admission on the serve path, so coverage is
    // bounded whenever it gates).
    let covered = e.held > e.redeemed ? e.held : e.redeemed;
    if (e.ceiling >= 0n && covered > e.ceiling) covered = e.ceiling;
    const o = e.served + e.inflight - covered;
    return o > 0n ? o : 0n;
  }

  /** Synchronize the durable on-chain baseline read from `ops()`: `redeemed` (the
   * cumulative captured this cycle) and `locked` (reserved-and-unredeemed funds).
   * This must run before admission. `redeemed` is monotonic within a cycle; the
   * collectable ceiling `redeemed + locked` is too (it grows only on a top-up), so
   * both are tracked as running maxima and a stale/cached read can never lower them. */
  syncOnchain(
    consumer: string,
    operator: string,
    cycle: bigint,
    redeemed: bigint,
    locked: bigint
  ): void {
    const e = this.entryFor(consumer, operator, cycle);
    if (cycle < e.cycle) return;
    if (redeemed > e.redeemed) e.redeemed = redeemed;
    if (redeemed > e.served) e.served = redeemed;
    // Collectable ceiling = the most a receipt can ever redeem this cycle. Take the
    // max observed so a lagging cached read (whose `locked` is discounted by serving
    // since the read) never shrinks a ceiling a fresher read already established; a
    // genuine top-up raises `locked` and lifts it on the next read (#437).
    const ceiling = redeemed + locked;
    if (ceiling > e.ceiling) e.ceiling = ceiling;
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

  /** Convert an admitted request's reserved ceiling into ACTUAL served cost.
   *  Returns the post-settle cumulative `served` for this cycle — the operator's
   *  on-chain cumulative AFTER this serve, which the consumer's receipt advances to
   *  (floored to `redeemed` on the next `syncOnchain`). The caller emits it as the
   *  serve event's `cumulativeCheckpoint` so the indexer can match this serve to the
   *  redeem whose interval closes on it (issue #379, off-chain), instead of
   *  reconstructing the position by summing amounts (which drifts on a
   *  never-redeemed / over-served serve — issue #446). */
  settleServed(
    consumer: string,
    operator: string,
    cycle: bigint,
    ceilingBase: bigint,
    actualBase: bigint
  ): bigint | null {
    const e = this.entryFor(consumer, operator, cycle);
    // A settle for an OLDER cycle than we've advanced to (the reservation bumped
    // generation while this request was in flight) must NOT mutate the current
    // entry — subtracting this dead cycle's ceiling from the new generation's
    // inflight, or adding its served cost, corrupts the live window. The work it
    // accounts for is already gone with the prior cycle. (Matches syncOnchain /
    // recordReceipt, which guard the same way.) Return `null` so the caller emits NO
    // checkpoint: the current entry's `served` belongs to the NEW cycle and could
    // collide with a real new-cycle redeem boundary, mis-attributing this dead-cycle
    // serve. With no checkpoint the row falls to the pending/tiler path — money-safe.
    if (cycle < e.cycle) return null;
    e.inflight = e.inflight > ceilingBase ? e.inflight - ceilingBase : 0n;
    if (actualBase > 0n) e.served += actualBase;
    return e.served;
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

  /** How much of the held receipt is collectable on-chain RIGHT NOW: its cumulative
   *  capped at the ceiling (`redeem` clamps `pay` to `locked`). Compared against
   *  `redeemed`, a positive gap means there's value to submit; zero means fully
   *  collected OR the ceiling is currently exhausted. Ceiling unknown (`< 0`, no
   *  chain read yet) ⇒ assume the full cumulative is collectable (legacy behavior). */
  private static collectableCumulative(e: Entry): bigint {
    if (!e.receipt) return 0n;
    return e.ceiling >= 0n && e.held > e.ceiling ? e.ceiling : e.held;
  }

  /** The receipt the redeem driver should submit next: the highest held one that
   *  still has collectable headroom on-chain (cumulative, capped at the ceiling,
   *  exceeds what's redeemed). Null when nothing is collectable right now — which
   *  retires a fully-collected OR ceiling-clamped receipt so the sweep doesn't spin
   *  resubmitting it (each resubmit would revert ExceedsReservation), yet
   *  REACTIVATES it if a same-cycle top-up later lifts the ceiling (issue #437). */
  redeemable(consumer: string, operator: string): HeldReceipt | null {
    const e = this.entries.get(key(consumer, operator));
    if (!e || !e.receipt) return null;
    return VaultCreditLedger.collectableCumulative(e) > e.redeemed ? e.receipt : null;
  }

  /** Record a redeem the driver submitted (idempotent, monotonic per cycle). The
   *  driver passes the receipt's FULL cumulative, but an over-ceiling receipt only
   *  captured up to `locked` on-chain, so the TRUE on-chain `redeemed` advanced only
   *  to min(cumulative, ceiling). Store that ACTUAL collected amount — not the full
   *  cumulative — so (a) coverage reflects real collection and (b) `redeemable`
   *  re-exposes the tail if a same-cycle top-up later lifts the ceiling (issue #437's
   *  recoverable path: reserve() more → held receipt becomes collectable again →
   *  rows back-fill), instead of the receipt being permanently retired. `redeemable`
   *  gates resubmission on collectable headroom, so capping here never spins. */
  noteRedeemed(consumer: string, operator: string, cumulative: bigint, cycle: bigint): void {
    const e = this.entryFor(consumer, operator, cycle);
    // Stale-cycle guard: a delayed redeem (or a StaleReceipt/uncollectable
    // classification) for a PRIOR cycle's receipt must not write that old
    // cumulative into the current generation's `redeemed` — doing so over-credits
    // `covered`, so `outstanding` under-counts and the operator floats more than
    // the window of un-receipted work this cycle. The old cumulative doesn't
    // authorize current-cycle work on-chain anyway.
    if (cycle < e.cycle) return;
    // On-chain a redeem captures min(cumulative, ceiling) − redeemed (pay clamped to
    // locked), so `redeemed` advances to at most the collectable ceiling. Keeping it
    // ≤ ceiling (rather than the full cumulative) is what lets a later top-up
    // reactivate the still-uncollected tail via redeemable() (#437).
    const collected = e.ceiling >= 0n && cumulative > e.ceiling ? e.ceiling : cumulative;
    if (collected > e.redeemed) e.redeemed = collected;
  }

  /** Every (consumer, operator) pair whose held receipt still has collectable
   *  headroom on-chain — drives the periodic redeem sweep. Uses the same
   *  ceiling-aware test as `redeemable`, so a receipt clamped by the ceiling drops
   *  out (no sweep spin) and re-appears once a top-up lifts the ceiling (#437). */
  pairsWithRedeemable(): Array<{ consumer: string; operator: string }> {
    const out: Array<{ consumer: string; operator: string }> = [];
    for (const [k, e] of this.entries) {
      if (e.receipt && VaultCreditLedger.collectableCumulative(e) > e.redeemed) {
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

  /** Snapshot for logging/metrics. `ceiling` is the on-chain collectable cap
   *  (`redeemed + locked`, or `-1` before the first read); `held` above it is
   *  uncollectable float — the exact quantity issue #437 had to reconstruct by
   *  hand from a null-txHash trace. */
  snapshot(consumer: string, operator: string): {
    cycle: bigint;
    served: bigint;
    inflight: bigint;
    held: bigint;
    redeemed: bigint;
    ceiling: bigint;
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
      ceiling: e.ceiling,
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
