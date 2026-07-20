const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

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
const { estimateReservationTokens, estimateTokens, withReservationMargin } = require("@halo/vault-core");

test("pins the current production vault", () => {
  assert.equal(VAULT_ADDRESS, "0x3907F660B257560883E891fbbB9F997Eff70E40E");
});

test("validates a custom vault once and uses it for contracts and typed-data domains", async () => {
  const custom = "0x000000000000000000000000000000000000dEaD";
  let signedDomain = null;
  const signer = {
    getAddress: async () => "0x0000000000000000000000000000000000000001",
    signTypedData: async (domain) => {
      signedDomain = domain;
      return "0xsigned";
    },
  };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
    vaultAddress: custom.toLowerCase(),
  });
  assert.equal(client.vault.target, custom);
  await client.signReserve({
    operator: "0x0000000000000000000000000000000000000002",
    amount: 1n,
    expiry: 2n,
    nonce: 3n,
    keyEpoch: 4n,
  });
  assert.equal(signedDomain.verifyingContract, custom);
});

test("rejects malformed vault addresses and unsupported chains at construction", () => {
  const signer = { getAddress: async () => "0x0000000000000000000000000000000000000001" };
  assert.throws(
    () =>
      new HaloVaultClient(signer, {
        facilitatorUrl: "https://facilitator.invalid",
        rpcUrl: "http://127.0.0.1:1",
        chainId: 8453,
        vaultAddress: "0x1234",
      }),
    /invalid vaultAddress/
  );
  assert.throws(
    () =>
      new HaloVaultClient(signer, {
        facilitatorUrl: "https://facilitator.invalid",
        rpcUrl: "http://127.0.0.1:1",
        chainId: 8453,
        vaultAddress: "",
      }),
    /invalid vaultAddress/
  );
  assert.throws(
    () =>
      new HaloVaultClient(signer, {
        facilitatorUrl: "https://facilitator.invalid",
        rpcUrl: "http://127.0.0.1:1",
        chainId: 1,
      }),
    /Unsupported chainId/
  );
});

test("pending redeem recovery never replays a signature scoped to another vault", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-sdk-vault-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, "pending.json");
  const otherVault = "0x0000000000000000000000000000000000000002";
  writeFileSync(
    store,
    JSON.stringify([
      {
        key: "operator:1",
        vaultAddress: otherVault,
        operator: "0x0000000000000000000000000000000000000003",
        cumulative: "10",
        signature: "0xsigned-for-other-domain",
        cycle: "1",
      },
    ])
  );
  const logs = [];
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000001" },
    {
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      vaultAddress: "0x000000000000000000000000000000000000dEaD",
      pendingStorePath: store,
      log: (message) => logs.push(message),
    }
  );
  client.resumePendingRedeems();
  assert.equal(client.pendingRedeemCount, 0);
  assert.match(logs.join("\n"), /signed for a different vault/);
  client.persistPending();
  assert.match(readFileSync(store, "utf8"), /signed-for-other-domain/);
});

