const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HaloVaultClient,
  VAULT_ADDRESS,
  classifyRedeemError,
  computeReserveAmount,
  payInference,
  parseVaultSettlement,
  priceTokens,
  reportedUsageTokens,
  selectVaultOperator,
  usageTokensFromSseBody,
} = require("../dist/vault");

test("pins the current production vault", () => {
  assert.equal(VAULT_ADDRESS, "0x3907F660B257560883E891fbbB9F997Eff70E40E");
});

test("reservation batching preserves liquidity slots but still covers the request", () => {
  assert.equal(
    computeReserveAmount({
      estCost: 100n,
      locked: 0n,
      withdrawable: 8_000n,
      reserveMultiple: 50n,
      liquiditySlots: 8n,
      live: true,
    }),
    1_000n
  );
  assert.equal(
    computeReserveAmount({
      estCost: 2_000n,
      locked: 0n,
      withdrawable: 8_000n,
      reserveMultiple: 5n,
      liquiditySlots: 8n,
      live: true,
    }),
    2_000n
  );
});

test("parses streamed settlement from the trailing SSE event", () => {
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "321" })).toString("base64");
  const body = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    "",
    "event: halo-settlement",
    `data: ${JSON.stringify({ status: 200, paymentResponse })}`,
    "",
  ].join("\n");
  const headers = new Headers({ "content-type": "text/event-stream; charset=utf-8" });
  assert.deepEqual(parseVaultSettlement(headers, body), { present: true, amount: 321n });
});

test("uses the buffered settlement header before SSE fallback", () => {
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "42" })).toString("base64");
  const headers = new Headers({ "PAYMENT-RESPONSE": paymentResponse });
  assert.deepEqual(parseVaultSettlement(headers, ""), { present: true, amount: 42n });
});

test("distinguishes an authoritative zero settlement from an absent settlement", () => {
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "0" })).toString("base64");
  const explicitZero = parseVaultSettlement(
    new Headers({ "PAYMENT-RESPONSE": paymentResponse }),
    ""
  );
  assert.deepEqual(explicitZero, { present: true, amount: 0n });
  assert.deepEqual(parseVaultSettlement(new Headers(), ""), {
    present: false,
    amount: 0n,
  });
});

