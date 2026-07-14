import { VaultCreditLedger } from "./vaultCredit";
import { classifyRedeemError, formatUsdcBase } from "@halo/vault-core";

export { classifyRedeemError } from "@halo/vault-core";

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

  /** Periodically retry pairs that still hold a redeemable receipt. */
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
            `  ✓ vault redeem ${body.hash} collected ${fmtUsd(receipt.cumulative)} cumulative (${receipt.cumulative} base) from ${abbrev(consumer)}`
          );
          return;
        }
        if (res.ok && body.status === "already-redeemed") {
          // Treat the facilitator's terminal duplicate response as locally complete.
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
          // Deterministic verification failure: retrying cannot make this receipt collectible.
          this.ledger.noteRedeemed(consumer, operator, receipt.cumulative, receipt.cycle);
          this.log(
            `  ⚠ vault receipt from ${abbrev(consumer)} is uncollectable (${errStr.slice(0, 80)}) — abandoning (loss can reach the reservation's collectible ceiling)`
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

/** Classify named vault errors as collected, deterministic-uncollectable, or transient.
 * Ambiguous messages remain transient so a collectible receipt is never discarded. */
function fmtUsd(base: bigint): string {
  return formatUsdcBase(base, { withDollarSign: true });
}
function abbrev(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
