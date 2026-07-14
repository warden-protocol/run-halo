import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  UndeliverableImageResponseError,
  buildImageMediaFrames,
  buildImagePricingAnnounce,
  buildImageTerminalBody,
  buildNoImageTerminalBody,
  buildPricingAnnounce,
  callUpstreamImage,
  inlineImageBytesFromResponse,
  prepareImageDeliveryFrames,
  priceServedImagesForVault,
  requestAcceptsMedia,
  servedImageCountFromResponse,
} from "./commands/serve";
import { imagePriceForModel, validateConfig, type HaloConfig } from "./config";
import { priceRequest } from "./pricing";
import { cmdSetup } from "./commands/setup";
import {
  decryptBytes,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
} from "./encryption";
import {
  MEDIA_RELAY_WS_MAX_MESSAGE_BYTES,
  MediaChunkFrame,
  reassembleMediaEnvelope,
  trimPadding,
  unpackMediaPlaintext,
} from "./mediaChunks";

function baseConfig(overrides: Partial<HaloConfig> = {}): HaloConfig {
  // Mirrors the shape `halo setup` actually writes for a single-provider
  // operator: the per-image overlay (`usdcPerImage`) lives on the top-level
  // `pricing` block alongside the chat mode, and `imageModels` on the
  // provider — `provider.pricing` is unset (that's the `--add-provider`
  // shape, a different case, covered separately below). `slug: "custom"`
  // keeps margin-mode tests network-free (no resolver registered for it, so
  // `priceRequest` falls back to `fallbackPerRequestUsdc` synchronously).
  const cfg: HaloConfig = {
    version: 1,
    relayUrl: "http://relay.test",
    indexerUrl: "http://indexer.test",
    operator: {
      address: "0x0000000000000000000000000000000000000001",
      keystorePath: "/tmp/keystore.json",
    },
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["gpt-4o", "dall-e-3"],
      imageModels: ["dall-e-3"],
    },
    pricing: {
      mode: "margin",
      marginPercent: 25,
      usdcPerImage: 0.02,
      fallbackPerRequestUsdc: 10_000,
    },
    facilitator: { url: "http://facilitator.test" },
  };
  return { ...cfg, ...overrides };
}

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

test("servedImageCountFromResponse counts OpenAI image data entries", () => {
  assert.equal(
    servedImageCountFromResponse({
      data: [
        { b64_json: "iVBORw0KGgo=" },
        { url: "data:image/png;base64,abc" },
        { revised_prompt: "not an image" },
      ],
    }),
    2
  );
});

test("requestAcceptsMedia accepts explicit body or header signal only", () => {
  assert.equal(requestAcceptsMedia({ model: "dall-e-3", acceptMedia: true }, {}), true);
  assert.equal(
    requestAcceptsMedia({ model: "dall-e-3" }, { "x-halo-accept-media": "1" }),
    true
  );
  assert.equal(
    requestAcceptsMedia({ model: "dall-e-3" }, { "x-halo-accept-media": "true" }),
    true
  );
  assert.equal(
    requestAcceptsMedia({ model: "dall-e-3" }, { "x-halo-accept-media": "0" }),
    false
  );
  assert.equal(requestAcceptsMedia({ model: "dall-e-3" }, {}), false);
});

