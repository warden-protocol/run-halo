const assert = require("node:assert/strict");
const { test } = require("node:test");
const { classifyRedeemError } = require("../dist/cjs/index.js");

test("classifyRedeemError: already-collected reverts terminate the retry", () => {
  for (const e of [
    "execution reverted: StaleReceipt",
    "ExceedsReservation()",
    "vault submit failed: already redeemed",
    "already collected",
    "receipt already settled",
  ]) {
    assert.equal(classifyRedeemError(e), "collected", e);
  }
});

test("classifyRedeemError: permanently-unredeemable receipts are abandoned", () => {
  for (const e of [
    "execution reverted: BadSignature",
    "NoSessionKey()",
    "signature does not recover to the session key",
    "vault receipt for cycle 1 superseded on-chain by cycle 2",
  ]) {
    assert.equal(classifyRedeemError(e), "uncollectable", e);
  }
});

test("classifyRedeemError: genuinely transient errors are retried", () => {
  for (const e of [
    "fetch failed",
    "timeout",
    "HTTP 502",
    "connection reset",
  ]) {
    assert.equal(classifyRedeemError(e), "transient", e);
  }
});
