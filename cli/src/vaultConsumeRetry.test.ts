import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  EMPTY_VAULT_SSE_REPLAY_DIGEST,
  VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
  VAULT_SSE_REPLAY_MANIFEST_TYPES,
  advanceVaultSseReplayDigest,
  digestVaultSseReplayRequest,
  parseVaultSseReplayPrepareRequest,
  recoverVaultSseReplayReceiptSigner,
  vaultSseReplayDomain,
  vaultSseReplayManifestValue,
  type VaultSseReplayPair,
  type VaultSseReplayPrepareRequest,
  type VaultSseReplayUnsignedManifest,
} from "@halo/vault-core";
import { vaultSend } from "./commands/consume";
import type { VaultConsumeClient } from "./vault-consume";
import { HALO_VERSION } from "./version";

function replayEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("vaultSend uses capable CLI replay and returns only after exact receipt custody", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const consumerSession = Wallet.createRandom();
  const operatorWallet = Wallet.createRandom();
  const vaultAddress = Wallet.createRandom().address.toLowerCase();
  const consumer = Wallet.createRandom().address.toLowerCase();
  const requestId = "00000000-0000-4000-8000-000000000002";
  const resumeToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const frame = JSON.stringify({
    id: "chat-cli",
    object: "chat.completion.chunk",
    created: 2_345,
    model: "test/model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
  });
  const responseDigest = advanceVaultSseReplayDigest(
    EMPTY_VAULT_SSE_REPLAY_DIGEST,
    frame
  );
  let prepared: VaultSseReplayPrepareRequest | undefined;
  let ordinaryPosts = 0;
  let receiptDelivered = false;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/prepare")) {
      prepared = parseVaultSseReplayPrepareRequest(
        JSON.parse(String(init?.body))
      ) ?? undefined;
      assert.ok(prepared);
      return Response.json(
        {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId,
          resumeToken,
          prepareExpiresAtMs: Date.now() + 10_000,
        },
        { status: 201 }
      );
    }
    if (url.endsWith("/attach")) {
      assert.ok(prepared);
      const pair = prepared.pair as VaultSseReplayPair;
      const unsigned: VaultSseReplayUnsignedManifest = {
        protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
        requestId,
        requestDigest: digestVaultSseReplayRequest(prepared.requestBody),
        responseDigest,
        vault: pair.vault,
        consumer: pair.consumer,
        operator: pair.operator,
        cycle: pair.cycle,
        keyEpoch: pair.keyEpoch,
        amountUsdc: "11",
        frameCount: 1,
        outcome: "success",
      };
      const manifest = {
        ...unsigned,
        signature: await operatorWallet.signTypedData(
          vaultSseReplayDomain(pair.chainId, pair.vault),
          VAULT_SSE_REPLAY_MANIFEST_TYPES,
          vaultSseReplayManifestValue(unsigned)
        ),
      };
      const resultExpiresAtMs = Date.now() + 30_000;
      return new Response(
        replayEvent("halo-replay-attached", {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId,
          state: "complete",
          resultExpiresAtMs,
        }) +
          replayEvent("halo-replay-frame", {
            requestId,
            index: 0,
            data: frame,
            encrypted: true,
          }) +
          replayEvent("halo-replay-result", {
            manifest,
            resultExpiresAtMs,
          }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (url.endsWith("/receipt")) {
      const delivery = JSON.parse(String(init?.body));
      assert.equal(
        recoverVaultSseReplayReceiptSigner(delivery),
        consumerSession.address.toLowerCase()
      );
      receiptDelivered = true;
      return Response.json({ accepted: true, requestId }, { status: 202 });
    }
    if (url.endsWith("/v1/chat/completions")) ordinaryPosts += 1;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  let replayRecorded = false;
  const receiptSignature = await consumerSession.signMessage("vault receipt");
  const client = {
    ensureReservation: async () => ({
      ops: {
        locked: 1_000n,
        redeemed: 20n,
        expiry: 0n,
        created: 0n,
        cycle: 7n,
      },
      keyEpoch: 2n,
    }),
    consumer: async () => consumer,
    recordAndRedeem: () => {
      throw new Error("legacy receipt path must not run");
    },
    recordReplayAndRedeem: async (
      servedBy: string,
      _ops: unknown,
      keyEpoch: bigint,
      cost: bigint,
      takeCustody: (receipt: {
        priorCumulative: string;
        targetCumulative: string;
        receiptSignature: string;
      }) => Promise<void>
    ) => {
      assert.equal(servedBy, operatorWallet.address.toLowerCase());
      assert.equal(keyEpoch, 2n);
      assert.equal(cost, 11n);
      await takeCustody({
        priorCumulative: "20",
        targetCumulative: "31",
        receiptSignature,
      });
      replayRecorded = true;
    },
  } as unknown as VaultConsumeClient;
  const request = {
    model: "test/model",
    stream: true,
    _enc: { encrypted: "request" },
  };
  const result = await vaultSend(
    client,
    "https://relay.invalid/v1/chat/completions",
    request,
    {
      forwardHeaders: {},
      signal: new AbortController().signal,
      operator: operatorWallet.address.toLowerCase(),
      priceUsdPerMtok: 1,
      estTokens: 100,
      replay: {
        relayUrl: "https://relay.invalid",
        vaultAddress,
        sessionWallet: consumerSession,
        decryptFrame: async (value) => value,
      },
    }
  );

  assert.equal(ordinaryPosts, 0);
  assert.equal(receiptDelivered, true);
  assert.equal(replayRecorded, true);
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "11");
  assert.equal(result.e2eDecrypted, true);
  assert.deepEqual(JSON.parse(result.body), {
    id: "chat-cli",
    object: "chat.completion",
    created: 2_345,
    model: "test/model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        finish_reason: "stop",
      },
    ],
  });
  assert.deepEqual(JSON.parse(prepared?.requestBody ?? "null"), {
    ...request,
    maxAmountUsdc: "120",
  });
  assert.deepEqual(prepared?.pair, {
    chainId: "8453",
    vault: vaultAddress,
    consumer,
    operator: operatorWallet.address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  });
});

