const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseVaultRedeemResponse,
  vaultRedeemDisposition,
} = require("../dist/cjs/index.js");

const TX = `0x${"a".repeat(64)}`;

test("parseVaultRedeemResponse accepts every cycle-aware response variant", () => {
  const variants = [
    { status: "rejected", reason: "invalid-receipt", error: "bad receipt" },
    {
      status: "pending",
      transaction: TX,
      cumulative: "20",
      cycle: "3",
      coalesced: true,
    },
    { status: "already-redeemed", redeemed: "20", cycle: "3" },
    { status: "confirmed", transaction: TX, cumulative: "20", cycle: "3" },
    { status: "reverted", transaction: TX, cumulative: "20", cycle: "3" },
  ];
  for (const variant of variants) {
    assert.deepEqual(parseVaultRedeemResponse(variant), variant);
  }
});

test("parseVaultRedeemResponse rejects legacy, incomplete, and unbounded shapes", () => {
  const invalid = [
    { hash: TX },
    { status: "already-redeemed", redeemed: "20" },
    { status: "pending", transaction: TX, cumulative: "20", cycle: "3" },
    { status: "pending", transaction: "0xshort", cumulative: "20", cycle: "3", coalesced: false },
    { status: "confirmed", transaction: TX, cumulative: "-1", cycle: "3" },
    { status: "confirmed", transaction: TX, cumulative: "1".repeat(79), cycle: "3" },
    { status: "rejected", reason: "rpc-url-as-label", error: "no" },
    { status: "future-status" },
  ];
  for (const value of invalid) assert.equal(parseVaultRedeemResponse(value), null);
});

test("vaultRedeemDisposition clears only canonical success or uncollectable receipts", () => {
  const expected = { cumulative: "20", cycle: "3" };
  assert.equal(
    vaultRedeemDisposition(
      { status: "already-redeemed", redeemed: "20", cycle: "3" },
      expected
    ),
    "collected"
  );
  assert.equal(
    vaultRedeemDisposition(
      { status: "confirmed", transaction: TX, cumulative: "20", cycle: "3" },
      expected
    ),
    "collected"
  );
  assert.equal(
    vaultRedeemDisposition({
      status: "pending",
      transaction: TX,
      cumulative: "20",
      cycle: "3",
      coalesced: false,
    }),
    "retry"
  );
  assert.equal(
    vaultRedeemDisposition({ status: "reverted", transaction: TX, cumulative: "20", cycle: "3" }),
    "retry"
  );
  for (const reason of ["cycle-mismatch", "invalid-receipt"]) {
    assert.equal(
      vaultRedeemDisposition({ status: "rejected", reason, error: "bad" }, expected),
      "uncollectable"
    );
  }
  for (const reason of ["invalid-request", "unavailable"]) {
    assert.equal(
      vaultRedeemDisposition({ status: "rejected", reason, error: "retry" }, expected),
      "retry"
    );
  }
  assert.equal(
    vaultRedeemDisposition(
      {
        status: "rejected",
        reason: "unavailable",
        error: "receipt cycle 4 is ahead of current cycle 3; retry after vault state catches up",
      },
      { cumulative: "20", cycle: "4" }
    ),
    "retry",
    "a request cycle ahead of a lagging facilitator view remains collectible"
  );
  assert.equal(
    vaultRedeemDisposition(
      { status: "confirmed", transaction: TX, cumulative: "20", cycle: "4" },
      expected
    ),
    "retry",
    "a terminal response from another cycle cannot clear this receipt"
  );
  assert.equal(
    vaultRedeemDisposition(
      { status: "already-redeemed", redeemed: "19", cycle: "3" },
      expected
    ),
    "retry",
    "canonical coverage below the submitted cumulative is not terminal"
  );
});
