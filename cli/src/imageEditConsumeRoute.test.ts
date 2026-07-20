import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Wallet } from "ethers";
import {
  createConsumeHttpServer,
  createImageEditHandler,
  dispatchConsumeInferenceRoute,
  imageEditRelayBodyBytes,
  imageEditRelayBodyBytesForPlaintext,
  selectVaultImageOperator,
  vaultSendImageEdit,
  type ConsumeRequestHandler,
  type ImageEditHandlerDependencies,
  type VaultImageSendResult,
} from "./commands/consume";
import { buildImageMediaFrames } from "./commands/serve";
import {
  chunkMediaEnvelope,
  packMediaPlaintext,
  padToBucket,
} from "./mediaChunks";
import {
  decryptBytes,
  encryptBytes,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
  type BytesEncryptedEnvelope,
  type OperatorKeyPair,
} from "./encryption";
import type { VaultConsumeClient } from "./vault-consume";
import {
  IMAGE_EDIT_MAX_BODY_BYTES,
  IMAGE_EDIT_MAX_INPUT_BYTES,
  parseImageEditPlaintext,
  type ImageEditPlaintextV1,
} from "@halo/vault-core";

const MODEL = "openai/gpt-image-1";
const CONSUMER = "0x00000000000000000000000000000000000000c0";

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function fakePng(dataBytes = 4, metadata = false): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13, 1)),
    ...(metadata ? [pngChunk("tEXt", Buffer.from("GPS=private"))] : []),
    pngChunk("IDAT", Buffer.alloc(dataBytes, 7)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

function multipart(parts: MultipartPart[], boundary = "halo-edit-boundary"): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const filename = part.filename === undefined ? "" : `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(typeof part.value === "string" ? Buffer.from(part.value) : part.value);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function validParts(image = fakePng(4, true), n = "1"): MultipartPart[] {
  return [
    { name: "model", value: MODEL },
    { name: "prompt", value: "remove the background" },
    { name: "n", value: n },
    { name: "image", value: image, filename: "source.png", contentType: "image/png" },
  ];
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startSidecar(
  t: TestContext,
  deps: ImageEditHandlerDependencies,
  counters: { generation: number; completion: number } = { generation: 0, completion: 0 }
): Promise<{ url: string; server: http.Server }> {
  const edit = createImageEditHandler(deps);
  const completion: ConsumeRequestHandler = async (_req, res) => {
    counters.completion += 1;
    res.writeHead(204).end();
  };
  const generation: ConsumeRequestHandler = async (_req, res) => {
    counters.generation += 1;
    res.writeHead(204).end();
  };
  const server = createConsumeHttpServer(async (req, res) => {
    const routed = dispatchConsumeInferenceRoute(req, res, {
      completion,
      imageGeneration: generation,
      imageEdit: edit,
    });
    if (routed) return routed;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "halo_not_found" } }));
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  return { url, server };
}

async function postMultipart(
  url: string,
  parts: MultipartPart[],
  headers: Record<string, string> = {},
  boundary = "halo-edit-boundary"
): Promise<{ response: Response; json: any }> {
  const body = multipart(parts, boundary);
  const response = await fetch(`${url}/v1/images/edits`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, ...headers },
    body,
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

async function postRawHttp(
  url: string,
  body: Buffer,
  headers: Record<string, string>
): Promise<{ status: number; json: any }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: "POST",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}

function budgetHeaders(budget: { spentBase: bigint; budgetBase: bigint }): Record<string, string> {
  if (budget.budgetBase === 0n) return {};
  return {
    "X-Halo-Budget-Spent": (Number(budget.spentBase) / 1_000_000).toFixed(4),
    "X-Halo-Budget-Remaining":
      (Number(budget.budgetBase - budget.spentBase) / 1_000_000).toFixed(4),
  };
}

interface TestOperator {
  advertisement: Record<string, unknown>;
  keys: OperatorKeyPair;
}

async function makeOperator(
  overrides: Record<string, unknown> = {},
  authenticated = true
): Promise<TestOperator> {
  const wallet = Wallet.createRandom();
  const keys = generateOperatorKeypair();
  const pubkey = keys.publicKeyHex.replace(/^0x/, "").toLowerCase();
  const signer = authenticated ? wallet : Wallet.createRandom();
  const pubkeyAttestation = await signer.signMessage(
    `halo-pubkey:${wallet.address.toLowerCase()}:${pubkey}`
  );
  return {
    keys,
    advertisement: {
      address: wallet.address,
      models: [MODEL],
      imageModels: [MODEL],
      imageEditModels: [MODEL],
      imagePricing: { [MODEL]: 0.02 },
      encryptionPubkey: keys.publicKeyHex,
      pubkeyAttestation,
      vaultPayments: true,
      ...overrides,
    },
  };
}

interface RelayState {
  operatorRequests: number;
  editRequests: number;
  chatRequests: number;
  wrappers: Array<Record<string, unknown>>;
  plaintexts: ImageEditPlaintextV1[];
}

interface RelayMode {
  outputImages?: Buffer[];
  rawMedia?: Array<{ bytes: Buffer; mime: string }>;
  settlementBase?: string;
  reservationFailures?: number;
  reservationRequiredBase?: string;
}

async function startRelay(
  t: TestContext,
  operators: TestOperator[],
  mode: RelayMode = {}
): Promise<{ url: string; state: RelayState }> {
  const state: RelayState = {
    operatorRequests: 0,
    editRequests: 0,
    chatRequests: 0,
    wrappers: [],
    plaintexts: [],
  };
  let remainingReservationFailures = mode.reservationFailures ?? 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/operators") {
      state.operatorRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ operators: operators.map((operator) => operator.advertisement) }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      state.chatRequests += 1;
      res.writeHead(500).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/images/edit") {
      res.writeHead(404).end();
      return;
    }
    state.editRequests += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const wrapper = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    state.wrappers.push(wrapper);
    const selectedAddress = String(req.headers["x-halo-operator"] || "").toLowerCase();
    const selected = operators.find(
      (operator) => String(operator.advertisement.address).toLowerCase() === selectedAddress
    );
    assert.ok(selected, "relay request pins one advertised operator");
    const opened = decryptBytes(wrapper._enc as BytesEncryptedEnvelope, selected.keys.privateKey);
    state.plaintexts.push(parseImageEditPlaintext(opened.plaintext));

    if (remainingReservationFailures > 0) {
      remainingReservationFailures -= 1;
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "vault_reservation_insufficient",
            requiredUsdcBase: mode.reservationRequiredBase ?? "50000",
          },
        })
      );
      return;
    }

    const requestId = `edit-${state.editRequests}`;
    const frames = mode.rawMedia
      ? mode.rawMedia.flatMap((media, imageIndex) => {
          const padded = padToBucket(packMediaPlaintext(media.bytes, media.mime));
          try {
            const envelope = encryptBytes(padded, opened.senderPublicKey, selected.keys);
            return chunkMediaEnvelope(requestId, envelope, {
              imageIndex,
              imageCount: mode.rawMedia!.length,
            });
          } finally {
            padded.fill(0);
          }
        })
      : buildImageMediaFrames(
          requestId,
          {
            data: (mode.outputImages ?? [fakePng(5)]).map((image) => ({
              b64_json: image.toString("base64"),
            })),
          },
          opened.senderPublicKey,
          selected.keys
        ).frames;
    let body = frames
      .map((frame) => `event: halo-media\ndata: ${JSON.stringify(frame)}\n\n`)
      .join("");
    if (mode.settlementBase !== undefined) {
      const paymentResponse = Buffer.from(
        JSON.stringify({ amountUsdc: mode.settlementBase })
      ).toString("base64");
      body += `event: halo-settlement\ndata: ${JSON.stringify({ paymentResponse })}\n\n`;
    }
    body += "event: done\ndata: {}\n\n";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  });
  const url = await listen(server);
  t.after(() => closeServer(server));
  return { url, state };
}

function fakeVault() {
  const ensured: bigint[] = [];
  const redeemed: bigint[] = [];
  const client = {
    ensureReservation: async (_operator: string, amount: bigint, _signal?: AbortSignal) => {
      ensured.push(amount);
      return {
        ops: { locked: amount, redeemed: 0n, expiry: 0n, created: 0n, cycle: BigInt(ensured.length) },
        keyEpoch: BigInt(ensured.length),
      };
    },
    consumer: async () => CONSUMER,
    recordAndRedeem: (_operator: string, _ops: unknown, _epoch: bigint, amount: bigint) => {
      redeemed.push(amount);
    },
  } as unknown as VaultConsumeClient;
  return { client, ensured, redeemed };
}

function relayDependencies(
  relayUrl: string,
  vault: VaultConsumeClient,
  budget: { spentBase: bigint; reservedBase: bigint; budgetBase: bigint },
  overrides: Partial<ImageEditHandlerDependencies> = {}
): ImageEditHandlerDependencies {
  return {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => budgetHeaders(budget),
    selectOperator: (model, pinned, signal) =>
      selectVaultImageOperator(relayUrl, model, pinned, true, signal),
    sendImage: (opts) => vaultSendImageEdit(vault, relayUrl, opts),
    ...overrides,
  };
}

test("loopback sidecar routes plural edits, strips before v2 relay send, returns paid b64_json evidence, and keeps generation wiring", async (t) => {
  const operator = await makeOperator();
  const relay = await startRelay(t, [operator], { settlementBase: "20000" });
  const vault = fakeVault();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const counters = { generation: 0, completion: 0 };
  const sidecar = await startSidecar(
    t,
    relayDependencies(relay.url, vault.client, budget),
    counters
  );

  const original = fakePng(4, true);
  const clean = fakePng(4, false);
  const { response, json } = await postMultipart(
    sidecar.url,
    validParts(original).filter((part) => part.name !== "n")
  );
  assert.equal(response.status, 200);
  assert.deepEqual(json.data, [{ b64_json: fakePng(5).toString("base64") }]);
  assert.equal(response.headers.get("x-halo-operator"), operator.advertisement.address);
  assert.equal(response.headers.get("x-halo-paid"), "true");
  assert.equal(response.headers.get("x-halo-e2e-encrypted"), "true");
  assert.equal(response.headers.get("x-halo-charged-base"), "20000");
  assert.equal(response.headers.get("x-halo-budget-spent"), "0.0200");
  assert.equal(relay.state.editRequests, 1);
  assert.equal(relay.state.chatRequests, 0);
  assert.deepEqual(Object.keys(relay.state.wrappers[0]).sort(), ["_enc", "acceptMedia", "model"]);
  assert.equal(relay.state.wrappers[0].model, MODEL);
  assert.equal(relay.state.wrappers[0].acceptMedia, true);
  assert.equal((relay.state.wrappers[0]._enc as BytesEncryptedEnvelope).v, 2);
  assert.deepEqual(Buffer.from(relay.state.plaintexts[0].image.b64_json, "base64"), clean);
  assert.equal(relay.state.plaintexts[0].prompt, "remove the background");
  assert.equal(relay.state.plaintexts[0].n, 1);
  assert.equal(budget.spentBase, 20_000n);
  assert.equal(budget.reservedBase, 0n);
  assert.deepEqual(vault.redeemed, [20_000n]);

  const singular = await fetch(`${sidecar.url}/v1/images/edit`, { method: "POST" });
  assert.equal(singular.status, 404, "the public route is plural; singular is relay-internal only");
  const generation = await fetch(`${sidecar.url}/v1/images/generations`, { method: "POST" });
  assert.equal(generation.status, 204);
  assert.equal(counters.generation, 1);
});

test("route rejects JSON, raw images, malformed boundaries, duplicate fields, unknown fields, and invalid n with typed 4xx errors", async (t) => {
  const operator = await makeOperator();
  let selections = 0;
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const deps: ImageEditHandlerDependencies = {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => ({}),
    selectOperator: async () => {
      selections += 1;
      return {
        pin: {
          address: String(operator.advertisement.address),
          priceUsdcPerImage: 0.02,
          encryptionPubkey: operator.keys.publicKeyHex,
        },
        reason: "selected",
      };
    },
    sendImage: async () => {
      throw new Error("must not send malformed requests");
    },
  };
  const sidecar = await startSidecar(t, deps);

  for (const contentType of ["application/json", "image/png"]) {
    const response = await fetch(`${sidecar.url}/v1/images/edits`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: contentType === "application/json" ? "{}" : fakePng(),
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json() as any).error.code, "unsupported_content_type");
  }

  const malformed = await fetch(`${sidecar.url}/v1/images/edits`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=wrong" },
    body: multipart(validParts(), "right"),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as any).error.code, "malformed_multipart");

  const duplicate = await postMultipart(sidecar.url, [
    ...validParts(),
    { name: "prompt", value: "second prompt" },
  ]);
  assert.equal(duplicate.response.status, 400);
  assert.equal(duplicate.json.error.code, "duplicate_multipart_field");

  const multipleImages = await postMultipart(sidecar.url, [
    ...validParts(),
    { name: "image", value: fakePng(), filename: "second.png", contentType: "image/png" },
  ]);
  assert.equal(multipleImages.response.status, 400);
  assert.equal(multipleImages.json.error.code, "duplicate_multipart_field");

  const unknown = await postMultipart(sidecar.url, [
    ...validParts(),
    { name: "mask", value: fakePng(), filename: "mask.png", contentType: "image/png" },
  ]);
  assert.equal(unknown.response.status, 400);
  assert.equal(unknown.json.error.code, "unknown_multipart_field");

  for (const n of ["0", "1.5", "11"]) {
    const invalid = await postMultipart(sidecar.url, validParts(fakePng(), n));
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.error.code, "invalid_image_count");
  }
  for (const missing of ["model", "prompt", "image"]) {
    const result = await postMultipart(
      sidecar.url,
      validParts().filter((part) => part.name !== missing)
    );
    assert.equal(result.response.status, 400);
    assert.equal(result.json.error.code, `missing_${missing}`);
  }
  assert.equal(selections, 0);
});

test("multipart reader enforces both trusted Content-Length and streaming byte counts", async (t) => {
  let selections = 0;
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const sidecar = await startSidecar(t, {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => ({}),
    selectOperator: async () => {
      selections += 1;
      throw new Error("must not select an oversized request");
    },
    sendImage: async () => {
      throw new Error("must not send an oversized request");
    },
  });
  const oversized = Buffer.alloc(IMAGE_EDIT_MAX_BODY_BYTES + 1, 1);
  const contentType = "multipart/form-data; boundary=halo-edit-boundary";
  const declared = await postRawHttp(`${sidecar.url}/v1/images/edits`, oversized, {
    "content-type": contentType,
    "content-length": String(oversized.length),
  });
  assert.equal(declared.status, 413);
  assert.equal(declared.json.error.code, "request_too_large");

  const streamed = await postRawHttp(`${sidecar.url}/v1/images/edits`, oversized, {
    "content-type": contentType,
  });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.json.error.code, "request_too_large");
  assert.equal(selections, 0);
});

test("both unsupported and malformed strip failures return typed 400 before selection or send", async (t) => {
  let selections = 0;
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const sidecar = await startSidecar(t, {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => ({}),
    selectOperator: async () => {
      selections += 1;
      throw new Error("must not select");
    },
    sendImage: async () => {
      throw new Error("must not send");
    },
  });

  const unsupported = await postMultipart(
    sidecar.url,
    validParts(Buffer.from("not an image")).map((part) =>
      part.name === "image" ? { ...part, contentType: "application/octet-stream" } : part
    )
  );
  assert.equal(unsupported.response.status, 400);
  assert.equal(unsupported.json.error.code, "image_strip_failed");

  const malformedPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13)),
  ]);
  const malformed = await postMultipart(sidecar.url, validParts(malformedPng));
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.json.error.code, "image_strip_failed");
  assert.equal(selections, 0);
});

test("global and request-level confidentiality requirements fail edits closed before selection", async (t) => {
  let selections = 0;
  const logged: boolean[] = [];
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const deps: ImageEditHandlerDependencies = {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => ({}),
    selectOperator: async () => {
      selections += 1;
      throw new Error("must not select a confidential image edit");
    },
    sendImage: async () => {
      throw new Error("must not send a confidential image edit");
    },
    logRequest: (info) => logged.push(info.confidential),
  };

  const globalSidecar = await startSidecar(t, { ...deps, confidentialOnly: true });
  const global = await postMultipart(globalSidecar.url, validParts());
  assert.equal(global.response.status, 400);
  assert.equal(global.json.error.type, "halo_confidential_error");
  assert.equal(global.json.error.code, "image_edit_confidential_unsupported");

  const requestSidecar = await startSidecar(t, deps);
  const perRequest = await postMultipart(
    requestSidecar.url,
    validParts(),
    { "x-halo-confidential": "true" }
  );
  assert.equal(perRequest.response.status, 400);
  assert.equal(perRequest.json.error.type, "halo_confidential_error");
  assert.equal(perRequest.json.error.code, "image_edit_confidential_unsupported");
  assert.equal(selections, 0);
  assert.deepEqual(logged, [true, true]);
});

test("stripped input and final encrypted body caps fail before relay/funded work", async (t) => {
  const operator = await makeOperator();
  let selections = 0;
  let sends = 0;
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const baseDeps: ImageEditHandlerDependencies = {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => budgetHeaders(budget),
    selectOperator: async () => {
      selections += 1;
      return {
        pin: {
          address: String(operator.advertisement.address),
          priceUsdcPerImage: 0.02,
          encryptionPubkey: operator.keys.publicKeyHex,
        },
        reason: "selected",
      };
    },
    sendImage: async () => {
      sends += 1;
      throw new Error("must not send an oversized request");
    },
  };
  const inputSidecar = await startSidecar(t, baseDeps);
  const inputOverflow = await postMultipart(
    inputSidecar.url,
    validParts(fakePng(IMAGE_EDIT_MAX_INPUT_BYTES + 1))
  );
  assert.equal(inputOverflow.response.status, 413);
  assert.equal(inputOverflow.json.error.code, "image_too_large");
  assert.equal(selections, 0);
  assert.equal(sends, 0);

  for (const model of [MODEL, 'model-"-😀']) {
    for (const byteLength of [0, 1, 2, 3, 31]) {
      const samplePlaintext = Buffer.alloc(byteLength, 1);
      const sampleEnvelope = encryptBytes(
        samplePlaintext,
        hexToPubkey(operator.keys.publicKeyHex),
        generateEphemeralKeypair()
      );
      assert.equal(
        imageEditRelayBodyBytesForPlaintext(model, samplePlaintext.length),
        imageEditRelayBodyBytes(model, sampleEnvelope)
      );
    }
  }

  const finalBudget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const finalSidecar = await startSidecar(t, {
    ...baseDeps,
    budget: finalBudget,
    budgetHeaders: () => budgetHeaders(finalBudget),
    preflightBodyBytes: () => IMAGE_EDIT_MAX_BODY_BYTES + 1,
  });
  const finalOverflow = await postMultipart(finalSidecar.url, validParts());
  assert.equal(finalOverflow.response.status, 413);
  assert.equal(finalOverflow.json.error.code, "encrypted_body_too_large");
  assert.equal(selections, 0, "final-body admission must happen before operator discovery");
  assert.equal(sends, 0);
  assert.equal(finalBudget.reservedBase, 0n);
});

test("allowlist, exact edit capability, Vault, positive price, authenticated key, and pin gates fail closed", async (t) => {
  const good = await makeOperator();
  const noEdit = await makeOperator({ imageEditModels: [] });
  const noVault = await makeOperator({ vaultPayments: false });
  const free = await makeOperator({ imagePricing: { [MODEL]: 0 } });
  const forged = await makeOperator({}, false);

  const missingAllowlistBudget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  let missingAllowlistSelections = 0;
  const allowlistDeps: ImageEditHandlerDependencies = {
    allowedModels: undefined,
    maxAmountBase: 100_000n,
    budget: missingAllowlistBudget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => ({}),
    selectOperator: async () => {
      missingAllowlistSelections += 1;
      throw new Error("must not select");
    },
    sendImage: async () => {
      throw new Error("must not send");
    },
  };
  const missingAllowlist = await startSidecar(t, allowlistDeps);
  const noList = await postMultipart(missingAllowlist.url, validParts());
  assert.equal(noList.response.status, 403);
  assert.equal(noList.json.error.code, "image_edit_allowlist_required");
  assert.equal(missingAllowlistSelections, 0);

  allowlistDeps.allowedModels = [MODEL];
  const outside = await postMultipart(
    missingAllowlist.url,
    validParts().map((part) => part.name === "model" ? { ...part, value: "other-model" } : part)
  );
  assert.equal(outside.response.status, 403);
  assert.equal(outside.json.error.code, "model_not_allowed");

  for (const candidate of [noEdit, noVault, free, forged]) {
    const relay = await startRelay(t, [candidate]);
    const vault = fakeVault();
    const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
    const sidecar = await startSidecar(t, relayDependencies(relay.url, vault.client, budget));
    const result = await postMultipart(sidecar.url, validParts());
    assert.equal(result.response.status, 503);
    assert.equal(
      result.json.error.code,
      candidate === forged ? "image_operator_no_encryption_key" : "no_image_edit_operator"
    );
    assert.equal(relay.state.editRequests, 0);
    assert.equal(vault.ensured.length, 0);
  }

  const relay = await startRelay(t, [forged, good]);
  const vault = fakeVault();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const pinnedSidecar = await startSidecar(t, relayDependencies(relay.url, vault.client, budget));
  const pinned = await postMultipart(
    pinnedSidecar.url,
    validParts(),
    { "x-halo-operator": String(forged.advertisement.address) }
  );
  assert.equal(pinned.response.status, 503);
  assert.equal(pinned.json.error.code, "image_operator_no_encryption_key");
  assert.equal(relay.state.editRequests, 0, "an unusable explicit pin never falls through to the good operator");
});

test("per-request and cumulative budgets reject before the funded relay request", async (t) => {
  const operator = await makeOperator();
  const relay = await startRelay(t, [operator], { settlementBase: "20000" });
  const vault = fakeVault();
  const capBudget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const capSidecar = await startSidecar(
    t,
    relayDependencies(relay.url, vault.client, capBudget, { maxAmountBase: 19_999n })
  );
  const capped = await postMultipart(capSidecar.url, validParts());
  assert.equal(capped.response.status, 402);
  assert.equal(capped.json.error.code, "over_cap");
  assert.equal(relay.state.editRequests, 0);
  assert.equal(vault.ensured.length, 0);

  const cumulativeBudget = { spentBase: 5_000n, reservedBase: 0n, budgetBase: 20_000n };
  const cumulativeSidecar = await startSidecar(
    t,
    relayDependencies(relay.url, vault.client, cumulativeBudget)
  );
  const overBudget = await postMultipart(cumulativeSidecar.url, validParts());
  assert.equal(overBudget.response.status, 402);
  assert.equal(overBudget.json.error.code, "over_budget");
  assert.equal(cumulativeBudget.reservedBase, 0n);
  assert.equal(relay.state.editRequests, 0);
});

test("uncapped and capped concurrent edits release only reservations they actually took", async (t) => {
  const operator = await makeOperator();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 0n };
  const pending: Array<(result: VaultImageSendResult) => void> = [];
  const sidecar = await startSidecar(t, {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => budgetHeaders(budget),
    selectOperator: async () => ({
      pin: {
        address: String(operator.advertisement.address),
        priceUsdcPerImage: 0.02,
        encryptionPubkey: operator.keys.publicKeyHex,
      },
      reason: "selected",
    }),
    sendImage: () => new Promise<VaultImageSendResult>((resolve) => pending.push(resolve)),
  });
  const failed = {
    ok: false as const,
    status: 502,
    images: [] as [],
    paid: false as const,
    errorBody: { error: { type: "test_failure" } },
  };
  const waitForPending = async (count: number): Promise<void> => {
    const deadline = Date.now() + 2_000;
    while (pending.length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(pending.length, count, `expected ${count} funded edit sends to be pending`);
  };

  const first = postMultipart(sidecar.url, validParts());
  await waitForPending(1);
  assert.equal(budget.reservedBase, 0n, "the initially uncapped edit takes no reservation");

  budget.budgetBase = 100_000n;
  const second = postMultipart(sidecar.url, validParts());
  await waitForPending(2);
  assert.equal(budget.reservedBase, 20_000n, "the newly capped edit reserves its ceiling");

  budget.budgetBase = 0n;
  pending[0](failed);
  await first;
  assert.equal(
    budget.reservedBase,
    20_000n,
    "finishing the originally uncapped edit must not erase the other edit's reservation"
  );

  pending[1](failed);
  await second;
  assert.equal(budget.reservedBase, 0n);
});

test("zero media never redeems or accrues and releases local budget admission", async (t) => {
  const operator = await makeOperator();
  const relay = await startRelay(t, [operator], { outputImages: [], settlementBase: "20000" });
  const vault = fakeVault();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const sidecar = await startSidecar(t, relayDependencies(relay.url, vault.client, budget));
  const result = await postMultipart(sidecar.url, validParts());
  assert.equal(result.response.status, 502);
  assert.equal(result.json.error.type, "image_no_media_delivered");
  assert.equal(vault.redeemed.length, 0);
  assert.equal(budget.spentBase, 0n);
  assert.equal(budget.reservedBase, 0n);
});

test("empty, unsupported, and MIME-mismatched encrypted media never redeem", async (t) => {
  const operator = await makeOperator();
  const cases = [
    { name: "empty", bytes: Buffer.alloc(0), mime: "image/png" },
    { name: "unsupported", bytes: Buffer.from("GIF89a"), mime: "image/gif" },
    { name: "mismatch", bytes: fakePng(5), mime: "image/jpeg" },
  ];

  for (const media of cases) {
    const relay = await startRelay(t, [operator], {
      rawMedia: [{ bytes: media.bytes, mime: media.mime }],
      settlementBase: "20000",
    });
    const vault = fakeVault();
    const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
    const sidecar = await startSidecar(t, relayDependencies(relay.url, vault.client, budget));
    const result = await postMultipart(sidecar.url, validParts());
    assert.equal(result.response.status, 502, media.name);
    assert.equal(result.json.error.type, "image_media_decode_failed", media.name);
    assert.deepEqual(vault.redeemed, [], media.name);
    assert.equal(budget.spentBase, 0n, media.name);
    assert.equal(budget.reservedBase, 0n, media.name);
  }
});

test("an in-cap reservation price race is re-admitted and keeps redemption aligned with the accepted ceiling", async (t) => {
  const operator = await makeOperator();
  const relay = await startRelay(t, [operator], {
    settlementBase: "999999",
    reservationFailures: 1,
    reservationRequiredBase: "50000",
  });
  const vault = fakeVault();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const sidecar = await startSidecar(t, relayDependencies(relay.url, vault.client, budget));
  const result = await postMultipart(sidecar.url, validParts());
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("x-halo-charged-base"), "50000");
  assert.equal(relay.state.editRequests, 2);
  assert.equal(relay.state.chatRequests, 0);
  assert.deepEqual(vault.ensured, [24_000n, 50_000n]);
  assert.deepEqual(vault.redeemed, [50_000n]);
  assert.equal(budget.spentBase, 50_000n);
  assert.equal(budget.reservedBase, 0n);
});

test("reservation price retries above either spend cap are rejected before re-reservation or replay", async (t) => {
  const operator = await makeOperator();
  const cases = [
    {
      name: "per-request",
      required: "50000",
      maxAmountBase: 49_999n,
      budgetBase: 100_000n,
      code: "over_cap",
    },
    {
      name: "cumulative",
      required: "50000",
      maxAmountBase: 100_000n,
      budgetBase: 40_000n,
      code: "over_budget",
    },
  ] as const;

  for (const scenario of cases) {
    const relay = await startRelay(t, [operator], {
      reservationFailures: 1,
      reservationRequiredBase: scenario.required,
    });
    const vault = fakeVault();
    const budget = {
      spentBase: 0n,
      reservedBase: 0n,
      budgetBase: scenario.budgetBase,
    };
    const sidecar = await startSidecar(
      t,
      relayDependencies(relay.url, vault.client, budget, {
        maxAmountBase: scenario.maxAmountBase,
      })
    );
    const result = await postMultipart(sidecar.url, validParts());
    assert.equal(result.response.status, 402, scenario.name);
    assert.equal(result.json.error.code, scenario.code, scenario.name);
    assert.equal(relay.state.editRequests, 1, `${scenario.name}: retry must not be replayed`);
    assert.deepEqual(vault.ensured, [24_000n], `${scenario.name}: retry must not reserve`);
    assert.deepEqual(vault.redeemed, []);
    assert.equal(budget.spentBase, 0n);
    assert.equal(budget.reservedBase, 0n);
  }
});

test("n=1 caps adversarial extra media frames and settlement to one delivered image", async (t) => {
  const operator = await makeOperator();
  const firstImage = fakePng(5);
  const relay = await startRelay(t, [operator], {
    outputImages: [firstImage, fakePng(6)],
    settlementBase: "40000",
  });
  const vault = fakeVault();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  const sidecar = await startSidecar(t, relayDependencies(relay.url, vault.client, budget));

  const result = await postMultipart(sidecar.url, validParts(fakePng(), "1"));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.json.data, [{ b64_json: firstImage.toString("base64") }]);
  assert.equal(result.response.headers.get("x-halo-charged-base"), "20000");
  assert.deepEqual(vault.redeemed, [20_000n]);
  assert.equal(budget.spentBase, 20_000n);
  assert.equal(budget.reservedBase, 0n);
});

test("client disconnect aborts in-flight operator discovery before selection or payment", async (t) => {
  let discoveryStartedResolve!: () => void;
  const discoveryStarted = new Promise<void>((resolve) => {
    discoveryStartedResolve = resolve;
  });
  let discoveryClosedResolve!: () => void;
  const discoveryClosed = new Promise<void>((resolve) => {
    discoveryClosedResolve = resolve;
  });
  const discoveryServer = http.createServer((_req, res) => {
    discoveryStartedResolve();
    res.once("close", discoveryClosedResolve);
  });
  const discoveryUrl = await listen(discoveryServer);
  t.after(() => closeServer(discoveryServer));

  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  let sends = 0;
  const sidecar = await startSidecar(t, {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => budgetHeaders(budget),
    selectOperator: (model, pinned, signal) =>
      selectVaultImageOperator(discoveryUrl, model, pinned, true, signal),
    sendImage: async () => {
      sends += 1;
      throw new Error("must not send while discovery is pending");
    },
  });

  const body = multipart(validParts());
  const target = new URL(`${sidecar.url}/v1/images/edits`);
  const request = http.request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=halo-edit-boundary",
      "content-length": String(body.length),
    },
  });
  request.on("error", () => {});
  request.end(body);
  await discoveryStarted;
  request.destroy();
  await Promise.race([
    discoveryClosed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("discovery fetch did not abort promptly")), 2_000)
    ),
  ]);
  assert.equal(sends, 0);
  assert.equal(budget.spentBase, 0n);
  assert.equal(budget.reservedBase, 0n);
});

test("client disconnect cancels a pending vault reservation and scrubs the encrypted payload", async (t) => {
  const operator = await makeOperator();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  let reservationStartedResolve!: () => void;
  const reservationStarted = new Promise<void>((resolve) => {
    reservationStartedResolve = resolve;
  });
  let reservationAbortedResolve!: () => void;
  const reservationAborted = new Promise<void>((resolve) => {
    reservationAbortedResolve = resolve;
  });
  const captured: { envelope?: BytesEncryptedEnvelope } = {};
  const client = {
    ensureReservation: async (
      _operator: string,
      _amount: bigint,
      signal?: AbortSignal
    ) => {
      assert.ok(signal, "the HTTP disconnect signal reaches vault reservation work");
      reservationStartedResolve();
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          reservationAbortedResolve();
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    consumer: async () => {
      throw new Error("consumer lookup must not follow an aborted reservation");
    },
    recordAndRedeem: () => {
      throw new Error("an aborted reservation must not redeem");
    },
  } as unknown as VaultConsumeClient;
  const sidecar = await startSidecar(t, {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => budgetHeaders(budget),
    selectOperator: async () => ({
      pin: {
        address: String(operator.advertisement.address),
        priceUsdcPerImage: 0.02,
        encryptionPubkey: operator.keys.publicKeyHex,
      },
      reason: "selected",
    }),
    sendImage: (opts) => {
      captured.envelope = opts.envelope;
      return vaultSendImageEdit(client, "http://127.0.0.1:1", opts);
    },
  });

  const body = multipart(validParts());
  const target = new URL(`${sidecar.url}/v1/images/edits`);
  const request = http.request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=halo-edit-boundary",
      "content-length": String(body.length),
    },
  });
  request.on("error", () => {});
  request.end(body);
  await reservationStarted;
  assert.equal(budget.reservedBase.toString(), "20000");
  assert.ok(captured.envelope?.ct);
  request.destroy();
  await Promise.race([
    reservationAborted,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("vault reservation did not abort promptly")), 2_000)
    ),
  ]);

  const deadline = Date.now() + 2_000;
  while (budget.reservedBase !== 0n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(budget.reservedBase, 0n);
  assert.equal(budget.spentBase, 0n);
  assert.equal(captured.envelope?.ct, "");
  assert.equal(captured.envelope?.epk, "");
  assert.equal(captured.envelope?.nonce, "");
});

test("client disconnect aborts the funded send and releases budget admission exactly once", async (t) => {
  const operator = await makeOperator();
  const budget = { spentBase: 0n, reservedBase: 0n, budgetBase: 100_000n };
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let aborts = 0;
  const sidecar = await startSidecar(t, {
    allowedModels: [MODEL],
    maxAmountBase: 100_000n,
    budget,
    budgetUrl: "http://127.0.0.1/v1/budget",
    budgetHeaders: () => budgetHeaders(budget),
    selectOperator: async () => ({
      pin: {
        address: String(operator.advertisement.address),
        priceUsdcPerImage: 0.02,
        encryptionPubkey: operator.keys.publicKeyHex,
      },
      reason: "selected",
    }),
    sendImage: (opts) =>
      new Promise((_resolve, reject) => {
        startedResolve();
        const abort = () => {
          aborts += 1;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        opts.signal.addEventListener("abort", abort, { once: true });
        if (opts.signal.aborted) abort();
      }),
  });

  const body = multipart(validParts());
  const target = new URL(`${sidecar.url}/v1/images/edits`);
  const request = http.request({
    hostname: target.hostname,
    port: Number(target.port),
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=halo-edit-boundary",
      "content-length": String(body.length),
    },
  });
  request.on("error", () => {});
  request.end(body);
  await started;
  assert.ok(budget.reservedBase > 0n);
  request.destroy();

  const deadline = Date.now() + 2_000;
  while (budget.reservedBase !== 0n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(budget.reservedBase, 0n);
  assert.equal(budget.spentBase, 0n);
  assert.equal(aborts, 1);
});
