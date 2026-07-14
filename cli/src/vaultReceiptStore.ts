import { writeFileSync, renameSync, readFileSync, existsSync } from "fs";
import type { HeldReceipt } from "./vaultCredit";

export interface StoredReceipt {
  consumer: string;
  operator: string;
  receipt: HeldReceipt;
}

const VERSION = 1;

interface WireReceipt {
  cumulative: string;
  signature: string;
  cycle: string;
}

export class VaultReceiptStore {
  private lastWarnMs = 0;

  constructor(
    private readonly filePath: string,
    private readonly log: (msg: string) => void = (m) => console.warn(m)
  ) {}

  /** Return an empty snapshot rather than block startup on unreadable state. */
  load(): StoredReceipt[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as {
        receipts?: Record<string, WireReceipt>;
      };
      const receipts = parsed?.receipts;
      if (!receipts || typeof receipts !== "object") return [];
      const out: StoredReceipt[] = [];
      for (const [k, v] of Object.entries(receipts)) {
        const idx = k.indexOf(":");
        if (idx <= 0) continue;
        const consumer = k.slice(0, idx);
        const operator = k.slice(idx + 1);
        if (!consumer || !operator || !v || typeof v.signature !== "string" || !v.signature) continue;
        const cumulative = toBig(v.cumulative);
        const cycle = toBig(v.cycle);
        if (cumulative === null || cycle === null || cumulative <= 0n || cycle < 0n) continue;
        out.push({ consumer, operator, receipt: { cumulative, signature: v.signature, cycle } });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Persist atomically; a throttled warning reports best-effort write failure. */
  save(snapshot: StoredReceipt[]): void {
    try {
      const receipts: Record<string, WireReceipt> = {};
      for (const { consumer, operator, receipt } of snapshot) {
        receipts[`${consumer.toLowerCase()}:${operator.toLowerCase()}`] = {
          cumulative: receipt.cumulative.toString(),
          signature: receipt.signature,
          cycle: receipt.cycle.toString(),
        };
      }
      const body = JSON.stringify({ version: VERSION, receipts }, null, 2);
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.warnThrottled(
        `  ⚠ vault: could not persist held receipts (${(err as Error).message}); crash recovery degraded`
      );
    }
  }

  private warnThrottled(msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnMs < 60_000) return;
    this.lastWarnMs = now;
    this.log(msg);
  }
}

function toBig(s: unknown): bigint | null {
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}
