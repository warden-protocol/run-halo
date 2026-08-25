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
  recoverVaultSseReplayCommandSigner,
  recoverVaultSseReplayReceiptSigner,
  vaultSseReplayDomain,
  vaultSseReplayManifestValue,
  type VaultSseReplayManifest,
  type VaultSseReplayPair,
  type VaultSseReplayUnsignedManifest,
} from "@halo/vault-core";
import {
  buildCliVaultSseReplayRequestBody,
  cliOperatorSupportsVaultSseReplayModel,
  deliverCliVaultSseReplayReceipt,
  runCliVaultSseReplay,
} from "./vaultSseReplayConsumer";

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("CLI replay selection requires the requested model in the exact list", () => {
  const globalOnly = { vaultProtocols: [VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL] };
  const mixed = {
    vaultProtocols: [VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL],
    vaultSseReplayV1Models: ["vendor/supported"],
  };
  assert.equal(cliOperatorSupportsVaultSseReplayModel(globalOnly, "vendor/supported"), false);
  assert.equal(cliOperatorSupportsVaultSseReplayModel(mixed, "vendor/supported"), true);
  assert.equal(cliOperatorSupportsVaultSseReplayModel(mixed, "vendor/other"), false);
  assert.equal(
    cliOperatorSupportsVaultSseReplayModel(
      { vaultSseReplayV1Models: ["vendor/supported-plus"] },
      "vendor/supported"
    ),
    false
  );
});

test("CLI replay request body passes the shared relay prepare parser", () => {
  const parsed = parseVaultSseReplayPrepareRequest({
    protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    path: "/v1/chat/completions",
    requestBody: JSON.stringify(
      buildCliVaultSseReplayRequestBody(
        "test/model",
        { ciphertext: "request" },
        100n
      )
    ),
    pair: {
      chainId: "8453",
      vault: "0x1111111111111111111111111111111111111111",
      consumer: "0x2222222222222222222222222222222222222222",
      operator: "0x3333333333333333333333333333333333333333",
      cycle: "7",
      keyEpoch: "2",
    },
  });

  assert.ok(parsed);
  assert.equal(JSON.parse(parsed.requestBody).stream, true);
});