test("callUpstreamImage posts to the provider images endpoint and requests inline base64", async (t) => {
  const cfg = baseConfig({
    provider: {
      slug: "openrouter",
      baseUrl: "https://openrouter.test/api/v1",
      apiKey: "sk-test",
      models: ["dall-e-3"],
      imageModels: ["dall-e-3"],
    },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url, init) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String((init as { body?: unknown }).body));
    return new Response(JSON.stringify({ data: [{ b64_json: pngWithText("ok").toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const upstream = await callUpstreamImage(cfg, undefined, {
    model: "dall-e-3",
    prompt: "draw a halo",
    stream: true,
    user: "must-not-forward",
  });

  assert.equal(upstream.status, 200);
  assert.equal(seenUrl, "https://openrouter.test/api/v1/images/generations");
  assert.equal(seenBody.prompt, "draw a halo");
  assert.equal(seenBody.response_format, "b64_json");
  assert.equal(seenBody.stream, undefined);
  assert.equal(seenBody.user, undefined);
});

test("URL-only image responses fail closed instead of being fetched", () => {
  assert.throws(
    () => inlineImageBytesFromResponse({ data: [{ url: "https://provider.test/image.png" }] }),
    (err: unknown) => {
      assert.ok(err instanceof UndeliverableImageResponseError);
      assert.equal((err as UndeliverableImageResponseError).type, "url_only_image_response");
      return true;
    }
  );
});

test("buildImageMediaFrames strips metadata before encrypting and chunking", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const source = pngWithText("parameters\0secret prompt");

  const prepared = buildImageMediaFrames(
    "req-image-1",
    { data: [{ b64_json: source.toString("base64") }] },
    hexToPubkey(consumer.publicKeyHex),
    operator
  );

  assert.equal(prepared.imageCount, 1);
  assert.ok(prepared.frames.length > 0);
  assert.ok(prepared.frames.every((frame) => frame.imageIndex === 0));
  assert.ok(prepared.frames.every((frame) => frame.imageCount === 1));
  const envelope = reassembleMediaEnvelope(prepared.frames);
  const decrypted = decryptBytes(envelope, consumer.privateKey, hexToPubkey(operator.publicKeyHex));
  const media = unpackMediaPlaintext(trimPadding(decrypted.plaintext));
  assert.equal(media.mime, "image/png");
  assert.ok(!media.bytes.includes(Buffer.from("secret prompt")));
});

test("buildImageMediaFrames makes n>1 image responses reassemblable by image index", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const sources = [pngWithText("first prompt"), pngWithText("second prompt")];

  const prepared = buildImageMediaFrames(
    "req-image-many",
    { data: sources.map((source) => ({ b64_json: source.toString("base64") })) },
    hexToPubkey(consumer.publicKeyHex),
    operator
  );

  assert.equal(prepared.imageCount, 2);
  assert.ok(prepared.frames.length >= 2);
  const grouped = new Map<number, MediaChunkFrame[]>();
  for (const frame of prepared.frames) {
    assert.equal(frame.imageCount, 2);
    grouped.set(frame.imageIndex!, [...(grouped.get(frame.imageIndex!) ?? []), frame]);
  }
  assert.deepEqual([...grouped.keys()].sort(), [0, 1]);

  for (const [imageIndex, frames] of grouped) {
    const envelope = reassembleMediaEnvelope(frames);
    const decrypted = decryptBytes(envelope, consumer.privateKey, hexToPubkey(operator.publicKeyHex));
    const media = unpackMediaPlaintext(trimPadding(decrypted.plaintext));
    assert.equal(media.mime, "image/png");
    assert.ok(!media.bytes.includes(Buffer.from("prompt")));
    assert.ok(media.bytes.includes(Buffer.from([1, 2, 3, 4])), `image ${imageIndex} pixels preserved`);
  }
});

test("image vault success terminal body is a tiny marker, never upstream image data", () => {
  const marker = buildImageTerminalBody({ servedImageCount: 2 });

  assert.deepEqual(marker, { imageDelivered: true, images: 2 });
  assert.ok(Buffer.byteLength(JSON.stringify(marker), "utf8") < MEDIA_RELAY_WS_MAX_MESSAGE_BYTES);
  assert.equal(JSON.stringify(marker).includes("b64_json"), false);
});

test("image vault no-image terminal body is tiny and never upstream image data", () => {
  const marker = buildNoImageTerminalBody();
  const serialized = JSON.stringify(marker);

  assert.deepEqual(marker, {
    error: {
      type: "no_image",
      message: "Upstream image response contained no deliverable inline images.",
    },
  });
  assert.ok(Buffer.byteLength(serialized, "utf8") < MEDIA_RELAY_WS_MAX_MESSAGE_BYTES);
  assert.equal(serialized.includes("b64_json"), false);
  assert.equal(serialized.includes("sidecar"), false);
});

test("prepareImageDeliveryFrames fails closed without pubkey and on count mismatch", () => {
  const operator = generateOperatorKeypair();
  const responseData = { data: [{ b64_json: pngWithText("one").toString("base64") }] };

  assert.throws(
    () =>
      prepareImageDeliveryFrames({
        requestId: "req-no-key",
        responseData,
        imageSettlement: { servedImageCount: 1 },
        consumerPublicKey: undefined,
        operatorKeys: operator,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UndeliverableImageResponseError);
      assert.equal((err as UndeliverableImageResponseError).type, "image_encryption_required");
      return true;
    }
  );

  assert.throws(
    () =>
      prepareImageDeliveryFrames({
        requestId: "req-count-mismatch",
        responseData,
        imageSettlement: { servedImageCount: 2 },
        consumerPublicKey: hexToPubkey(generateEphemeralKeypair().publicKeyHex),
        operatorKeys: operator,
      }),
    (err: unknown) => {
      assert.ok(err instanceof UndeliverableImageResponseError);
      assert.equal((err as UndeliverableImageResponseError).type, "image_count_mismatch");
      return true;
    }
  );
});

test("buildImageMediaFrames rejects an oversized upstream image body before decode", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();

  assert.throws(
    () =>
      buildImageMediaFrames(
        "req-too-large",
        { data: [{ b64_json: "A".repeat(17 * 1024 * 1024) }] },
        hexToPubkey(consumer.publicKeyHex),
        operator
      ),
    (err: unknown) => {
      assert.ok(err instanceof UndeliverableImageResponseError);
      assert.equal((err as UndeliverableImageResponseError).type, "image_upstream_body_too_large");
      return true;
    }
  );
});

test("servedImageCountFromResponse counts chat image response shapes", () => {
  assert.equal(
    servedImageCountFromResponse({
      choices: [
        {
          message: {
            images: [{ image_url: { url: "data:image/png;base64,abc" } }],
            content: [{ type: "output_image", b64_json: "duplicate" }],
          },
        },
        {
          message: {
            content: [{ type: "output_image", b64_json: "abc" }],
          },
        },
      ],
    }),
    2
  );
});

test("image settlement prices returned images, not the client requested n", () => {
  const requestBody = { model: "dall-e-3", n: 4 };
  assert.equal(requestBody.n, 4);

  const priced = priceServedImagesForVault(
    0.02,
    { data: [{ b64_json: "one" }, { b64_json: "two" }] },
    100_000n
  );

  assert.equal(priced.servedImageCount, 2);
  assert.equal(priced.uncappedAmount, 40_000n);
  assert.equal(priced.actualAmount, 40_000n);
  assert.equal(priced.tokens, 0);
});

test("zero detected images produce no billable image settlement", () => {
  const priced = priceServedImagesForVault(0.02, { data: [] }, 100_000n);

  assert.equal(priced.servedImageCount, 0);
  assert.equal(priced.uncappedAmount, 0n);
  assert.equal(priced.actualAmount, 0n);
  assert.equal(priced.tokens, 0);
});

test("image settlement still applies the existing per-request vault ceiling", () => {
  const priced = priceServedImagesForVault(
    0.02,
    { data: [{ b64_json: "one" }, { b64_json: "two" }, { b64_json: "three" }] },
    40_000n
  );

  assert.equal(priced.servedImageCount, 3);
  assert.equal(priced.uncappedAmount, 60_000n);
  assert.equal(priced.actualAmount, 40_000n);
});

test("imagePriceForModel resolves the per-image overlay only for configured imageModels", () => {
  const cfg = baseConfig();

  assert.equal(imagePriceForModel(cfg, "dall-e-3"), 0.02);
  assert.equal(imagePriceForModel(cfg, "gpt-4o"), null);
});

test("the per-image overlay is independent of the chat pricing mode", () => {
  const marginCfg = baseConfig();
  const flatCfg = baseConfig({
    pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, usdcPerImage: 0.02, fallbackPerRequestUsdc: 10_000 },
  });

  assert.equal(imagePriceForModel(marginCfg, "dall-e-3"), 0.02);
  assert.equal(imagePriceForModel(flatCfg, "dall-e-3"), 0.02);
});

test("a provider-level pricing override's usdcPerImage wins over the operator-wide one (--add-provider shape)", () => {
  const cfg = baseConfig({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["gpt-4o", "dall-e-3"],
      imageModels: ["dall-e-3"],
      pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, usdcPerImage: 0.05 },
    },
  });

  assert.equal(imagePriceForModel(cfg, "dall-e-3"), 0.05);
});

