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

test("maps every upstream 401 to operator_auth_failure", () => {
  assert.equal(classifyUpstreamProviderError(401, { error: { message: "bad key" } }), "operator_auth_failure");
});

test("maps only explicit account credential failures on 403 to operator_auth_failure", () => {
  const bodies = [
    { error: { message: "Invalid API key" } },
    { error: { message: "The API key has been revoked." } },
    { error: { message: "Authentication failed for the supplied credentials." } },
    { error: { code: "invalid-api-key" } },
  ];

  for (const body of bodies) {
    assert.equal(classifyUpstreamProviderError(403, body), "operator_auth_failure");
  }
});

test("maps an OpenRouter regional 403 to a request-scoped provider_error", () => {
  const raw = {
    error: {
      message: "Provider returned error",
      code: 403,
      metadata: {
        raw:
          "sakana/sakana-namazu is not available in your region: " +
          "Sakana AI blocks requests originating from your location.",
        provider_name: "Sakana AI",
      },
    },
  };

  assert.equal(classifyUpstreamProviderError(403, raw), "provider_error");
  const normalized = normalizeUpstreamError(raw, 403);
  assert.equal(normalized.status, 502);
  assert.deepEqual(normalized.data, {
    error: {
      message: "The selected operator's upstream provider is temporarily unavailable.",
      type: "upstream_provider_error",
      code: "provider_error",
    },
  });
  assert.doesNotMatch(JSON.stringify(normalized.data), /sakana|region|location/i);
});

test("keeps model, moderation, and ambiguous 403 failures request-scoped", () => {
  const bodies = [
    { error: { message: "forbidden" } },
    { error: { message: "This API key does not have access to the selected model." } },
    { error: { message: "This API key is disabled for the selected model by regional policy." } },
    {
      error: {
        message: "Provider returned error",
        metadata: {
          raw: "Request blocked by moderation because the prompt said purchase more credits.",
        },
      },
    },
    { error: { metadata: { raw: "Authentication failed for the supplied credentials." } } },
    { error: { metadata: { raw: "Your account balance is too low." } } },
    {
      error: {
        message: "The selected model is unavailable in this region.",
        code: "invalid_api_key",
      },
    },
    { error: { code: "unauthorized" } },
    { error: { type: "auth_error" } },
    { error: { code: "billing_error" } },
  ];

  for (const body of bodies) {
    assert.equal(classifyUpstreamProviderError(403, body), "provider_error");
  }
});

test("keeps explicit account-credit 403 failures sticky", () => {
  const bodies = [
    { error: { message: "Your account balance is too low." } },
    { error: { code: "insufficient_quota" } },
  ];

  for (const body of bodies) {
    assert.equal(classifyUpstreamProviderError(403, body), "credit_exhausted");
  }
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
