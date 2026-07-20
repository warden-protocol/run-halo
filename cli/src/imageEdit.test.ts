import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import prompts from "prompts";
import {
  ImageEditPlaintextError,
  serializeImageEditPlaintext,
} from "@halo/vault-core";
import {
  buildImageEditModelsAnnounce,
  buildOpenRouterImageEditBody,
  callUpstreamImageEdit,
  completeVaultImageServe,
  deliverVaultImageFrames,
  fetchTeeSignature,
  fetchTeeSignatureForRequest,
  ImageEditRequestError,
  inlineImageBytesFromResponse,
  openImageEditRequest,
  priceServedImagesForVault,
  resolveImageServeKind,
} from "./commands/serve";
import { cmdSetup } from "./commands/setup";
import { parseFlags } from "./flags";
import { configProviders, loadConfig, validateConfig, type HaloConfig } from "./config";
import {
  encryptBytes,
  encryptRequest,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
} from "./encryption";
import { clearBreaker, tripBreaker } from "./provider-breaker";
import { VaultCreditLedger } from "./vaultCredit";
import type { RelayDeliveryResult } from "./relayDelivery";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.from([0, 0, 0, 0])]);
}

function pngWithText(text: string): Buffer {
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", Buffer.alloc(13, 7)),
    pngChunk("tEXt", Buffer.from(text)),
    pngChunk("IDAT", Buffer.from([1, 2, 3, 4])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function config(overrides: Partial<HaloConfig> = {}): HaloConfig {
  const cfg: HaloConfig = {
    version: 1,
    relayUrl: "http://relay.test",
    indexerUrl: "http://indexer.test",
    operator: {
      address: "0x0000000000000000000000000000000000000001",
      keystorePath: "/tmp/keystore.json",
    },
    provider: {
      slug: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      apiKey: "sk-test",
      models: ["openai/gpt-image-1", "openai/gpt-4.1"],
      imageModels: ["openai/gpt-image-1"],
      imageEditModels: ["openai/gpt-image-1"],
    },
    pricing: {
      mode: "flat",
      flatUsdcPer1KTokens: 0.001,
      usdcPerImage: 0.02,
      fallbackPerRequestUsdc: 10_000,
    },
    facilitator: { url: "http://facilitator.test" },
  };
  return { ...cfg, ...overrides };
}

function encryptedEditOuter(params: {
  model?: string;
  prompt?: string;
  n?: number;
  mime?: "image/jpeg" | "image/png" | "image/webp";
  bytes?: Buffer;
}) {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const plaintext = serializeImageEditPlaintext({
    prompt: params.prompt ?? "make it a watercolor",
    n: params.n ?? 1,
    image: {
      mime: params.mime ?? "image/png",
      b64_json: (params.bytes ?? pngWithText("GPS and device metadata")).toString("base64"),
    },
  });
  return {
    operator,
    consumer,
    outer: {
      model: params.model ?? "openai/gpt-image-1",
      acceptMedia: true,
      _enc: encryptBytes(plaintext, hexToPubkey(operator.publicKeyHex), consumer),
    },
  };
}

test("edit capability is absent by default and announced only for an exact configured healthy adapter model", () => {
  const generationOnly = config({
    provider: {
      slug: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      models: ["openai/gpt-image-1"],
      imageModels: ["openai/gpt-image-1"],
    },
  });
  assert.deepEqual(buildImageEditModelsAnnounce(generationOnly), []);

  const enabled = config();
  assert.doesNotThrow(() => validateConfig(enabled));
  assert.deepEqual(buildImageEditModelsAnnounce(enabled), ["openai/gpt-image-1"]);
  tripBreaker("openrouter", "operator_auth_failure");
  assert.deepEqual(buildImageEditModelsAnnounce(enabled), []);
  clearBreaker("openrouter");
});

test("edit configuration must be an exact image/model subset on the tested provider with positive price", () => {
  const missingImageMembership = config({
    provider: {
      slug: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      models: ["openai/gpt-image-1"],
      imageModels: [],
      imageEditModels: ["openai/gpt-image-1"],
    },
  });
  assert.throws(() => validateConfig(missingImageMembership), /must also be listed.*imageModels/);

  const unsupportedProvider = config({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["openai/gpt-image-1"],
      imageModels: ["openai/gpt-image-1"],
      imageEditModels: ["openai/gpt-image-1"],
    },
  });
  assert.throws(() => validateConfig(unsupportedProvider), /supported inline image-edit adapter/);

  const freeEdit = config({
    pricing: {
      mode: "flat",
      flatUsdcPer1KTokens: 0.001,
      usdcPerImage: 0,
      fallbackPerRequestUsdc: 10_000,
    },
  });
  assert.throws(() => validateConfig(freeEdit), /finite positive usdcPerImage/);

  const subRoundingEdit = config({
    pricing: {
      mode: "flat",
      flatUsdcPer1KTokens: 0.001,
      usdcPerImage: 1e-13,
      fallbackPerRequestUsdc: 10_000,
    },
  });
  assert.throws(() => validateConfig(subRoundingEdit), /remains non-zero/);
  assert.deepEqual(buildImageEditModelsAnnounce(subRoundingEdit), []);
  assert.equal(
    resolveImageServeKind(subRoundingEdit, "/v1/images/edit", "openai/gpt-image-1"),
    "unsupported-edit"
  );
});

test("setup requires an explicit OpenRouter edit subset and persists only that exact subset", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-edit-setup-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  await cmdSetup({
    provider: "openrouter",
    apiKey: "test-only-key-000000000000",
    models: "openai/gpt-image-1,openai/gpt-4.1",
    imageModels: "openai/gpt-image-1",
    imageEditModels: "openai/gpt-image-1",
    imagePrice: 0.02,
    margin: 25,
    noWalletPassphrase: true,
  });

  const provider = loadConfig().provider;
  assert.deepEqual(provider.imageModels, ["openai/gpt-image-1"]);
  assert.deepEqual(provider.imageEditModels, ["openai/gpt-image-1"]);

  await assert.rejects(
    () =>
      cmdSetup({
        provider: "openrouter",
        apiKey: "test-only-key-000000000000",
        models: "openai/gpt-image-1,openai/gpt-4.1",
        imageModels: "openai/gpt-image-1",
        imageEditModels: "openai/gpt-image-1",
        imagePrice: 1e-13,
        margin: 25,
        noWalletPassphrase: true,
      }),
    /remains non-zero/
  );
  assert.equal(loadConfig().pricing.usdcPerImage, 0.02);
});

