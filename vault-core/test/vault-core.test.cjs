const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  TypedDataEncoder,
  Wallet,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} = require("ethers");
const core = require("../dist/cjs/index.js");

test("pins the current Base HaloVault deployment", () => {
  assert.equal(core.VAULT_CHAIN_ID, 8453);
  assert.equal(core.VAULT_ADDRESS, "0x3907F660B257560883E891fbbB9F997Eff70E40E");
});

test("generated EIP-712 types reproduce the Solidity type strings and hashes", () => {
  const reserveType = TypedDataEncoder.from(core.RESERVE_TYPES).encodeType("Reserve");
  const receiptType = TypedDataEncoder.from(core.RECEIPT_TYPES).encodeType("Receipt");
  assert.equal(reserveType, core.RESERVE_TYPE_STRING);
  assert.equal(receiptType, core.RECEIPT_TYPE_STRING);
  assert.equal(keccak256(toUtf8Bytes(reserveType)), keccak256(toUtf8Bytes(core.RESERVE_TYPE_STRING)));
  assert.equal(keccak256(toUtf8Bytes(receiptType)), keccak256(toUtf8Bytes(core.RECEIPT_TYPE_STRING)));
});

test("reserve signature verifies against the generated domain and types", async () => {
  const wallet = new Wallet("0x0123456789012345678901234567890123456789012345678901234567890123");
  const reserve = {
    consumer: wallet.address,
    operator: "0x1111111111111111111111111111111111111111",
    amount: 123n,
    expiry: 1_800_000_000n,
    nonce: 7n,
    keyEpoch: 2n,
  };
  const signature = await wallet.signTypedData(
    core.vaultDomain(core.VAULT_CHAIN_ID),
    core.RESERVE_TYPES,
    reserve
  );
  assert.equal(
    verifyTypedData(core.vaultDomain(core.VAULT_CHAIN_ID), core.RESERVE_TYPES, reserve, signature),
    wallet.address
  );
});

test("pricing guards, empty model ids, and refresh bump remain canonical", () => {
  assert.equal(core.priceTokens(2, 50), 100n);
  assert.equal(core.priceImages(0.02, 2), 40_000n);
  assert.equal(core.priceImages(0.02, 0), 0n);
  assert.equal(core.priceImages(0.0000001, 1), 1n);
  assert.equal(core.withReservationMargin(100n), 120n);
  assert.equal(core.withReservationMargin(1n), 2n);
  assert.throws(() => core.priceTokens(Infinity, 1), /finite non-negative/);
  assert.throws(() => core.priceTokens(1e-13, 1_000_000), /rounds to 0/);
  assert.throws(() => core.priceImages(-1, 1), /finite non-negative/);
  assert.throws(() => core.priceImages(1, -1), /finite non-negative/);
  assert.throws(() => core.priceImages(1e-13, 1), /rounds to 0/);
  assert.equal(core.matchesModel("", "gpt-4"), false);
  assert.equal(core.matchesModel("gpt-4", "gpt-4-turbo"), true);
  assert.equal(
    core.computeReserveAmount({
      estCost: 100n,
      locked: 500n,
      withdrawable: 10n,
      reserveMultiple: 5n,
      liquiditySlots: 8n,
      live: false,
    }),
    1n
  );
});

test("price resolution accepts an exact pricing key outside models and rejects non-finite values", () => {
  assert.equal(
    core.resolveModelPriceUsdPerMtok(["advertised/model"], { "requested/model": 0.002 }, "requested/model"),
    2
  );
  assert.equal(
    core.resolveModelPriceUsdPerMtok(["gpt-4"], { "gpt-4": Infinity }, "gpt-4"),
    null
  );
  assert.equal(
    core.resolveModelPriceUsdPerMtok(["gpt-4"], { "gpt-4": -0.001 }, "gpt-4"),
    null
  );
});