test("managed payInference validates and propagates its custom vault option", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        operators: [
          {
            address: "0x0000000000000000000000000000000000000009",
            models: ["model"],
            pricing: { model: 0.001 },
            vaultPayments: true,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  await assert.rejects(
    payInference({
      signer: {},
      relayUrl: "https://relay.invalid",
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      vaultAddress: "0x1234",
      body: { model: "model" },
    }),
    /invalid vaultAddress/
  );
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

test("payInference reserves explicit and omitted reasoning completion ceilings (#510, #532)", async (t) => {
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
              models: ["z-ai/glm-5"],
              pricing: { "z-ai/glm-5": 0.001 },
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

  const ensured = [];
  const client = {
    ensureReservation: async (_address, cost) => {
      ensured.push(cost);
      return {
        ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
        keyEpoch: 1n,
      };
    },
    consumer: async () => "0x0000000000000000000000000000000000000022",
    recordAndRedeem: () => {},
  };

  const body = { model: "z-ai/glm-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  const result = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body,
    client,
  });

  assert.equal(calls, 2, "operator list + settled send");
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);

  // resolveModelPriceUsdPerMtok scales the advertised per-1K rate to per-Mtok (0.001 * 1000 = 1).
  const price = 1;
  const withCeiling = withReservationMargin(priceTokens(price, estimateReservationTokens(body)));
  const withRaw = withReservationMargin(priceTokens(price, estimateTokens(body.messages, 16)));
  assert.equal(ensured[0], withCeiling);
  assert.ok(withCeiling > withRaw, "reasoning ceiling must raise the reservation above raw max_tokens=16");

  calls = 0;
  ensured.length = 0;
  const omittedBody = {
    model: "z-ai/glm-5",
    messages: [{ role: "user", content: "hi" }],
  };
  const omittedResult = await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: omittedBody,
    client,
  });

  assert.equal(calls, 2, "operator list + omitted-limit settled send");
  assert.equal(omittedResult.status, 200);
  assert.equal(omittedResult.paid, true);
  assert.equal(
    ensured[0],
    withReservationMargin(priceTokens(price, estimateReservationTokens(omittedBody)))
  );
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
          { address: "0x0000000000000000000000000000000000000017", models: ["model"], pricing: { model: 0.001 }, vaultPayments: false },
          { address: "0x0000000000000000000000000000000000000018", models: ["model"], pricing: { model: 0.004 }, vaultPayments: true },
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

test("ensureReservation refuses to top up a reservation wedged past its lifetime cap (#473)", async () => {
  const signer = { getAddress: async () => "0x0000000000000000000000000000000000000009" };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x000000000000000000000000000000000000000a";
  const now = Math.floor(Date.now() / 1000);
  const session = "0x00000000000000000000000000000000000000ab";
  client.consumer = async () => signer.getAddress();
  client.sessionAddress = async () => session;
  client.readVaultState = async () => ({
    balance: 1_000_000n,
    lockedTotal: 500n,
    withdrawable: 1_000_000n,
    sessionKey: session,
    reserveNonce: 0n,
    keyEpoch: 0n,
  });
  client.maxReserveTtl = async () => 100n;
  client.redeemGrace = async () => 1000n;
  client.readOps = async () => ({
    locked: 500n,
    redeemed: 0n,
    expiry: BigInt(now - 10),
    created: BigInt(now - 200),
    cycle: 3n,
  });
  let released = 0;
  client.postRelease = async () => {
    released += 1;
    return "0x";
  };
  let reserved = 0;
  client.postReserve = async () => {
    reserved += 1;
  };
  await assert.rejects(() => client.ensureReservation(operator, 100n), /stranded until/);
  assert.equal(released, 0, "wedged reservation must not be released (NotExpired)");
  assert.equal(reserved, 0, "wedged reservation must not be topped up");
});

test("ensureReservation reclaims a lifetime-capped reservation then reserves fresh (#473)", async () => {
  const signer = { getAddress: async () => "0x000000000000000000000000000000000000000b" };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x000000000000000000000000000000000000000c";
  const now = Math.floor(Date.now() / 1000);
  const session = "0x00000000000000000000000000000000000000cd";
  client.consumer = async () => signer.getAddress();
  client.sessionAddress = async () => session;
  client.readVaultState = async () => ({
    balance: 1_000_000n,
    lockedTotal: 500n,
    withdrawable: 1_000_000n,
    sessionKey: session,
    reserveNonce: 0n,
    keyEpoch: 0n,
  });
  client.maxReserveTtl = async () => 100n;
  client.redeemGrace = async () => 5n;
  let locked = 500n;
  client.readOps = async () => ({
    locked,
    redeemed: 0n,
    expiry: BigInt(now - 100),
    created: BigInt(now - 300),
    cycle: 3n,
  });
  let released = 0;
  client.postRelease = async () => {
    released += 1;
    locked = 0n;
    return "0x";
  };
  client.signReserve = async () => "0xsig";
  let reserved = 0;
  client.postReserve = async () => {
    reserved += 1;
  };
  client.waitForReservation = async () => ({
    locked: 600n,
    redeemed: 0n,
    expiry: BigInt(now + 3600),
    created: BigInt(now),
    cycle: 4n,
  });
  const res = await client.ensureReservation(operator, 100n);
  assert.equal(released, 1, "capped reservation is reclaimed once");
  assert.equal(reserved, 1, "a fresh reserve follows the reclaim");
  assert.equal(res.ops.cycle, 4n, "returns the new cycle, not the dead one");
});

test("ensureReservation fails closed when reclaiming a capped reservation fails; never tops up the dead cycle (#473/PR#481)", async () => {
  const signer = { getAddress: async () => "0x000000000000000000000000000000000000000d" };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x000000000000000000000000000000000000000e";
  const now = Math.floor(Date.now() / 1000);
  const session = "0x00000000000000000000000000000000000000ef";
  client.consumer = async () => signer.getAddress();
  client.sessionAddress = async () => session;
  client.readVaultState = async () => ({
    balance: 1_000_000n,
    lockedTotal: 500n,
    withdrawable: 1_000_000n,
    sessionKey: session,
    reserveNonce: 0n,
    keyEpoch: 0n,
  });
  client.maxReserveTtl = async () => 100n;
  client.redeemGrace = async () => 5n;
  client.readOps = async () => ({
    locked: 500n,
    redeemed: 0n,
    expiry: BigInt(now - 100),
    created: BigInt(now - 300),
    cycle: 3n,
  });
  client.postRelease = async () => {
    throw new Error("facilitator down");
  };
  let reserved = 0;
  client.signReserve = async () => "0xsig";
  client.postReserve = async () => {
    reserved += 1;
  };
  await assert.rejects(() => client.ensureReservation(operator, 100n), /facilitator down/);
  assert.equal(reserved, 0, "a failed reclaim must NOT fall through to top up the dead cycle");
});

test("ensureReservation fails closed on an expired-but-revivable reservation with no free balance to refresh (#473/PR#481 P1)", async () => {
  const signer = { getAddress: async () => "0x0000000000000000000000000000000000000010" };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x0000000000000000000000000000000000000011";
  const now = Math.floor(Date.now() / 1000);
  const session = "0x0000000000000000000000000000000000001100";
  client.consumer = async () => signer.getAddress();
  client.sessionAddress = async () => session;
  client.readVaultState = async () => ({
    balance: 5_000n,
    lockedTotal: 5_000n,
    withdrawable: 0n,
    sessionKey: session,
    reserveNonce: 0n,
    keyEpoch: 0n,
  });
  client.maxReserveTtl = async () => 604800n;
  client.redeemGrace = async () => 21600n;
  client.readOps = async () => ({
    locked: 5_000n,
    redeemed: 0n,
    expiry: BigInt(now - 30),
    created: BigInt(now - 30),
    cycle: 2n,
  });
  client.releaseExpiredReservations = async () => false;
  let reserved = 0;
  client.signReserve = async () => "0xsig";
  client.postReserve = async () => {
    reserved += 1;
  };
  await assert.rejects(
    () => client.ensureReservation(operator, 1_000n),
    /expired and there's no free balance/
  );
  assert.equal(reserved, 0, "must not return an expired reservation without refreshing it");
});

test("ensureReservation serves a still-live reservation at its cap without a dead refresh top-up (#481 near-expiry)", async () => {
  const signer = { getAddress: async () => "0x0000000000000000000000000000000000000012" };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x0000000000000000000000000000000000000013";
  const now = Math.floor(Date.now() / 1000);
  const session = "0x0000000000000000000000000000000000001200";
  const TTL = 604800n;
  client.consumer = async () => signer.getAddress();
  client.sessionAddress = async () => session;
  client.readVaultState = async () => ({
    balance: 10_000n,
    lockedTotal: 5_000n,
    withdrawable: 5_000n,
    sessionKey: session,
    reserveNonce: 0n,
    keyEpoch: 4n,
  });
  client.maxReserveTtl = async () => TTL;
  client.redeemGrace = async () => 21600n;
  client.readOps = async () => ({
    locked: 5_000n,
    redeemed: 0n,
    expiry: BigInt(now + 60),
    created: BigInt(now + 60) - TTL,
    cycle: 9n,
  });
  let reserved = 0;
  client.signReserve = async () => "0xsig";
  client.postReserve = async () => {
    reserved += 1;
  };
  const res = await client.ensureReservation(operator, 1_000n);
  assert.equal(reserved, 0, "no dead refresh top-up on a live at-cap reservation");
  assert.equal(res.ops.cycle, 9n, "serves on the existing reservation as-is");
  assert.equal(res.keyEpoch, 4n);
});

test("ensureReservation fails closed for an UNDER-COVERED near-expiry at-cap reservation - no dead coverage top-up (#481)", async () => {
  const signer = { getAddress: async () => "0x0000000000000000000000000000000000000014" };
  const client = new HaloVaultClient(signer, {
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
  });
  const operator = "0x0000000000000000000000000000000000000015";
  const now = Math.floor(Date.now() / 1000);
  const session = "0x0000000000000000000000000000000000001400";
  const TTL = 604800n;
  client.consumer = async () => signer.getAddress();
  client.sessionAddress = async () => session;
  client.readVaultState = async () => ({
    balance: 10_000n,
    lockedTotal: 500n,
    withdrawable: 9_500n,
    sessionKey: session,
    reserveNonce: 0n,
    keyEpoch: 2n,
  });
  client.maxReserveTtl = async () => TTL;
  client.redeemGrace = async () => 21600n;
  client.readOps = async () => ({
    locked: 500n,
    redeemed: 0n,
    expiry: BigInt(now + 60),
    created: BigInt(now + 60) - TTL,
    cycle: 7n,
  });
  client.releaseExpiredReservations = async () => false;
  let reserved = 0;
  client.signReserve = async () => "0xsig";
  client.postReserve = async () => {
    reserved += 1;
  };
  await assert.rejects(
    () => client.ensureReservation(operator, 1_000n),
    /at its on-chain lifetime cap and about to expire/
  );
  assert.equal(reserved, 0, "must NOT top up a doomed at-cap cycle even to add coverage");
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

test("priceTokens rejects a non-finite or negative price instead of crashing in ethers", () => {
  assert.throws(() => priceTokens(NaN, 100), /finite non-negative/);
  assert.throws(() => priceTokens(Infinity, 100), /finite non-negative/);
  assert.throws(() => priceTokens(-1, 100), /finite non-negative/);
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
  assert.equal(reportedUsageTokens({ total_tokens: -1, completion_tokens: 8 }), 8);
});

test("selectVaultOperator drops operators with a non-finite/non-positive price and keeps routing", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
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
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "100");
  assert.equal(charged, 100n);
});

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
  client.readOps = async () => ({ locked: 2_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n });
  client.postRedeem = async (_operator, cumulative) => {
    submitted.push(cumulative);
    return "0xredeem";
  };
  const operator = "0x0000000000000000000000000000000000000053";
  client.recordAndRedeem(operator, { locked: 2_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n }, 1n, 1_500n);
  client.recordAndRedeem(operator, { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n }, 1n, 600n);
  await client.flushRedeems();
  assert.ok(submitted.every((c) => c >= 1_500n), `cumulative regressed: ${submitted}`);
  assert.equal(submitted[submitted.length - 1], 2_000n);
});