test("an explicit empty image-edit flag survives CLI parsing as the disable operation", () => {
  const flags = parseFlags(["--image-edit-models", ""]);
  assert.equal(flags["image-edit-models"], "");
});

function interactiveOpenRouterAnswers(params: {
  needsApiKey: boolean;
  editModels: string[] | null;
}): unknown[] {
  const models = ["openai/gpt-image-1", "openai/gpt-image-2"];
  return [
    "openrouter",
    ...(params.needsApiKey ? ["test-only-key-000000000000"] : []),
    models,
    "margin",
    25,
    true,
    models.join(","),
    0.02,
    params.editModels !== null,
    ...(params.editModels === null ? [] : [params.editModels]),
    1,
    "https://relay.halo.test",
    "https://indexer.halo.test",
    "",
  ];
}

function mockOpenRouterModels(t: TestContext): void {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "openai/gpt-image-1" },
          { id: "openai/gpt-image-2" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;
}

test("interactive --add-provider persists an edit opt-in for a new OpenRouter provider", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-edit-add-provider-new-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  mockOpenRouterModels(t);

  await cmdSetup({
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "chat-model",
    flat: 0.001,
    noWalletPassphrase: true,
  });
  prompts.inject(
    interactiveOpenRouterAnswers({
      needsApiKey: true,
      editModels: ["openai/gpt-image-1"],
    })
  );
  await cmdSetup({ addProvider: true, noWalletPassphrase: true });

  const openrouter = configProviders(loadConfig()).find(
    (provider) => provider.slug === "openrouter"
  );
  assert.deepEqual(openrouter?.imageModels, [
    "openai/gpt-image-1",
    "openai/gpt-image-2",
  ]);
  assert.deepEqual(openrouter?.imageEditModels, ["openai/gpt-image-1"]);
});

