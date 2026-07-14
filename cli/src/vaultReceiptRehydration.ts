import type { ReceiptVerification } from "./vault";
import { HeldReceipt, ReceiptSnapshot, VaultCreditLedger } from "./vaultCredit";

export interface PendingHeldReceipt extends HeldReceipt {
  consumer: string;
  operator: string;
}

export function receiptPairKey(consumer: string, operator: string): string {
  return `${consumer.toLowerCase()}:${operator.toLowerCase()}`;
}

function supersedes(candidate: ReceiptSnapshot[number], current: ReceiptSnapshot[number]): boolean {
  if (candidate.receipt.cycle !== current.receipt.cycle) {
    return candidate.receipt.cycle > current.receipt.cycle;
  }
  // Do not let a delayed lower live receipt regress the pending authorization.
  return candidate.receipt.cumulative >= current.receipt.cumulative;
}

/** Merge snapshots monotonically by cycle and cumulative authorization. */
export function mergeReceiptSnapshots(...snapshots: ReceiptSnapshot[]): ReceiptSnapshot {
  const byPair = new Map<string, ReceiptSnapshot[number]>();
  for (const snapshot of snapshots) {
    for (const candidate of snapshot) {
      const k = receiptPairKey(candidate.consumer, candidate.operator);
      const current = byPair.get(k);
      if (!current || supersedes(candidate, current)) byPair.set(k, candidate);
    }
  }
  return [...byPair.values()];
}

function pendingSnapshot(pending: ReadonlyMap<string, PendingHeldReceipt>): ReceiptSnapshot {
  return [...pending.values()].map((p) => ({
    consumer: p.consumer,
    operator: p.operator,
    receipt: { cumulative: p.cumulative, signature: p.signature, cycle: p.cycle },
  }));
}

export function durableReceiptSnapshot(
  pending: ReadonlyMap<string, PendingHeldReceipt>,
  ledgerSnapshot: ReceiptSnapshot
): ReceiptSnapshot {
  return mergeReceiptSnapshots(pendingSnapshot(pending), ledgerSnapshot);
}

/** Retry when verification lacks an authoritative view at least as new as the receipt. */
export function shouldRetryRehydration(
  pending: PendingHeldReceipt,
  verification: ReceiptVerification
): boolean {
  return !verification.ok && (verification.transient || verification.cycle < pending.cycle);
}

/** Keep pending durable through ledger sync/record, then checkpoint its removal. */
export function handoffRehydratedReceipt(args: {
  key: string;
  pending: Map<string, PendingHeldReceipt>;
  receipt: PendingHeldReceipt;
  verification: ReceiptVerification;
  ledger: VaultCreditLedger;
  persistCurrent: (snapshot: ReceiptSnapshot) => void;
}): boolean {
  const { key, pending, receipt, verification, ledger, persistCurrent } = args;
  ledger.syncOnchain(
    receipt.consumer,
    receipt.operator,
    verification.cycle,
    verification.redeemed,
    verification.locked
  );
  const advanced = ledger.recordReceipt(receipt.consumer, receipt.operator, {
    cumulative: receipt.cumulative,
    signature: receipt.signature,
    cycle: verification.cycle,
  });
  pending.delete(key);
  persistCurrent(ledger.receiptSnapshot());
  return advanced;
}
