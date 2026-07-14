import test from "node:test";
import assert from "node:assert/strict";
import { vaultSend } from "./commands/consume";
import type { VaultConsumeClient } from "./vault-consume";
import { HALO_VERSION } from "./version";

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