test("interactive --add-provider changes and then disables an existing edit subset", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-edit-add-provider-existing-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  mockOpenRouterModels(t);

  await cmdSetup({
    provider: "openrouter",
    apiKey: "test-only-key-000000000000",
    models: "openai/gpt-image-1,openai/gpt-image-2",
    imageModels: "openai/gpt-image-1,openai/gpt-image-2",
    imageEditModels: "openai/gpt-image-1",
    imagePrice: 0.02,
    margin: 25,
    noWalletPassphrase: true,
  });

  prompts.inject(
    interactiveOpenRouterAnswers({
      needsApiKey: false,
      editModels: ["openai/gpt-image-2"],
    })
  );
  await cmdSetup({ addProvider: true, noWalletPassphrase: true });
  assert.deepEqual(loadConfig().provider.imageEditModels, ["openai/gpt-image-2"]);

  prompts.inject(
    interactiveOpenRouterAnswers({ needsApiKey: false, editModels: null })
  );
  await cmdSetup({ addProvider: true, noWalletPassphrase: true });
  assert.equal(loadConfig().provider.imageEditModels, undefined);
});

test("v2 edit decryption validates the shared schema, strips input metadata, and retains the consumer key", () => {
  const { operator, consumer, outer } = encryptedEditOuter({ n: 2 });
  const opened = openImageEditRequest(outer, operator.privateKey);

  assert.equal(opened.model, "openai/gpt-image-1");
  assert.equal(opened.edit.prompt, "make it a watercolor");
  assert.equal(opened.edit.n, 2);
  assert.deepEqual(
    Buffer.from(opened.consumerPublicKey),
    Buffer.from(consumer.publicKeyHex, "hex")
  );
  assert.equal(
    Buffer.from(opened.edit.image.b64_json, "base64").includes(Buffer.from("GPS and device metadata")),
    false
  );
});

test("edit opening rejects plaintext/v1 wrappers, extra outer fields, MIME mismatch, and malformed images", () => {
  const { operator, consumer, outer } = encryptedEditOuter({});
  const operatorPubkey = hexToPubkey(operator.publicKeyHex);
  const v1 = encryptRequest(
    { prompt: "edit", n: 1, image: { mime: "image/png", b64_json: "AQID" } },
    operatorPubkey,
    consumer
  );

  for (const [body, type] of [
    [{ model: "openai/gpt-image-1", acceptMedia: true }, "invalid_image_edit_wrapper"],
    [{ model: "openai/gpt-image-1", acceptMedia: true, _enc: v1 }, "image_edit_encryption_required"],
    [{ ...outer, plaintext: "must not pass" }, "invalid_image_edit_wrapper"],
  ] as const) {
    assert.throws(
      () => openImageEditRequest(body, operator.privateKey),
      (err: unknown) => err instanceof ImageEditRequestError && err.type === type
    );
  }

  const mismatch = encryptedEditOuter({ mime: "image/jpeg", bytes: pngWithText("meta") });
  assert.throws(
    () => openImageEditRequest(mismatch.outer, mismatch.operator.privateKey),
    (err: unknown) => err instanceof ImageEditRequestError && err.type === "image_mime_mismatch"
  );

  const malformed = encryptedEditOuter({ bytes: Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 5])]) });
  assert.throws(
    () => openImageEditRequest(malformed.outer, malformed.operator.privateKey),
    (err: unknown) => err instanceof ImageEditRequestError && err.type === "malformed_input_image"
  );
});

