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
  assert.equal(core.withReservationMargin(100n), 120n);
  assert.equal(core.withReservationMargin(1n), 2n);
  assert.throws(() => core.priceTokens(Infinity, 1), /finite non-negative/);
  assert.throws(() => core.priceTokens(1e-13, 1_000_000), /rounds to 0/);
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
  // No key set yet → the next deposit registers one; not a problem.
  assert.equal(core.classifySessionKey(core.ZERO_ADDRESS, wallet), "unregistered");
  assert.equal(core.classifySessionKey("", wallet), "unregistered");
  // Registered key IS the signer, case-insensitively → receipts redeem.
  assert.equal(core.classifySessionKey(wallet.toLowerCase(), wallet), "match");
  assert.equal(core.classifySessionKey(wallet, wallet.toLowerCase()), "match");
  // A DIFFERENT key is registered (e.g. the browser sub-wallet on a CLI wallet)
  // → every receipt this signer produces reverts BadSignature.
  assert.equal(
    core.classifySessionKey("0x00000000000000000000000000000000000000ff", wallet),
    "mismatch"
  );
});

test("session sub-wallet derivation is pinned and deterministic (#426 cross-surface)", async () => {
  // The message is a CROSS-SURFACE CONTRACT with the browser (frontend/src/lib/
  // subKey.ts). Pin it byte-for-byte so a change that would strand funds / desync
  // the CLI's browser mode fails loudly here.
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

  // Deterministic: the same wallet reproduces the same sub-wallet; a different
  // wallet derives a different one. This is what lets the CLI (`--session-key
  // browser`) and the browser share one session key.
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
  // Operator streams the settlement frame but mislabels/omits content-type — the
  // scan must not depend on the operator-controlled header (invariant #3).
  for (const ct of ["application/json", "text/plain", ""]) {
    const headers = new Headers(ct ? { "content-type": ct } : {});
    const parsed = core.parseVaultSettlement(headers, body);
    assert.equal(parsed.present, true, `content-type=${JSON.stringify(ct)}`);
    assert.equal(parsed.amount, 12345n);
  }
  // Correctly-labeled SSE still honored.
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
  const price = 1000; // USD per Mtok
  // 1) explicit settlement wins even under a generic content-type.
  const s = core.meterVaultResponse(
    new Headers({ "content-type": "application/json" }),
    settlementFrame("777"),
    price
  );
  assert.deepEqual(s, { cost: 777n, settled: true, metered: true });
  // 2) no settlement → meter from reported body usage (invariant #4: real work is paid).
  const u = core.meterVaultResponse(
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({ usage: { total_tokens: 1000 } }),
    price
  );
  assert.equal(u.settled, false);
  assert.equal(u.metered, true);
  assert.equal(u.cost, core.priceTokens(price, 1000));
  assert.ok(u.cost > 0n);
  // 3) neither settlement nor usage → unmeterable, cost 0n (invariant #2: never guess).
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

// ── Reasoning-aware completion ceiling (issue #421, Fix B sizing) ─────────────

test("isReasoningModel flags reasoning families and not ordinary models", () => {
  for (const m of [
    "o1",
    "o1-preview",
    "o3-mini",
    "openai/o4-mini",
    "o5",
    "o6", // open-ended digit range — future o-series still match
    "o10",
    "o3:latest", // Ollama/OpenRouter tag suffix
    "o1_mini", // underscore-delimited variant
    "gpt-5",
    "gpt-5-mini",
    "gemini-2.5-flash", // reasons by default (no suffix)
    "google/gemini-2.5-pro",
    "grok-4", // real xAI reasoning flagship id
    "x-ai/grok-4",
    "grok-3-mini-beta", // real xAI reasoning id
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
    "o200k-tokenizer", // 'o2' then digits then non-boundary — must NOT match
    "claude-sonnet-4-6", // Claude extended-thinking is opt-in + stripped → not sized here
    "gemini-1.5-pro",
    "grok-3", // non-mini grok-3 does not reason by default
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
  // honors an explicit (larger) max_completion_tokens
  assert.equal(core.completionCeilingTokens("gpt-4o", 16, 4096), 4096);
});

test("completionCeilingTokens floors reasoning models to the reasoning headroom", () => {
  // the #421 repro: max_tokens:16 on a reasoning model → floored, not 16
  assert.equal(core.completionCeilingTokens("o3-mini", 16), core.REASONING_COMPLETION_FLOOR);
  assert.equal(
    core.completionCeilingTokens("deepseek-r1", 100),
    core.REASONING_COMPLETION_FLOOR
  );
  // a caller who already asks for MORE than the floor keeps their larger budget
  const big = core.REASONING_COMPLETION_FLOOR + 5000;
  assert.equal(core.completionCeilingTokens("o3-mini", big), big);
  assert.equal(core.completionCeilingTokens("o3-mini", 16, big), big);
});

test("completionCeilingTokens is defensive on non-finite / non-positive budgets", () => {
  assert.equal(core.completionCeilingTokens("gpt-4o", NaN), 0);
  assert.equal(core.completionCeilingTokens("gpt-4o", -5), 0);
  // reasoning model with a garbage budget still gets the floor
  assert.equal(core.completionCeilingTokens("o3-mini", NaN), core.REASONING_COMPLETION_FLOOR);
});

test("REASONING_COMPLETION_FLOOR is a fixed positive integer (consumer/operator must agree)", () => {
  assert.equal(typeof core.REASONING_COMPLETION_FLOOR, "number");
  assert.ok(Number.isInteger(core.REASONING_COMPLETION_FLOOR));
  assert.ok(core.REASONING_COMPLETION_FLOOR > 0);
});

test("classifyReservationRevival gates zombie top-ups on the lifetime cap (#473)", () => {
  const TTL = 604800n; // 7d maxReserveTtl (dev)
  const GRACE = 21600n; // 6h redeemGrace (dev)
  const now = 10_000_000n;
  // No funds locked → nothing to strand; take the normal reserve path.
  assert.equal(
    core.classifyReservationRevival({ locked: 0n, expiry: 0n, created: 0n }, TTL, GRACE, now),
    "live_or_revivable"
  );
  // Expired but cap still in the future → a top-up extends expiry, so revivable.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 10n, created: now - 100n },
      TTL,
      GRACE,
      now
    ),
    "live_or_revivable"
  );
  // Lifetime cap in the past, still within expiry+grace → wedged (can't revive, can't reclaim).
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 100n, created: now - TTL - 100n },
      TTL,
      GRACE,
      now
    ),
    "wedged"
  );
  // Lifetime cap in the past AND past expiry+grace → reclaimable.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - GRACE - 100n, created: now - TTL - GRACE - 100n },
      TTL,
      GRACE,
      now
    ),
    "reclaimable"
  );
  // Never-topped reservation older than the cap but expiry far in the past:
  // expiry < cap < now still strands (cap can't push expiry past now).
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - TTL, created: now - TTL, },
      TTL,
      GRACE,
      now
    ),
    "reclaimable"
  );
  // #481 review: expired AND reclaim-eligible, but the lifetime cap is still
  // comfortably in the FUTURE → prefer a plain top-up (revive), NOT reclaim.
  // `releaseExpired` can transiently revert (GracePeriodNotOver, sequencer gate)
  // even past expiry+grace, so we must not force the fragile reclaim path when a
  // robust revive is available.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - GRACE - 50n, created: now - GRACE - 50n },
      TTL, // cap = created + TTL is far in the future
      GRACE,
      now,
      120n
    ),
    "live_or_revivable"
  );
  // Reclaim IS preferred when past grace AND the cap is too close to safely
  // revive (a top-up would race the cap): expiry past grace, cap inside margin.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - GRACE - 50n, created: now - TTL + 60n }, // cap = now + 60
      TTL,
      GRACE,
      now,
      120n // margin 120 > 60 headroom → revive unsafe → reclaim
    ),
    "reclaimable"
  );
  // Expired within grace, cap comfortably in the future → revivable by top-up.
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
  // Expired within grace, but the cap is INSIDE the safety margin → a top-up
  // could mine after the cap and strand the funds, and reclaim isn't available
  // yet → wedged.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now - 10n, created: now - TTL + 60n }, // cap = now + 60
      TTL,
      GRACE,
      now,
      120n // margin 120 > 60 headroom
    ),
    "wedged"
  );
  // #481 review (near-expiry): NOT yet expired but inside the refresh margin AND
  // sitting at its lifetime cap (cap == expiry, within the margin). A refresh
  // top-up can't move expiry → don't submit a dead top-up; keep serving as-is.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now + 60n, created: now + 60n - TTL }, // live; cap = now + 60
      TTL,
      GRACE,
      now,
      120n // margin 120 > 60 headroom → cap can't extend expiry
    ),
    "serve_as_is"
  );
  // Near-expiry but the cap is far ahead → a refresh top-up DOES extend expiry.
  assert.equal(
    core.classifyReservationRevival(
      { locked: 100n, expiry: now + 60n, created: now }, // live; cap = now + TTL (far)
      TTL,
      GRACE,
      now,
      120n
    ),
    "live_or_revivable"
  );
});