test("image price resolution mirrors model matching without token-rate scaling", () => {
  assert.equal(
    core.resolveImagePriceUsdc(["advertised/image"], { "requested/image": 0.04 }, "requested/image"),
    0.04
  );
  assert.equal(
    core.resolveImagePriceUsdc(["dall-e-3"], { "dall-e-3": 0.02 }, "dall-e-3-hd"),
    0.02
  );
  assert.equal(
    core.resolveImagePriceUsdc(["dall-e-3"], { "dall-e-3": 0.02 }, "gpt-4o"),
    null
  );
  assert.equal(
    core.resolveImagePriceUsdc(["dall-e-3"], { "dall-e-3": Infinity }, "dall-e-3"),
    null
  );
  assert.equal(
    core.resolveImagePriceUsdc(["dall-e-3"], { "dall-e-3": -0.001 }, "dall-e-3"),
    null
  );
  assert.equal(
    core.resolveImagePriceUsdc(["dall-e-3"], { "dall-e-3": 0.02 }, "dall-e-3"),
    0.02
  );
});

test("shared vault selection distinguishes free and legacy pinned operators", () => {
  const legacy = {
    address: "0xlegacy",
    models: ["model"],
    pricing: { model: 0.001 },
    vaultPayments: false,
  };
  const free = {
    address: "0xfree",
    models: ["model"],
    pricing: { model: 0 },
    vaultPayments: true,
  };
  assert.equal(
    core.selectVaultOperatorFromList([legacy], "model", { requireAddress: legacy.address }).reason,
    "pinned_not_vault_capable"
  );
  assert.equal(core.selectVaultOperatorFromList([free], "model").reason, "free_model");
});

test("shared image vault selection uses exact image capability and positive per-image pricing", () => {
  const legacy = {
    address: "0xlegacy",
    models: ["dall-e-3"],
    pricing: { "dall-e-3": 0.001 },
    imageModels: ["dall-e-3"],
    imagePricing: { "dall-e-3": 0.02 },
    vaultPayments: false,
  };
  const fuzzyCollision = {
    address: "0xfuzzy",
    models: ["dall-e-3"],
    pricing: { "dall-e-3": 0.001 },
    imageModels: ["dall-e-3"],
    imagePricing: { "dall-e-3": 0.01 },
    vaultPayments: true,
  };
  const expensive = {
    address: "0xexpensive",
    models: ["dall-e-3-hd"],
    pricing: { "dall-e-3-hd": 0.001 },
    imageModels: ["dall-e-3-hd"],
    imagePricing: { "dall-e-3-hd": 0.08 },
    vaultPayments: true,
  };
  const cheap = {
    address: "0xcheap",
    models: ["dall-e-3-hd"],
    pricing: { "dall-e-3-hd": 0.001 },
    imageModels: ["dall-e-3-hd"],
    imagePricing: { "dall-e-3-hd": 0.03 },
    vaultPayments: true,
  };
  const free = {
    address: "0xfree",
    models: ["image/free"],
    imageModels: ["image/free"],
    imagePricing: { "image/free": 0 },
    vaultPayments: true,
  };
  const fuzzyPriceOnly = {
    address: "0xfuzzyprice",
    models: ["dall-e-3", "dall-e-3-hd"],
    pricing: { "dall-e-3": 0.001, "dall-e-3-hd": 0.001 },
    imageModels: ["dall-e-3", "dall-e-3-hd"],
    imagePricing: { "dall-e-3": 0.01 },
    vaultPayments: true,
  };

  assert.equal(
    core.selectVaultImageOperatorFromList([legacy], "dall-e-3").reason,
    "no_vault_operator"
  );
  assert.equal(
    core.selectVaultImageOperatorFromList([fuzzyCollision], "dall-e-3-hd").reason,
    "no_operator"
  );
  assert.equal(
    core.selectVaultImageOperatorFromList([fuzzyPriceOnly], "dall-e-3-hd").reason,
    "unpriced"
  );
  const selected = core.selectVaultImageOperatorFromList(
    [expensive, cheap, fuzzyCollision],
    "dall-e-3-hd"
  );
  assert.equal(selected.reason, "selected");
  assert.equal(selected.selected.operator.address, "0xcheap");
  assert.equal(selected.selected.priceUsdcPerImage, 0.03);
  assert.equal(core.selectVaultImageOperatorFromList([free], "image/free").reason, "free_model");
});

