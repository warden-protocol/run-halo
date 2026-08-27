import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_COMPLETION_CEILING_TOKENS,
  requestCompletionCeilingTokens,
} from "@halo/vault-core";
import {
  chatCompletionsToAnthropicRequest,
  type OpenAIChatRequest,
} from "./anthropic-adapter";
import type { HaloConfig, ProviderConfig } from "./config";
import {
  buildVaultSseReplayPricingCapabilityAnnounce,
  buildVaultSseReplayModelsAnnounce,
  callUpstream,
  forwardVaultCompletionLimit,
  invalidVaultTextGenerationControlField,
  shouldAnnounceLegacyGlobalVaultReplay,
  streamUpstream,
} from "./commands/serve";

function configFor(provider: ProviderConfig): HaloConfig {
  return {
    version: 1,
    relayUrl: "http://relay.test",
    indexerUrl: "http://indexer.test",
    operator: {
      address: "0x0000000000000000000000000000000000000001",
      keystorePath: "/tmp/keystore.json",
    },
    provider,
    pricing: {
      mode: "flat",
      flatUsdcPer1KTokens: 0.001,
      fallbackPerRequestUsdc: 1_000,
    },
    facilitator: { url: "http://facilitator.test" },
  };
}

test("forwardVaultCompletionLimit emits one provider-compatible alias", async () => {
  const legacyProvider: ProviderConfig = {
    slug: "venice",
    baseUrl: "https://venice.test/v1",
    models: ["minimax/minimax-m2.5"],
  };
  const reasoningBody = {
    model: "minimax/minimax-m2.5",
    messages: [{ role: "user", content: "hi" }],
  };
  const reasoningGate = requestCompletionCeilingTokens(reasoningBody);
  const compatible = await forwardVaultCompletionLimit(
    reasoningBody,
    legacyProvider,
    reasoningGate
  );
  assert.equal(reasoningGate, 8192);
  assert.equal(compatible.max_tokens, reasoningGate);
  assert.equal(compatible.max_completion_tokens, undefined);
  assert.equal((reasoningBody as Record<string, unknown>).max_tokens, undefined);

  const directOpenAiProvider: ProviderConfig = {
    slug: "openai",
    baseUrl: "https://openai.test/v1",
    models: ["gpt-4o"],
  };
  const directOpenAiBody = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  const directOpenAiGate = requestCompletionCeilingTokens(directOpenAiBody);
  const directOpenAi = await forwardVaultCompletionLimit(
    directOpenAiBody,
    directOpenAiProvider,
    directOpenAiGate
  );
  assert.equal(directOpenAiGate, DEFAULT_COMPLETION_CEILING_TOKENS);
  assert.equal(directOpenAi.max_completion_tokens, directOpenAiGate);
  assert.equal(directOpenAi.max_tokens, undefined);
});

test("forwardVaultCompletionLimit translates explicit aliases conservatively", async () => {
  const provider: ProviderConfig = {
    slug: "openai",
    baseUrl: "https://openai-alias.test/v1",
    models: ["gpt-5"],
  };
  const cases = [
    { body: { model: "gpt-5", max_tokens: 7 }, expected: 7 },
    { body: { model: "gpt-5", max_completion_tokens: 11 }, expected: 11 },
    { body: { model: "gpt-5", max_tokens: 7, max_completion_tokens: 11 }, expected: 7 },
  ];
  for (const { body, expected } of cases) {
    const forwarded = await forwardVaultCompletionLimit(
      body,
      provider,
      requestCompletionCeilingTokens(body)
    );
    assert.equal(forwarded.max_completion_tokens, expected);
    assert.equal(forwarded.max_tokens, undefined);
  }
});

