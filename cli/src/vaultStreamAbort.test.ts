import test from "node:test";
import assert from "node:assert/strict";
import { VaultCreditLedger } from "./vaultCredit";
import {
  releaseAbortedVaultServe,
  withAbortedStreamCleanup,
} from "./vaultStreamAbort";

const C = "0x1111111111111111111111111111111111111111";
const O = "0x2222222222222222222222222222222222222222";
const CY = 1n;

test("aborted vault stream releases the admitted ceiling instead of booking served work", () => {
  const ledger = new VaultCreditLedger();
  ledger.syncOnchain(C, O, CY, 0n, 1_000n);
  assert.equal(ledger.admit(C, O, CY, 400n, 1_000n).ok, true);
  assert.equal(ledger.outstandingFor(C, O), 400n);

  const released = releaseAbortedVaultServe({
    abortedRequestIds: new Set(["req-1"]),
    requestId: "req-1",
    creditLedger: ledger,
    consumer: C,
    operator: O,
    cycle: CY,
    ceiling: 400n,
  });

  assert.equal(released, true);
  assert.equal(ledger.outstandingFor(C, O), 0n);
  assert.equal(ledger.redeemable(C, O), null);
});

test("non-aborted vault stream leaves the admitted ceiling for normal settlement", () => {
  const ledger = new VaultCreditLedger();
  ledger.syncOnchain(C, O, CY, 0n, 1_000n);
  assert.equal(ledger.admit(C, O, CY, 400n, 1_000n).ok, true);

  const released = releaseAbortedVaultServe({
    abortedRequestIds: new Set(),
    requestId: "req-1",
    creditLedger: ledger,
    consumer: C,
    operator: O,
    cycle: CY,
    ceiling: 400n,
  });

  assert.equal(released, false);
  assert.equal(ledger.outstandingFor(C, O), 400n);
  ledger.settleServed(C, O, CY, 400n, 250n);
  assert.equal(ledger.outstandingFor(C, O), 250n);
});

test("aborted stream cleanup runs after normal completion", async () => {
  const aborted = new Set(["req-1"]);
  const result = await withAbortedStreamCleanup(aborted, "req-1", async () => "ok");

  assert.equal(result, "ok");
  assert.equal(aborted.has("req-1"), false);
});

test("aborted stream cleanup runs after early-return style completion", async () => {
  const aborted = new Set(["req-1"]);
  await withAbortedStreamCleanup(aborted, "req-1", async () => {
    return;
  });

  assert.equal(aborted.has("req-1"), false);
});

test("aborted stream cleanup runs after thrown errors", async () => {
  const aborted = new Set(["req-1"]);

  await assert.rejects(
    withAbortedStreamCleanup(aborted, "req-1", async () => {
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(aborted.has("req-1"), false);
});