test("payInference marks a settled SSE response paid and queues its redeem", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000009";
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "77" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: operator,
              models: ["model"],
              pricing: { model: 0.001 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
        `event: halo-settlement\ndata: ${JSON.stringify({ paymentResponse })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
  let redeemed;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000010",
    recordAndRedeem: (address, _ops, _epoch, cost) => {
      redeemed = { address, cost };
      return Promise.resolve();
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [{ role: "user", content: "hello" }] },
    client,
  });
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "77");
  assert.deepEqual(redeemed, { address: operator, cost: 77n });
});

test("payInference re-reserves from a typed insufficient-reservation 402 and retries once", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000021";
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "91" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: operator,
              models: ["model"],
              pricing: { model: 0.001 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (calls === 2) {
      return new Response(
        JSON.stringify({
          error: {
            type: "vault_reservation_insufficient",
            requiredUsdcBase: "5000",
          },
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      );
    }
    return new Response('{"choices":[]}', {
      status: 200,
      headers: { "PAYMENT-RESPONSE": paymentResponse },
    });
  };

  const ensured = [];
  let redeemed;
  const client = {
    ensureReservation: async (_address, cost) => {
      ensured.push(cost);
      const retry = ensured.length === 2;
      return {
        ops: {
          locked: retry ? 5_000n : 2_000n,
          redeemed: 0n,
          expiry: 0n,
          created: 0n,
          cycle: retry ? 2n : 1n,
        },
        keyEpoch: retry ? 2n : 1n,
      };
    },
    consumer: async () => "0x0000000000000000000000000000000000000022",
    recordAndRedeem: (address, ops, epoch, cost) => {
      redeemed = { address, cycle: ops.cycle, epoch, cost };
    },
    flushRedeems: async () => {},
  };

  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [{ role: "user", content: "hello" }] },
    client,
  });

  assert.equal(calls, 3, "operator list + rejected send + one retry");
  assert.equal(ensured.length, 2);
  assert.equal(ensured[1], 5_000n, "retry reserves the operator's exact reported floor");
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "91");
  assert.deepEqual(redeemed, { address: operator, cycle: 2n, epoch: 2n, cost: 91n });
});

test("uses exact-first fuzzy model matching and prefers vault-capable operators", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          {
            address: "0x0000000000000000000000000000000000000001",
            models: ["gpt-4o-2024-08-06"],
            pricing: { "gpt-4o-2024-08-06": 0.001 },
            vaultPayments: false,
          },
          {
            address: "0x0000000000000000000000000000000000000002",
            models: ["gpt-4o-2024-11-20"],
            pricing: { "gpt-4o-2024-11-20": 0.003 },
            vaultPayments: true,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const selected = await selectVaultOperator("https://relay.invalid", "gpt-4o");
  assert.equal(selected?.address, "0x0000000000000000000000000000000000000002");
  assert.equal(selected?.priceUsdPerMtok, 3);
});

test("does NOT fall back to a legacy operator when no vault capability is announced", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  // A vault reservation is bound on-chain to a (consumer, operator) pair, so a
  // legacy operator can't honor it. selectVaultOperator must return null (caller
  // fails fast) rather than pin an unusable legacy operator.
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          {
            address: "0x0000000000000000000000000000000000000011",
            models: ["model"],
            pricing: { model: 0.004 },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  assert.equal(await selectVaultOperator("https://relay.invalid", "model"), null);
});

test("picks the cheapest in-price VAULT-CAPABLE operator, never a cheaper legacy one", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          // Cheapest overall, but legacy → must be skipped.
          { address: "0x0000000000000000000000000000000000000017", models: ["model"], pricing: { model: 0.001 }, vaultPayments: false },
          // Cheapest vault-capable within the price band → selected.
          { address: "0x0000000000000000000000000000000000000018", models: ["model"], pricing: { model: 0.004 }, vaultPayments: true },
          // Vault-capable but over the price band → excluded by maxPrice.
          { address: "0x0000000000000000000000000000000000000019", models: ["model"], pricing: { model: 0.010 }, vaultPayments: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const selected = await selectVaultOperator("https://relay.invalid", "model", {
    maxPriceUsdPerMtok: 5,
  });
  assert.equal(selected?.address, "0x0000000000000000000000000000000000000018");
  assert.equal(selected?.priceUsdPerMtok, 4);
});

test("default payInference does not wait for a slow facilitator redeem", async (t) => {
  const originalFetch = global.fetch;
  const originalEnsure = HaloVaultClient.prototype.ensureReservation;
  const originalConsumer = HaloVaultClient.prototype.consumer;
  const originalSign = HaloVaultClient.prototype.signReceipt;
  const originalPost = HaloVaultClient.prototype.postRedeem;
  const originalReadOps = HaloVaultClient.prototype.readOps;
  t.after(() => {
    global.fetch = originalFetch;
    HaloVaultClient.prototype.ensureReservation = originalEnsure;
    HaloVaultClient.prototype.consumer = originalConsumer;
    HaloVaultClient.prototype.signReceipt = originalSign;
    HaloVaultClient.prototype.postRedeem = originalPost;
    HaloVaultClient.prototype.readOps = originalReadOps;
  });

  HaloVaultClient.prototype.ensureReservation = async () => ({
    ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
    keyEpoch: 1n,
  });
  // The stale-cycle guard in attemptRedeem reads on-chain ops() before posting;
  // stub it (no live RPC here) so the redeem reaches the slow postRedeem stub
  // instead of leaking an ethers network-detection retry against the dead rpcUrl.
  HaloVaultClient.prototype.readOps = async () => ({
    locked: 1_000n,
    redeemed: 0n,
    expiry: 0n,
    created: 0n,
    cycle: 1n,
  });
  HaloVaultClient.prototype.consumer = async () =>
    "0x0000000000000000000000000000000000000012";
  HaloVaultClient.prototype.signReceipt = async () => "0xsigned";
  let releaseRedeem;
  let redeemStarted;
  const started = new Promise((resolve) => {
    redeemStarted = resolve;
  });
  const slowRedeem = new Promise((resolve) => {
    releaseRedeem = resolve;
  });
  HaloVaultClient.prototype.postRedeem = async () => {
    redeemStarted();
    await slowRedeem;
    return "0xredeem";
  };

  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "10" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: "0x0000000000000000000000000000000000000013",
              models: ["model"],
              pricing: { model: 0.001 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response('{"choices":[]}', {
      status: 200,
      headers: { "PAYMENT-RESPONSE": paymentResponse },
    });
  };

  const result = await Promise.race([
    payInference({
      signer: {},
      relayUrl: "https://relay.invalid",
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      body: { model: "model", messages: [] },
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("payInference waited for redeem")), 500)
    ),
  ]);
  assert.equal(result.paid, true);
  await started;
  releaseRedeem();
  assert.equal(typeof result.flushRedeems, "function");
  await result.flushRedeems();
});

test("retains transient redeem failures for a later retry", async () => {
  const signer = {
    getAddress: async () => "0x0000000000000000000000000000000000000004",
  };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  client.signReceipt = async () => "0xsigned";
  // Same-cycle, un-redeemed on-chain state so the stale-cycle guard is a no-op
  // and the redeem reaches the stubbed postRedeem (no live RPC in tests).
  client.readOps = async () => ({ locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n });
  client.postRedeem = async () => {
    throw new Error("redeem failed (HTTP 503)");
  };

  client.recordAndRedeem(
    "0x0000000000000000000000000000000000000005",
    { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
    1n,
    100n
  );
  await client.flushRedeems();
  assert.equal(client.pendingRedeemCount, 1);
});

test("does not double-submit a redeem while one attempt is in flight", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000014" },
    {
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
    }
  );
  client.signReceipt = async () => "0xsigned";
  // Same-cycle on-chain state so the stale-cycle guard is a no-op (no live RPC).
  client.readOps = async () => ({ locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 2n });
  let calls = 0;
  let releaseRedeem;
  let redeemStarted;
  const started = new Promise((resolve) => {
    redeemStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseRedeem = resolve;
  });
  client.postRedeem = async () => {
    calls += 1;
    redeemStarted();
    await gate;
    return "0xredeem";
  };
  const operator = "0x0000000000000000000000000000000000000015";
  client.recordAndRedeem(
    operator,
    { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 2n },
    1n,
    100n
  );
  await started;
  await Promise.all([
    client.attemptRedeem(`${operator}:2`),
    client.attemptRedeem(`${operator}:2`),
  ]);
  assert.equal(calls, 1);
  releaseRedeem();
  await client.flushRedeems();
});

test("rejects stream:true before performing network work", async (t) => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error("unexpected fetch");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  await assert.rejects(
    payInference({
      signer: {},
      relayUrl: "https://relay.invalid",
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      body: { model: "model", stream: true },
    }),
    /stream:true is not supported/
  );
  assert.equal(called, false);
});

test("locally meters a successful buffered response with no settlement header", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000016";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: operator,
              models: ["model"],
              pricing: { model: 0.002 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ choices: [], usage: { total_tokens: 50 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let charged;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000017",
    recordAndRedeem: (_operator, _ops, _epoch, cost) => {
      charged = cost;
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [] },
    client,
  });
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "100");
  assert.equal(charged, 100n);
});

test("does not locally meter over an explicit zero operator settlement", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000020";
  const zeroSettlement = Buffer.from(JSON.stringify({ amountUsdc: "0" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: operator,
              models: ["model"],
              pricing: { model: 0.002 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ choices: [], usage: { total_tokens: 50 } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": zeroSettlement,
      },
    });
  };
  let redeemCalled = false;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000021",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
    flushRedeems: async () => {},
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [], max_tokens: 1024 },
    client,
  });
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false);
});

test("reclaims eligible reservations without dropping the retry hint early", async () => {
  const signer = {
    getAddress: async () => "0x0000000000000000000000000000000000000006",
  };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x0000000000000000000000000000000000000007";
  client.reservedOperators.add(operator);
  client.redeemGrace = async () => 10n;
  client.readOps = async () => ({
    locked: 500n,
    redeemed: 0n,
    expiry: BigInt(Math.floor(Date.now() / 1000) - 11),
    created: 0n,
    cycle: 1n,
  });
  let releases = 0;
  client.postRelease = async () => {
    releases += 1;
    return "0xrelease";
  };

  assert.equal(await client.releaseExpiredReservations(), true);
  assert.equal(releases, 1);
  assert.equal(client.reservedOperators.has(operator), true);

  client.readOps = async () => ({
    locked: 0n,
    redeemed: 500n,
    expiry: 0n,
    created: 0n,
    cycle: 1n,
  });
  assert.equal(await client.releaseExpiredReservations(), false);
  assert.equal(client.reservedOperators.has(operator), false);
});

test("optional undefined values do not erase client defaults", () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000008" },
    {
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      reserveTtlSec: undefined,
      reserveMultiple: undefined,
    }
  );
  assert.equal(client.cfg.reserveTtlSec, 3600);
  assert.equal(client.cfg.reserveMultiple, 5n);
  assert.equal(client.cfg.reserveLiquiditySlots, 8n);
});

test("only terminal redeem errors are discarded", () => {
  assert.equal(classifyRedeemError("execution reverted: StaleReceipt"), "collected");
  assert.equal(classifyRedeemError("BadSignature"), "uncollectable");
  assert.equal(classifyRedeemError("nonce already known"), "transient");
});

// ── PR 384 review regressions ────────────────────────────────────────────────

test("priceTokens rejects a non-finite or negative price instead of crashing in ethers", () => {
  assert.throws(() => priceTokens(NaN, 100), /finite non-negative/);
  assert.throws(() => priceTokens(Infinity, 100), /finite non-negative/);
  assert.throws(() => priceTokens(-1, 100), /finite non-negative/);
  // sanity: a valid price still meters as before ($2/Mtok × 50 tok = 100 base units).
  assert.equal(priceTokens(2, 50), 100n);
});

test("reportedUsageTokens trusts a finite total_tokens, including an authoritative zero", () => {
  assert.equal(reportedUsageTokens({ total_tokens: 0 }), 0);
  assert.equal(reportedUsageTokens({ total_tokens: 50 }), 50);
});

test("reportedUsageTokens sums the prompt/completion split when total_tokens is absent", () => {
  assert.equal(reportedUsageTokens({ prompt_tokens: 12, completion_tokens: 8 }), 20);
  assert.equal(reportedUsageTokens({ completion_tokens: 8 }), 8);
  assert.equal(reportedUsageTokens({ prompt_tokens: 12 }), 12);
});

test("reportedUsageTokens returns undefined for missing/unusable usage (caller falls back to estimate)", () => {
  assert.equal(reportedUsageTokens(undefined), undefined);
  assert.equal(reportedUsageTokens(null), undefined);
  assert.equal(reportedUsageTokens({}), undefined);
  assert.equal(reportedUsageTokens({ total_tokens: -5 }), undefined);
  assert.equal(reportedUsageTokens({ total_tokens: "50" }), undefined);
  // a non-finite total with a valid split falls through to the split.
  assert.equal(reportedUsageTokens({ total_tokens: -1, completion_tokens: 8 }), 8);
});

test("selectVaultOperator drops operators with a non-finite/non-positive price and keeps routing", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  // Untrusted relay JSON: a string price, an explicit null, a missing entry, and
  // a zero price must all be skipped without crashing — leaving the one healthy
  // operator selectable.
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          { address: "0x0000000000000000000000000000000000000031", models: ["model"], pricing: { model: "not-a-number" }, vaultPayments: true },
          { address: "0x0000000000000000000000000000000000000032", models: ["model"], pricing: { model: null }, vaultPayments: true },
          { address: "0x0000000000000000000000000000000000000033", models: ["model"], pricing: {}, vaultPayments: true },
          { address: "0x0000000000000000000000000000000000000034", models: ["model"], pricing: { model: 0 }, vaultPayments: true },
          { address: "0x0000000000000000000000000000000000000035", models: ["model"], pricing: { model: 0.005 }, vaultPayments: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const selected = await selectVaultOperator("https://relay.invalid", "model");
  assert.equal(selected?.address, "0x0000000000000000000000000000000000000035");
  assert.equal(selected?.priceUsdPerMtok, 5);
});

test("selectVaultOperator returns null (not a crash) when every advertised price is garbled", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          { address: "0x0000000000000000000000000000000000000036", models: ["model"], pricing: { model: "garbage" }, vaultPayments: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  assert.equal(await selectVaultOperator("https://relay.invalid", "model"), null);
});

test("an SSE no-settlement, no-usage response is left UNMETERED (not charged the inflated estimate)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000040";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            { address: operator, models: ["model"], pricing: { model: 0.002 }, vaultPayments: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // Operator SSE-frames a buffered request, emitting NEITHER a halo-settlement
    // event NOR a usage frame. The response is unmeterable, so we must not charge
    // the max_tokens-inflated estimate (which would over-charge / be gameable).
    return new Response(`data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  let redeemCalled = false;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000041",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [], max_tokens: 1024 },
    client,
  });
  // Unmeterable → not charged (vs. the old 2048-base-unit max_tokens estimate).
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false);
});