// Regression for Blocker B: setup.ts's real single-provider output has
// cfg.pricing.mode = "margin"/"flat" (never a mode named after images) with
// provider.pricing unset — so a chat model on a per-image operator must price
// through the SAME margin/flat branch as any other chat model, never throw.
test("priceRequest for a chat model on a per-image operator prices by the chat mode, never throws (regression: Blocker B)", async () => {
  const cfg = baseConfig();

  const amount = await priceRequest({
    cfg,
    model: "gpt-4o",
    promptTokens: 500,
    completionTokens: 500,
  });

  // "custom" has no registered upstream resolver, so margin mode falls back
  // to fallbackPerRequestUsdc — the point is it settles a real, nonzero
  // amount instead of throwing "flat_per_image pricing is only available
  // for configured image models (gpt-4o)".
  assert.equal(amount, 10_000n);
});

test("priceRequest uses a provider's own pricing override over the operator-wide one for a chat model", async () => {
  const cfg = baseConfig({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["gpt-4o"],
      pricing: { mode: "flat", flatUsdcPer1KTokens: 0.002 },
    },
    pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, fallbackPerRequestUsdc: 10_000 },
  });

  const amount = await priceRequest({
    cfg,
    model: "gpt-4o",
    promptTokens: 500,
    completionTokens: 500,
  });

  // The provider's own $0.002/1K wins over the operator-wide $0.001/1K.
  assert.equal(amount, 2_000n);
});

