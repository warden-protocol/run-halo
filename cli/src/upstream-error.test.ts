import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUpstreamProviderError,
  normalizeUpstreamError,
} from "./upstream-error";

test("maps upstream 402 credit exhaustion to a structured 502 without leaking provider text", () => {
  const raw = {
    error: {
      message: "Credit limit exceeded. Spent: $28.00285363, Limit: $28.00. Please purchase more credits.",
      type: "insufficient_quota",
    },
  };

  const normalized = normalizeUpstreamError(raw, 402);

  assert.equal(normalized.status, 502);
  assert.deepEqual(normalized.data, {
    error: {
      message: "The selected operator's upstream provider account cannot serve this request right now.",
      type: "upstream_provider_error",
      code: "credit_exhausted",
    },
  });
  assert.doesNotMatch(JSON.stringify(normalized.data), /Spent: \$28/i);
});

test("maps upstream auth failures to operator_auth_failure", () => {
  assert.equal(classifyUpstreamProviderError(401, { error: { message: "bad key" } }), "operator_auth_failure");
  assert.equal(classifyUpstreamProviderError(403, { error: { message: "forbidden" } }), "operator_auth_failure");
});

test("splits credit-class 429 from other provider throttling", () => {
  assert.equal(
    classifyUpstreamProviderError(429, { error: { message: "quota exhausted; add credits" } }),
    "credit_exhausted"
  );
  assert.equal(
    classifyUpstreamProviderError(429, {
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    }),
    "provider_error"
  );
  assert.equal(
    classifyUpstreamProviderError(429, { error: { message: "too many requests" } }),
    "provider_error"
  );
});

test("maps upstream 5xx failures to provider_error", () => {
  assert.equal(classifyUpstreamProviderError(500, { error: { message: "server exploded" } }), "provider_error");
  assert.equal(classifyUpstreamProviderError(503, "maintenance"), "provider_error");
});

test("detects credit exhaustion in top-level and plain-string bodies", () => {
  assert.equal(
    classifyUpstreamProviderError(429, { message: "Your account balance is too low" }),
    "credit_exhausted"
  );
  assert.equal(
    classifyUpstreamProviderError(429, "Please purchase more credits."),
    "credit_exhausted"
  );
});

test("classifies 400 account-credit exhaustion (e.g. Anthropic) as credit_exhausted", () => {
  assert.equal(
    classifyUpstreamProviderError(400, {
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    }),
    "credit_exhausted"
  );
  assert.equal(
    classifyUpstreamProviderError(400, { error: { message: "You are out of credits." } }),
    "credit_exhausted"
  );
});

test("maps 400 credit exhaustion to a structured 502, not a leaked 400", () => {
  const normalized = normalizeUpstreamError(
    { error: { message: "Credit balance too low; purchase more credits." } },
    400
  );
  assert.equal(normalized.status, 502);
  assert.deepEqual(normalized.data, {
    error: {
      message: "The selected operator's upstream provider account cannot serve this request right now.",
      type: "upstream_provider_error",
      code: "credit_exhausted",
    },
  });
});

test("does not treat an ordinary 400 bad request as credit exhaustion", () => {
  assert.equal(
    classifyUpstreamProviderError(400, {
      error: { message: "invalid request: bad max_tokens", type: "invalid_request_error" },
    }),
    null
  );
  // A prompt that merely mentions the word "credit" must not trip the narrow 400 rule.
  assert.equal(
    classifyUpstreamProviderError(400, {
      error: { message: "The model does not support the 'credit' parameter" },
    }),
    null
  );
});

test("keeps consumer-fault upstream errors as 4xx with only safe fields", () => {
  const normalized = normalizeUpstreamError(
    {
      error: {
        message: "invalid request: bad max_tokens",
        type: "invalid_request_error",
        code: "bad_request",
        prompt: "must not leak",
      },
    },
    400
  );

  assert.equal(normalized.status, 400);
  assert.deepEqual(normalized.data, {
    error: {
      message: "invalid request: bad max_tokens",
      type: "invalid_request_error",
      code: "bad_request",
    },
  });
  assert.doesNotMatch(JSON.stringify(normalized.data), /must not leak/);
});
