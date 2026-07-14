import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { VaultCreditLedger, ReceiptSnapshot } from "./vaultCredit";
import { VaultReceiptStore } from "./vaultReceiptStore";

const C = "0x1111111111111111111111111111111111111111";
const O = "0x2222222222222222222222222222222222222222";
const CY = 1n;

function capture(): { snaps: ReceiptSnapshot[]; cb: (s: ReceiptSnapshot) => void } {
  const snaps: ReceiptSnapshot[] = [];
  return { snaps, cb: (s) => snaps.push(s) };
}

test("onChange fires on recordReceipt advance, with the held receipt", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: CY }), true);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].length, 1);
  assert.equal(snaps[0][0].receipt.cumulative, 100n);
  assert.equal(snaps[0][0].consumer, C.toLowerCase());
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: CY }), false);
  assert.equal(snaps.length, 1);
});

test("onChange does NOT fire on the serve hot path (admit / settleServed / releaseInflight)", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  l.admit(C, O, CY, 500n, 1000n);
  l.settleServed(C, O, CY, 500n, 400n);
  l.releaseInflight(C, O, CY, 0n);
  assert.equal(snaps.length, 0, "hot-path methods must never persist");
});

test("onChange fires (pruning) when a redeem covers the held receipt", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  l.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: CY });
  l.noteRedeemed(C, O, 100n, CY);
  assert.equal(snaps.length, 2);
  assert.deepEqual(snaps[1], []);
});

test("onChange fires (dropping the receipt) on a cycle reset", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  l.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: 1n });
  l.recordReceipt(C, O, { cumulative: 50n, signature: "0xb", cycle: 2n });
  const empty = snaps.find((s) => s.length === 0);
  assert.ok(empty, "cycle reset must emit a pruning snapshot");
  assert.equal(snaps[snaps.length - 1][0].receipt.cycle, 2n);
});

test("a ceiling-clamped tail remains in the snapshot across a restart", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  l.syncOnchain(C, O, CY, 50n, 0n);
  l.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: CY });
  assert.equal(l.redeemable(C, O), null, "tail above the ceiling is not collectable now");
  const last = snaps[snaps.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].receipt.cumulative, 100n);
});

test("syncOnchain prunes a receipt that was redeemed elsewhere on-chain", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  l.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: CY });
  l.syncOnchain(C, O, CY, 100n, 0n);
  assert.deepEqual(snaps[snaps.length - 1], [], "a collected receipt is pruned from disk");
});

test("dropReceipt prunes even a pair never recorded into the ledger", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  l.dropReceipt(C, O);
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0], []);
});

test("dropReceipt(expected) does NOT clobber a newer receipt recorded meanwhile", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  const stale = { cumulative: 100n, signature: "0xold", cycle: CY };
  l.recordReceipt(C, O, { cumulative: 200n, signature: "0xnew", cycle: CY });
  l.dropReceipt(C, O, stale);
  assert.equal(l.redeemable(C, O)?.cumulative, 200n, "newer receipt must remain collectable");
  const last = snaps[snaps.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].receipt.cumulative, 200n);
});

test("dropReceipt(expected) DOES drop when the held receipt still matches", () => {
  const { snaps, cb } = capture();
  const l = new VaultCreditLedger(cb);
  const r = { cumulative: 100n, signature: "0xa", cycle: CY };
  l.recordReceipt(C, O, r);
  l.dropReceipt(C, O, r);
  assert.equal(l.redeemable(C, O), null);
  assert.deepEqual(snaps[snaps.length - 1], []);
});

test("held receipt survives a restart and is re-armed for collection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-restart-"));
  const file = path.join(dir, "vault-receipts.json");
  try {
    const store1 = new VaultReceiptStore(file);
    const l1 = new VaultCreditLedger((s) => store1.save(s));
    l1.recordReceipt(C, O, { cumulative: 100n, signature: "0xsig", cycle: CY });

    const store2 = new VaultReceiptStore(file);
    const loaded = store2.load();
    assert.equal(loaded.length, 1);
    const l2 = new VaultCreditLedger((s) => store2.save(s));
    l2.syncOnchain(C, O, CY, 0n, 1_000n);
    assert.equal(l2.recordReceipt(C, O, loaded[0].receipt), true);
    const r = l2.redeemable(C, O);
    assert.ok(r, "the rehydrated receipt is collectable again");
    assert.equal(r!.cumulative, 100n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale-cycle persisted receipt is NOT resubmitted after restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-restart-"));
  const file = path.join(dir, "vault-receipts.json");
  try {
    const store1 = new VaultReceiptStore(file);
    const l1 = new VaultCreditLedger((s) => store1.save(s));
    l1.recordReceipt(C, O, { cumulative: 100n, signature: "0xsig", cycle: 1n });

    const store2 = new VaultReceiptStore(file);
    const loaded = store2.load();
    const l2 = new VaultCreditLedger((s) => store2.save(s));
    l2.syncOnchain(C, O, 2n, 0n, 1_000n);
    assert.equal(l2.recordReceipt(C, O, loaded[0].receipt), false);
    assert.equal(l2.redeemable(C, O), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-redeemed persisted receipt is NOT resubmitted after restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-restart-"));
  const file = path.join(dir, "vault-receipts.json");
  try {
    const store1 = new VaultReceiptStore(file);
    const l1 = new VaultCreditLedger((s) => store1.save(s));
    l1.recordReceipt(C, O, { cumulative: 100n, signature: "0xsig", cycle: CY });

    const store2 = new VaultReceiptStore(file);
    const loaded = store2.load();
    const l2 = new VaultCreditLedger((s) => store2.save(s));
    l2.syncOnchain(C, O, CY, 100n, 0n);
    l2.recordReceipt(C, O, loaded[0].receipt);
    assert.equal(l2.redeemable(C, O), null, "nothing left to collect → no resubmit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