// Direct regression for buildPricingAnnounce itself — the function whose
// flat_per_image guards this rework removed. Blocker A's symptom depended on
// this function wrongly excluding EVERY model (via the operator-wide mode)
// instead of only the ones actually declared image models.
test("buildPricingAnnounce excludes only configured image models and prices every other model normally (regression: Blocker A)", async () => {
  const cfg = baseConfig({
    pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, usdcPerImage: 0.02, fallbackPerRequestUsdc: 10_000 },
  });

  assert.deepEqual(await buildPricingAnnounce(cfg), { "gpt-4o": 0.001 });
});

test("image pricing announce is absent without imageModels and scoped to the subset", () => {
  const cfg = baseConfig();
  assert.deepEqual(buildImagePricingAnnounce(cfg), { "dall-e-3": 0.02 });

  const noImageModels = baseConfig({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["dall-e-3"],
    },
  });
  assert.deepEqual(buildImagePricingAnnounce(noImageModels), {});
});

test("imageModels pricing requires a valid usdcPerImage", () => {
  const cfg = baseConfig({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["dall-e-3"],
      imageModels: ["dall-e-3"],
    },
    pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, fallbackPerRequestUsdc: 10_000 },
  });

  assert.throws(() => validateConfig(cfg), /requires a finite non-negative usdcPerImage/);
});

test("imageModels must be a subset of provider models", () => {
  const cfg = baseConfig({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["gpt-4o"],
      imageModels: ["dall-e-3"],
    },
  });

  assert.throws(() => validateConfig(cfg), /must also be listed/);
});