test("a buffered no-settlement response reporting total_tokens:0 charges zero (no over-charge)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000042";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            { address: operator, models: ["model"], pricing: { model: 0.002 }, vaultPayments: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ choices: [], usage: { total_tokens: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let redeemCalled = false;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000043",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [], max_tokens: 1024 },
    client,
  });
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false);
});

test("a buffered no-settlement response sums prompt+completion when total_tokens is absent", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000044";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            { address: operator, models: ["model"], pricing: { model: 0.002 }, vaultPayments: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 20 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  let charged;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000045",
    recordAndRedeem: (_operator, _ops, _epoch, cost) => {
      charged = cost;
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [], max_tokens: 1024 },
    client,
  });
  // 30 + 20 = 50 tok at $2/Mtok = 100 base units (not the 1024-token estimate).
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "100");
  assert.equal(charged, 100n);
});

test("mode:exact surfaces a vault-enforcing relay's 402 as an InferenceResult, not a throw", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  // The relay vault gate returns 402 with a JSON body and NO PAYMENT-REQUIRED
  // header. The exact escape hatch must return that body, not crash.
  global.fetch = async () =>
    new Response(
      JSON.stringify({ error: { type: "vault_payment_required", message: "use vault" } }),
      { status: 402, headers: { "content-type": "application/json" } }
    );
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    mode: "exact",
    body: { model: "model", messages: [] },
  });
  assert.equal(result.status, 402);
  assert.equal(result.paid, false);
  assert.match(result.body, /vault_payment_required/);
});

