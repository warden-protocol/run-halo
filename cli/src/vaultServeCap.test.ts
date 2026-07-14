import test from "node:test";
import assert from "node:assert/strict";
import { collectibleServeAmount } from "./vault";
import { VaultCreditLedger } from "./vaultCredit";

test("returns the actual cost when it fits within the gated ceiling", () => {
  assert.equal(collectibleServeAmount(64n, 105n), 64n);
});

test("caps to the ceiling when actual over-serves (the #421 reasoning-model case)", () => {
  assert.equal(collectibleServeAmount(236n, 105n), 105n);
});

test("returns the shared value when actual equals the ceiling", () => {
  assert.equal(collectibleServeAmount(105n, 105n), 105n);
});

test("returns 0 when the ceiling is 0", () => {
  assert.equal(collectibleServeAmount(236n, 0n), 0n);
});

test("returns 0 when the actual cost is 0", () => {
  assert.equal(collectibleServeAmount(0n, 105n), 0n);
});

test("rejects negative inputs (numeric-domain guard, invariant #6)", () => {
  assert.throws(() => collectibleServeAmount(-1n, 100n), /non-negative/);
  assert.throws(() => collectibleServeAmount(100n, -1n), /non-negative/);
});

test("result is always <= actual and <= ceiling", () => {
  const samples: Array<[bigint, bigint]> = [
    [0n, 0n],
    [1n, 0n],
    [0n, 1n],
    [50n, 50n],
    [49n, 50n],
    [51n, 50n],
    [1_000_000n, 1n],
    [1n, 1_000_000n],
  ];
  for (const [actual, ceiling] of samples) {
    const got = collectibleServeAmount(actual, ceiling);
    assert.ok(got <= actual, `${got} <= ${actual}`);
    assert.ok(got <= ceiling, `${got} <= ${ceiling}`);
    assert.equal(got, actual < ceiling ? actual : ceiling);
  }
});

test("capped serve keeps the credit ledger symmetric with the admission (and would break without the cap)", () => {
  const C = "0x1111111111111111111111111111111111111111";
  const O = "0x2222222222222222222222222222222222222222";
  const CY = 1n;
  const ceiling = 105n;
  const locked = 105n;
  const window = 100_000n;
  const uncapped = 236n;

  const withCap = new VaultCreditLedger();
  withCap.syncOnchain(C, O, CY, 0n, locked);
  assert.equal(withCap.admit(C, O, CY, ceiling, window).ok, true);
  const capped = collectibleServeAmount(uncapped, ceiling);
  assert.equal(capped, 105n);
  withCap.settleServed(C, O, CY, ceiling, capped);
  const outstandingCapped = withCap.outstandingFor(C, O);
  assert.equal(outstandingCapped, 105n);
  assert.ok(outstandingCapped <= ceiling, "capped: outstanding <= gated ceiling");
  assert.ok(outstandingCapped <= locked, "capped: outstanding <= on-chain locked");

  const noCap = new VaultCreditLedger();
  noCap.syncOnchain(C, O, CY, 0n, locked);
  assert.equal(noCap.admit(C, O, CY, ceiling, window).ok, true);
  noCap.settleServed(C, O, CY, ceiling, uncapped);
  const outstandingUncapped = noCap.outstandingFor(C, O);
  assert.equal(outstandingUncapped, 236n);
  assert.ok(outstandingUncapped > locked, "uncapped: outstanding exceeds on-chain locked (the bug)");
});