test("route identity and exact membership distinguish edits from generation and arbitrary multimodal chat", () => {
  const cfg = config();
  assert.equal(resolveImageServeKind(cfg, "/v1/images/edit", "openai/gpt-image-1"), "edit");
  assert.equal(resolveImageServeKind(cfg, "/v1/chat/completions", "openai/gpt-image-1"), "generation");
  assert.equal(resolveImageServeKind(cfg, "/v1/chat/completions", "openai/gpt-4.1"), "text");
  assert.equal(resolveImageServeKind(cfg, "/v1/images/edit", "openai/gpt-4.1"), "unsupported-edit");
});

test("OpenRouter edit adapter matches the dedicated Image API contract with stripped inline input", async (t) => {
  const cfg = config();
  const openedSource = encryptedEditOuter({ n: 3 });
  const opened = openImageEditRequest(openedSource.outer, openedSource.operator.privateKey);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url, init) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String((init as { body?: unknown }).body));
    assert.deepEqual(Object.keys(seenBody).sort(), ["input_references", "model", "n", "prompt"]);
    return new Response(
      JSON.stringify({
        created: 1,
        data: [{ b64_json: pngWithText("output").toString("base64") }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const result = await callUpstreamImageEdit(
    cfg,
    undefined,
    { model: opened.model },
    opened.edit
  );

  assert.equal(result.status, 200);
  assert.equal(seenUrl, "https://openrouter.test/api/v1/images");
  assert.equal(seenBody.model, "openai/gpt-image-1");
  assert.equal(seenBody.prompt, "make it a watercolor");
  assert.equal(seenBody.n, 3);
  assert.equal("messages" in seenBody, false);
  assert.equal("modalities" in seenBody, false);
  assert.equal("provider" in seenBody, false);
  assert.equal("user" in seenBody, false);
  assert.equal("metadata" in seenBody, false);
  const reference = (seenBody.input_references as Array<Record<string, unknown>>)[0];
  assert.equal(reference.type, "image_url");
  assert.match(
    ((reference.image_url as { url: string }).url),
    /^data:image\/png;base64,/
  );
  assert.equal(
    ((reference.image_url as { url: string }).url).includes(
      Buffer.from("GPS and device metadata").toString("base64")
    ),
    false
  );
  assert.equal(inlineImageBytesFromResponse(result.data).length, 1);
});

test("OpenRouter edit adapter keeps its deadline active while reading a stalled body", async (t) => {
  const cfg = config();
  const source = encryptedEditOuter({});
  const opened = openImageEditRequest(source.outer, source.operator.privateKey);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const result = await callUpstreamImageEdit(
    cfg,
    undefined,
    { model: opened.model },
    opened.edit,
    { timeoutMs: 20 }
  );

  assert.equal(result.status, 504);
  assert.equal(
    (result.data as { error: { type: string } }).error.type,
    "provider_timeout"
  );
  const completion = await runProductionImageCompletion({ upstream: result });
  assert.equal(completion.result.ok, false);
  assert.equal(completion.ledger.outstandingFor(completion.consumer, completion.operator), 0n);
  assert.equal(completion.servedEvents, 0);
});

test("OpenRouter edit adapter stops reading an oversized response body at the byte cap", async (t) => {
  const cfg = config();
  const source = encryptedEditOuter({});
  const opened = openImageEditRequest(source.outer, source.operator.privateKey);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const eightMiB = new Uint8Array(8 * 1024 * 1024);
          controller.enqueue(eightMiB);
          controller.enqueue(eightMiB);
          controller.enqueue(Uint8Array.of(0));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const result = await callUpstreamImageEdit(
    cfg,
    undefined,
    { model: opened.model },
    opened.edit
  );

  assert.equal(result.status, 502);
  assert.equal(
    (result.data as { error: { type: string } }).error.type,
    "image_upstream_body_too_large"
  );
  const completion = await runProductionImageCompletion({ upstream: result });
  assert.equal(completion.result.ok, false);
  assert.equal(completion.ledger.outstandingFor(completion.consumer, completion.operator), 0n);
  assert.equal(completion.servedEvents, 0);
});

test("non-TEE edit headers and an upstream id never trigger proof retrieval", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("non-TEE proof fetch must not run");
  }) as typeof fetch;

  const signature = await fetchTeeSignatureForRequest({
    providerSlug: "openrouter",
    baseUrl: "https://openrouter.test/api/v1",
    apiKey: "test-key",
    chatId: "upstream-id",
    model: "openai/gpt-image-1",
    headers: {
      "x-client-pub-key": "client-controlled",
      "x-encryption-version": "v1",
    },
  });

  assert.equal(signature, null);
  assert.equal(fetches, 0);
});