test("priceTokens rejects a positive price that rounds to 0 instead of serving unpriced", () => {
  assert.throws(() => priceTokens(1e-13, 1_000_000), /rounds to 0/);
  assert.throws(() => priceTokens(4e-13, 1_000_000), /rounds to 0/);
  assert.equal(priceTokens(1e-12, 1), 1n);
});

test("ensureReservation serves a covered near-expiry reservation with the whole balance locked (no doomed 1n reserve)", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000060" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  const secNow = Math.floor(Date.now() / 1000);
  client.readVaultState = async () => ({
    balance: 5_000n,
    lockedTotal: 5_000n,
    withdrawable: 0n,
    sessionKey: "0x0000000000000000000000000000000000000060",
    reserveNonce: 0n,
    keyEpoch: 7n,
  });
  client.maxReserveTtl = async () => 604800n;
  client.redeemGrace = async () => 21600n;
  const ops = { locked: 5_000n, redeemed: 0n, expiry: BigInt(secNow + 60), created: BigInt(secNow), cycle: 3n };
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

test("ensureReservation rejects an aborted queued job promptly and skips its vault work", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000068" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  client.ensureColdReservation = async (operator) => {
    calls.push(operator);
    await firstGate;
    return {
      ops: { locked: 1_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    };
  };

  const first = client.ensureReservation(
    "0x00000000000000000000000000000000000000a1",
    1_000n
  );
  while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = client.ensureReservation(
    "0x00000000000000000000000000000000000000a2",
    1_000n,
    controller.signal
  );
  controller.abort(new Error("client disconnected"));
  await assert.rejects(
    Promise.race([
      second,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("queued abort timed out")), 500)
      ),
    ]),
    /client disconnected/
  );
  releaseFirst();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["0x00000000000000000000000000000000000000a1"]);
});