// ── PR 384 review round 2 regressions ────────────────────────────────────────

test("priceTokens rejects a non-finite or negative token count (e.g. max_tokens=Infinity)", () => {
  assert.throws(() => priceTokens(2, Infinity), /tokens must be a finite non-negative/);
  assert.throws(() => priceTokens(2, NaN), /tokens must be a finite non-negative/);
  assert.throws(() => priceTokens(2, -5), /tokens must be a finite non-negative/);
});

test("usageTokensFromSseBody reads the trailing usage frame", () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    "",
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":30,"completion_tokens":20,"total_tokens":50}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  assert.equal(usageTokensFromSseBody(body), 50);
});

test("usageTokensFromSseBody returns undefined when no frame carries usage", () => {
  const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  assert.equal(usageTokensFromSseBody(body), undefined);
});

test("an SSE no-settlement response charges ACTUAL usage from the trailing frame, not the estimate", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000050";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            { address: operator, models: ["model"], pricing: { model: 0.002 }, vaultPayments: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    // SSE, no halo-settlement, but a trailing usage frame reporting 50 tokens.
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
        'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":50}}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };
  let charged;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000051",
    recordAndRedeem: (_operator, _ops, _epoch, cost) => {
      charged = cost;
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [], max_tokens: 1024 },
    client,
  });
  // 50 actual tokens at $2/Mtok = 100 base units — NOT the 1024-token estimate (2048).
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "100");
  assert.equal(charged, 100n);
});

