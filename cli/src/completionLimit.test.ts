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
  callUpstream,
  forwardVaultCompletionLimit,
  invalidVaultTextGenerationControlField,
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

test("forwardVaultCompletionLimit injects the shared gate in the provider-compatible field", () => {
  const reasoningBody = {
    model: "minimax/minimax-m2.5",
    messages: [{ role: "user", content: "hi" }],
  };
  const reasoningGate = requestCompletionCeilingTokens(reasoningBody);
  const compatible = forwardVaultCompletionLimit(reasoningBody, "openrouter", reasoningGate);
  assert.equal(reasoningGate, 8192);
  assert.equal(compatible.max_tokens, reasoningGate);
  assert.equal(compatible.max_completion_tokens, undefined);
  assert.equal((reasoningBody as Record<string, unknown>).max_tokens, undefined);

  const directOpenAiBody = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
  };
  const directOpenAiGate = requestCompletionCeilingTokens(directOpenAiBody);
  const directOpenAi = forwardVaultCompletionLimit(directOpenAiBody, "openai", directOpenAiGate);
  assert.equal(directOpenAiGate, DEFAULT_COMPLETION_CEILING_TOKENS);
  assert.equal(directOpenAi.max_completion_tokens, directOpenAiGate);
  assert.equal(directOpenAi.max_tokens, undefined);
});

test("forwardVaultCompletionLimit preserves every explicit completion-limit field", () => {
  const cases = [
    { model: "gpt-5", max_tokens: 7 },
    { model: "gpt-5", max_completion_tokens: 11 },
    { model: "gpt-5", max_tokens: 7, max_completion_tokens: 11 },
    { model: "gpt-5", max_tokens: 0 },
    { model: "gpt-5", max_completion_tokens: -1 },
    { model: "gpt-5", max_tokens: undefined },
  ];
  for (const body of cases) {
    assert.strictEqual(
      forwardVaultCompletionLimit(body, "openai", requestCompletionCeilingTokens(body)),
      body
    );
  }
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
  globalThis.fetch = (async (_url, init) => {
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
  globalThis.fetch = (async (_url, init) => {
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
  assert.deepEqual(result.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  assert.equal(deltas.length, 1);
  assert.equal(seen.max_tokens, gate);
  assert.equal(seen.max_completion_tokens, undefined);
  assert.equal(seen.stream, true);
  assert.deepEqual(seen.stream_options, { include_usage: true });
  assert.deepEqual(seen.provider, { require_parameters: true });
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
  globalThis.fetch = (async (_url, init) => {
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
