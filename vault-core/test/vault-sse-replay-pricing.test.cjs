const test = require("node:test");
const assert = require("node:assert/strict");
const pricing = require("../dist/cjs/vaultSseReplayPricing.js");

function quote(overrides = {}) {
  return pricing.buildVaultSseReplayPricingQuote({
    protocol: pricing.VAULT_SSE_REPLAY_PRICING_PROTOCOL,
    model: "vendor/model",
    promptUsdPerMtok: "1.3",
    completionUsdPerMtok: "13",
    cacheReadUsdPerMtok: "0.65",
    requestUsdcBase: "250",
    fallbackUsdcBase: "10000",
    marginBps: 3000,
    issuedAtMs: 1_000,
    expiresAtMs: 601_000,
    ...overrides,
  });
}

test("request-aware replay pricing keeps asymmetric rates, request cost, and margin", () => {
  const value = quote();

  assert.equal(value.marginBps, 3000);
  assert.equal(
    pricing.priceVaultSseReplayPricingQuote(value, {
      promptTokens: 1_000,
      completionTokens: 100,
      cachedPromptTokens: 200,
    }),
    2_720n
  );
});

test("request-aware replay pricing uses its quoted fallback only for a zero component total", () => {
  const value = quote({ requestUsdcBase: "0" });

  assert.equal(
    pricing.priceVaultSseReplayPricingQuote(value, {
      promptTokens: 0,
      completionTokens: 0,
    }),
    10_000n
  );
  assert.equal(
    pricing.priceVaultSseReplayPricingQuote(value, {
      promptTokens: 1,
      completionTokens: 0,
    }),
    2n
  );
});

test("replay pricing quotes are strict, content-addressed, model-bound, and expiring", () => {
  const value = quote();
  assert.deepEqual(pricing.parseVaultSseReplayPricingQuote(value), value);
  assert.equal(
    pricing.parseVaultSseReplayPricingQuote({ ...value, completionUsdPerMtok: "12" }),
    null
  );
  assert.equal(
    pricing.parseVaultSseReplayPricingQuote({ ...value, fallbackUsdcBase: "0" }),
    null
  );
  assert.equal(
    pricing.parseVaultSseReplayPricingQuote({ ...value, extra: true }),
    null
  );
  assert.equal(
    pricing.isVaultSseReplayPricingQuoteUsable(value, "vendor/model", 600_999),
    true
  );
  assert.equal(
    pricing.isVaultSseReplayPricingQuoteUsable(value, "vendor/model", 601_000),
    false
  );
  assert.equal(
    pricing.isVaultSseReplayPricingQuoteUsable(value, "vendor/other", 2_000),
    false
  );
});