test("recordAndRedeem clamps to the high-water reservation ceiling, not a stale ops snapshot", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000052" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  const submitted = [];
  client.signReceipt = async () => "0xsig";
  // Same-cycle, un-redeemed on-chain state so the stale-cycle guard is a no-op.
  client.readOps = async () => ({ locked: 2_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n });
  client.postRedeem = async (_operator, cumulative) => {
    submitted.push(cumulative);
    return "0xredeem";
  };
  const operator = "0x0000000000000000000000000000000000000053";
  // Fresh snapshot sees locked=2000; record 1500 of served cost.
  client.recordAndRedeem(operator, { locked: 2_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n }, 1n, 1_500n);
  // A STALE snapshot (older, lower locked=1000) for the same cycle records another
  // 600. It must not clamp the cumulative back below the already-recorded 1500.
  client.recordAndRedeem(operator, { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n }, 1n, 600n);
  await client.flushRedeems();
  // 1500 then 1500+600=2100 clamped to the high-water ceiling 2000 — never regressed.
  assert.ok(submitted.every((c) => c >= 1_500n), `cumulative regressed: ${submitted}`);
  assert.equal(submitted[submitted.length - 1], 2_000n);
});

// ── PR 384 review round 3 regressions ────────────────────────────────────────

test("priceTokens rejects a positive price that rounds to 0 instead of serving unpriced", () => {
  // A positive price below the 12-decimal resolution (< 5e-13 USD/Mtok) rounds to
  // 0n; without the guard priceTokens would return 0n for ANY token count, so
  // payInference would serve real inference with paid:false and never redeem.
  assert.throws(() => priceTokens(1e-13, 1_000_000), /rounds to 0/);
  assert.throws(() => priceTokens(4e-13, 1_000_000), /rounds to 0/);
  // Boundary: the smallest representable positive price (1e-12) still meters.
  assert.equal(priceTokens(1e-12, 1), 1n);
});

// ── PR 384 review round 4 regressions ────────────────────────────────────────

test("ensureReservation serves a covered near-expiry reservation with the whole balance locked (no doomed 1n reserve)", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000060" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  const secNow = Math.floor(Date.now() / 1000);
  // Whole balance locked to this operator: withdrawable == 0. The reservation still
  // covers estCost but is within the 120s refresh margin. The operator gates on the
  // actual on-chain expiry (not yet passed), so the request must be served against the
  // existing reservation — NOT hard-failed, and NOT via a 1n reserve that would revert
  // InsufficientFree (amount > withdrawable).
  client.readVaultState = async () => ({
    balance: 5_000n,
    lockedTotal: 5_000n,
    withdrawable: 0n,
    // Headless client: the registered session key IS this wallet (== consumer),
    // so the #426 preflight passes and this stays a pure reserve-sizing test.
    sessionKey: "0x0000000000000000000000000000000000000060",
    reserveNonce: 0n,
    keyEpoch: 7n,
  });
  const ops = { locked: 5_000n, redeemed: 0n, expiry: BigInt(secNow + 60), created: 0n, cycle: 3n };
  client.readOps = async () => ops;
  let reserveAttempted = false;
  client.postReserve = async () => {
    reserveAttempted = true;
    return "0xreserve";
  };
  const result = await client.ensureReservation(
    "0x00000000000000000000000000000000000000aa",
    1_000n
  );
  assert.equal(reserveAttempted, false);
  assert.equal(result.ops.locked, 5_000n);
  assert.equal(result.keyEpoch, 7n);
});