test("ensureReservation propagates abort to in-flight vault reads before mutation", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x0000000000000000000000000000000000000069" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
  let readStarted;
  const started = new Promise((resolve) => {
    readStarted = resolve;
  });
  client.readVaultState = async (signal) => {
    assert.ok(signal);
    readStarted();
    return new Promise((_, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  client.readOps = async (_operator, signal) => {
    assert.ok(signal);
    return { locked: 0n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 0n };
  };
  let reserveAttempted = false;
  client.postReserve = async () => {
    reserveAttempted = true;
    return "0xreserve";
  };

  const controller = new AbortController();
  const reservation = client.ensureReservation(
    "0x00000000000000000000000000000000000000a3",
    1_000n,
    controller.signal
  );
  await started;
  controller.abort(new Error("client disconnected"));
  await assert.rejects(
    Promise.race([
      reservation,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("in-flight abort timed out")), 500)
      ),
    ]),
    /client disconnected/
  );
  assert.equal(reserveAttempted, false);
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
    sessionKey: "0x0000000000000000000000000000000000000062",
    reserveNonce: 0n,
    keyEpoch: 1n,
  });
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
  client.readVaultState = async () => ({
    ...base,
    sessionKey: "0x00000000000000000000000000000000000000a0",
  });
  assert.equal((await client.checkSessionKey()).status, "match");
  client.readVaultState = async () => ({
    ...base,
    sessionKey: "0x00000000000000000000000000000000000000ff",
  });
  const mismatch = await client.checkSessionKey();
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.registered, "0x00000000000000000000000000000000000000ff");
  assert.equal(mismatch.expected, wallet);
});