// Regression for Blocker A: `halo setup --image-price 0.02` without
// `--image-models` used to default imageModels to EVERY advertised model
// (setup.ts's old `imageModels.length > 0 ? imageModels : models`), silently
// turning every chat model into a $0-settling image model. Assert the real
// `cmdSetup` flag path now refuses this instead of defaulting.
test("halo setup --image-price without --image-models refuses instead of defaulting to all models (regression: Blocker A)", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-setup-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  await assert.rejects(
    () =>
      cmdSetup({
        provider: "custom",
        baseUrl: "https://custom.test/v1",
        models: "gpt-4o,dall-e-3",
        margin: 25,
        imagePrice: 0.02,
        noWalletPassphrase: true,
      }),
    /--image-price requires --image-models/
  );
});

test("halo setup --image-price with --image-models produces a config where the chat model keeps token pricing (regression: Blocker A/B)", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-setup-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  await cmdSetup({
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "gpt-4o,dall-e-3",
    imageModels: "dall-e-3",
    margin: 25,
    imagePrice: 0.02,
    noWalletPassphrase: true,
  });

  const { loadConfig } = await import("./config");
  const cfg = loadConfig();

  assert.doesNotThrow(() => validateConfig(cfg));
  assert.equal(imagePriceForModel(cfg, "dall-e-3"), 0.02);
  assert.equal(imagePriceForModel(cfg, "gpt-4o"), null);
  const amount = await priceRequest({
    cfg,
    model: "gpt-4o",
    promptTokens: 500,
    completionTokens: 500,
  });
  assert.ok(amount > 0n);
});

// Regression: decoupling the per-image overlay from pricing.mode means an
// operator can legitimately have ONLY image models and no reason to pass
// --margin/--flat. cmdSetup must default the (now-inert) chat pricing mode
// silently in driven mode rather than blocking on an unanswerable prompt.
test("halo setup with only --image-price/--image-models (no --margin/--flat) completes non-interactively", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-setup-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  await cmdSetup({
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "dall-e-3",
    imageModels: "dall-e-3",
    imagePrice: 0.02,
    noWalletPassphrase: true,
  });

  const { loadConfig } = await import("./config");
  const cfg = loadConfig();

  assert.doesNotThrow(() => validateConfig(cfg));
  assert.equal(imagePriceForModel(cfg, "dall-e-3"), 0.02);
});

test("halo setup --add-provider re-run without repeating --image-price/--image-models preserves the existing overlay", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-setup-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  await cmdSetup({
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "gpt-4o,dall-e-3",
    imageModels: "dall-e-3",
    margin: 25,
    imagePrice: 0.02,
    noWalletPassphrase: true,
  });

  // Re-run --add-provider for the SAME slug (e.g. rotating nothing in
  // particular) without --image-price/--image-models this time.
  await cmdSetup({
    addProvider: true,
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "gpt-4o,dall-e-3",
    margin: 30,
    noWalletPassphrase: true,
  });

  const { loadConfig } = await import("./config");
  const cfg = loadConfig();

  assert.doesNotThrow(() => validateConfig(cfg));
  assert.equal(imagePriceForModel(cfg, "dall-e-3"), 0.02);
});

// Regression for FIX 1 (BLOCKER): providerServesConfiguredImageModel used to
// use the fuzzy bidirectional-substring matchesModel, which swept a plain
// chat model into the per-image branch whenever its id collided with a
// configured image-model id ("dall-e-3-hd" contains "dall-e-3"). That
// re-opened a free-serve bug: a chat request priced per-image, the text
// response has 0 images, and the 0-count vault path releases and collects $0.
// providerServesConfiguredImageModel now requires EXACT membership.
test("imagePriceForModel uses exact image-model membership, not substring collision (regression: FIX 1)", async () => {
  const cfg = baseConfig({
    provider: {
      slug: "custom",
      baseUrl: "https://custom.test/v1",
      models: ["gpt-4o", "dall-e-3", "dall-e-3-hd"],
      imageModels: ["dall-e-3"],
    },
    pricing: {
      mode: "margin",
      marginPercent: 25,
      usdcPerImage: 0.02,
      fallbackPerRequestUsdc: 10_000,
    },
  });

  assert.equal(imagePriceForModel(cfg, "dall-e-3"), 0.02);
  // The collision case — the fix. "dall-e-3-hd" is a plain chat model that
  // was never opted into imageModels; it must NOT resolve to the per-image
  // overlay just because its id contains "dall-e-3".
  assert.equal(imagePriceForModel(cfg, "dall-e-3-hd"), null);
  assert.equal(imagePriceForModel(cfg, "gpt-4o"), null);

  const announce = await buildPricingAnnounce(cfg);
  // The colliding chat model keeps its token price...
  assert.ok(
    "dall-e-3-hd" in announce,
    "dall-e-3-hd (chat model colliding with the image-model id) must keep its token price"
  );
  // ...and the real image model is excluded from token pricing (it's priced
  // per-image instead, via buildImagePricingAnnounce).
  assert.ok(
    !("dall-e-3" in announce),
    "dall-e-3 (the configured image model) must be excluded from token pricing"
  );

  // The legit dall-e-3 image + dall-e-3-hd chat coexistence must validate.
  assert.doesNotThrow(() => validateConfig(cfg));
});