test("permitted TEE proof reads stay deadline- and byte-bounded after response headers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
      }),
      { status: 200 }
    )) as typeof fetch;
  assert.equal(
    await fetchTeeSignature(
      "https://near.test/v1",
      "test-key",
      "chat-id",
      "near-model",
      { timeoutMs: 20, maxBodyBytes: 32 }
    ),
    null
  );

  globalThis.fetch = (async () =>
    new Response(new Uint8Array(33), {
      status: 200,
      headers: { "content-length": "33" },
    })) as typeof fetch;
  assert.equal(
    await fetchTeeSignature(
      "https://near.test/v1",
      "test-key",
      "chat-id",
      "near-model",
      { timeoutMs: 100, maxBodyBytes: 32 }
    ),
    null
  );
});

test("OpenRouter edit request builder strips again at the provider boundary", () => {
  const body = buildOpenRouterImageEditBody("openai/gpt-image-1", {
    prompt: "edit",
    n: 1,
    image: { mime: "image/png", b64_json: pngWithText("private metadata").toString("base64") },
  });
  const reference = (body.input_references as Array<Record<string, unknown>>)[0];
  const dataUri = (reference.image_url as { url: string }).url;

  assert.equal(dataUri.includes(Buffer.from("private metadata").toString("base64")), false);
});