test("vaultSend re-reserves the typed operator requirement and retries the unserved request once", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const requestBodies: string[] = [];
  const requestVersions: Array<string | null> = [];
  let sends = 0;
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sends += 1;
    requestBodies.push(String(init?.body ?? ""));
    requestVersions.push(new Headers(init?.headers).get("X-Halo-Cli-Version"));
    if (sends === 1) {
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
    const settlement = Buffer.from(JSON.stringify({ amountUsdc: "73" })).toString("base64");
    return new Response('{"choices":[]}', {
      status: 200,
      headers: { "PAYMENT-RESPONSE": settlement },
    });
  }) as typeof fetch;

  const ensured: bigint[] = [];
  let redeemed:
    | { operator: string; cycle: bigint; keyEpoch: bigint; cost: bigint }
    | undefined;
  const operator = "0x0000000000000000000000000000000000000031";
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => {
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
    consumer: async () => "0x0000000000000000000000000000000000000032",
    recordAndRedeem: (
      servedBy: string,
      ops: { cycle: bigint },
      keyEpoch: bigint,
      cost: bigint
    ) => {
      redeemed = { operator: servedBy, cycle: ops.cycle, keyEpoch, cost };
    },
  } as unknown as VaultConsumeClient;

  const result = await vaultSend(client, "https://relay.invalid/v1/chat/completions", {
    model: "model",
    messages: [{ role: "user", content: "hello" }],
  }, {
    forwardHeaders: {},
    signal: new AbortController().signal,
    operator,
    priceUsdPerMtok: 1,
    estTokens: 1_000,
  });

  assert.equal(sends, 2);
  assert.deepEqual(requestBodies, [requestBodies[0], requestBodies[0]], "retry replays the same body");
  assert.deepEqual(requestVersions, [HALO_VERSION, HALO_VERSION]);
  assert.equal(ensured.length, 2);
  assert.equal(ensured[1], 5_000n);
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "73");
  assert.deepEqual(redeemed, { operator, cycle: 2n, keyEpoch: 2n, cost: 73n });
});

function meteringClient(operator: string): {
  client: VaultConsumeClient;
  redeemed: () => { operator: string; cost: bigint } | undefined;
} {
  let redeemed: { operator: string; cost: bigint } | undefined;
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x00000000000000000000000000000000000000c0",
    recordAndRedeem: (servedBy: string, _ops: unknown, _epoch: bigint, cost: bigint) => {
      redeemed = { operator: servedBy, cost };
    },
  } as unknown as VaultConsumeClient;
  return { client, redeemed: () => redeemed };
}

const runVaultSend = (client: VaultConsumeClient, operator: string) =>
  vaultSend(
    client,
    "https://relay.invalid/v1/chat/completions",
    { model: "model", messages: [{ role: "user", content: "hello" }] },
    { forwardHeaders: {}, signal: new AbortController().signal, operator, priceUsdPerMtok: 1, estTokens: 1_000 }
  );

