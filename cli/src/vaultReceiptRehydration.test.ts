import test from "node:test";
import assert from "node:assert/strict";
import type { ReceiptVerification } from "./vault";
import { ReceiptSnapshot, VaultCreditLedger } from "./vaultCredit";
import {
  PendingHeldReceipt,
  durableReceiptSnapshot,
  handoffRehydratedReceipt,
  mergeReceiptSnapshots,
  receiptPairKey,
  shouldRetryRehydration,
} from "./vaultReceiptRehydration";

const C = "0x1111111111111111111111111111111111111111";
const O = "0x2222222222222222222222222222222222222222";

function stored(cumulative: bigint, cycle: bigint, signature: string): ReceiptSnapshot[number] {
  return { consumer: C, operator: O, receipt: { cumulative, cycle, signature } };
}

function pending(cumulative: bigint, cycle: bigint, signature: string): PendingHeldReceipt {
  return { consumer: C, operator: O, cumulative, cycle, signature };
}

function verification(
  values: Partial<ReceiptVerification> & Pick<ReceiptVerification, "ok" | "cycle">
): ReceiptVerification {
  return {
    transient: false,
    redeemed: 0n,
    locked: 1_000n,
    ...values,
  };
}

test("a lower live receipt cannot replace a higher same-cycle pending receipt", () => {
  const merged = mergeReceiptSnapshots(
    [stored(200n, 7n, "0xhigher-pending")],
    [stored(150n, 7n, "0xlower-live")]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].receipt.cumulative, 200n);
  assert.equal(merged[0].receipt.signature, "0xhigher-pending");
});

test("a verified receipt from a newer cycle supersedes an older pending cycle", () => {
  const merged = mergeReceiptSnapshots(
    [stored(500n, 7n, "0xold-cycle")],
    [stored(100n, 8n, "0xnew-cycle")]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].receipt.cycle, 8n);
  assert.equal(merged[0].receipt.cumulative, 100n);
});

test("a successful-but-behind chain view is retried instead of pruning", () => {
  const p = pending(200n, 7n, "0xvalid");
  assert.equal(
    shouldRetryRehydration(
      p,
      verification({
        ok: false,
        cycle: 6n,
        reason: "signature does not recover to the consumer's session key",
      })
    ),
    true
  );
  assert.equal(
    shouldRetryRehydration(
      p,
      verification({
        ok: false,
        transient: true,
        cycle: 0n,
        reason: "could not read on-chain state",
      })
    ),
    true
  );
});

test("an authoritative newer-cycle failure remains deterministic", () => {
  const p = pending(200n, 7n, "0xstale");
  assert.equal(
    shouldRetryRehydration(
      p,
      verification({
        ok: false,
        cycle: 8n,
        reason: "signature does not recover to the consumer's session key",
      })
    ),
    false
  );
});

test("handoff keeps the pending receipt in every write until the ledger owns it", () => {
  const p = pending(200n, 7n, "0xhigher-pending");
  const pendingReceipts = new Map([[receiptPairKey(C, O), p]]);
  const writes: Array<{ pendingSize: number; snapshot: ReceiptSnapshot }> = [];
  const persistCurrent = (ledgerSnapshot: ReceiptSnapshot): void => {
    writes.push({
      pendingSize: pendingReceipts.size,
      snapshot: durableReceiptSnapshot(pendingReceipts, ledgerSnapshot),
    });
  };
  const ledger = new VaultCreditLedger(persistCurrent);

  ledger.syncOnchain(C, O, 7n, 0n, 1_000n);
  ledger.recordReceipt(C, O, { cumulative: 100n, cycle: 7n, signature: "0xlower-live" });
  assert.equal(writes.at(-1)?.snapshot[0].receipt.cumulative, 200n);
  writes.length = 0;

  const advanced = handoffRehydratedReceipt({
    key: receiptPairKey(C, O),
    pending: pendingReceipts,
    receipt: p,
    verification: verification({ ok: true, cycle: 7n, redeemed: 100n, locked: 900n }),
    ledger,
    persistCurrent,
  });

  assert.equal(advanced, true);
  assert.deepEqual(writes.map((w) => w.pendingSize), [1, 1, 0]);
  assert.ok(
    writes.every(
      (w) => w.snapshot.length === 1 && w.snapshot[0].receipt.cumulative === 200n
    ),
    "no intermediate durable write may lose or regress the pending authorization"
  );
  assert.equal(ledger.redeemable(C, O)?.cumulative, 200n);
});

test("handoff prunes a receipt already fully redeemed on-chain", () => {
  const p = pending(100n, 7n, "0xcollected");
  const pendingReceipts = new Map([[receiptPairKey(C, O), p]]);
  const writes: ReceiptSnapshot[] = [];
  const persistCurrent = (ledgerSnapshot: ReceiptSnapshot): void => {
    writes.push(durableReceiptSnapshot(pendingReceipts, ledgerSnapshot));
  };
  const ledger = new VaultCreditLedger(persistCurrent);

  handoffRehydratedReceipt({
    key: receiptPairKey(C, O),
    pending: pendingReceipts,
    receipt: p,
    verification: verification({ ok: true, cycle: 7n, redeemed: 100n, locked: 0n }),
    ledger,
    persistCurrent,
  });

  assert.equal(writes[0][0].receipt.cumulative, 100n, "pending remains during ledger record");
  assert.deepEqual(writes.at(-1), [], "the final checkpoint prunes the collected receipt");
});