test("inline image responses are deliverable while URL-only edit output fails closed", () => {
  const image = pngWithText("output");
  assert.deepEqual(
    inlineImageBytesFromResponse({
      choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${image.toString("base64")}` } }] } }],
    }),
    [image]
  );
  assert.throws(
    () =>
      inlineImageBytesFromResponse({
        choices: [{ message: { images: [{ image_url: { url: "https://cdn.test/output.png" } }] } }],
      }),
    /refusing operator-side fetch/
  );
});

function admittedLedger() {
  const consumer = "0x1111111111111111111111111111111111111111";
  const operator = "0x2222222222222222222222222222222222222222";
  const cycle = 1n;
  const ceiling = 100_000n;
  const ledger = new VaultCreditLedger();
  ledger.syncOnchain(consumer, operator, cycle, 0n, ceiling);
  assert.equal(ledger.admit(consumer, operator, cycle, ceiling, ceiling).ok, true);
  return { ledger, consumer, operator, cycle, ceiling };
}

async function runProductionImageCompletion(params: {
  upstream?: { status: number; data: unknown; respHeaders?: Record<string, string> };
  confirmation?: RelayDeliveryResult;
  abortBeforeTerminal?: boolean;
  abortDuringConfirmation?: boolean;
  failFrame?: boolean;
  failErrorTerminal?: boolean;
} = {}) {
  const credit = admittedLedger();
  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const order: string[] = [];
  const terminals: unknown[] = [];
  let aborted = params.abortBeforeTerminal === true;
  let servedEvents = 0;
  const upstream = params.upstream ?? {
    status: 200,
    data: { data: [{ b64_json: pngWithText("output").toString("base64") }] },
  };

  const result = await completeVaultImageServe({
    requestId: "req-production-image",
    upstream,
    imagePrice: 0.02,
    ceiling: credit.ceiling,
    consumer: credit.consumer,
    operator: credit.operator,
    cycle: credit.cycle,
    creditLedger: credit.ledger,
    consumerPublicKey: hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys,
    encryptFailure: (data) => ({ encryptedFailure: data }),
    sendFrame: async () => {
      order.push("frame");
      if (params.failFrame) throw new Error("frame send failed");
    },
    sendTerminal: async (terminal) => {
      order.push("error-terminal");
      terminals.push(terminal);
      if (params.failErrorTerminal) throw new Error("terminal send failed");
    },
    confirmTerminal: async (terminal) => {
      order.push("success-terminal");
      terminals.push(terminal);
      if (params.abortDuringConfirmation) aborted = true;
      return params.confirmation ?? { ok: true };
    },
    isAborted: () => aborted,
    noteServed: () => order.push("note-served"),
    postServedEvent: () => {
      order.push("post-event");
      servedEvents += 1;
    },
  });
  return { ...credit, result, order, terminals, servedEvents };
}

test("production image completion commits accounting and served evidence only after relay confirmation", async () => {
  const responseData = {
    data: [
      { b64_json: pngWithText("one").toString("base64") },
      { b64_json: pngWithText("two").toString("base64") },
    ],
  };
  const completion = await runProductionImageCompletion({
    upstream: { status: 200, data: responseData },
  });

  assert.equal(completion.result.ok, true);
  assert.ok(completion.order.indexOf("frame") >= 0);
  assert.ok(
    completion.order.indexOf("success-terminal") <
      completion.order.indexOf("note-served")
  );
  assert.ok(
    completion.order.indexOf("note-served") < completion.order.indexOf("post-event")
  );
  assert.equal(completion.servedEvents, 1);
  assert.equal(
    completion.ledger.outstandingFor(completion.consumer, completion.operator),
    40_000n
  );
});

test("terminal send failure, relay timeout, and late relay abort release without served evidence", async () => {
  const cases: Array<{
    confirmation: RelayDeliveryResult;
    abortDuringConfirmation?: boolean;
  }> = [
    { confirmation: { ok: false, reason: "terminal-send-failed" } },
    { confirmation: { ok: false, reason: "confirmation-timeout" } },
    { confirmation: { ok: false, reason: "relay-aborted" } },
    { confirmation: { ok: true }, abortDuringConfirmation: true },
  ];

  for (const entry of cases) {
    const completion = await runProductionImageCompletion(entry);
    assert.equal(completion.result.ok, false);
    assert.equal(
      completion.ledger.outstandingFor(completion.consumer, completion.operator),
      0n
    );
    assert.equal(completion.ledger.snapshot(completion.consumer, completion.operator)?.served, 0n);
    assert.equal(completion.servedEvents, 0);
    assert.equal(completion.order.includes("note-served"), false);
    assert.equal(completion.order.includes("post-event"), false);
  }
});

test("production zero-image and frame/error-terminal failures release the admitted ceiling", async () => {
  for (const params of [
    { upstream: { status: 200, data: { data: [] } } },
    { failFrame: true },
    {
      upstream: {
        status: 502,
        data: { error: { type: "image_upstream_body_too_large" } },
      },
      failErrorTerminal: true,
    },
  ]) {
    const completion = await runProductionImageCompletion(params);
    assert.equal(completion.result.ok, false);
    assert.equal(
      completion.ledger.outstandingFor(completion.consumer, completion.operator),
      0n
    );
    assert.equal(completion.servedEvents, 0);
  }
});

async function runDelivery(params: {
  responseData: unknown;
  aborted?: boolean;
  failSend?: boolean;
}) {
  const credit = admittedLedger();
  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const imageSettlement = priceServedImagesForVault(0.02, params.responseData, credit.ceiling);
  const result = await deliverVaultImageFrames({
    requestId: "req-edit-delivery",
    responseData: params.responseData,
    imageSettlement,
    consumerPublicKey: hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys,
    isAborted: () => params.aborted === true,
    sendFrame: async () => {
      if (params.failSend) throw new Error("socket failed");
    },
    release: () =>
      credit.ledger.releaseInflight(
        credit.consumer,
        credit.operator,
        credit.cycle,
        credit.ceiling
      ),
  });
  if (result.ok) {
    credit.ledger.settleServed(
      credit.consumer,
      credit.operator,
      credit.cycle,
      credit.ceiling,
      imageSettlement.actualAmount
    );
  }
  return { ...credit, result };
}

test("edit frame-send failure releases admitted credit and creates no redeemable served amount", async () => {
  const responseData = { data: [{ b64_json: pngWithText("one").toString("base64") }] };
  const delivered = await runDelivery({ responseData, failSend: true });

  assert.equal(delivered.result.ok, false);
  assert.equal(delivered.result.ok ? "" : delivered.result.type, "image_media_delivery_failed");
  assert.equal(delivered.ledger.outstandingFor(delivered.consumer, delivered.operator), 0n);
  assert.equal(delivered.ledger.redeemable(delivered.consumer, delivered.operator), null);
});

test("edit relay abort releases admitted credit and creates no redeemable served amount", async () => {
  const responseData = { data: [{ b64_json: pngWithText("one").toString("base64") }] };
  const delivered = await runDelivery({ responseData, aborted: true });

  assert.equal(delivered.result.ok, false);
  assert.equal(delivered.result.ok ? "" : delivered.result.type, "image_media_delivery_aborted");
  assert.equal(delivered.ledger.outstandingFor(delivered.consumer, delivered.operator), 0n);
  assert.equal(delivered.ledger.redeemable(delivered.consumer, delivered.operator), null);
});

test("edit URL-only and output-strip failures release admitted credit without settlement", async () => {
  for (const responseData of [
    { data: [{ url: "https://cdn.test/output.png" }] },
    { data: [{ b64_json: Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 5])]).toString("base64") }] },
  ]) {
    const delivered = await runDelivery({ responseData });
    assert.equal(delivered.result.ok, false);
    assert.equal(delivered.ledger.outstandingFor(delivered.consumer, delivered.operator), 0n);
    assert.equal(delivered.ledger.redeemable(delivered.consumer, delivered.operator), null);
  }
});

test("n>1 edit delivery settles only the delivered output count inside the admitted ceiling", async () => {
  const responseData = {
    data: [
      { b64_json: pngWithText("one").toString("base64") },
      { b64_json: pngWithText("two").toString("base64") },
    ],
  };
  const delivered = await runDelivery({ responseData });

  assert.deepEqual(delivered.result.ok && delivered.result.frames > 0, true);
  assert.equal(delivered.ledger.outstandingFor(delivered.consumer, delivered.operator), 40_000n);
  assert.equal(delivered.ledger.snapshot(delivered.consumer, delivered.operator)?.served, 40_000n);
  assert.equal(
    delivered.ledger.redeemable(delivered.consumer, delivered.operator),
    null,
    "served accounting becomes redeemable only after the consumer supplies a receipt"
  );
});

test("zero-image edit settlement is unmetered", () => {
  const priced = priceServedImagesForVault(0.02, { data: [] }, 100_000n);
  assert.deepEqual(priced, {
    servedImageCount: 0,
    uncappedAmount: 0n,
    actualAmount: 0n,
    tokens: 0,
  });
});

test("shared schema errors stay typed for consumers and operators", () => {
  assert.throws(
    () => serializeImageEditPlaintext({ prompt: "edit", n: 0, image: { mime: "image/png", b64_json: "AQID" } }),
    (err: unknown) =>
      err instanceof ImageEditPlaintextError && err.code === "invalid_image_count"
  );
});