test("ensureReservation still hard-fails when the reservation genuinely can't cover the request", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000062" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  client.readVaultState = async () => ({
    balance: 500n,
    lockedTotal: 500n,
    withdrawable: 0n,
    // Headless client: registered session key == this wallet (== consumer), so the
    // #426 preflight passes and the test exercises the genuine can't-cover path.
    sessionKey: "0x0000000000000000000000000000000000000062",
    reserveNonce: 0n,
    keyEpoch: 1n,
  });
  // locked (500) < estCost (1000) and no free balance to reserve → must throw.
  client.readOps = async () => ({ locked: 500n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n });
  client.releaseExpiredReservations = async () => false;
  let reserveAttempted = false;
  client.postReserve = async () => {
    reserveAttempted = true;
    return "0xreserve";
  };
  await assert.rejects(
    client.ensureReservation("0x00000000000000000000000000000000000000ab", 1_000n),
    /can't cover this request/
  );
  assert.equal(reserveAttempted, false);
});

test("checkSessionKey classifies the on-chain key against this wallet (#426)", async () => {
  const wallet = "0x00000000000000000000000000000000000000A0";
  const client = new HaloVaultClient(
    { getAddress: async () => wallet },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  const base = { balance: 0n, lockedTotal: 0n, withdrawable: 0n, reserveNonce: 0n, keyEpoch: 0n };
  client.readVaultState = async () => ({
    ...base,
    sessionKey: "0x0000000000000000000000000000000000000000",
  });
  assert.equal((await client.checkSessionKey()).status, "unregistered");
  // Registered key IS this wallet (case-insensitive) → match.
  client.readVaultState = async () => ({
    ...base,
    sessionKey: "0x00000000000000000000000000000000000000a0",
  });
  assert.equal((await client.checkSessionKey()).status, "match");
  // A DIFFERENT key (e.g. the browser's in-browser sub-wallet) → mismatch.
  client.readVaultState = async () => ({
    ...base,
    sessionKey: "0x00000000000000000000000000000000000000ff",
  });
  const mismatch = await client.checkSessionKey();
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.registered, "0x00000000000000000000000000000000000000ff");
  assert.equal(mismatch.expected, wallet);
});

test("ensureReservation fails closed on a session-key mismatch — never serves unpayable work (#426)", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x00000000000000000000000000000000000000A1" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  // A different key is registered (the classic browser-sub-wallet-first case).
  // The vault has ample free balance, so ONLY the preflight can stop the reserve.
  client.readVaultState = async () => ({
    balance: 5_000n,
    lockedTotal: 0n,
    withdrawable: 5_000n,
    sessionKey: "0x00000000000000000000000000000000000000bb",
    reserveNonce: 0n,
    keyEpoch: 0n,
  });
  client.readOps = async () => ({ locked: 0n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 0n });
  let reserveAttempted = false;
  client.postReserve = async () => {
    reserveAttempted = true;
    return "0xreserve";
  };
  await assert.rejects(
    client.ensureReservation("0x00000000000000000000000000000000000000ab", 1_000n),
    /session-key mismatch/i
  );
  assert.equal(reserveAttempted, false);
});

test("ensureReservation proceeds when the registered session key is this wallet (#426)", async () => {
  const consumer = "0x00000000000000000000000000000000000000A2";
  const client = new HaloVaultClient(
    { getAddress: async () => consumer },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  const secNow = Math.floor(Date.now() / 1000);
  let reads = 0;
  client.readVaultState = async () => {
    reads += 1;
    return {
      balance: 5_000n,
      lockedTotal: 5_000n,
      withdrawable: 0n,
      sessionKey: consumer,
      reserveNonce: 0n,
      keyEpoch: 4n,
    };
  };
  client.readOps = async () => ({
    locked: 5_000n,
    redeemed: 0n,
    expiry: BigInt(secNow + 3600),
    created: 0n,
    cycle: 2n,
  });
  let reserveAttempted = false;
  client.postReserve = async () => {
    reserveAttempted = true;
    return "0xreserve";
  };
  const result = await client.ensureReservation(
    "0x00000000000000000000000000000000000000ac",
    1_000n
  );
  assert.equal(reserveAttempted, false);
  assert.equal(result.keyEpoch, 4n);
  // The session-key gate piggybacks on ensureColdReservation's own state read —
  // no SEPARATE preflight read — so each reservation reads state exactly once.
  assert.equal(reads, 1, `first reservation should read state once, got ${reads}`);
  await client.ensureReservation("0x00000000000000000000000000000000000000ac", 1_000n);
  assert.equal(reads, 2, `second reservation should read state once more, got ${reads}`);
});

test("a distinct session signer is the address the guard expects, not the consumer (#426 cross-surface)", async () => {
  const consumer = "0x00000000000000000000000000000000000000A5";
  const sessionAddr = "0x00000000000000000000000000000000000000E1";
  const client = new HaloVaultClient(
    { getAddress: async () => consumer },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 },
    { getAddress: async () => sessionAddr, signTypedData: async () => "0xsig" }
  );
  assert.equal(await client.consumer(), consumer);
  assert.equal(await client.sessionAddress(), sessionAddr);
  const base = { balance: 0n, lockedTotal: 0n, withdrawable: 0n, reserveNonce: 0n, keyEpoch: 0n };
  // The registered key is the SESSION signer → match (this is the browser-first
  // wallet the CLI now shares via --session-key browser).
  client.readVaultState = async () => ({ ...base, sessionKey: sessionAddr });
  assert.equal((await client.checkSessionKey()).status, "match");
  // The registered key is the CONSUMER (wallet) → mismatch: the wallet signs with
  // the sub-wallet now, so a wallet-registered key can't verify its receipts.
  client.readVaultState = async () => ({ ...base, sessionKey: consumer });
  assert.equal((await client.checkSessionKey()).status, "mismatch");
});

