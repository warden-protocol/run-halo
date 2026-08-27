import test from "node:test";
import assert from "node:assert/strict";
import type { HaloConfig, ProviderConfig } from "./config";
import {
  callUpstream,
  handleStartupProviderProbeResponse,
  streamUpstream,
} from "./commands/serve";
import {
  _resetBreakersForTest,
  breakerCode,
  isBreakerOpen,
} from "./provider-breaker";

const MODEL = "sakana/sakana-namazu";

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

function openRouterConfig(): HaloConfig {
  return configFor({
    slug: "openrouter",
    baseUrl: "https://openrouter.test/v1",
    apiKey: "sk-test-secret",
    models: [MODEL],
  });
}

function body(): { model: string; messages: Array<{ role: string; content: string }> } {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "hello" }],
  };
}

function regionalError(): unknown {
  return {
    error: {
      message: "Provider returned error",
      code: 403,
      metadata: {
        raw:
          "sakana/sakana-namazu is not available in your region: " +
          "Sakana AI blocks requests originating from your location.",
        provider_name: "Sakana AI",
      },
    },
  };
}

function moderationEchoError(): unknown {
  return {
    error: {
      message: "Provider returned error",
      code: 403,
      metadata: {
        raw: "Request blocked by moderation because the prompt said purchase more credits.",
      },
    },
  };
}

const SAFE_PROVIDER_ERROR = {
  error: {
    message: "The selected operator's upstream provider is temporarily unavailable.",
    type: "upstream_provider_error",
    code: "provider_error",
  },
};

test("regional and mixed-signal moderation 403s stay request-scoped across chat paths", async (t) => {
  _resetBreakersForTest();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalDebug = process.env.HALO_DEBUG_UPSTREAM_ERRORS;
  let diagnostics = "";
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (originalDebug === undefined) delete process.env.HALO_DEBUG_UPSTREAM_ERRORS;
    else process.env.HALO_DEBUG_UPSTREAM_ERRORS = originalDebug;
    _resetBreakersForTest();
  });

  delete process.env.HALO_DEBUG_UPSTREAM_ERRORS;
  let upstreamBody: unknown = regionalError();
  console.error = (...values: unknown[]) => {
    diagnostics += values.join(" ");
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(upstreamBody), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const cfg = openRouterConfig();
  for (const errorBody of [regionalError(), moderationEchoError()]) {
    upstreamBody = errorBody;
    const buffered = await callUpstream(cfg, undefined, body());
    const streamed = await streamUpstream(cfg, undefined, body(), () => {});

    assert.equal(buffered.status, 502);
    assert.deepEqual(buffered.data, SAFE_PROVIDER_ERROR);
    assert.equal(streamed.status, 502);
    assert.equal(streamed.ok, false);
    assert.deepEqual(streamed.errorData, SAFE_PROVIDER_ERROR);
    assert.equal(isBreakerOpen("openrouter"), false);
  }
  assert.doesNotMatch(diagnostics, /rejected the API key|re-set it with/i);
});

test("startup probe keeps a regional 403 non-sticky and debugs it only to the terminal", (t) => {
  _resetBreakersForTest();
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalWrite = process.stderr.write;
  const originalDebug = process.env.HALO_DEBUG_UPSTREAM_ERRORS;
  let persistentDiagnostics = "";
  let terminal = "";
  t.after(() => {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
    process.stderr.write = originalWrite;
    if (originalDebug === undefined) delete process.env.HALO_DEBUG_UPSTREAM_ERRORS;
    else process.env.HALO_DEBUG_UPSTREAM_ERRORS = originalDebug;
    _resetBreakersForTest();
  });

  process.env.HALO_DEBUG_UPSTREAM_ERRORS = "1";
  const collectPersistent = (...values: unknown[]): void => {
    persistentDiagnostics += values.join(" ");
  };
  console.error = collectPersistent;
  console.log = collectPersistent;
  console.warn = collectPersistent;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    terminal += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  handleStartupProviderProbeResponse(
    "openrouter",
    "sk-test-secret",
    403,
    JSON.stringify(regionalError())
  );

  assert.equal(isBreakerOpen("openrouter"), false);
  assert.doesNotMatch(persistentDiagnostics, /sakana|region|rejected the stored key/i);
  assert.match(terminal, /upstream\(startup-probe\) 403 body:.*sakana.*region/i);

  handleStartupProviderProbeResponse(
    "openrouter",
    "sk-test-secret",
    403,
    JSON.stringify({ error: { message: "Invalid API key" } })
  );
  assert.equal(isBreakerOpen("openrouter"), true);
  assert.equal(breakerCode("openrouter"), "operator_auth_failure");
  assert.match(persistentDiagnostics, /rejected the stored key/i);
  assert.doesNotMatch(persistentDiagnostics, /sk-test-secret/);
});

test("explicit credential 403 stays sticky for buffered and streaming calls", async (t) => {
  _resetBreakersForTest();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalDebug = process.env.HALO_DEBUG_UPSTREAM_ERRORS;
  let diagnostics = "";
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
    if (originalDebug === undefined) delete process.env.HALO_DEBUG_UPSTREAM_ERRORS;
    else process.env.HALO_DEBUG_UPSTREAM_ERRORS = originalDebug;
    _resetBreakersForTest();
  });

  delete process.env.HALO_DEBUG_UPSTREAM_ERRORS;
  console.error = (...values: unknown[]) => {
    diagnostics += values.join(" ");
  };
  console.warn = () => {};
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const cfg = openRouterConfig();
  const buffered = await callUpstream(cfg, undefined, body());
  assert.equal(buffered.status, 502);
  assert.equal(isBreakerOpen("openrouter"), true);
  assert.equal(breakerCode("openrouter"), "operator_auth_failure");

  _resetBreakersForTest();
  const streamed = await streamUpstream(cfg, undefined, body(), () => {});
  assert.equal(streamed.status, 502);
  assert.equal(isBreakerOpen("openrouter"), true);
  assert.equal(breakerCode("openrouter"), "operator_auth_failure");
  assert.match(diagnostics, /rejected the API key/);
  assert.doesNotMatch(diagnostics, /sk-test-secret/);
});

test("debug mode prints 401 and 403 bodies to the terminal-only stream", async (t) => {
  _resetBreakersForTest();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalWrite = process.stderr.write;
  const originalDebug = process.env.HALO_DEBUG_UPSTREAM_ERRORS;
  let terminal = "";
  let calls = 0;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
    process.stderr.write = originalWrite;
    if (originalDebug === undefined) delete process.env.HALO_DEBUG_UPSTREAM_ERRORS;
    else process.env.HALO_DEBUG_UPSTREAM_ERRORS = originalDebug;
    _resetBreakersForTest();
  });

  process.env.HALO_DEBUG_UPSTREAM_ERRORS = "1";
  console.error = () => {};
  console.warn = () => {};
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    terminal += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  globalThis.fetch = (async () => {
    calls += 1;
    const payload =
      calls === 1
        ? { error: { message: "auth-debug-body" } }
        : { error: { message: "forbidden-debug-body", metadata: { raw: "regional detail" } } };
    return new Response(JSON.stringify(payload), {
      status: calls === 1 ? 401 : 403,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const cfg = openRouterConfig();
  await callUpstream(cfg, undefined, body());
  await streamUpstream(cfg, undefined, body(), () => {});

  assert.match(terminal, /upstream 401 body:.*auth-debug-body/);
  assert.match(terminal, /upstream\(stream\) 403 body:.*forbidden-debug-body/);
});