test("cumulative receipt advancement keeps the high-water ceiling monotonic", () => {
  const first = core.advanceCumulativeReceipt({
    previous: 0n,
    cost: 1_500n,
    locked: 2_000n,
    redeemed: 0n,
  });
  assert.deepEqual(first, { cumulative: 1_500n, ceiling: 2_000n });
  const stale = core.advanceCumulativeReceipt({
    previous: first.cumulative,
    cost: 600n,
    locked: 1_000n,
    redeemed: 0n,
    priorCeiling: first.ceiling,
  });
  assert.deepEqual(stale, { cumulative: 2_000n, ceiling: 2_000n });
});

test("classifySessionKey distinguishes unregistered, match, and mismatch (#426)", () => {
  const wallet = "0x00000000000000000000000000000000000000A0";
  assert.equal(core.classifySessionKey(core.ZERO_ADDRESS, wallet), "unregistered");
  assert.equal(core.classifySessionKey("", wallet), "unregistered");
  assert.equal(core.classifySessionKey(wallet.toLowerCase(), wallet), "match");
  assert.equal(core.classifySessionKey(wallet, wallet.toLowerCase()), "match");
  assert.equal(
    core.classifySessionKey("0x00000000000000000000000000000000000000ff", wallet),
    "mismatch"
  );
});

test("session sub-wallet derivation is pinned and deterministic (#426 cross-surface)", async () => {
  assert.equal(
    core.SUBKEY_DERIVATION_MESSAGE,
    "Halo — create in-browser agent sub-wallet (v2).\n" +
      "Signing derives a wallet the agent uses to pay for tools autonomously.\n" +
      "The agent can ONLY spend USDC you load into this sub-wallet."
  );
  const owner = "0xAbC0000000000000000000000000000000000001";
  assert.equal(
    core.subKeyDerivationMessage(owner),
    core.SUBKEY_DERIVATION_MESSAGE + "\n" + owner.toLowerCase()
  );

  const main = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const sigA = await main.signMessage(core.subKeyDerivationMessage(main.address));
  const sigB = await main.signMessage(core.subKeyDerivationMessage(main.address));
  assert.equal(core.deriveSubKeyPrivateKey(sigA), core.deriveSubKeyPrivateKey(sigB));
  const sub = new Wallet(core.deriveSubKeyPrivateKey(sigA));

  const other = new Wallet("0x0123456789012345678901234567890123456789012345678901234567890123");
  const otherSub = new Wallet(
    core.deriveSubKeyPrivateKey(await other.signMessage(core.subKeyDerivationMessage(other.address)))
  );
  assert.notEqual(sub.address, otherSub.address);
});

test("reservation-insufficient parsing accepts only the typed positive decimal requirement", () => {
  const body = {
    error: {
      type: "vault_reservation_insufficient",
      requiredUsdcBase: "1234",
    },
  };
  assert.equal(core.requiredVaultReservationBase(body), 1234n);
  assert.equal(core.requiredVaultReservationBase(JSON.stringify(body)), 1234n);
  assert.equal(
    core.requiredVaultReservationBase({
      error: { type: "vault_reservation_insufficient", requiredUsdcBase: "-1" },
    }),
    null
  );
  assert.equal(
    core.requiredVaultReservationBase({
      error: { type: "other", requiredUsdcBase: "1234" },
    }),
    null
  );
  assert.equal(core.requiredVaultReservationBase("not json"), null);
});

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const settlementFrame = (amountUsdc) =>
  `event: halo-settlement\ndata: ${JSON.stringify({ paymentResponse: b64({ amountUsdc }) })}\n\n`;

test("parseVaultSettlement finds a body settlement frame regardless of content-type (F2/#3)", () => {
  const body = settlementFrame("12345");
  for (const ct of ["application/json", "text/plain", ""]) {
    const headers = new Headers(ct ? { "content-type": ct } : {});
    const parsed = core.parseVaultSettlement(headers, body);
    assert.equal(parsed.present, true, `content-type=${JSON.stringify(ct)}`);
    assert.equal(parsed.amount, 12345n);
  }
  const sse = core.parseVaultSettlement(new Headers({ "content-type": "text/event-stream" }), body);
  assert.equal(sse.present, true);
  assert.equal(sse.amount, 12345n);
});