test("ensureReservation proceeds when the registered key is the distinct session signer (#426)", async () => {
  const consumer = "0x00000000000000000000000000000000000000A6";
  const sessionAddr = "0x00000000000000000000000000000000000000E2";
  const client = new HaloVaultClient(
    { getAddress: async () => consumer },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 },
    { getAddress: async () => sessionAddr, signTypedData: async () => "0xsig" }
  );
  const secNow = Math.floor(Date.now() / 1000);
  client.readVaultState = async () => ({
    balance: 5_000n,
    lockedTotal: 5_000n,
    withdrawable: 0n,
    sessionKey: sessionAddr,
    reserveNonce: 0n,
    keyEpoch: 3n,
  });
  client.readOps = async () => ({
    locked: 5_000n,
    redeemed: 0n,
    expiry: BigInt(secNow + 3600),
    created: 0n,
    cycle: 2n,
  });
  const result = await client.ensureReservation("0x00000000000000000000000000000000000000ad", 1_000n);
  assert.equal(result.keyEpoch, 3n);
});

test("readVaultState falls through to on-chain when the facilitator omits sessionKey (#426 fail-closed)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const onchainKey = "0x00000000000000000000000000000000000000cc";
  // Facilitator returns state WITHOUT a sessionKey field (schema drift / partial
  // response). Coercing that to the zero address would read as "unregistered" and
  // fail the #426 guard OPEN — so the read must fall through to on-chain instead.
  global.fetch = async () =>
    new Response(
      JSON.stringify({ balance: "10", lockedTotal: "0", withdrawable: "10", reserveNonce: "0", keyEpoch: "0" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const client = new HaloVaultClient(
    { getAddress: async () => "0x00000000000000000000000000000000000000A3" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  // Stub the authoritative on-chain contract read the fallback uses.
  client.vault = {
    balance: async () => 10n,
    lockedTotal: async () => 0n,
    withdrawable: async () => 10n,
    sessionKey: async () => onchainKey,
    reserveNonce: async () => 0n,
    keyEpoch: async () => 0n,
  };
  const state = await client.readVaultState();
  assert.equal(state.sessionKey, onchainKey);
});

test("readVaultState trusts the facilitator read when it carries a valid sessionKey (#426)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const key = "0x00000000000000000000000000000000000000dd";
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        balance: "5",
        lockedTotal: "0",
        withdrawable: "5",
        sessionKey: key,
        reserveNonce: "1",
        keyEpoch: "2",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const client = new HaloVaultClient(
    { getAddress: async () => "0x00000000000000000000000000000000000000A4" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  // A valid facilitator sessionKey must be trusted — the on-chain path must NOT run.
  const boom = async () => {
    throw new Error("on-chain read must not be hit when the facilitator read is valid");
  };
  client.vault = {
    balance: boom,
    lockedTotal: boom,
    withdrawable: boom,
    sessionKey: boom,
    reserveNonce: boom,
    keyEpoch: boom,
  };
  const state = await client.readVaultState();
  assert.equal(state.sessionKey, key);
  assert.equal(state.keyEpoch, 2n);
});

test("a non-2xx response carrying a settlement header is neither marked paid nor charged", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000064";
  // Operator returns a 402 but still stamps a PAYMENT-RESPONSE with amountUsdc > 0.
  // Nothing is redeemed for a non-2xx, so chargedBase must not be populated and paid
  // must be false — a caller recording spend can't show a charge that never landed.
  const settlement = Buffer.from(JSON.stringify({ amountUsdc: "99" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          operators: [
            { address: operator, models: ["model"], pricing: { model: 0.002 }, vaultPayments: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "upstream failed" }), {
      status: 402,
      headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settlement },
    });
  };
  let redeemCalled = false;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000065",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [] },
    client,
  });
  assert.equal(result.status, 402);
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false);
});

test("selectVaultOperator skips an operator advertising an empty-string model (would match everything)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  // The empty-model operator is the cheapest, but `""` must NOT fuzzy-match "model"
  // (`"model".includes("")` is true) — otherwise it's pinned for a model it never
  // advertised. The legitimate operator must be selected instead.
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          { address: "0x0000000000000000000000000000000000000066", models: [""], pricing: { "": 0.001 }, vaultPayments: true },
          { address: "0x0000000000000000000000000000000000000067", models: ["model"], pricing: { model: 0.005 }, vaultPayments: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const selected = await selectVaultOperator("https://relay.invalid", "model");
  assert.equal(selected?.address, "0x0000000000000000000000000000000000000067");
  assert.equal(selected?.priceUsdPerMtok, 5);
});

test("selectVaultOperator returns null when the only operator advertises an empty-string model", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          { address: "0x0000000000000000000000000000000000000068", models: [""], pricing: { "": 0.001 }, vaultPayments: true },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  assert.equal(await selectVaultOperator("https://relay.invalid", "model"), null);
});