// Regression for FIX 2 (HIGH): re-running --add-provider to change one thing
// (e.g. rotate --api-key) WITHOUT passing --margin/--flat used to write the
// newProvider with the freshly-defaulted driven-mode pricing (e.g. margin
// 30%), which then shadowed the operator's real (deliberately chosen) token
// pricing — a provider.pricing block always beats cfg.pricing. Token pricing
// must now be preserved by default, same as the existing imageModels/
// usdcPerImage overlay preservation.
test("halo setup --add-provider re-run without --margin/--flat preserves existing token pricing (regression: FIX 2)", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-setup-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  await cmdSetup({
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "gpt-4o",
    flat: 0.0007,
    noWalletPassphrase: true,
  });

  // Re-run --add-provider to rotate the API key only — no --margin/--flat.
  await cmdSetup({
    addProvider: true,
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "gpt-4o",
    apiKey: "newkey",
    noWalletPassphrase: true,
  });

  const { loadConfig } = await import("./config");
  const cfg = loadConfig();

  const amount = await priceRequest({
    cfg,
    model: "gpt-4o",
    promptTokens: 500,
    completionTokens: 500,
  });

  // The operator's deliberate flat $0.0007/1K rate must survive the API-key
  // rotation. round(0.0007 * 1e6) = 700; 700 * 1000 tokens / 1000 = 700n.
  // Without the fix this would instead price via the freshly-defaulted
  // driven-mode margin (no upstream resolver for "custom") →
  // fallbackPerRequestUsdc = 10_000n.
  assert.equal(amount, 700n);
});

// Regression for the round-4 preserve fix: --add-provider for a BRAND-NEW slug
// (nothing to preserve) must use that slug's own driven-mode default, NOT the
// primary provider's operator-wide cfg.pricing. Preserve-by-default applies only
// when re-running an EXISTING slug.
test("halo setup --add-provider for a new slug uses its own driven default, not the primary's pricing", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-setup-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // Primary gateway priced margin 25% → operator-wide cfg.pricing = margin 25.
  await cmdSetup({
    provider: "custom",
    baseUrl: "https://custom.test/v1",
    models: "gpt-4o",
    margin: 25,
    noWalletPassphrase: true,
  });

  // Add a NEW gateway (ollama) WITHOUT --margin/--flat. Its per-slug driven
  // default is flat $0.0005/1K — it must NOT silently inherit the primary's
  // margin 25 (which on ollama has no upstream resolver → per-request fallback).
  await cmdSetup({
    addProvider: true,
    provider: "ollama",
    models: "llama3",
    noWalletPassphrase: true,
  });

  const { loadConfig } = await import("./config");
  const cfg = loadConfig();
  const ollama = (cfg.providers ?? []).find((p) => p.slug === "ollama");
  assert.ok(ollama, "ollama provider should be added");
  assert.equal(ollama.pricing?.mode, "flat");
  assert.equal(ollama.pricing?.flatUsdcPer1KTokens, 0.0005);
});
