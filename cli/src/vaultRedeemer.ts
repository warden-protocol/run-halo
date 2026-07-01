/**
 * Operator-side redeem driver (operator-driven redeem, issue #369).
 *
 * In the fixed flow the operator — the party owed the money — holds the
 * consumer-signed cumulative receipts and submits the on-chain `redeem` itself,
 * instead of hoping the consumer does. It posts the receipt to the facilitator
 * (same permissionless `/vault/redeem` the consumer used; the facilitator pays
 * gas and the contract verifies the signature), with retry, because its own
 * revenue depends on it landing — unlike the old consumer-driven fire-and-forget
 * that dropped failures.
 *
 * Coalescing: receipts are cumulative, so a single redeem of the HIGHEST held
 * receipt collects everything beneath it. `kick()` therefore just (re)schedules
 * a redeem of whatever `ledger.redeemable()` currently returns; many kicks during
 * a burst collapse into one on-chain redeem. Serialized per (consumer, operator)
 * so receipts settle in monotonic order and a re-scan never double-submits.
 *
 * Off the serve path entirely — the answer never waits on this.
 */
import { VaultCreditLedger } from "./vaultCredit";

const REDEEM_ATTEMPTS = 4;
const REDEEM_BACKOFF_MS = 750;

export class OperatorRedeemer {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly facilitatorUrl: string,
    private readonly ledger: VaultCreditLedger,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  private facBase(): string {
    return this.facilitatorUrl.replace(/\/+$/, "");
  }

  /** Schedule a redeem of the current highest unredeemed receipt for the pair.
   *  Idempotent + coalescing — safe to call on every receipt arrival. */
  kick(consumer: string, operator: string): void {
    const key = `${consumer.toLowerCase()}:${operator.toLowerCase()}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.redeemLatest(consumer, operator));
    this.queues.set(key, next);
  }

  /** Re-kick every pair that still holds an unredeemed receipt. Run on a timer so
   *  a receipt whose redeem failed transiently (and got no follow-up receipt) is
   *  still collected before the reservation expires (issue #369). */
  sweep(): void {
    for (const { consumer, operator } of this.ledger.pairsWithRedeemable()) {
      this.kick(consumer, operator);
    }
  }

  /** Await all in-flight redeems (graceful shutdown — collect before exit). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }

  private async redeemLatest(consumer: string, operator: string): Promise<void> {
    // Re-read inside the serialized task so we always submit the LATEST receipt
    // (a higher one may have arrived while earlier kicks were queued).
    const receipt = this.ledger.redeemable(consumer, operator);
    if (!receipt) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt < REDEEM_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.facBase()}/vault/redeem`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            consumer,
            operator,
            cumulative: receipt.cumulative.toString(),
            signature: receipt.signature,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = (await res.json().catch(() => ({}))) as {
          hash?: string;
          error?: string;
          status?: string;
        };
        if (res.ok && body.hash) {
          this.ledger.noteRedeemed(consumer, operator, receipt.cumulative, receipt.cycle);
          this.log(
            `  ✓ vault redeem ${body.hash.slice(0, 10)}… collected ${fmtUsd(receipt.cumulative)} cumulative from ${abbrev(consumer)}`
          );
          return;
        }
        if (res.ok && body.status === "already-redeemed") {
          // Facilitator deduped it: this cumulative is already captured on-chain
          // (issue #392 idempotency). Same terminal outcome as a StaleReceipt
          // revert — mark collected and stop, don't retry.
          this.ledger.noteRedeemed(consumer, operator, receipt.cumulative, receipt.cycle);
          return;
        }
        const errStr = body.error || `HTTP ${res.status}`;
        const cls = classifyRedeemError(errStr);
        if (cls === "collected") {
          // StaleReceipt / ExceedsReservation: a re-scan or earlier attempt
          // already landed this cumulative (or nothing remains) — not a loss.
          this.ledger.noteRedeemed(consumer, operator, receipt.cumulative, receipt.cycle);
          return;
        }
        if (cls === "uncollectable") {
          // Deterministic verify failure (e.g. the cycle bumped — the consumer
          // re-reserved, releasing this cycle's tail). Retrying can't help; stop
          // and surface the bounded loss (≤ the credit window) rather than spin.
          this.ledger.noteRedeemed(consumer, operator, receipt.cumulative, receipt.cycle);
          this.log(
            `  ⚠ vault receipt from ${abbrev(consumer)} is uncollectable (${errStr.slice(0, 80)}) — abandoning (bounded by the credit window)`
          );
          return;
        }
        lastErr = new Error(errStr); // transient → retry
      } catch (err) {
        lastErr = err; // network/timeout → transient → retry
      }
      if (attempt < REDEEM_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, REDEEM_BACKOFF_MS * (attempt + 1)));
      }
    }
    // Out of retries. Leave the receipt unredeemed in the ledger — a later
    // kick (next receipt, or a periodic sweep) retries; the operator keeps
    // refusing to over-serve this pair until it collects (window stays full).
    this.log(
      `  ⚠ vault redeem for ${abbrev(consumer)} failed after ${REDEEM_ATTEMPTS} tries (will retry on next receipt): ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }
}

/** Classify a facilitator redeem error so we retry only TRANSIENT failures.
 *  - `collected`: nothing left to collect (StaleReceipt = cumulative already
 *    redeemed; ExceedsReservation = reservation fully drained) — no loss, stop.
 *  - `uncollectable`: deterministic verify failure (BadSignature/NoSessionKey,
 *    incl. an old-cycle receipt whose digest no longer recovers) — retrying
 *    can't help; stop and report.
 *  - `transient`: RPC/HTTP/network blip (retry).
 *
 *  Matches the HaloVault custom-error NAMES, NOT bare words like "stale" or
 *  "already": those collide with benign transient RPC noise ("already known",
 *  "nonce ... already used", a "stale" block read), and classifying a transient
 *  blip as `collected`/`uncollectable` would mark a real, still-collectible
 *  receipt redeemed and silently abandon it (operator forfeits served revenue).
 *  When the revert name isn't present in the message (e.g. the node returns a
 *  bare "execution reverted"), we fall through to `transient` ON PURPOSE: a later
 *  kick / 30s sweep re-attempts, and the credit window stays full until it
 *  collects. Retrying a genuinely-stale receipt only wastes RPC; dropping a
 *  collectible one loses money — so we fail toward retry. */
export function classifyRedeemError(err: string): "collected" | "uncollectable" | "transient" {
  if (/StaleReceipt|ExceedsReservation/i.test(err)) return "collected";
  if (/BadSignature|NoSessionKey|does not recover/i.test(err)) return "uncollectable";
  return "transient";
}

function fmtUsd(base: bigint): string {
  return `$${(Number(base) / 1_000_000).toFixed(4)}`;
}
function abbrev(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