const operatorsResponse = (operator) =>
  new Response(
    JSON.stringify({
      operators: [
        { address: operator, models: ["model"], pricing: { model: 0.001 }, vaultPayments: true },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
const insufficient402 = (requiredUsdcBase) =>
  new Response(
    JSON.stringify({ error: { type: "vault_reservation_insufficient", requiredUsdcBase } }),
    { status: 402, headers: { "content-type": "application/json" } }
  );

test("payInference meters a streamed settlement even when the operator mislabels content-type (F2/#3)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000071";
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "64" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return operatorsResponse(operator);
    // Operator streams the halo-settlement frame in the body but labels the
    // response `application/json`. A content-type gate would drop this settlement
    // and pay $0 for served work (invariants #3/#4).
    return new Response(
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
        `event: halo-settlement\ndata: ${JSON.stringify({ paymentResponse })}\n\n`,
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  let redeemed;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000072",
    recordAndRedeem: (address, _ops, _epoch, cost) => {
      redeemed = { address, cost };
    },
    flushRedeems: async () => {},
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [{ role: "user", content: "hello" }] },
    client,
  });
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "64");
  assert.deepEqual(redeemed, { address: operator, cost: 64n });
});

test("payInference meters from reported body usage when the operator omits a settlement (F1/#4)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000073";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return operatorsResponse(operator);
    // Served completion, usage in the JSON body, but NO PAYMENT-RESPONSE header
    // and no settlement frame — must still be paid from usage, not charged 0.
    return new Response(JSON.stringify({ choices: [], usage: { total_tokens: 1000 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let redeemed;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000074",
    recordAndRedeem: (address, _ops, _epoch, cost) => {
      redeemed = { address, cost };
    },
    flushRedeems: async () => {},
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [{ role: "user", content: "hello" }] },
    client,
  });
  // The prior CLI-style header-only metering charged 0 here (paid:false). The fix
  // meters from body usage: a positive charge, redeemed, chargedBase consistent.
  assert.equal(result.paid, true);
  assert.ok(redeemed, "recordAndRedeem must fire for served, usage-reported work");
  assert.ok(redeemed.cost > 0n);
  assert.equal(redeemed.address, operator);
  assert.equal(result.chargedBase, redeemed.cost.toString());
});

test("payInference retries reservation-insufficient 402s up to the bounded cap and pins the latest snapshot (F6)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000075";
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "42" })).toString("base64");
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return operatorsResponse(operator);
    if (calls === 2) return insufficient402("5000"); // gate price advances once…
    if (calls === 3) return insufficient402("8000"); // …then advances AGAIN before replay
    return new Response('{"choices":[]}', {
      status: 200,
      headers: { "PAYMENT-RESPONSE": paymentResponse },
    });
  };
  const ensured = [];
  let redeemed;
  const client = {
    ensureReservation: async (_address, cost) => {
      ensured.push(cost);
      const n = BigInt(ensured.length);
      return { ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: n }, keyEpoch: n };
    },
    consumer: async () => "0x0000000000000000000000000000000000000076",
    recordAndRedeem: (address, ops, epoch, cost) => {
      redeemed = { address, cycle: ops.cycle, epoch, cost };
    },
    flushRedeems: async () => {},
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [{ role: "user", content: "hi" }] },
    client,
  });
  assert.equal(calls, 4, "operators + first send + two reserve-and-replay retries");
  assert.deepEqual(ensured.slice(1), [5000n, 8000n], "each retry reserves the next reported floor");
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "42");
  // Receipt must be signed against the LATEST reservation (invariant #5), never a
  // pre-retry snapshot — the single-shot retry could not survive two advances.
  assert.deepEqual(redeemed, { address: operator, cycle: 3n, epoch: 3n, cost: 42n });
});

test("payInference stops after the bounded cap when the gate keeps advancing (F6)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const operator = "0x0000000000000000000000000000000000000077";
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return operatorsResponse(operator);
    return insufficient402(String(1000 * calls)); // never satisfiable
  };
  let redeemCalled = false;
  const client = {
    ensureReservation: async (_address, cost) => ({
      ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000078",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
    flushRedeems: async () => {},
  };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [{ role: "user", content: "hi" }] },
    client,
  });
  // 1 operators + MAX_VAULT_RESERVATION_ATTEMPTS sends (first + 2 retries), then give up.
  assert.equal(calls, 4);
  assert.equal(result.status, 402);
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false, "a payment-gate 402 must never redeem");
});