test("CLI replay stops immediately when the operator rejects the signed attachment", async () => {
  const consumerSession = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const pair: VaultSseReplayPair = {
    chainId: "8453",
    vault: Wallet.createRandom().address.toLowerCase(),
    consumer: Wallet.createRandom().address.toLowerCase(),
    operator: operator.address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  };
  const requestId = "00000000-0000-4000-8000-000000000002";
  const resumeToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const paths: string[] = [];
  let cancelling = false;
  let cancelSignalAborted = false;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    paths.push(new URL(url).pathname);
    if (url.endsWith("/prepare")) {
      return Response.json(
        {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId,
          resumeToken,
          prepareExpiresAtMs: 11_000,
        },
        { status: 201 }
      );
    }
    if (url.endsWith("/attach")) {
      cancelling = true;
      return new Response(
        event("halo-replay-invalid", { requestId }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (url.endsWith("/cancel")) {
      cancelSignalAborted = init?.signal?.aborted === true;
      return new Promise<Response>(() => {});
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  await assert.rejects(
    runCliVaultSseReplay({
      relayUrl: "https://relay.example",
      path: "/v1/chat/completions",
      requestBody: JSON.stringify({
        model: "test/model",
        stream: true,
        _enc: { ciphertext: "request" },
        maxAmountUsdc: "100",
      }),
      maxAmountUsdc: 100n,
      pair,
      sessionWallet: consumerSession,
      decryptFrame: async (value) => value,
      fetchImpl,
      now: (() => {
        let cancelCalls = 0;
        return () => cancelling ? 3_000 * ++cancelCalls : 1_000;
      })(),
      sleep: async () => {},
    }),
    /authorization failed verification/
  );
  assert.deepEqual(paths, [
    "/v1/vault-sse-replay/prepare",
    "/v1/vault-sse-replay/attach",
    "/v1/vault-sse-replay/cancel",
  ]);
  assert.equal(cancelSignalAborted, true);
});

test("CLI replay cancellation interrupts reconnect backoff and sends cancel", async () => {
  const consumerSession = Wallet.createRandom();
  const pair: VaultSseReplayPair = {
    chainId: "8453",
    vault: Wallet.createRandom().address.toLowerCase(),
    consumer: Wallet.createRandom().address.toLowerCase(),
    operator: Wallet.createRandom().address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  };
  const requestId = "00000000-0000-4000-8000-000000000012";
  const resumeToken = "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL";
  const paths: string[] = [];
  const controller = new AbortController();
  let notifySleepStarted!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    notifySleepStarted = resolve;
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    paths.push(new URL(url).pathname);
    if (url.endsWith("/prepare")) {
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
    if (url.endsWith("/attach")) throw new Error("SSE dropped");
    if (url.endsWith("/cancel")) {
      return Response.json({ cancelled: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const running = runCliVaultSseReplay({
    relayUrl: "https://relay.example",
    path: "/v1/chat/completions",
    requestBody: JSON.stringify({
      model: "test/model",
      stream: true,
      _enc: { ciphertext: "request" },
      maxAmountUsdc: "100",
    }),
    maxAmountUsdc: 100n,
    pair,
    sessionWallet: consumerSession,
    decryptFrame: async (value) => value,
    signal: controller.signal,
    fetchImpl,
    sleep: async () => {
      notifySleepStarted();
      await new Promise<void>(() => {});
    },
  });

  await sleepStarted;
  controller.abort(new Error("stop requested"));
  await assert.rejects(
    Promise.race([
      running,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("abort did not interrupt backoff")), 1_000)
      ),
    ]),
    /stop requested/
  );
  assert.deepEqual(paths, [
    "/v1/vault-sse-replay/prepare",
    "/v1/vault-sse-replay/attach",
    "/v1/vault-sse-replay/cancel",
  ]);
});

test("CLI replay bounds an attachment that never returns response headers", async () => {
  const consumerSession = Wallet.createRandom();
  const pair: VaultSseReplayPair = {
    chainId: "8453",
    vault: Wallet.createRandom().address.toLowerCase(),
    consumer: Wallet.createRandom().address.toLowerCase(),
    operator: Wallet.createRandom().address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  };
  const paths: string[] = [];
  let attachSignalAborted = false;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    paths.push(new URL(url).pathname);
    if (url.endsWith("/prepare")) {
      return Response.json(
        {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId: "00000000-0000-4000-8000-000000000004",
          resumeToken: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
          prepareExpiresAtMs: 10_000,
        },
        { status: 201 }
      );
    }
    if (url.endsWith("/attach")) {
      init?.signal?.addEventListener("abort", () => {
        attachSignalAborted = true;
      });
      return new Promise<Response>(() => {});
    }
    if (url.endsWith("/cancel")) {
      return Response.json({ accepted: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let nowCalls = 0;

  await assert.rejects(
    runCliVaultSseReplay({
      relayUrl: "https://relay.example",
      path: "/v1/chat/completions",
      requestBody: JSON.stringify({
        model: "test/model",
        stream: true,
        _enc: { ciphertext: "request" },
        maxAmountUsdc: "100",
      }),
      maxAmountUsdc: 100n,
      pair,
      sessionWallet: consumerSession,
      decryptFrame: async (value) => value,
      fetchImpl,
      now: () => ++nowCalls >= 7 ? 119_995 : 0,
      sleep: async () => {},
    }),
    /inference deadline/
  );
  assert.equal(attachSignalAborted, true);
  assert.deepEqual(paths, [
    "/v1/vault-sse-replay/prepare",
    "/v1/vault-sse-replay/attach",
    "/v1/vault-sse-replay/cancel",
  ]);
});

test("CLI replay enforces its inference deadline while an SSE read is stalled", async () => {
  const consumerSession = Wallet.createRandom();
  const pair: VaultSseReplayPair = {
    chainId: "8453",
    vault: Wallet.createRandom().address.toLowerCase(),
    consumer: Wallet.createRandom().address.toLowerCase(),
    operator: Wallet.createRandom().address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  };
  const paths: string[] = [];
  let readerCancelled = false;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    paths.push(new URL(url).pathname);
    if (url.endsWith("/prepare")) {
      return Response.json(
        {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId: "00000000-0000-4000-8000-000000000003",
          resumeToken: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          prepareExpiresAtMs: 10_000,
        },
        { status: 201 }
      );
    }
    if (url.endsWith("/attach")) {
      return new Response(new ReadableStream({
        start() {},
        cancel() {
          readerCancelled = true;
          return new Promise<void>(() => {});
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.endsWith("/cancel")) {
      return Response.json({ accepted: true }, { status: 202 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  let nowCalls = 0;

  await assert.rejects(
    runCliVaultSseReplay({
      relayUrl: "https://relay.example",
      path: "/v1/chat/completions",
      requestBody: JSON.stringify({
        model: "test/model",
        stream: true,
        _enc: { ciphertext: "request" },
        maxAmountUsdc: "100",
      }),
      maxAmountUsdc: 100n,
      pair,
      sessionWallet: consumerSession,
      decryptFrame: async (value) => value,
      fetchImpl,
      now: () => ++nowCalls >= 7 ? 119_995 : 0,
      sleep: async () => {},
    }),
    /inference deadline/
  );
  assert.deepEqual(paths, [
    "/v1/vault-sse-replay/prepare",
    "/v1/vault-sse-replay/attach",
    "/v1/vault-sse-replay/cancel",
  ]);
  assert.equal(readerCancelled, true);
});

test("CLI replay resumes from frame zero, preserves tool calls, and retries exact receipt custody", async () => {
  const consumerSession = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const pair: VaultSseReplayPair = {
    chainId: "8453",
    vault: Wallet.createRandom().address.toLowerCase(),
    consumer: Wallet.createRandom().address.toLowerCase(),
    operator: operator.address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  };
  const requestBody = JSON.stringify({
    model: "test/model",
    stream: true,
    _enc: { ciphertext: "request" },
    maxAmountUsdc: "100",
  });
  const requestId = "00000000-0000-4000-8000-000000000001";
  const resumeToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const frame0 = JSON.stringify({
    id: "chat-1",
    object: "chat.completion.chunk",
    created: 1_234,
    model: "test/model",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "weather", arguments: "{\"city\":" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  const frame1 = JSON.stringify({
    id: "chat-1",
    object: "chat.completion.chunk",
    created: 1_234,
    model: "test/model",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: "\"Paris\"}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const frame2 = JSON.stringify({
    id: "chat-1",
    object: "chat.completion.chunk",
    created: 1_234,
    model: "test/model",
    choices: [],
    usage: { total_tokens: 9 },
  });
  const responseDigest = [frame0, frame1, frame2].reduce(
    advanceVaultSseReplayDigest,
    EMPTY_VAULT_SSE_REPLAY_DIGEST
  );
  const unsignedManifest: VaultSseReplayUnsignedManifest = {
    protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    requestId,
    requestDigest: digestVaultSseReplayRequest(requestBody),
    responseDigest,
    vault: pair.vault,
    consumer: pair.consumer,
    operator: pair.operator,
    cycle: pair.cycle,
    keyEpoch: pair.keyEpoch,
    amountUsdc: "11",
    frameCount: 3,
    outcome: "success",
  };
  const manifest: VaultSseReplayManifest = {
    ...unsignedManifest,
    signature: await operator.signTypedData(
      vaultSseReplayDomain(pair.chainId, pair.vault),
      VAULT_SSE_REPLAY_MANIFEST_TYPES,
      vaultSseReplayManifestValue(unsignedManifest)
    ),
  };
  const requestBodies: unknown[] = [];
  let receiptAttempts = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
    if (url.endsWith("/prepare")) {
      return Response.json(
        {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId,
          resumeToken,
          prepareExpiresAtMs: 11_000,
        },
        { status: 201 }
      );
    }
    if (url.endsWith("/attach")) {
      return new Response(
        event("halo-replay-attached", {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId,
          state: "running",
          resultExpiresAtMs: null,
        }) +
          event("halo-replay-frame", {
            requestId,
            index: 0,
            data: frame0,
            encrypted: true,
          }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (url.endsWith("/resume")) {
      return new Response(
        event("halo-replay-attached", {
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          requestId,
          state: "complete",
          resultExpiresAtMs: 31_000,
        }) +
          [frame0, frame1, frame2]
            .map((data, index) =>
              event("halo-replay-frame", {
                requestId,
                index,
                data,
                encrypted: true,
              })
            )
            .join("") +
          event("halo-replay-result", {
            manifest,
            resultExpiresAtMs: 31_000,
          }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    }
    if (url.endsWith("/receipt")) {
      receiptAttempts += 1;
      return Response.json(
        receiptAttempts === 1
          ? { error: { message: "ack lost" } }
          : { accepted: true, requestId },
        { status: receiptAttempts === 1 ? 503 : 202 }
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const delays: number[] = [];

  const result = await runCliVaultSseReplay({
    relayUrl: "https://relay.example",
    path: "/v1/chat/completions",
    requestBody,
    maxAmountUsdc: 100n,
    pair,
    sessionWallet: consumerSession,
    decryptFrame: async (value) => value,
    fetchImpl,
    now: () => 1_000,
    sleep: async (delay) => {
      delays.push(delay);
    },
  });

  assert.deepEqual(result.body, {
    id: "chat-1",
    object: "chat.completion",
    created: 1_234,
    model: "test/model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "weather",
                arguments: "{\"city\":\"Paris\"}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { total_tokens: 9 },
  });
  const commands = requestBodies.filter(
    (body): body is Record<string, unknown> =>
      typeof body === "object" && body !== null && "command" in body
  );
  assert.deepEqual(
    commands.map((command) => command.command),
    ["attach", "resume"]
  );
  assert.equal(commands[0].requestBody, requestBody);
  assert.equal("requestBody" in commands[1], false);
  for (const command of commands) {
    assert.equal(
      recoverVaultSseReplayCommandSigner(command as never),
      consumerSession.address.toLowerCase()
    );
  }

  const receiptSignature = await consumerSession.signMessage(
    "unchanged vault receipt"
  );
  await deliverCliVaultSseReplayReceipt(
    result,
    consumerSession,
    {
      priorCumulative: "20",
      targetCumulative: "31",
      receiptSignature,
    },
    {
      relayUrl: "https://relay.example",
      fetchImpl,
      now: () => 1_000,
      sleep: async (delay) => {
        delays.push(delay);
      },
    }
  );

  const deliveries = requestBodies.filter(
    (body): body is Record<string, unknown> =>
      typeof body === "object" && body !== null && "receiptSignature" in body
  );
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.equal(
    recoverVaultSseReplayReceiptSigner(deliveries[0] as never),
    consumerSession.address.toLowerCase()
  );
  assert.deepEqual(delays, [1_000, 1_000]);
});

test("CLI replay receipt delivery is bounded by result expiry before response headers", async () => {
  const session = Wallet.createRandom();
  const pair: VaultSseReplayPair = {
    chainId: "8453",
    vault: Wallet.createRandom().address.toLowerCase(),
    consumer: session.address.toLowerCase(),
    operator: Wallet.createRandom().address.toLowerCase(),
    cycle: "7",
    keyEpoch: "2",
  };
  let receiptSignalAborted = false;
  const fetchImpl = (async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    init?.signal?.addEventListener("abort", () => {
      receiptSignalAborted = true;
    });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const receiptSignature = await session.signMessage("replay receipt");

  await assert.rejects(
    deliverCliVaultSseReplayReceipt(
      {
        body: {},
        manifest: {
          responseDigest: EMPTY_VAULT_SSE_REPLAY_DIGEST,
        } as VaultSseReplayManifest,
        resultExpiresAtMs: 10,
        requestId: "00000000-0000-4000-8000-000000000005",
        resumeToken: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
        pair,
      },
      session,
      {
        priorCumulative: "0",
        targetCumulative: "1",
        receiptSignature,
      },
      {
        relayUrl: "https://relay.example",
        fetchImpl,
        now: () => 0,
        sleep: async () => {},
      }
    ),
    /before expiry/
  );
  assert.equal(receiptSignalAborted, true);
});