test("ensureReservation fails closed on a session-key mismatch - never serves unpayable work (#426)", async () => {
  const client = new HaloVaultClient(
    { getAddress: async () => "0x00000000000000000000000000000000000000A1" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
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
  client.readVaultState = async () => ({ ...base, sessionKey: sessionAddr });
  assert.equal((await client.checkSessionKey()).status, "match");
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
  global.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/vault/info")
          ? { vault: VAULT_ADDRESS }
          : { balance: "10", lockedTotal: "0", withdrawable: "10", reserveNonce: "0", keyEpoch: "0" }
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const client = new HaloVaultClient(
    { getAddress: async () => "0x00000000000000000000000000000000000000A3" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
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

test("readVaultState trusts the facilitator read only after matching its vault identity (#426)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const key = "0x00000000000000000000000000000000000000dd";
  global.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/vault/info")
          ? { vault: VAULT_ADDRESS }
          : {
              balance: "5",
              lockedTotal: "0",
              withdrawable: "5",
              sessionKey: key,
              reserveNonce: "1",
              keyEpoch: "2",
            }
      ),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  const client = new HaloVaultClient(
    { getAddress: async () => "0x00000000000000000000000000000000000000A4" },
    { facilitatorUrl: "https://facilitator.invalid", rpcUrl: "http://127.0.0.1:1", chainId: 8453 }
  );
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
    if (calls === 2) return insufficient402("5000");
    if (calls === 3) return insufficient402("8000");
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
    return insufficient402(String(1000 * calls));
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
  assert.equal(calls, 4);
  assert.equal(result.status, 402);
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false, "a payment-gate 402 must never redeem");
});