test("catalog capabilities choose modern, legacy, or no completion-limit alias per model", async (t) => {
  const provider: ProviderConfig = {
    slug: "openrouter",
    baseUrl: "https://capabilities.test/v1",
    models: ["modern", "legacy", "neither", "unknown"],
  };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async (url) => {
    assert.equal(String(url), "https://capabilities.test/v1/models");
    return new Response(
      JSON.stringify({
        data: [
          { id: "modern", supported_parameters: ["max_completion_tokens"] },
          { id: "legacy", supported_parameters: ["max_tokens"] },
          { id: "neither", supported_parameters: ["temperature"] },
          { id: "unknown" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const modern = await forwardVaultCompletionLimit(
    { model: "modern", max_tokens: 9 },
    provider,
    100
  );
  const legacy = await forwardVaultCompletionLimit(
    { model: "legacy", max_completion_tokens: 11 },
    provider,
    100
  );
  const neither = await forwardVaultCompletionLimit(
    { model: "neither", max_tokens: 7 },
    provider,
    100
  );
  assert.deepEqual(modern, { model: "modern", max_completion_tokens: 9 });
  assert.deepEqual(legacy, { model: "legacy", max_tokens: 11 });
  assert.deepEqual(neither, { model: "neither" });
  await assert.rejects(
    forwardVaultCompletionLimit({ model: "unknown" }, provider, 100),
    /completion-limit capability unavailable/
  );
  await assert.rejects(
    forwardVaultCompletionLimit({ model: "missing" }, provider, 100),
    /completion-limit capability unavailable/
  );
});

test("catalog capability discovery fails closed before Vault provider work", async (t) => {
  const provider: ProviderConfig = {
    slug: "openrouter",
    baseUrl: "https://capability-unavailable.test/v1",
    models: ["catalog/model"],
  };
  const cfg = configFor(provider);
  const body = { model: "catalog/model", messages: [{ role: "user", content: "hi" }] };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let upstreamRequests = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/models")) {
      return new Response("catalog unavailable", { status: 503 });
    }
    upstreamRequests += 1;
    return new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    forwardVaultCompletionLimit(body, provider, 100),
    /completion-limit capability unavailable/
  );
  assert.deepEqual(await buildVaultSseReplayModelsAnnounce(cfg, provider.models), []);
  assert.equal(
    shouldAnnounceLegacyGlobalVaultReplay(cfg, provider.models, []),
    false
  );

  const buffered = await callUpstream(cfg, undefined, body, undefined, 100);
  assert.equal(buffered.status, 502);
  assert.deepEqual(buffered.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  const streamed = await streamUpstream(cfg, undefined, { ...body, stream: true }, () => {}, 100);
  assert.equal(streamed.ok, false);
  assert.equal(streamed.status, 502);
  assert.equal(upstreamRequests, 0);
});

test("replay announcement is exact per model and withholds the legacy global token for mixed operators", async (t) => {
  const openrouter: ProviderConfig = {
    slug: "openrouter",
    baseUrl: "https://announce-capabilities.test/v1",
    models: ["modern", "neither"],
  };
  const anthropic: ProviderConfig = {
    slug: "anthropic",
    baseUrl: "https://anthropic.test/v1",
    models: ["claude"],
  };
  const cfg = {
    ...configFor(openrouter),
    providers: [openrouter, anthropic],
  };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      data: [
        { id: "modern", supported_parameters: ["max_completion_tokens"] },
        { id: "neither", supported_parameters: ["temperature"] },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as typeof fetch;

  const announced = ["modern", "neither", "claude"];
  const replayModels = await buildVaultSseReplayModelsAnnounce(cfg, announced);
  const requestAware = await buildVaultSseReplayPricingCapabilityAnnounce(
    cfg,
    announced,
    1_000
  );
  assert.deepEqual(replayModels, ["modern"]);
  assert.deepEqual(requestAware, { models: [], quotes: {} });
  assert.equal(
    shouldAnnounceLegacyGlobalVaultReplay(cfg, announced, replayModels),
    false
  );
  assert.equal(
    shouldAnnounceLegacyGlobalVaultReplay(cfg, ["modern"], replayModels),
    true
  );
});

test("margin replay is advertised only through request-aware pricing capability", async (t) => {
  const model = "margin/model";
  const provider: ProviderConfig = {
    slug: "openrouter",
    baseUrl: "https://margin-replay-capability.test/v1",
    models: [model],
  };
  const cfg = configFor(provider);
  cfg.pricing = {
    mode: "margin",
    marginPercent: 25,
    fallbackPerRequestUsdc: 1_000,
  };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () => Response.json({
    data: [
      {
        id: model,
        supported_parameters: ["max_tokens"],
        pricing: { prompt: "0.000001", completion: "0.000010" },
      },
    ],
  })) as typeof fetch;

  const legacyModels = await buildVaultSseReplayModelsAnnounce(cfg, [model]);
  const requestAware = await buildVaultSseReplayPricingCapabilityAnnounce(
    cfg,
    [model],
    1_000
  );

  assert.deepEqual(legacyModels, []);
  assert.deepEqual(requestAware.models, [model]);
  assert.equal(requestAware.quotes[model]?.marginBps, 2500);
  assert.equal(
    shouldAnnounceLegacyGlobalVaultReplay(cfg, [model], legacyModels),
    false
  );
});

test("vault text generation-control validator allows only absent or numeric n=1", () => {
  assert.equal(invalidVaultTextGenerationControlField({ model: "gpt-5" }, false), null);
  assert.equal(
    invalidVaultTextGenerationControlField({ model: "gpt-5", n: 1 }, false),
    null
  );
  for (const n of [null, "1", undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 2]) {
    assert.equal(invalidVaultTextGenerationControlField({ model: "gpt-5", n }, false), "n");
  }
  assert.equal(
    invalidVaultTextGenerationControlField({ model: "image", n: 2, max_tokens: 0 }, true),
    null
  );
});

test("vault text completion-limit validator accepts absence or positive finite integers only", () => {
  assert.equal(invalidVaultTextGenerationControlField({ model: "gpt-5" }, false), null);
  assert.equal(
    invalidVaultTextGenerationControlField({ model: "gpt-5", max_tokens: 1 }, false),
    null
  );
  assert.equal(
    invalidVaultTextGenerationControlField(
      {
        model: "gpt-5",
        max_tokens: 1024,
        max_completion_tokens: 8192,
      },
      false
    ),
    null
  );

  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ max_tokens: null }, "max_tokens"],
    [{ max_tokens: "1024" }, "max_tokens"],
    [{ max_tokens: undefined }, "max_tokens"],
    [{ max_tokens: Number.NaN }, "max_tokens"],
    [{ max_tokens: Number.POSITIVE_INFINITY }, "max_tokens"],
    [{ max_tokens: 1.5 }, "max_tokens"],
    [{ max_tokens: 0 }, "max_tokens"],
    [{ max_tokens: -1 }, "max_tokens"],
    [{ max_tokens: 1, max_completion_tokens: null }, "max_completion_tokens"],
  ];
  for (const [body, field] of invalid) {
    assert.equal(invalidVaultTextGenerationControlField(body, false), field);
  }
});

test("buffered upstream calls add the vault limit only when the vault ceiling is supplied", async (t) => {
  const cfg = configFor({
    slug: "openai",
    baseUrl: "https://openai.test/v1",
    apiKey: "sk-test",
    models: ["gpt-5"],
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const seen: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [{
            id: "minimax/minimax-m2.5",
            supported_parameters: ["max_tokens"],
            pricing: { prompt: "0.001", completion: "0.001" },
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    seen.push(JSON.parse(String((init as { body?: unknown }).body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const body = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] };
  await callUpstream(cfg, undefined, body);
  await callUpstream(
    cfg,
    undefined,
    body,
    undefined,
    requestCompletionCeilingTokens(body)
  );

  const openRouterCfg = configFor({
    slug: "openrouter",
    baseUrl: "https://openrouter.test/api/v1",
    apiKey: "sk-test",
    models: ["minimax/minimax-m2.5"],
  });
  const openRouterBody = {
    model: "minimax/minimax-m2.5",
    messages: [{ role: "user", content: "hi" }],
    provider: { require_parameters: false, order: ["unsupported-first"] },
  };
  await callUpstream(openRouterCfg, undefined, openRouterBody);
  await callUpstream(
    openRouterCfg,
    undefined,
    openRouterBody,
    undefined,
    requestCompletionCeilingTokens(openRouterBody)
  );

  assert.equal(seen.length, 4);
  assert.equal(seen[0].max_tokens, undefined);
  assert.equal(seen[0].max_completion_tokens, undefined);
  assert.equal(seen[1].max_tokens, undefined);
  assert.equal(seen[1].max_completion_tokens, 8192);
  assert.equal(seen[2].max_tokens, undefined);
  assert.equal(seen[2].provider, undefined);
  assert.equal(seen[3].max_tokens, 8192);
  assert.deepEqual(seen[3].provider, { require_parameters: true });
});

test("streaming vault calls forward the shared gate through legacy OpenAI-compatible APIs", async (t) => {
  const cfg = configFor({
    slug: "openrouter",
    baseUrl: "https://openrouter.test/api/v1",
    models: ["minimax/minimax-m2.5"],
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "minimax/minimax-m2.5", supported_parameters: ["max_tokens"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    seen = JSON.parse(String((init as { body?: unknown }).body)) as Record<string, unknown>;
    const delta = JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
    const usage = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    return new Response(`data: ${delta}\n\ndata: ${usage}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const body = {
    model: "minimax/minimax-m2.5",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    provider: { require_parameters: false },
  };
  const deltas: unknown[] = [];
  const gate = requestCompletionCeilingTokens(body);
  const result = await streamUpstream(cfg, undefined, body, (delta) => deltas.push(delta), gate);

  assert.equal(result.ok, true);
  assert.deepEqual(result.usage, {
    prompt_tokens: 2,
    completion_tokens: 1,
    total_tokens: 3,
    cached_prompt_tokens: 0,
  });
  assert.equal(deltas.length, 1);
  assert.equal(seen.max_tokens, gate);
  assert.equal(seen.max_completion_tokens, undefined);
  assert.equal(seen.stream, true);
  assert.deepEqual(seen.stream_options, { include_usage: true });
  assert.deepEqual(seen.provider, { require_parameters: true });
});

test("streaming accepts split CRLF, multiline data, EOF dispatch, and component-only usage", async (t) => {
  const cfg = configFor({
    slug: "venice",
    baseUrl: "https://sse-variants.test/v1",
    models: ["model"],
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const chunks = [
    ": keepalive\r\ndata: {\"choices\":\r",
    "\ndata: [{\"delta\":{\"content\":\"ok\"}}]}\r\n\r",
    "\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,",
    "\"completion_tokens\":1}}",
  ];
  globalThis.fetch = (async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }
  )) as typeof fetch;

  const deltas: unknown[] = [];
  const result = await streamUpstream(
    cfg,
    undefined,
    { model: "model", messages: [], stream: true },
    (delta) => deltas.push(delta),
    100
  );
  assert.equal(result.ok, true);
  assert.equal(deltas.length, 1);
  assert.deepEqual(result.usage, {
    prompt_tokens: 2,
    completion_tokens: 1,
    total_tokens: 3,
    cached_prompt_tokens: 0,
  });
});

test("streaming requires usage to remain terminal", async (t) => {
  const cfg = configFor({
    slug: "venice",
    baseUrl: "https://sse-terminal.test/v1",
    models: ["model"],
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const delta = JSON.stringify({ choices: [{ delta: { content: "late" } }] });
  const usage = JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
  const bodies = [
    "data: " + usage + "\n\ndata: " + delta + "\n\n",
    "data: " + delta + "\n\ndata: " + usage +
      "\n\ndata: [DONE]\n\ndata: " + delta + "\n\n",
  ];
  globalThis.fetch = (async () => new Response(bodies.shift(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as typeof fetch;

  for (let index = 0; index < 2; index += 1) {
    const result = await streamUpstream(
      cfg,
      undefined,
      { model: "model", messages: [], stream: true },
      () => {},
      100
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.usage, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  }
});

test("streaming fails closed on malformed events, contradictory usage, and non-SSE success", async (t) => {
  const cfg = configFor({
    slug: "venice",
    baseUrl: "https://sse-failure.test/v1",
    models: ["model"],
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bodies = [
    new Response("data: {not-json}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    new Response(
      "data: {\"choices\":[{}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":99}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ),
    new Response(
      "event: error\ndata: {\"error\":{\"message\":\"bad upstream event\"}}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ),
    new Response(JSON.stringify({ choices: [{}] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    new Response(null, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  ];
  globalThis.fetch = (async () => bodies.shift() as Response) as typeof fetch;

  for (let index = 0; index < 5; index += 1) {
    const result = await streamUpstream(
      cfg,
      undefined,
      { model: "model", messages: [], stream: true },
      () => {},
      100
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.usage, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  }
});

test("Anthropic maps valid modern limits and defaults malformed values", () => {
  const explicit = chatCompletionsToAnthropicRequest({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_completion_tokens: 2048,
  });
  assert.equal(explicit.max_tokens, 2048);
  assert.equal(explicit.max_completion_tokens, undefined);

  const maxTokensWins = chatCompletionsToAnthropicRequest({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 512,
    max_completion_tokens: 2048,
  });
  assert.equal(maxTokensWins.max_tokens, 512);

  const omitted = chatCompletionsToAnthropicRequest({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(omitted.max_tokens, DEFAULT_COMPLETION_CEILING_TOKENS);

  const invalid = chatCompletionsToAnthropicRequest({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: null,
  } as unknown as OpenAIChatRequest);
  assert.equal(invalid.max_tokens, DEFAULT_COMPLETION_CEILING_TOKENS);

  const invalidLegacyWithExplicitModern = chatCompletionsToAnthropicRequest({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: null,
    max_completion_tokens: 2048,
  } as unknown as OpenAIChatRequest);
  assert.equal(invalidLegacyWithExplicitModern.max_tokens, 2048);

  for (const maxCompletionTokens of [
    null,
    "2048",
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    const invalidModern = chatCompletionsToAnthropicRequest({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: maxCompletionTokens,
    } as unknown as OpenAIChatRequest);
    assert.equal(invalidModern.max_tokens, DEFAULT_COMPLETION_CEILING_TOKENS);
  }

  const historicNumericLegacy = chatCompletionsToAnthropicRequest({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 0,
  });
  assert.equal(historicNumericLegacy.max_tokens, 0);
});

test("non-vault Anthropic calls default a non-numeric legacy limit before upstream", async (t) => {
  const cfg = configFor({
    slug: "anthropic",
    baseUrl: "https://anthropic.test/v1",
    apiKey: "sk-test",
    models: ["claude-sonnet-4-5"],
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) {
      return new Response(
        JSON.stringify({
          data: [{ id: "minimax/minimax-m2.5", supported_parameters: ["max_tokens"] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    seen = JSON.parse(String((init as { body?: unknown }).body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: "msg-test",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const body = {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: null,
  } as unknown as Parameters<typeof callUpstream>[2];
  const result = await callUpstream(cfg, undefined, body);

  assert.equal(result.status, 200);
  assert.equal(seen.max_tokens, DEFAULT_COMPLETION_CEILING_TOKENS);
  assert.equal(seen.max_completion_tokens, undefined);
});
