/**
 * Tests for the CLI's vault-only image generation consumer.
 *
 * Synthetic media frames are built with the OPERATOR's own real
 * `buildImageMediaFrames` (encryptBytes → chunkMediaEnvelope with
 * imageIndex/imageCount), so the round-trip through the CLI's new SSE reader
 * and decrypt path is genuine, not a hand-rolled stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  accrueImageBudget,
  buildImageResponseHeaders,
  buildImageRelayRequest,
  buildImagesResponseBody,
  consumeImageSseStream,
  imagePerRequestCapGate,
  modelAllowlistGate,
  releaseImageBudget,
  reserveImageBudget,
  selectVaultImageOperator,
  vaultSendImage,
} from "./commands/consume";
import { Wallet } from "ethers";
import { buildImageMediaFrames } from "./commands/serve";
import {
  decryptBytes,
  encryptRequest,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
  type BytesEncryptedEnvelope,
} from "./encryption";
import type { VaultConsumeClient } from "./vault-consume";
import {
  priceImages,
  selectVaultImageOperatorFromList,
  withReservationMargin,
} from "@halo/vault-core";

// ── minimal valid PNGs (only KEEP-listed chunks, so the operator's
// stripImageMetadata pass returns them byte-identical) ─────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.from([0, 0, 0, 0])]);
}
function fakePng(marker: number): Buffer {
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", Buffer.alloc(13, marker)),
    pngChunk("IDAT", Buffer.from([marker, marker, marker, marker])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sseFromFrames(frames: unknown[], settlementAmountUsdc?: string): string {
  let body = frames.map((f) => `event: halo-media\ndata: ${JSON.stringify(f)}\n\n`).join("");
  if (settlementAmountUsdc !== undefined) {
    const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: settlementAmountUsdc })).toString(
      "base64"
    );
    body += `event: halo-settlement\ndata: ${JSON.stringify({ status: 200, paymentResponse })}\n\n`;
  }
  body += `event: done\ndata: {}\n\n`;
  return body;
}

// ── D4 / test plan: CLI halo-media SSE reader ───────────────────────────────

test("consumeImageSseStream reassembles+decrypts a single-image stream into the exact original bytes and correct b64_json", async () => {
  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const raw = fakePng(7);
  const built = buildImageMediaFrames(
    "req-1",
    { data: [{ b64_json: raw.toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  const sse = sseFromFrames(built.frames, "12345");
  const res = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

  const decryptMedia = (envelope: BytesEncryptedEnvelope): Buffer =>
    decryptBytes(envelope, consumerKeys.privateKey, hexToPubkey(operatorKeys.publicKeyHex)).plaintext;

  const stream = await consumeImageSseStream(res, decryptMedia);
  assert.equal(stream.images.length, 1);
  assert.deepEqual(stream.images[0].bytes, raw);
  assert.equal(stream.images[0].mime, "image/png");
  assert.equal(stream.settlementBase, 12345n);

  const body = buildImagesResponseBody(stream.images, 1_700_000_000);
  assert.equal(body.created, 1_700_000_000);
  assert.deepEqual(body.data, [{ b64_json: raw.toString("base64") }]);
});

test("buildImageResponseHeaders exposes paid encrypted image delivery metadata and preserves budget headers", () => {
  const operator = "0x00000000000000000000000000000000000abc";
  const headers = buildImageResponseHeaders(
    operator,
    { ok: true, paid: true, chargedBase: "20000", images: [{}] },
    { "X-Halo-Budget-Remaining": "0.0800" }
  );

  assert.deepEqual(headers, {
    "X-Halo-Budget-Remaining": "0.0800",
    "X-Halo-Operator": operator,
    "X-Halo-Paid": "true",
    "X-Halo-E2E-Encrypted": "true",
    "X-Halo-Charged-Base": "20000",
  });
});

test("buildImageResponseHeaders reports an unmetered successful image without inventing a charge", () => {
  const headers = buildImageResponseHeaders("0xoperator", { ok: true, paid: false, images: [{}] });
  assert.equal(headers["X-Halo-Operator"], "0xoperator");
  assert.equal(headers["X-Halo-Paid"], "false");
  assert.equal(headers["X-Halo-E2E-Encrypted"], "true");
  assert.equal("X-Halo-Charged-Base" in headers, false);
});

test("buildImageResponseHeaders never claims operator delivery, encryption, or payment for a failed image result", () => {
  const headers = buildImageResponseHeaders(
    "0xoperator",
    { ok: false, paid: true, chargedBase: "20000" },
    { "X-Halo-Budget-Remaining": "0.1000" }
  );
  assert.deepEqual(headers, { "X-Halo-Budget-Remaining": "0.1000" });
});

test("buildImageResponseHeaders fails closed when a paid success lacks an exact base-unit charge", () => {
  assert.throws(
    () => buildImageResponseHeaders("0xoperator", { ok: true, paid: true, images: [{}] }),
    /missing a positive exact base-unit charge/
  );
  assert.throws(
    () =>
      buildImageResponseHeaders("0xoperator", {
        ok: true,
        paid: true,
        chargedBase: "0.02",
        images: [{}],
      }),
    /missing a positive exact base-unit charge/
  );
  assert.throws(
    () =>
      buildImageResponseHeaders("0xoperator", {
        ok: true,
        paid: true,
        chargedBase: "0",
        images: [{}],
      }),
    /missing a positive exact base-unit charge/
  );
});

test("buildImageResponseHeaders refuses to claim encrypted delivery when no image was delivered", () => {
  assert.throws(
    () => buildImageResponseHeaders("0xoperator", { ok: true, paid: false, images: [] }),
    /no delivered image/
  );
});

test("consumeImageSseStream groups n>1 frames by imageIndex and reassembles each image independently", async () => {
  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const rawImages = [fakePng(1), fakePng(2), fakePng(3)];
  const built = buildImageMediaFrames(
    "req-n",
    { data: rawImages.map((b) => ({ b64_json: b.toString("base64") })) },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  assert.equal(built.imageCount, 3);
  const sse = sseFromFrames(built.frames);
  const res = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  const decryptMedia = (envelope: BytesEncryptedEnvelope): Buffer =>
    decryptBytes(envelope, consumerKeys.privateKey, hexToPubkey(operatorKeys.publicKeyHex)).plaintext;

  const stream = await consumeImageSseStream(res, decryptMedia);
  assert.equal(stream.images.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(stream.images[i].bytes, rawImages[i], `image ${i} bytes preserved`);
  }
  assert.equal(stream.settlementBase, null, "no halo-settlement frame rode this stream");

  const body = buildImagesResponseBody(stream.images);
  assert.deepEqual(
    body.data,
    rawImages.map((b) => ({ b64_json: b.toString("base64") }))
  );
});

test("consumeImageSseStream extracts the halo-settlement amount independent of any media frames", async () => {
  const paymentResponse = Buffer.from(JSON.stringify({ amountUsdc: "424242" })).toString("base64");
  const sse =
    `event: halo-settlement\ndata: ${JSON.stringify({ status: 200, paymentResponse })}\n\n` +
    `event: done\ndata: {}\n\n`;
  const res = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  const stream = await consumeImageSseStream(res, () => {
    throw new Error("decryptMedia must not be called when there are no media frames");
  });
  assert.equal(stream.settlementBase, 424242n);
  assert.deepEqual(stream.images, []);
});

test("consumeImageSseStream throws an image_media_decode_failed-shaped error on a tampered frame, never returning partial images", async () => {
  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const built = buildImageMediaFrames(
    "req-bad",
    { data: [{ b64_json: fakePng(9).toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  // Flip the first 4 ciphertext characters of the FIRST frame (still valid
  // base64 alphabet, so frame-sequence validation passes). The first frame is
  // always within the real (non-padding) ciphertext region — chunkMediaEnvelope
  // only ever pads the TAIL of the last frame, and reassembleMediaEnvelope
  // truncates that padding away — so tampering the tail of the last frame
  // instead would silently land in discarded padding and never surface here.
  const tampered = built.frames.map((f, i) =>
    i === 0
      ? {
          ...f,
          ciphertext:
            (f.ciphertext.slice(0, 4) === "AAAA" ? "BBBB" : "AAAA") + f.ciphertext.slice(4),
        }
      : f
  );
  const sse = sseFromFrames(tampered);
  const res = new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  const decryptMedia = (envelope: BytesEncryptedEnvelope): Buffer =>
    decryptBytes(envelope, consumerKeys.privateKey, hexToPubkey(operatorKeys.publicKeyHex)).plaintext;

  await assert.rejects(() => consumeImageSseStream(res, decryptMedia), /image media decode failed/);
});

// ── D2: relay request always targets /v1/chat/completions + acceptMedia
// (regression for A8's dead-route blocker — never a relay images route) ────

test("buildImageRelayRequest targets /v1/chat/completions with acceptMedia in body+header, never a relay images route", () => {
  const envelope = {
    v: 1 as const,
    alg: "x25519-aes256gcm" as const,
    epk: "e".repeat(64),
    nonce: "0".repeat(24),
    ct: "deadbeef",
  };
  const built = buildImageRelayRequest("https://relay.test/", "0xoperator", "0xconsumer", "dall-e-3", envelope);
  assert.equal(built.url, "https://relay.test/v1/chat/completions");
  assert.ok(!built.url.includes("/v1/images/generations"), "must never target a relay images route");
  assert.deepEqual(built.body, { model: "dall-e-3", acceptMedia: true, _enc: envelope });
  assert.equal(built.headers["x-halo-payment-mode"], "vault");
  assert.equal(built.headers["x-halo-operator"], "0xoperator");
  assert.equal(built.headers["x-halo-vault-consumer"], "0xconsumer");
  assert.equal(built.headers["x-halo-accept-media"], "1");
  assert.equal("x-halo-max-price" in built.headers, false, "image requests never send x-halo-max-price");
});

// ── D3 / invariant #7: selection is exact per-image pricing, never a token
// fallback ───────────────────────────────────────────────────────────────────

test("selectVaultImageOperatorFromList never falls back to token pricing when no per-image price is announced", () => {
  const operators = [
    // Only a TOKEN price is announced for this model; not a member of
    // imageModels at all, so it must never be swept onto the image branch.
    { address: "0x1", models: ["dall-e-3"], pricing: { "dall-e-3": 5 }, vaultPayments: true },
  ];
  const selection = selectVaultImageOperatorFromList(operators, "dall-e-3");
  assert.equal(selection.selected, null);
  assert.equal(selection.reason, "no_operator");
});

test("selectVaultImageOperator skips a cheaper forged key but never falls through an explicit pin", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const forgedWallet = Wallet.createRandom();
  const validWallet = Wallet.createRandom();
  const forgedKeys = generateOperatorKeypair();
  const validKeys = generateOperatorKeypair();
  const forgedPubkey = forgedKeys.publicKeyHex.replace(/^0x/, "").toLowerCase();
  const validPubkey = validKeys.publicKeyHex.replace(/^0x/, "").toLowerCase();
  const forgedMessage = `halo-pubkey:${forgedWallet.address.toLowerCase()}:${forgedPubkey}`;
  const validMessage = `halo-pubkey:${validWallet.address.toLowerCase()}:${validPubkey}`;
  const forgedAttestation = await Wallet.createRandom().signMessage(forgedMessage);
  const validAttestation = await validWallet.signMessage(validMessage);
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        operators: [
          {
            address: forgedWallet.address,
            models: [],
            imageModels: ["dall-e-3"],
            imagePricing: { "dall-e-3": 0.01 },
            encryptionPubkey: forgedKeys.publicKeyHex,
            pubkeyAttestation: forgedAttestation,
            vaultPayments: true,
          },
          {
            address: validWallet.address,
            models: [],
            imageModels: ["dall-e-3"],
            imagePricing: { "dall-e-3": 0.02 },
            encryptionPubkey: validKeys.publicKeyHex,
            pubkeyAttestation: validAttestation,
            vaultPayments: true,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const selected = await selectVaultImageOperator("https://relay.test", "dall-e-3");
  assert.equal(selected.pin?.address, validWallet.address);
  assert.equal(selected.pin?.priceUsdcPerImage, 0.02);
  assert.equal(selected.pin?.encryptionPubkey, validPubkey);

  const pinnedForged = await selectVaultImageOperator(
    "https://relay.test",
    "dall-e-3",
    forgedWallet.address
  );
  assert.equal(pinnedForged.pin, null);
  assert.equal(pinnedForged.reason, "no_encrypted_operator");

  const pinnedValid = await selectVaultImageOperator(
    "https://relay.test",
    "dall-e-3",
    validWallet.address
  );
  assert.equal(pinnedValid.pin?.address, validWallet.address);
});

// ── D3 + D5: sizing via priceImages × n with margin, metering from the
// settlement only, full round trip via vaultSendImage ──────────────────────

test("vaultSendImage sizes the reservation via priceImages(perImage, n) with margin, sends acceptMedia to /v1/chat/completions, and meters/redeems from the settlement only", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const raw = fakePng(4);
  const built = buildImageMediaFrames(
    "req-vault-send",
    { data: [{ b64_json: raw.toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  const sse = sseFromFrames(built.frames, "20000");

  const operator = "0x00000000000000000000000000000000000abc";
  let seenUrl = "";
  let seenHeaders: Headers | null = null;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = new Headers(init?.headers);
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const ensuredCosts: bigint[] = [];
  let redeemed: { operator: string; cost: bigint } | undefined;
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => {
      ensuredCosts.push(cost);
      return { ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n }, keyEpoch: 1n };
    },
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: (servedBy: string, _ops: unknown, _epoch: bigint, cost: bigint) => {
      redeemed = { operator: servedBy, cost };
    },
  } as unknown as VaultConsumeClient;

  const envelope = encryptRequest(
    { prompt: "draw a halo" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );

  const result = await vaultSendImage(client, "https://relay.test", {
    operator,
    priceUsdcPerImage: 0.02,
    imageCount: 3,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  // Reservation is sized from the announced per-image price × the requested
  // count, with margin — never from token pricing (invariant #7).
  const expectedCost = withReservationMargin(priceImages(0.02, 3));
  assert.deepEqual(ensuredCosts, [expectedCost]);

  // Relay call is /v1/chat/completions with acceptMedia — never a relay
  // images route (A8's dead-route blocker).
  assert.equal(seenUrl, "https://relay.test/v1/chat/completions");
  assert.equal(seenHeaders!.get("x-halo-accept-media"), "1");
  assert.equal(seenHeaders!.get("x-halo-payment-mode"), "vault");
  assert.equal(seenHeaders!.has("x-halo-max-price"), false);

  assert.equal(result.ok, true);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0].bytes, raw);
  // Metered from the operator's settlement only (20000), NOT from n=3 or any
  // token-price guess.
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "20000");
  assert.deepEqual(redeemed, { operator, cost: 20000n });
});

test("vaultSendImage leaves the response unmetered (no redeem) when the operator never settles", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const raw = fakePng(5);
  const built = buildImageMediaFrames(
    "req-no-settlement",
    { data: [{ b64_json: raw.toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  // Media frames but NO halo-settlement event at all.
  const sse = sseFromFrames(built.frames);

  global.fetch = (async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

  let redeemCalled = false;
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => ({
      ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
  } as unknown as VaultConsumeClient;

  const envelope = encryptRequest(
    { prompt: "x" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );

  const result = await vaultSendImage(client, "https://relay.test", {
    operator: "0x00000000000000000000000000000000000abc",
    priceUsdcPerImage: 0.02,
    imageCount: 1,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.equal(result.images.length, 1, "images are still delivered even though unmetered");
  assert.equal(result.paid, false);
  assert.equal(result.chargedBase, undefined);
  assert.equal(redeemCalled, false, "never guess a charge — unmeterable stays unmetered");
});

// ── FIX 1 (invariant #1/#3): redeem must be tied to images actually
// delivered, never to a bare operator-claimed settlement ───────────────────

test("vaultSendImage refuses a positive settlement with ZERO media frames — never redeems for images not delivered", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  // A non-compliant operator: a positive halo-settlement, but NO halo-media
  // frames at all rode this stream.
  const sse = sseFromFrames([], "20000");
  global.fetch = (async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  let redeemCalled = false;
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => ({
      ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
  } as unknown as VaultConsumeClient;

  const envelope = encryptRequest(
    { prompt: "x" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );

  const result = await vaultSendImage(client, "https://relay.test", {
    operator: "0x00000000000000000000000000000000000abc",
    priceUsdcPerImage: 0.02,
    imageCount: 1,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  assert.equal(redeemCalled, false, "must never redeem a settlement claimed with zero delivered images");
  assert.equal(result.ok, false);
  assert.equal(result.paid, false);
  assert.deepEqual(result.images, []);
  assert.equal(
    (result.errorBody as { error: { type: string } }).error.type,
    "image_no_media_delivered"
  );
});

test("vaultSendImage refuses ZERO media frames even when the operator never settles", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = (async () =>
    new Response(sseFromFrames([]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  let redeemCalled = false;
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => ({
      ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: () => {
      redeemCalled = true;
    },
  } as unknown as VaultConsumeClient;
  const envelope = encryptRequest(
    { prompt: "x" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );

  const result = await vaultSendImage(client, "https://relay.test", {
    operator: "0x00000000000000000000000000000000000abc",
    priceUsdcPerImage: 0.02,
    imageCount: 1,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  assert.equal(redeemCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.deepEqual(result.images, []);
  assert.equal(
    (result.errorBody as { error: { type: string } }).error.type,
    "image_no_media_delivered"
  );
});

test("vaultSendImage caps the redeemed amount to what the decoded image count justifies, never the operator's inflated settlement", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const raw = fakePng(11);
  // Only ONE image's frames actually made it through decode...
  const built = buildImageMediaFrames(
    "req-cap",
    { data: [{ b64_json: raw.toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  const perImage = 0.02;
  // ...but the settlement claims 3 images' worth.
  const inflatedSettlement = priceImages(perImage, 3).toString();
  const sse = sseFromFrames(built.frames, inflatedSettlement);

  global.fetch = (async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

  let redeemed: { operator: string; cost: bigint } | undefined;
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => ({
      ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: (servedBy: string, _ops: unknown, _epoch: bigint, cost: bigint) => {
      redeemed = { operator: servedBy, cost };
    },
  } as unknown as VaultConsumeClient;

  const envelope = encryptRequest(
    { prompt: "x" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );
  const operator = "0x00000000000000000000000000000000000abc";

  const result = await vaultSendImage(client, "https://relay.test", {
    operator,
    priceUsdcPerImage: perImage,
    imageCount: 3,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  const justifiedForOne = priceImages(perImage, 1);
  assert.equal(result.ok, true);
  assert.equal(result.images.length, 1);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, justifiedForOne.toString());
  assert.notEqual(result.chargedBase, inflatedSettlement, "must not redeem the operator's inflated settlement");
  assert.deepEqual(redeemed, { operator, cost: justifiedForOne }, "redeemed the CAPPED amount");
});

// ── Reserve-and-replay (invariant #5), mirroring
// vaultConsumeRetry.test.ts's text-path test for the image path ────────────

test("vaultSendImage re-reserves the typed vault_reservation_insufficient requirement and retries the unserved request once, redeeming with the POST-retry ops/keyEpoch", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const raw = fakePng(30);
  const built = buildImageMediaFrames(
    "req-retry",
    { data: [{ b64_json: raw.toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  const sse = sseFromFrames(built.frames, "20000");

  let sends = 0;
  global.fetch = (async () => {
    sends += 1;
    if (sends === 1) {
      return new Response(
        JSON.stringify({
          error: { type: "vault_reservation_insufficient", requiredUsdcBase: "50000" },
        }),
        { status: 402, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const ensured: bigint[] = [];
  let redeemed: { operator: string; cycle: bigint; keyEpoch: bigint; cost: bigint } | undefined;
  const operator = "0x00000000000000000000000000000000000abc";
  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => {
      ensured.push(cost);
      const retry = ensured.length === 2;
      return {
        ops: {
          locked: retry ? 50_000n : 1_000n,
          redeemed: 0n,
          expiry: 0n,
          created: 0n,
          cycle: retry ? 2n : 1n,
        },
        keyEpoch: retry ? 2n : 1n,
      };
    },
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: (servedBy: string, ops: { cycle: bigint }, keyEpoch: bigint, cost: bigint) => {
      redeemed = { operator: servedBy, cycle: ops.cycle, keyEpoch, cost };
    },
  } as unknown as VaultConsumeClient;

  const envelope = encryptRequest(
    { prompt: "x" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );

  const result = await vaultSendImage(client, "https://relay.test", {
    operator,
    priceUsdcPerImage: 0.02,
    imageCount: 1,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  assert.equal(sends, 2, "first send 402'd on an insufficient reservation, retry succeeded");
  assert.equal(ensured.length, 2);
  assert.equal(ensured[1], 50_000n, "re-reserved the reported requiredUsdcBase, not a single-shot give-up");
  assert.equal(result.ok, true);
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "20000");
  assert.deepEqual(
    redeemed,
    { operator, cycle: 2n, keyEpoch: 2n, cost: 20000n },
    "redeemed using the POST-retry ops/keyEpoch, never a stale pre-retry snapshot"
  );
});

// ── FIX 2: cumulative --budget-usdc gate wired into the image route ────────

test("imagePerRequestCapGate refuses an image ceiling above --max-usdc before payment", () => {
  const gate = imagePerRequestCapGate(60_000n, 50_000n);
  assert.ok(gate);
  assert.equal(gate!.status, 402);
  assert.deepEqual(gate!.body, {
    error: {
      message:
        "Image request ceiling of $0.0600 exceeds the per-request cap of $0.0500. Raise it with --max-usdc, request fewer images, or route to a cheaper operator.",
      type: "halo_over_cap",
      code: "over_cap",
      requiredUsdcBase: "60000",
      maxUsdcBase: "50000",
    },
  });
});

test("imagePerRequestCapGate admits an image ceiling at or below --max-usdc", () => {
  assert.equal(imagePerRequestCapGate(50_000n, 50_000n), null);
  assert.equal(imagePerRequestCapGate(49_999n, 50_000n), null);
});

test("reserveImageBudget refuses (402 halo_over_budget/over_budget) when the image ceiling would exceed the budget, leaving state untouched", () => {
  const budget = { spentBase: 90_000n, reservedBase: 0n, budgetBase: 100_000n };
  const ceiling = 20_000n; // spent + reserved + ceiling = 110_000 > 100_000 cap
  const admission = reserveImageBudget(budget, ceiling, "http://127.0.0.1:8799/v1/budget");
  assert.equal(admission.admitted, false);
  if (!admission.admitted) {
    const body = admission.body as { error: { type: string; code: string } };
    assert.equal(body.error.type, "halo_over_budget");
    assert.equal(body.error.code, "over_budget");
  }
  assert.equal(budget.reservedBase, 0n, "a refusal must never reserve");
});

test("reserveImageBudget admits and reserves when the ceiling fits; releaseImageBudget gives it back and clamps at zero", () => {
  const budget = { spentBase: 10_000n, reservedBase: 0n, budgetBase: 100_000n };
  const ceiling = 20_000n;
  const admission = reserveImageBudget(budget, ceiling, "http://127.0.0.1:8799/v1/budget");
  assert.equal(admission.admitted, true);
  assert.equal(budget.reservedBase, 20_000n);
  releaseImageBudget(budget, ceiling);
  assert.equal(budget.reservedBase, 0n);
  releaseImageBudget(budget, ceiling);
  assert.equal(budget.reservedBase, 0n, "a stray double-release must never underflow negative");
});

test("reserveImageBudget is a no-op admit when the session budget is uncapped (budgetBase 0)", () => {
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const admission = reserveImageBudget(budget, 1_000_000_000n, "http://127.0.0.1:8799/v1/budget");
  assert.equal(admission.admitted, true);
  assert.equal(budget.reservedBase, 0n, "uncapped budget never reserves");
});

test("accrueImageBudget adds the charged amount to spentBase only on a paid, parseable result", () => {
  const budget = { spentBase: 5_000n };
  accrueImageBudget(budget, { paid: true, chargedBase: "1234" });
  assert.equal(budget.spentBase, 6_234n);
  accrueImageBudget(budget, { paid: false, chargedBase: "999" });
  assert.equal(budget.spentBase, 6_234n, "an unpaid result never accrues");
  accrueImageBudget(budget, { paid: true });
  assert.equal(budget.spentBase, 6_234n, "paid with no chargedBase never accrues");
});

test("simulated handleImage budget flow: an over-ceiling request never reaches the relay, and a paid request accrues spentBase by the charged amount", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const perImage = 0.02;
  const n = 3;
  const ceiling = priceImages(perImage, n);

  // 1) Budget too tight for this request's ceiling — must refuse BEFORE ever
  // calling vaultSendImage/the relay (mirrors handleImage's gate ordering).
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error("must not be called — the budget gate must refuse first");
  }) as typeof fetch;
  const tightBudget = { spentBase: 0n, reservedBase: 0n, budgetBase: ceiling - 1n };
  const refusal = reserveImageBudget(tightBudget, ceiling, "http://127.0.0.1:8799/v1/budget");
  assert.equal(refusal.admitted, false);
  assert.equal(fetchCalled, false, "no relay call on a budget refusal");

  // 2) Roomy budget — admits, pays, and accrues exactly the charged amount.
  const roomyBudget = { spentBase: 0n, reservedBase: 0n, budgetBase: ceiling * 10n };
  const admission = reserveImageBudget(roomyBudget, ceiling, "http://127.0.0.1:8799/v1/budget");
  assert.equal(admission.admitted, true);
  assert.equal(roomyBudget.reservedBase, ceiling);

  const operatorKeys = generateOperatorKeypair();
  const consumerKeys = generateEphemeralKeypair();
  const raw = fakePng(21);
  const built = buildImageMediaFrames(
    "req-budget-ok",
    { data: [{ b64_json: raw.toString("base64") }] },
    hexToPubkey(consumerKeys.publicKeyHex),
    operatorKeys
  );
  const chargedUsdc = priceImages(perImage, 1).toString();
  const sse = sseFromFrames(built.frames, chargedUsdc);
  global.fetch = (async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;

  const client = {
    ensureReservation: async (_operator: string, cost: bigint) => ({
      ops: { locked: cost, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x00000000000000000000000000000000000def",
    recordAndRedeem: () => {},
  } as unknown as VaultConsumeClient;

  const envelope = encryptRequest(
    { prompt: "x" },
    hexToPubkey(operatorKeys.publicKeyHex),
    consumerKeys
  );
  const result = await vaultSendImage(client, "https://relay.test", {
    operator: "0x00000000000000000000000000000000000abc",
    priceUsdcPerImage: perImage,
    imageCount: n,
    model: "dall-e-3",
    envelope,
    ephemeralPrivateKey: consumerKeys.privateKey,
    operatorPublicKey: hexToPubkey(operatorKeys.publicKeyHex),
    signal: new AbortController().signal,
  });

  // Same release/accrue ordering handleImage performs after vaultSendImage settles.
  releaseImageBudget(roomyBudget, ceiling);
  accrueImageBudget(roomyBudget, result);

  assert.equal(roomyBudget.reservedBase, 0n, "the reservation is released once the request settles");
  assert.equal(roomyBudget.spentBase, BigInt(chargedUsdc), "spentBase accrues exactly the charged amount");
});

// ── FIX 3: cfg.consume.allowedModels enforcement for the image route ───────

test("modelAllowlistGate refuses (403 halo_model_not_allowed) a model outside the configured allowlist, before any payment", () => {
  const gate = modelAllowlistGate("gpt-image-1", ["dall-e-3", "dall-e-2"]);
  assert.ok(gate);
  assert.equal(gate!.status, 403);
  assert.equal((gate!.body as { error: { type: string } }).error.type, "halo_model_not_allowed");
});

test("modelAllowlistGate is a no-op when the model is in the allowlist, or no allowlist is configured", () => {
  assert.equal(modelAllowlistGate("dall-e-3", ["dall-e-3"]), null);
  assert.equal(modelAllowlistGate("anything", undefined), null);
  assert.equal(modelAllowlistGate("anything", []), null);
});
