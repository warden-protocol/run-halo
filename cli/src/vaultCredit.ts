export interface HeldReceipt {
  /** Cumulative base units this receipt authorizes (monotonic per cycle). */
  cumulative: bigint;
  /** EIP-712 Receipt signature (recovers to the consumer's session key). */
  signature: string;
  cycle: bigint;
}

export type ReceiptSnapshot = Array<{ consumer: string; operator: string; receipt: HeldReceipt }>;

interface Entry {
  cycle: bigint;
  served: bigint;
  inflight: bigint;
  /** Highest receipt cumulative we hold a signature for, this cycle. */
  held: bigint;
  receipt: HeldReceipt | null;
  /** Highest cumulative treated locally as redeemed; chain sync may advance it. */
  redeemed: bigint;
  /** Maximum collectable cumulative; `-1` means no chain read yet. */
  ceiling: bigint;
}

export interface AdmitResult {
  ok: boolean;
  /** Why the request was refused (only when !ok). */
  reason?: string;
  /** Un-receipted work currently floated for this pair (base units). */
  outstanding: bigint;
  /** Signals a stale reservation cycle that must be refreshed before re-gating. */
  stale?: boolean;
}

const key = (consumer: string, operator: string): string =>
  `${consumer.toLowerCase()}:${operator.toLowerCase()}`;

const receiptMatches = (current: HeldReceipt, expected?: HeldReceipt): boolean =>
  !expected ||
  (current.cumulative === expected.cumulative &&
    current.cycle === expected.cycle &&
    current.signature === expected.signature);

export class VaultCreditLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onChange?: (snapshot: ReceiptSnapshot) => void) {}

  /** Receipts that still authorize value above the redeemed baseline. */
  receiptSnapshot(): ReceiptSnapshot {
    const snapshot: ReceiptSnapshot = [];
    for (const [k, e] of this.entries) {
      if (e.receipt && e.held > e.redeemed) {
        const idx = k.indexOf(":");
        snapshot.push({
          consumer: k.slice(0, idx),
          operator: k.slice(idx + 1),
          receipt: { ...e.receipt },
        });
      }
    }
    return snapshot;
  }

  private persist(): void {
    if (!this.onChange) return;
    this.onChange(this.receiptSnapshot());
  }

  /** Reset state on a newer cycle and never overwrite it with an older cycle. */
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
      e.ceiling = -1n;
      this.persist();
    }
    return e;
  }

  private static outstanding(e: Entry): bigint {
    // Uncollectable receipt headroom must not reduce outstanding exposure.
    let covered = e.held > e.redeemed ? e.held : e.redeemed;
    if (e.ceiling >= 0n && covered > e.ceiling) covered = e.ceiling;
    const o = e.served + e.inflight - covered;
    return o > 0n ? o : 0n;
  }

  /** Merge an `ops()` read monotonically so stale reads cannot lower coverage. */
  syncOnchain(
    consumer: string,
    operator: string,
    cycle: bigint,
    redeemed: bigint,
    locked: bigint
  ): void {
    const e = this.entryFor(consumer, operator, cycle);
    if (cycle < e.cycle) return;
    const wasDurable = e.receipt !== null && e.held > e.redeemed;
    if (redeemed > e.redeemed) e.redeemed = redeemed;
    if (redeemed > e.served) e.served = redeemed;
    // Preserve the highest observed collectable ceiling within a cycle.
    const ceiling = redeemed + locked;
    if (ceiling > e.ceiling) e.ceiling = ceiling;
    if (wasDurable && e.held <= e.redeemed) this.persist();
  }

  /** Reserve a ceiling synchronously while bounding accumulated exposure. */
  admit(
    consumer: string,
    operator: string,
    cycle: bigint,
    ceilingBase: bigint,
    windowBase: bigint
  ): AdmitResult {
    const e = this.entryFor(consumer, operator, cycle);
    // Refuse stale cycles without mutating the newer generation.
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
    // A lone request may exceed the window; subsequent accumulation may not.
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

  /** Replace an admitted ceiling with actual cost and return its checkpoint. */
  settleServed(
    consumer: string,
    operator: string,
    cycle: bigint,
    ceilingBase: bigint,
    actualBase: bigint
  ): bigint | null {
    const e = this.entryFor(consumer, operator, cycle);
    // An older cycle must not mutate or emit a checkpoint for the current generation.
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

  /** Keep the highest receipt for the current cycle and report whether it advanced. */
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
    this.persist();
    return true;
  }

  /** Conditionally clear an authorization and always emit the resolved snapshot. */
  dropReceipt(consumer: string, operator: string, expected?: HeldReceipt): void {
    const e = this.entries.get(key(consumer, operator));
    if (e && e.receipt && receiptMatches(e.receipt, expected)) {
      e.receipt = null;
      e.held = 0n;
    }
    this.persist();
  }

  /** Cap held cumulative to the known collectable ceiling. */
  private static collectableCumulative(e: Entry): bigint {
    if (!e.receipt) return 0n;
    return e.ceiling >= 0n && e.held > e.ceiling ? e.ceiling : e.held;
  }

  /** Return the highest held receipt with collectable headroom. */
  redeemable(consumer: string, operator: string): HeldReceipt | null {
    const e = this.entries.get(key(consumer, operator));
    if (!e || !e.receipt) return null;
    return VaultCreditLedger.collectableCumulative(e) > e.redeemed ? e.receipt : null;
  }

  /** Mark a submitted redeem locally, capped to known collectable headroom. */
  noteRedeemed(consumer: string, operator: string, cumulative: bigint, cycle: bigint): void {
    const e = this.entryFor(consumer, operator, cycle);
    // Never credit an older cycle against current exposure.
    if (cycle < e.cycle) return;
    // Capping here lets a later top-up reactivate an uncollected tail.
    const collected = e.ceiling >= 0n && cumulative > e.ceiling ? e.ceiling : cumulative;
    if (collected > e.redeemed) {
      e.redeemed = collected;
      this.persist();
    }
  }

  /** Pairs whose held receipt still has collectable headroom. */
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

  /** Snapshot for logging and metrics. */
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

/** Resolve the six-decimal USDC window for accumulated unreceipted work.
 * A single larger request may pass when idle; callers also cap against on-chain locked funds. */
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