test("parseVaultSettlement prefers the PAYMENT-RESPONSE header, and reports absent when neither present", () => {
  const withHeader = core.parseVaultSettlement(new Headers({ "PAYMENT-RESPONSE": b64({ amountUsdc: "500" }) }), "");
  assert.equal(withHeader.present, true);
  assert.equal(withHeader.amount, 500n);
  const none = core.parseVaultSettlement(
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({ usage: { total_tokens: 10 } })
  );
  assert.equal(none.present, false);
  assert.equal(none.amount, 0n);
});

test("usageTokensFromBody reads JSON usage and SSE trailing usage alike (F1)", () => {
  assert.equal(core.usageTokensFromBody(JSON.stringify({ usage: { total_tokens: 42 } })), 42);
  assert.equal(
    core.usageTokensFromBody(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 7 } })),
    12
  );
  const sse = `data: ${JSON.stringify({ choices: [] })}\n\ndata: ${JSON.stringify({ usage: { total_tokens: 9 } })}\n\ndata: [DONE]\n\n`;
  assert.equal(core.usageTokensFromBody(sse), 9);
  assert.equal(core.usageTokensFromBody(JSON.stringify({ choices: [] })), undefined);
  assert.equal(core.usageTokensFromBody("neither json nor frames"), undefined);
});

test("meterVaultResponse: settlement > body usage > unmeterable, content-type independent (F1/F2/#4)", () => {
  const price = 1000;
  const s = core.meterVaultResponse(
    new Headers({ "content-type": "application/json" }),
    settlementFrame("777"),
    price
  );
  assert.deepEqual(s, { cost: 777n, settled: true, metered: true });
  const u = core.meterVaultResponse(
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({ usage: { total_tokens: 1000 } }),
    price
  );
  assert.equal(u.settled, false);
  assert.equal(u.metered, true);
  assert.equal(u.cost, core.priceTokens(price, 1000));
  assert.ok(u.cost > 0n);
  const none = core.meterVaultResponse(
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({ choices: [] }),
    price
  );
  assert.deepEqual(none, { cost: 0n, settled: false, metered: false });
});

test("formatUsdcBase renders 6-dp base units with an optional $ (F10)", () => {
  assert.equal(core.formatUsdcBase(0n), "0.0000");
  assert.equal(core.formatUsdcBase(1_000_000n), "1.0000");
  assert.equal(core.formatUsdcBase(1_234_500n), "1.2345");
  assert.equal(core.formatUsdcBase(1_000_000n, { withDollarSign: true }), "$1.0000");
  assert.equal(core.formatUsdcBase(1_234_500n, { withDollarSign: true }), "$1.2345");
});

test("vaultDomain verifyingContract defaults to the pin but accepts an override (F3)", () => {
  const pinned = core.vaultDomain(8453);
  assert.equal(pinned.verifyingContract, core.VAULT_ADDRESS);
  const custom = "0x000000000000000000000000000000000000dEaD";
  const overridden = core.vaultDomain(8453, custom);
  assert.equal(overridden.verifyingContract, custom);
  assert.equal(overridden.name, pinned.name);
  assert.equal(overridden.version, pinned.version);
  assert.equal(overridden.chainId, 8453);
});

test("MAX_VAULT_RESERVATION_ATTEMPTS is a bounded positive integer (F6)", () => {
  assert.equal(typeof core.MAX_VAULT_RESERVATION_ATTEMPTS, "number");
  assert.ok(Number.isInteger(core.MAX_VAULT_RESERVATION_ATTEMPTS));
  assert.ok(core.MAX_VAULT_RESERVATION_ATTEMPTS >= 2 && core.MAX_VAULT_RESERVATION_ATTEMPTS <= 10);
});

