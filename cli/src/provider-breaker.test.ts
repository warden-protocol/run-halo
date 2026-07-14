import test from "node:test";
import assert from "node:assert/strict";
import {
  _resetBreakersForTest,
  breakerCode,
  clearBreaker,
  isBreakerOpen,
  isStickyUpstreamCode,
  openBreakerSlugs,
  setBreakerChangeHandler,
  tripBreaker,
} from "./provider-breaker";

test.beforeEach(() => _resetBreakersForTest());

test("only credit/auth codes are sticky enough to trip", () => {
  assert.equal(isStickyUpstreamCode("credit_exhausted"), true);
  assert.equal(isStickyUpstreamCode("operator_auth_failure"), true);
  assert.equal(isStickyUpstreamCode("provider_error"), false);
  assert.equal(isStickyUpstreamCode(null), false);
  assert.equal(isStickyUpstreamCode(undefined), false);
});

test("tripping a credit-class fault opens the breaker and records the code", () => {
  assert.equal(isBreakerOpen("openrouter"), false);
  assert.equal(tripBreaker("openrouter", "credit_exhausted"), true);
  assert.equal(isBreakerOpen("openrouter"), true);
  assert.equal(breakerCode("openrouter"), "credit_exhausted");
  assert.deepEqual(openBreakerSlugs(), ["openrouter"]);
});

test("transient/unknown codes never trip the breaker", () => {
  assert.equal(tripBreaker("openrouter", "provider_error"), false);
  assert.equal(tripBreaker("openrouter", null), false);
  assert.equal(isBreakerOpen("openrouter"), false);
  assert.deepEqual(openBreakerSlugs(), []);
});

test("re-tripping an open breaker is a no-op that keeps the first reason", () => {
  assert.equal(tripBreaker("openrouter", "credit_exhausted", 1000), true);
  assert.equal(tripBreaker("openrouter", "operator_auth_failure", 2000), false);
  assert.equal(breakerCode("openrouter"), "credit_exhausted");
});

test("clearing an open breaker closes it; clearing a closed one is a no-op", () => {
  tripBreaker("near", "operator_auth_failure");
  assert.equal(clearBreaker("near"), true);
  assert.equal(isBreakerOpen("near"), false);
  assert.equal(breakerCode("near"), null);
  assert.equal(clearBreaker("near"), false);
});

test("breakers are tracked independently per provider slug", () => {
  tripBreaker("openrouter", "credit_exhausted");
  tripBreaker("near", "operator_auth_failure");
  assert.deepEqual(openBreakerSlugs().sort(), ["near", "openrouter"]);
  clearBreaker("openrouter");
  assert.deepEqual(openBreakerSlugs(), ["near"]);
});

test("the change hook fires on the open transition and on close, not on repeats", () => {
  let changes = 0;
  setBreakerChangeHandler(() => {
    changes += 1;
  });
  tripBreaker("openrouter", "credit_exhausted");
  tripBreaker("openrouter", "credit_exhausted");
  tripBreaker("openrouter", "provider_error");
  clearBreaker("openrouter");
  clearBreaker("openrouter");
  assert.equal(changes, 2);
});
