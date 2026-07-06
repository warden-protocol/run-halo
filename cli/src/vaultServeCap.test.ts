/**
 * Vault serve-path over-serve cap (issue #421).
 * Run: `node --require ts-node/register --test src/vaultServeCap.test.ts`
 *
 * The load-bearing property: the amount the operator reports/awards for a vault
 * serve is NEVER more than THIS request's gated ceiling (`ceilingCost` — what the
 * serve gate verified against the reservation and what the credit ledger reserved
 * as in-flight via `admit`). Reasoning models emit reasoning tokens that a small
 * `max_tokens` ceiling never bounded, so the priced ACTUAL cost can exceed the
 * ceiling. The consumer's cumulative receipt is itself capped to locked+redeemed,
 * so an uncapped award credits value the operator can never redeem AND books more
 * `served` than was admitted — breaking the credit-window bound (invariant #9) and
 * stranding a permanent txHash:null indexer row. `collectibleServeAmount` is that
 * cap; the gate guarantees `ceilingCost <= remaining`, so the capped amount is
 * always collectible on-chain too. These tests pin the cap and show the credit
 * ledger stays symmetric with the admission when it is applied — and would break
 * without it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { collectibleServeAmount } from "./vault";
import { VaultCreditLedger } from "./vaultCredit";

test("returns the actual cost when it fits within the gated ceiling", () => {
  assert.equal(collectibleServeAmount(64n, 105n), 64n);
});

test("caps to the ceiling when actual over-serves (the #421 reasoning-model case)", () => {
  // Repro from the issue: max_tokens:16 gated ~105 base, reasoning model priced
  // 236 base actual → operator collects 105 (the gated ceiling), not 236.
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
  // Model the #421 flow end-to-end against the operator's credit ledger.
  const C = "0x1111111111111111111111111111111111111111";
  const O = "0x2222222222222222222222222222222222222222";
  const CY = 1n;
  const ceiling = 105n; // gate ceiling sized from a small max_tokens; reserved by admit()
  const locked = 105n; // on-chain collectible this cycle (remaining == locked >= ceiling)
  const window = 100_000n;
  const uncapped = 236n; // reasoning model priced this — above the gated ceiling

  // WITH the cap (the fix): settleServed books only the gated ceiling as `served`,
  // so outstanding never exceeds what admit reserved (or the on-chain reservation).
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

  // WITHOUT the cap (the #421 bug): booking the uncapped 236 as `served` releases
  // only the 105 ceiling from inflight, so outstanding balloons to 236 — past both
  // the gated ceiling and the on-chain collectible `locked`. This is exactly the
  // over-count the cap prevents; asserting it fails-open here guards the regression.
  const noCap = new VaultCreditLedger();
  noCap.syncOnchain(C, O, CY, 0n, locked);
  assert.equal(noCap.admit(C, O, CY, ceiling, window).ok, true);
  noCap.settleServed(C, O, CY, ceiling, uncapped);
  const outstandingUncapped = noCap.outstandingFor(C, O);
  assert.equal(outstandingUncapped, 236n);
  assert.ok(outstandingUncapped > locked, "uncapped: outstanding exceeds on-chain locked (the bug)");
});