test("vaultSend meters from body usage when the operator omits PAYMENT-RESPONSE (F1/#4)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = (async () =>
    new Response(JSON.stringify({ choices: [], usage: { total_tokens: 1000 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const operator = "0x00000000000000000000000000000000000000c1";
  const { client, redeemed } = meteringClient(operator);
  const result = await runVaultSend(client, operator);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "1000");
  assert.deepEqual(redeemed(), { operator, cost: 1000n });
});

test("vaultSend meters a body settlement frame even under a generic content-type (F1/F2/#3)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "88" })).toString("base64");
  global.fetch = (async () =>
    new Response(
      `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
        `event: halo-settlement\ndata: ${JSON.stringify({ paymentResponse })}\n\n`,
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
  const operator = "0x00000000000000000000000000000000000000c2";
  const { client, redeemed } = meteringClient(operator);
  const result = await runVaultSend(client, operator);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "88");
  assert.deepEqual(redeemed(), { operator, cost: 88n });
});

const creditWindow402 = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "vault_credit_window_exceeded",
        message: "Vault credit window exceeded: awaiting a receipt for prior work",
        requiredUsdcBase: "6160",
      },
    }),
    { status: 402, headers: { "content-type": "application/json" } }
  );

test("vaultSend waits out a transiently full credit window and replays the identical request", async (t) => {
  const originalFetch = global.fetch;
  const originalWait = process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS;
  process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS = "1";
  t.after(() => {
    global.fetch = originalFetch;
    if (originalWait === undefined) delete process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS;
    else process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS = originalWait;
  });
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "42" })).toString("base64");
  const requestBodies: string[] = [];
  let sends = 0;
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sends += 1;
    requestBodies.push(String(init?.body ?? ""));
    if (sends <= 2) return creditWindow402();
    return new Response('{"choices":[]}', {
      status: 200,
      headers: { "PAYMENT-RESPONSE": paymentResponse },
    });
  }) as typeof fetch;
  let reservations = 0;
  const operator = "0x00000000000000000000000000000000000000c5";
  const client = {
    ensureReservation: async () => {
      reservations += 1;
      return {
        ops: { locked: 1_000_000n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
        keyEpoch: 1n,
      };
    },
    consumer: async () => "0x00000000000000000000000000000000000000c6",
    recordAndRedeem: () => {},
  } as unknown as VaultConsumeClient;
  const result = await runVaultSend(client, operator);
  assert.equal(sends, 3, "first send + two credit-window waits");
  assert.equal(reservations, 1, "a full credit window must not trigger re-reservation");
  assert.deepEqual(
    requestBodies,
    [requestBodies[0], requestBodies[0], requestBodies[0]],
    "each credit-window replay resends the identical body"
  );
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "42");
});

test("vaultSend surfaces a persistently full credit window after bounded waits", async (t) => {
  const originalFetch = global.fetch;
  const originalWait = process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS;
  process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS = "1";
  t.after(() => {
    global.fetch = originalFetch;
    if (originalWait === undefined) delete process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS;
    else process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS = originalWait;
  });
  let sends = 0;
  global.fetch = (async () => {
    sends += 1;
    return creditWindow402();
  }) as typeof fetch;
  const operator = "0x00000000000000000000000000000000000000c7";
  const { client, redeemed } = meteringClient(operator);
  const result = await runVaultSend(client, operator);
  assert.equal(sends, 4, "first send + the bounded credit-window replays");
  assert.equal(result.status, 402);
  assert.equal(result.paid, false);
  assert.equal(redeemed(), undefined);
});

test("vaultSend aborts a pending credit-window wait when the caller disconnects", async (t) => {
  const originalFetch = global.fetch;
  const originalWait = process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS;
  process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS = "60000";
  t.after(() => {
    global.fetch = originalFetch;
    if (originalWait === undefined) delete process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS;
    else process.env.HALO_VAULT_CREDIT_WAIT_BASE_MS = originalWait;
  });
  const controller = new AbortController();
  global.fetch = (async () => {
    queueMicrotask(() => controller.abort(new Error("client disconnected")));
    return creditWindow402();
  }) as typeof fetch;
  const operator = "0x00000000000000000000000000000000000000c8";
  const { client } = meteringClient(operator);
  await assert.rejects(
    vaultSend(
      client,
      "https://relay.invalid/v1/chat/completions",
      { model: "model", messages: [{ role: "user", content: "hello" }] },
      { forwardHeaders: {}, signal: controller.signal, operator, priceUsdPerMtok: 1, estTokens: 1_000 }
    ),
    /client disconnected/
  );
});

test("vaultSend retries reservation-insufficient 402s more than once, up to the bounded cap (F6)", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "55" })).toString("base64");
  let sends = 0;
  global.fetch = (async () => {
    sends += 1;
    if (sends === 1 || sends === 2) {
      return new Response(
        JSON.stringify({
          error: { type: "vault_reservation_insufficient", requiredUsdcBase: String(5000 * sends) },
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      );
    }
    return new Response('{"choices":[]}', {
      status: 200,
      headers: { "PAYMENT-RESPONSE": paymentResponse },
    });
  }) as typeof fetch;
  const ensured: bigint[] = [];
  const operator = "0x00000000000000000000000000000000000000c3";
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => {
      ensured.push(cost);
      const n = BigInt(ensured.length);
      return { ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: n }, keyEpoch: n };
    },
    consumer: async () => "0x00000000000000000000000000000000000000c4",
    recordAndRedeem: () => {},
  } as unknown as VaultConsumeClient;
  const result = await runVaultSend(client, operator);
  assert.equal(sends, 3, "first send + two reserve-and-replay retries");
  assert.deepEqual(ensured.slice(1), [5000n, 10000n], "each retry reserves the next reported floor");
  assert.equal(result.status, 200);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "55");
});
