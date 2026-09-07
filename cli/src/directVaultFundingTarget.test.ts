import test from "node:test";
import assert from "node:assert/strict";
import { directVaultFundingTargetBase } from "./commands/consume";
import { WalletAccessError } from "./wallet-access/domain/walletAccess";

test("Privy vault target accepts disabled and exactly representable positive amounts", () => {
  assert.equal(directVaultFundingTargetBase(undefined), null);
  assert.equal(directVaultFundingTargetBase(0), null);
  assert.equal(directVaultFundingTargetBase(2.5), 2_500_000n);
  assert.equal(directVaultFundingTargetBase(0.000001), 1n);
});

test("Privy vault target rejects invalid values before RPC or signing", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.0000001, Number.MAX_VALUE]) {
    assert.throws(
      () => directVaultFundingTargetBase(value),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_direct_funding_insufficient"
    );
  }
});