test("isReasoningModel flags reasoning families and not ordinary models", () => {
  for (const m of [
    "o1",
    "o1-preview",
    "o3-mini",
    "openai/o4-mini",
    "o5",
    "o6",
    "o10",
    "o3:latest",
    "o1_mini",
    "gpt-5",
    "gpt-5-mini",
    "gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "grok-4",
    "x-ai/grok-4",
    "grok-3-mini-beta",
    "deepseek-r1",
    "deepseek/deepseek-r1-distill-qwen-32b",
    "magistral-small",
    "qwen/qwq-32b",
    "qwen3-235b-a22b-thinking",
    "some-reasoner",
  ]) {
    assert.equal(core.isReasoningModel(m), true, `expected reasoning: ${m}`);
  }
  for (const m of [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "o200k-tokenizer",
    "claude-sonnet-4-6",
    "gemini-1.5-pro",
    "grok-3",
    "llama-3.3-70b",
    "qwen2.5-72b",
    "mixtral-8x7b",
    "",
  ]) {
    assert.equal(core.isReasoningModel(m), false, `expected non-reasoning: ${m}`);
  }
});

test("completionCeilingTokens leaves ordinary models at their max_tokens budget", () => {
  assert.equal(core.completionCeilingTokens("gpt-4o", 16), 16);
  assert.equal(core.completionCeilingTokens("gpt-4o", 1024), 1024);
  assert.equal(core.completionCeilingTokens("gpt-4o", 16, 4096), 4096);
});

test("completionCeilingTokens floors reasoning models to the reasoning headroom", () => {
  assert.equal(core.completionCeilingTokens("o3-mini", 16), core.REASONING_COMPLETION_FLOOR);
  assert.equal(
    core.completionCeilingTokens("deepseek-r1", 100),
    core.REASONING_COMPLETION_FLOOR
  );
  const big = core.REASONING_COMPLETION_FLOOR + 5000;
  assert.equal(core.completionCeilingTokens("o3-mini", big), big);
  assert.equal(core.completionCeilingTokens("o3-mini", 16, big), big);
});

test("completionCeilingTokens is defensive on non-finite / non-positive budgets", () => {
  assert.equal(core.completionCeilingTokens("gpt-4o", NaN), 0);
  assert.equal(core.completionCeilingTokens("gpt-4o", -5), 0);
  assert.equal(core.completionCeilingTokens("o3-mini", NaN), core.REASONING_COMPLETION_FLOOR);
});

test("REASONING_COMPLETION_FLOOR is a fixed positive integer (consumer/operator must agree)", () => {
  assert.equal(typeof core.REASONING_COMPLETION_FLOOR, "number");
  assert.ok(Number.isInteger(core.REASONING_COMPLETION_FLOOR));
  assert.ok(core.REASONING_COMPLETION_FLOOR > 0);
});

test("classifyReservationRevival gates zombie top-ups on the lifetime cap (#473)", () => {
  const TTL = 604800n;
  const GRACE = 21600n;
  const now = 10_000_000n;
  assert.equal(
    core.classifyReservationRevival({ locked: 0n, expiry: 0n, created: 0n }, TTL, GRACE, now),
    "live_or_revivable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 10n, created: now - 100n },
      TTL,
      GRACE,
      now
    ),
    "live_or_revivable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 100n, created: now - TTL - 100n },
      TTL,
      GRACE,
      now
    ),
    "wedged"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - GRACE - 100n, created: now - TTL - GRACE - 100n },
      TTL,
      GRACE,
      now
    ),
    "reclaimable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - TTL, created: now - TTL, },
      TTL,
      GRACE,
      now
    ),
    "reclaimable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - GRACE - 50n, created: now - GRACE - 50n },
      TTL,
      GRACE,
      now,
      120n
    ),
    "live_or_revivable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - GRACE - 50n, created: now - TTL + 60n },
      TTL,
      GRACE,
      now,
      120n
    ),
    "reclaimable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 10n, created: now - 10n },
      TTL,
      GRACE,
      now,
      120n
    ),
    "live_or_revivable"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 10n, created: now - TTL + 60n },
      TTL,
      GRACE,
      now,
      120n
    ),
    "wedged"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now + 60n, created: now + 60n - TTL },
      TTL,
      GRACE,
      now,
      120n
    ),
    "serve_as_is"
  );
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now + 60n, created: now },
      TTL,
      GRACE,
      now,
      120n
    ),
    "live_or_revivable"
  );
});
