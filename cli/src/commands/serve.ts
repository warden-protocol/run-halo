import prompts from "prompts";
import { WebSocket } from "ws";
import { randomBytes } from "crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import {
  HaloConfig,
  ProviderConfig,
  configDir,
  loadConfig,
  configProviders,
  providerForModel,
  allConfiguredModels,
  imagePriceForModel,
  providerServesConfiguredImageModel,
} from "../config";
import { loadWallet } from "../wallet";
import { Facilitator } from "../facilitator";
import { imageEndpointPathFor, wireFormatFor, isTeeProviderSlug } from "../providers";
import {
  anthropicHeaders,
  anthropicResponseToChatCompletion,
  chatCompletionsToAnthropicRequest,
  OpenAIChatRequest,
} from "../anthropic-adapter";
import {
  estimateRequestPromptTokens,
  priceRequest,
  upstreamContextLength,
  upstreamRatePer1KUsd,
} from "../pricing";
import {
  checkReservationCached,
  collectibleServeAmount,
  noteServed,
  readReservation,
  verifyReceipt,
  invalidateGate,
  ReservationCheck,
  getVaultAddress,
  setActiveVaultAddress,
} from "../vault";
import { VaultCreditLedger, creditWindowBase, AdmitResult, ReceiptSnapshot } from "../vaultCredit";
import { VaultReceiptStore } from "../vaultReceiptStore";
import {
  PendingHeldReceipt,
  durableReceiptSnapshot,
  handoffRehydratedReceipt,
  receiptPairKey,
  shouldRetryRehydration,
} from "../vaultReceiptRehydration";
import { releaseAbortedVaultServe, withAbortedStreamCleanup } from "../vaultStreamAbort";
import { OperatorRedeemer } from "../vaultRedeemer";
import {
  formatUsdcBase,
  priceImages,
  requestCompletionCeilingTokens,
} from "@halo/vault-core";
import { isAddress } from "ethers";
import { decryptSecret, isEncryptedSecret } from "../secret";
import { sanitizeChatRequest, sanitizeMessages } from "../sanitize";
import { installProxyFromEnv } from "../proxy";
import {
  classifyUpstreamProviderError,
  CREDIT_EXHAUSTED_400_RE,
  normalizeUpstreamError,
  operatorErrorResponse,
  transientUpstreamErrorResponse,
  upstreamProviderErrorResponse,
  type UpstreamProviderErrorCode,
} from "../upstream-error";
import {
  breakerCode,
  clearBreaker,
  isBreakerOpen,
  isStickyUpstreamCode,
  openBreakerSlugs,
  setBreakerChangeHandler,
  tripBreaker,
} from "../provider-breaker";
import {
  decryptRequest,
  encryptBytes,
  encryptResponse,
  generateOperatorKeypair,
  isEncryptedEnvelope,
  OperatorKeyPair,
} from "../encryption";
import {
  MediaChunkFrame,
  chunkMediaEnvelope,
  packMediaPlaintext,
  padToBucket,
} from "../mediaChunks";
import {
  ImageFormat,
  MalformedImageError,
  UnsupportedImageFormatError,
  detectImageFormat,
  stripImageMetadata,
} from "../imageStrip";
import { relayCliVersion } from "../relayVersion";
import {
  facilitatorVaultError,
  inspectFacilitatorVault,
} from "../vault-address";
import {
  CapabilityAnnouncementSync,
  FacilitatorIdentityProbe,
  retainVaultIdentityAnnouncement,
} from "../vaultCapability";
import { restartIntoManagedInstall, startAutoUpdateMonitor } from "../update";

interface InferenceRequestMessage {
  type: "inference-request";
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    max_tokens?: number;
    max_completion_tokens?: number;
    [k: string]: unknown;
  };
}

interface StreamAbortMessage {
  type: "stream-abort";
  requestId: string;
  reason?: string;
}

// Timeout for the upstream provider fetch. Must be shorter than the relay's
// INFERENCE_TIMEOUT_MS (120s) so the operator can send a proper error response
// instead of letting the relay time out and return 504.
const UPSTREAM_TIMEOUT_MS = 90_000;
// Re-ping local models inside Ollama's default 5-min keep_alive window.
const MODEL_WARM_INTERVAL_MS = 4 * 60_000;
const VAULT_CAPABILITY_RETRY_MS = 60_000;
const MAX_MEDIA_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_UPSTREAM_BODY_BYTES = MAX_MEDIA_STREAM_BYTES;

interface UpstreamUsage {
  total_tokens: number;
  /** OpenAI-shape input/output split. Required for margin-mode pricing
   *  (most providers charge different rates per side). Falls back to
   *  total_tokens / 0 when an upstream doesn't report the split. */
  prompt_tokens: number;
  completion_tokens: number;
  /** Prompt tokens served from the provider's prompt cache
   *  (usage.prompt_tokens_details.cached_tokens). Billed at the cheaper
   *  cache-read rate so the provider's caching saving reaches the consumer. */
  cached_prompt_tokens?: number;
}

function requestedImageCount(body: InferenceRequestMessage["body"]): number {
  const n = body && typeof body === "object" ? (body as { n?: unknown }).n : undefined;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.ceil(n) : 1;
}

export function requestAcceptsMedia(
  body: InferenceRequestMessage["body"],
  headers: Record<string, string | undefined>
): boolean {
  const header = (headers["x-halo-accept-media"] || "").trim().toLowerCase();
  return body.acceptMedia === true || header === "1" || header === "true";
}

export function forwardVaultCompletionLimit(
  body: InferenceRequestMessage["body"],
  providerSlug: string,
  completionCeilingTokens: number
): InferenceRequestMessage["body"] {
  const hasMaxTokens = Object.prototype.hasOwnProperty.call(body, "max_tokens");
  const hasMaxCompletionTokens = Object.prototype.hasOwnProperty.call(
    body,
    "max_completion_tokens"
  );
  if (hasMaxTokens || hasMaxCompletionTokens) return body;

  return providerSlug === "openai"
    ? { ...body, max_completion_tokens: completionCeilingTokens }
    : { ...body, max_tokens: completionCeilingTokens };
}

export function invalidVaultTextGenerationControlField(
  body: InferenceRequestMessage["body"],
  isImageRequest: boolean
): "max_tokens" | "max_completion_tokens" | "n" | null {
  if (isImageRequest) return null;
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      return field;
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "n")) {
    const n = body.n;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n !== 1) {
      return "n";
    }
  }
  return null;
}

function imageEntryHasBytesOrUrl(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.b64_json === "string" && entry.b64_json.length > 0) return true;
  if (typeof entry.url === "string" && entry.url.length > 0) return true;
  const imageUrl = entry.image_url;
  if (typeof imageUrl === "string" && imageUrl.length > 0) return true;
  if (imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as { url?: unknown }).url;
    return typeof url === "string" && url.length > 0;
  }
  return false;
}

function countImageEntries(value: unknown): number {
  return Array.isArray(value) ? value.filter(imageEntryHasBytesOrUrl).length : 0;
}

export function servedImageCountFromResponse(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const root = data as Record<string, unknown>;
  const direct = countImageEntries(root.data);
  if (direct > 0) return direct;

  const choices = Array.isArray(root.choices) ? root.choices : [];
  let count = 0;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const messageImages = countImageEntries(msg.images);
    if (messageImages > 0) {
      count += messageImages;
      continue;
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      count += content.filter((part) => {
        if (!part || typeof part !== "object") return false;
        const p = part as Record<string, unknown>;
        return (
          p.type === "image_url" ||
          p.type === "output_image" ||
          imageEntryHasBytesOrUrl(p)
        );
      }).length;
    }
  }
  return count;
}

export function priceServedImagesForVault(
  usdcPerImage: number,
  responseData: unknown,
  ceilingCost: bigint
): { servedImageCount: number; uncappedAmount: bigint; actualAmount: bigint; tokens: 0 } {
  const servedImageCount = servedImageCountFromResponse(responseData);
  const uncappedAmount = priceImages(usdcPerImage, servedImageCount);
  return {
    servedImageCount,
    uncappedAmount,
    actualAmount: collectibleServeAmount(uncappedAmount, ceilingCost),
    tokens: 0,
  };
}

export class UndeliverableImageResponseError extends Error {
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.name = "UndeliverableImageResponseError";
    this.type = type;
  }
}

function imageMimeForFormat(format: ImageFormat): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      throw new UndeliverableImageResponseError(
        "unsupported_image_format",
        `unsupported image format after strip: ${format}`
      );
  }
}

function decodeInlineImageBase64(value: string): Buffer {
  const dataUrl = /^data:[^;,]+;base64,(.*)$/i.exec(value);
  const raw = dataUrl ? dataUrl[1] : value;
  if (raw.length === 0 || raw.length % 4 === 1 || /[\r\n]/.test(raw) || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new UndeliverableImageResponseError(
      "malformed_image_base64",
      "upstream image response contained malformed inline base64"
    );
  }
  return Buffer.from(raw, "base64");
}

function inlineImageBase64FromEntry(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.b64_json === "string" && entry.b64_json.length > 0) {
    return entry.b64_json;
  }
  if (entryHasUrlOnlyImage(entry)) {
    throw new UndeliverableImageResponseError(
      "url_only_image_response",
      "upstream returned a URL-only image response; refusing operator-side fetch"
    );
  }
  return null;
}

function entryHasUrlOnlyImage(entry: Record<string, unknown>): boolean {
  if (typeof entry.url === "string" && entry.url.length > 0) return true;
  const imageUrl = entry.image_url;
  if (typeof imageUrl === "string" && imageUrl.length > 0) return true;
  if (imageUrl && typeof imageUrl === "object") {
    const url = (imageUrl as { url?: unknown }).url;
    return typeof url === "string" && url.length > 0;
  }
  return false;
}

function inlineImageBytesFromEntry(value: unknown): Buffer | null {
  const b64 = inlineImageBase64FromEntry(value);
  return b64 === null ? null : decodeInlineImageBase64(b64);
}

function inlineImageBase64FromResponse(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    const images: string[] = [];
    for (const entry of root.data) {
      const b64 = inlineImageBase64FromEntry(entry);
      if (b64) images.push(b64);
    }
    return images;
  }

  const images: string[] = [];
  const choices = Array.isArray(root.choices) ? root.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    if (Array.isArray(msg.images)) {
      let foundInImages = false;
      for (const entry of msg.images) {
        const b64 = inlineImageBase64FromEntry(entry);
        if (b64) {
          images.push(b64);
          foundInImages = true;
        }
      }
      if (foundInImages) continue;
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const b64 = inlineImageBase64FromEntry(part);
        if (b64) images.push(b64);
      }
    }
  }
  return images;
}

export function inlineImageBytesFromResponse(data: unknown): Buffer[] {
  return inlineImageBase64FromResponse(data).map(decodeInlineImageBase64);
}

function assertImageUpstreamBodyWithinCap(responseData: unknown): void {
  const bodyBytes = Buffer.byteLength(JSON.stringify(responseData), "utf8");
  if (bodyBytes > MAX_IMAGE_UPSTREAM_BODY_BYTES) {
    throw new UndeliverableImageResponseError(
      "image_upstream_body_too_large",
      `upstream image response exceeds ${MAX_IMAGE_UPSTREAM_BODY_BYTES} bytes`
    );
  }
}

export function buildImageMediaFrames(
  requestId: string,
  responseData: unknown,
  consumerPublicKey: Uint8Array,
  operatorKeys: OperatorKeyPair
): { frames: MediaChunkFrame[]; imageCount: number; streamBytes: number } {
  assertImageUpstreamBodyWithinCap(responseData);
  const images = inlineImageBase64FromResponse(responseData);
  const frames: MediaChunkFrame[] = [];
  let streamBytes = 0;
  for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
    const stripped = stripImageMetadata(decodeInlineImageBase64(images[imageIndex]));
    const mime = imageMimeForFormat(detectImageFormat(stripped));
    const packed = packMediaPlaintext(stripped, mime);
    const padded = padToBucket(packed);
    const envelope = encryptBytes(padded, consumerPublicKey, operatorKeys);
    const imageFrames = chunkMediaEnvelope(requestId, envelope, {
      imageIndex,
      imageCount: images.length,
    });
    for (const frame of imageFrames) {
      streamBytes += Buffer.byteLength(JSON.stringify(frame), "utf8");
      if (streamBytes > MAX_MEDIA_STREAM_BYTES) {
        throw new UndeliverableImageResponseError(
          "media_stream_too_large",
          `encrypted image media stream exceeds ${MAX_MEDIA_STREAM_BYTES} bytes`
        );
      }
      frames.push(frame);
    }
  }
  return { frames, imageCount: images.length, streamBytes };
}

export function buildImageTerminalBody(imageSettlement: { servedImageCount: number }): unknown {
  return {
    imageDelivered: true,
    images: imageSettlement.servedImageCount,
  };
}

export function buildNoImageTerminalBody(): unknown {
  return {
    error: {
      type: "no_image",
      message: "Upstream image response contained no deliverable inline images.",
    },
  };
}

export function prepareImageDeliveryFrames(params: {
  requestId: string;
  responseData: unknown;
  imageSettlement: { servedImageCount: number };
  consumerPublicKey: Uint8Array | undefined;
  operatorKeys: OperatorKeyPair;
}): { frames: MediaChunkFrame[]; imageCount: number; streamBytes: number } {
  if (params.consumerPublicKey === undefined) {
    throw new UndeliverableImageResponseError(
      "image_encryption_required",
      "Image delivery requires an encrypted Halo request with a consumer public key."
    );
  }
  const prepared = buildImageMediaFrames(
    params.requestId,
    params.responseData,
    params.consumerPublicKey,
    params.operatorKeys
  );
  if (prepared.imageCount !== params.imageSettlement.servedImageCount) {
    throw new UndeliverableImageResponseError(
      "image_count_mismatch",
      `image response count changed during media preparation (${prepared.imageCount} prepared, ${params.imageSettlement.servedImageCount} priced)`
    );
  }
  return prepared;
}

type SignedVoucher = {
  voucher: { budgetId: string; operator: string; cumulative: string; expiry: number };
  signature: string;
};

/** Parse a voucher for verbatim forwarding; absent or malformed input becomes `undefined`. */
function parseVoucherHeader(raw: string | undefined): SignedVoucher | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    if (
      obj &&
      typeof obj === "object" &&
      obj.voucher &&
      typeof obj.voucher === "object" &&
      typeof obj.signature === "string"
    ) {
      return obj as SignedVoucher;
    }
  } catch {
    /* malformed — treat as no voucher */
  }
  return undefined;
}

// Forward the confidential request's ephemeral-key and scheme headers verbatim.
const E2EE_REQ_HEADERS = ["x-client-pub-key", "x-encryption-version", "x-signing-algo"];

function maskApiKeyForLog(k: string | undefined): string {
  if (!k) return "(no key sent)";
  if (k.length <= 12) return `set, len ${k.length}`;
  return `${k.slice(0, 6)}…${k.slice(-4)} (len ${k.length})`;
}

// Allowlist response-proof headers so upstreams cannot echo arbitrary operator metadata.
function passthroughResponseHeaders(res: { headers: Headers }): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (
      lk.startsWith("x-near-") ||
      lk.startsWith("x-tee-") ||
      lk === "x-signature" ||
      lk === "x-signing-address" ||
      lk === "x-attestation" ||
      lk === "x-chat-id"
    ) {
      out[lk] = v;
    }
  });
  return out;
}

/** Fetch the keyed response proof for client-side signer verification; return base64 or `null`. */
async function fetchTeeSignature(
  baseUrl: string,
  apiKey: string | undefined,
  chatId: string,
  model: string
): Promise<string | null> {
  if (!apiKey || !chatId) return null;
  try {
    const url =
      `${baseUrl.replace(/\/+$/, "")}/signature/${encodeURIComponent(chatId)}` +
      `?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.text(), "utf-8").toString("base64");
  } catch {
    return null;
  }
}

/** Resolve which provider serves a request body's model, plus its plaintext key.
 *  By serve start every provider's apiKey has been decrypted in place, so this
 *  returns a usable Bearer token (or undefined for keyless local providers). */
function resolveProvider(
  cfg: HaloConfig,
  body: InferenceRequestMessage["body"]
): { provider: ProviderConfig; apiKey: string | undefined } {
  const model = typeof (body as { model?: unknown })?.model === "string"
    ? (body as { model: string }).model
    : "";
  const provider = providerForModel(configProviders(cfg), model);
  const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : undefined;
  return { provider, apiKey };
}

// Sticky credit/auth faults de-announce the provider and reject before payment.
// Background probes close the breaker; transient upstream failures do not open it.
const PROVIDER_REPROBE_INTERVAL_MS = 60_000;

function tripBreakerLogged(slug: string, code: UpstreamProviderErrorCode | null): void {
  if (!tripBreaker(slug, code)) return;
  const why =
    code === "credit_exhausted"
      ? "upstream provider account is out of credits"
      : "upstream provider rejected the API key";
  console.warn(
    `  ⛔ circuit breaker OPEN for "${slug}" (${why}); de-announcing its models and ` +
      `instant-rejecting its requests until it recovers (re-probing every ${PROVIDER_REPROBE_INTERVAL_MS / 1000}s)`
  );
}

function clearBreakerLogged(slug: string): void {
  if (clearBreaker(slug)) {
    console.log(`  ✅ circuit breaker CLOSED for "${slug}"; re-announcing its models`);
  }
}

// Union of models advertised by providers whose breaker is currently open.
function breakerDeannouncedModels(cfg: HaloConfig): Set<string> {
  const providers = configProviders(cfg);
  const out = new Set<string>();
  for (const m of allConfiguredModels(cfg)) {
    if (isBreakerOpen(providerForModel(providers, m).slug)) out.add(m);
  }
  return out;
}

// Sends an active max_tokens:1 request; true means no sticky credit/auth fault was detected.
async function probeProviderHealthy(provider: ProviderConfig): Promise<boolean> {
  const k = typeof provider.apiKey === "string" ? provider.apiKey : undefined;
  if (!k) return true; // keyless/local provider — nothing to authenticate
  const model = provider.models[0];
  if (!model) return true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const wire = wireFormatFor(provider.slug);
    const base = provider.baseUrl.replace(/\/+$/, "");
    const url = wire === "anthropic" ? `${base}/messages` : `${base}/chat/completions`;
    const headers =
      wire === "anthropic"
        ? anthropicHeaders(k)
        : { "Content-Type": "application/json", Authorization: `Bearer ${k}` };
    const body =
      wire === "anthropic"
        ? chatCompletionsToAnthropicRequest({
            model,
            messages: [{ role: "user", content: "." }],
            max_tokens: 1,
          })
        : { model, messages: [{ role: "user", content: "." }], max_tokens: 1 };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) return true;
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { message: text } };
    }
    return !isStickyUpstreamCode(classifyUpstreamProviderError(res.status, parsed));
  } catch {
    return false;
  }
}

async function startBreakerReprobe(cfg: HaloConfig): Promise<void> {
  const providers = configProviders(cfg);
  for (;;) {
    await new Promise((r) => setTimeout(r, PROVIDER_REPROBE_INTERVAL_MS));
    for (const slug of openBreakerSlugs()) {
      const provider = providers.find((p) => p.slug === slug);
      if (!provider) {
        clearBreakerLogged(slug); // provider no longer configured — nothing to gate
        continue;
      }
      if (await probeProviderHealthy(provider)) clearBreakerLogged(slug);
    }
  }
}

export async function callUpstream(
  cfg: HaloConfig,
  _apiKey: string | undefined,
  body: InferenceRequestMessage["body"],
  reqHeaders?: Record<string, string>,
  vaultCompletionCeilingTokens?: number
): Promise<{ status: number; data: unknown; usage: UpstreamUsage; respHeaders: Record<string, string> }> {
  const zeroUsage: UpstreamUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  // Multi-provider: the model in the body picks the gateway + key (a single
  // operator may front several). `_apiKey` is retained for signature stability
  // but the resolved provider's own key is authoritative.
  const { provider, apiKey } = resolveProvider(cfg, body);
  const wire = wireFormatFor(provider.slug);
  const base = provider.baseUrl.replace(/\/+$/, "");

  const forwardedBody =
    vaultCompletionCeilingTokens === undefined
      ? body
      : forwardVaultCompletionLimit(body, provider.slug, vaultCompletionCeilingTokens);

  // Apply the identity-metadata allowlist before either upstream wire-format path.
  const { sanitized, report } = sanitizeChatRequest(forwardedBody);
  if (sanitized.messages !== undefined) {
    sanitized.messages = sanitizeMessages(sanitized.messages);
  }
  if (vaultCompletionCeilingTokens !== undefined && provider.slug === "openrouter") {
    sanitized.provider = { require_parameters: true };
  }
  // Buffered calls remove `stream`; the streaming path forces it independently.
  delete sanitized.stream;
  if (report.dropped.length > 0) {
    // Log field names only, never values. Counts are auditable; contents are not.
    console.warn(
      `  ⚠ stripped ${report.dropped.length} non-allowlisted field(s) from request: ${report.dropped.join(", ")}`
    );
  }

  let url: string;
  let headers: Record<string, string>;
  let outboundBody: string;
  if (wire === "anthropic") {
    if (!apiKey) {
      return {
        ...upstreamProviderErrorResponse("operator_auth_failure"),
        usage: zeroUsage,
        respHeaders: {},
      };
    }
    url = `${base}/messages`;
    headers = anthropicHeaders(apiKey);
    outboundBody = JSON.stringify(
      chatCompletionsToAnthropicRequest(sanitized as OpenAIChatRequest)
    );
  } else {
    url = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    // Forward the consumer's E2EE headers to the upstream enclave so it can
    // decrypt the content + encrypt the reply. The operator never sees plaintext.
    if (reqHeaders) {
      for (const h of E2EE_REQ_HEADERS) {
        if (reqHeaders[h]) headers[h] = reqHeaders[h];
      }
    }
    outboundBody = JSON.stringify(sanitized);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: outboundBody,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? `upstream timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(`  ⚠ upstream request failed before response: ${msg}`);
    return {
      ...transientUpstreamErrorResponse(),
      usage: zeroUsage,
      respHeaders: {},
    };
  }
  clearTimeout(timer);

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: { message: text } };
  }

  // Sanitize non-2xx bodies; raw debug detail may reach the live terminal but never the consumer or log file.
  if (!res.ok) {
    // Attribute auth failures to the selected provider and expose only a masked key fingerprint.
    if (res.status === 401 || res.status === 403) {
      const masked = maskApiKeyForLog(apiKey);
      console.error(
        `  ✖ upstream "${provider.slug}" rejected the API key (HTTP ${res.status}). ` +
          `Key sent: ${masked}. The key configured for "${provider.slug}" was refused by ${base} — ` +
          `re-set it with: halo setup --add-provider --provider ${provider.slug} --api-key <key>  (then restart serve).`
      );
    } else if (process.env.HALO_DEBUG_UPSTREAM_ERRORS === "1") {
      // Terminal-only: the body can echo the prompt, so it must not hit serve.log.
      debugToTerminal(`  upstream ${res.status} body: ${text.slice(0, 2000)}`);
    } else {
      console.error(
        `  upstream ${res.status} (set HALO_DEBUG_UPSTREAM_ERRORS=1 to print body to this terminal)`
      );
    }
    // A credit/auth fault won't clear next request — open this provider's
    // breaker so we de-announce its models and stop paying to re-discover it.
    tripBreakerLogged(provider.slug, classifyUpstreamProviderError(res.status, parsed));
    const normalized = normalizeUpstreamError(parsed, res.status);
    return { ...normalized, usage: zeroUsage, respHeaders: {} };
  }

  // Translate Anthropic responses back to OpenAI shape so the consumer sees a
  // uniform response regardless of which provider served them.
  if (wire === "anthropic") {
    const { data, usage } = anthropicResponseToChatCompletion(
      parsed as Parameters<typeof anthropicResponseToChatCompletion>[0],
      (body as { model?: string }).model
    );
    return { status: res.status, data, usage, respHeaders: passthroughResponseHeaders(res) };
  }

  const d = parsed as {
    usage?: {
      total_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number } | null;
    };
  };
  const promptTokens = d.usage?.prompt_tokens ?? 0;
  const completionTokens = d.usage?.completion_tokens ?? 0;
  const totalTokens = d.usage?.total_tokens ?? promptTokens + completionTokens;
  const cachedPromptTokens = d.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    status: res.status,
    data: parsed,
    usage: {
      total_tokens: totalTokens,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cached_prompt_tokens: cachedPromptTokens,
    },
    respHeaders: passthroughResponseHeaders(res),
  };
}

export async function callUpstreamImage(
  cfg: HaloConfig,
  _apiKey: string | undefined,
  body: InferenceRequestMessage["body"]
): Promise<{ status: number; data: unknown; usage: UpstreamUsage; respHeaders: Record<string, string> }> {
  const zeroUsage: UpstreamUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  const { provider, apiKey } = resolveProvider(cfg, body);
  const wire = wireFormatFor(provider.slug);
  const imagePath = imageEndpointPathFor(provider.slug);
  if (wire === "anthropic" || imagePath === null) {
    return {
      status: 502,
      data: {
        error: {
          message: `provider "${provider.slug}" does not expose a supported inline image generation endpoint`,
          type: "unsupported_image_provider",
        },
      },
      usage: zeroUsage,
      respHeaders: {},
    };
  }

  const { sanitized, report } = sanitizeChatRequest(body);
  delete sanitized.stream;
  sanitized.response_format = "b64_json";
  if (report.dropped.length > 0) {
    console.warn(
      `  ⚠ stripped ${report.dropped.length} non-allowlisted image field(s) from request: ${report.dropped.join(", ")}`
    );
  }

  const base = provider.baseUrl.replace(/\/+$/, "");
  const url = `${base}${imagePath}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(sanitized),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? `upstream image timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    return { status: 504, data: { error: { message: msg } }, usage: zeroUsage, respHeaders: {} };
  }
  clearTimeout(timer);

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: { message: text } };
  }

  if (!res.ok) {
    if (process.env.HALO_DEBUG_UPSTREAM_ERRORS === "1") {
      debugToTerminal(`  upstream(image) ${res.status} body: ${text.slice(0, 2000)}`);
    } else {
      console.error(
        `  upstream(image) ${res.status} (set HALO_DEBUG_UPSTREAM_ERRORS=1 to print body to this terminal)`
      );
    }
    return {
      status: res.status,
      data: sanitizeUpstreamError(parsed, res.status),
      usage: zeroUsage,
      respHeaders: {},
    };
  }

  return {
    status: res.status,
    data: parsed,
    usage: zeroUsage,
    respHeaders: passthroughResponseHeaders(res),
  };
}

/** Stream OpenAI-format deltas and capture final usage. */
export async function streamUpstream(
  cfg: HaloConfig,
  _apiKey: string | undefined,
  body: InferenceRequestMessage["body"],
  onDelta: (deltaObj: unknown) => void,
  vaultCompletionCeilingTokens?: number
): Promise<{ status: number; usage: UpstreamUsage; ok: boolean; errorData?: unknown }> {
  const zeroUsage: UpstreamUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  // Per-model provider resolution (multi-provider operators) — see callUpstream.
  const { provider, apiKey } = resolveProvider(cfg, body);
  const forwardedBody =
    vaultCompletionCeilingTokens === undefined
      ? body
      : forwardVaultCompletionLimit(body, provider.slug, vaultCompletionCeilingTokens);
  const { sanitized } = sanitizeChatRequest(forwardedBody);
  if (sanitized.messages !== undefined) sanitized.messages = sanitizeMessages(sanitized.messages);
  if (vaultCompletionCeilingTokens !== undefined && provider.slug === "openrouter") {
    sanitized.provider = { require_parameters: true };
  }
  const base = provider.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const outbound = { ...sanitized, stream: true, stream_options: { include_usage: true } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(outbound),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? `upstream timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(`  ⚠ upstream(stream) request failed before response: ${msg}`);
    const normalized = transientUpstreamErrorResponse();
    return { status: normalized.status, usage: zeroUsage, ok: false, errorData: normalized.data };
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: { message: text } };
    }
    if (res.status === 401 || res.status === 403) {
      console.error(
        `  ✖ upstream(stream) "${provider.slug}" rejected the API key (HTTP ${res.status}). ` +
          `Key sent: ${maskApiKeyForLog(apiKey)}. The key configured for "${provider.slug}" ` +
          `was refused by ${base} — re-set it with: halo setup --add-provider --provider ${provider.slug} --api-key <key>  (then restart serve).`
      );
    } else if (process.env.HALO_DEBUG_UPSTREAM_ERRORS === "1") {
      // Terminal-only: the body can echo the prompt, so it must not hit serve.log.
      debugToTerminal(`  upstream(stream) ${res.status} body: ${text.slice(0, 2000)}`);
    } else {
      console.error(
        `  upstream(stream) ${res.status} (set HALO_DEBUG_UPSTREAM_ERRORS=1 to print body to this terminal)`
      );
    }
    tripBreakerLogged(provider.slug, classifyUpstreamProviderError(res.status, parsed));
    const normalized = normalizeUpstreamError(parsed, res.status);
    return { status: normalized.status, usage: zeroUsage, ok: false, errorData: normalized.data };
  }

  let usage = zeroUsage;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const evt = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of evt.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          let obj: unknown;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          const o = obj as {
            usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
            choices?: unknown[];
          };
          if (o.usage && typeof o.usage.total_tokens === "number") {
            usage = {
              total_tokens: o.usage.total_tokens ?? 0,
              prompt_tokens: o.usage.prompt_tokens ?? 0,
              completion_tokens: o.usage.completion_tokens ?? 0,
            };
          }
          if (Array.isArray(o.choices) && o.choices.length > 0) onDelta(obj);
        }
      }
    }
  } catch (err) {
    clearTimeout(timer);
    console.warn(
      `  ⚠ upstream(stream) read failed: ${err instanceof Error ? err.message : String(err)}`
    );
    const normalized = upstreamProviderErrorResponse("provider_error");
    return {
      status: normalized.status,
      usage,
      ok: false,
      errorData: normalized.data,
    };
  }
  clearTimeout(timer);
  return { status: 200, usage, ok: true };
}

/** Reduce an upstream error body to a fixed {message,type,code} shape so a hostile or
 *  misconfigured upstream cannot leak operator-side request metadata to the consumer. */
function sanitizeUpstreamError(parsed: unknown, status: number): unknown {
  const src = (parsed as { error?: unknown })?.error;
  const safe: { message: string; type?: string; code?: string } = {
    message: `upstream provider returned ${status}`,
  };
  if (src && typeof src === "object") {
    const e = src as Record<string, unknown>;
    if (typeof e.message === "string" && e.message.length > 0 && e.message.length < 500) {
      safe.message = e.message;
    }
    if (typeof e.type === "string" && e.type.length < 100) safe.type = e.type;
    if (typeof e.code === "string" && e.code.length < 100) safe.code = e.code;
  } else if (typeof (parsed as { message?: unknown })?.message === "string") {
    const m = (parsed as { message: string }).message;
    if (m.length > 0 && m.length < 500) safe.message = m;
  }
  return { error: safe };
}

function sendWsJson(ws: WebSocket, message: unknown): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("relay websocket is not open"));
  }
  const payload = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    ws.send(payload, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Reconnect indefinitely with capped exponential backoff unless an explicit attempt limit is set.
// A successful announcement resets the failure count.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 0;

/** Resolve the reconnect-attempt cap. Env var HALO_MAX_RECONNECT_ATTEMPTS wins, then default. */
function resolveMaxReconnectAttempts(): number {
  const envVal = process.env.HALO_MAX_RECONNECT_ATTEMPTS;
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_MAX_RECONNECT_ATTEMPTS;
}

// Application pings detect silent relay/proxy loss that protocol-level auto-pongs cannot expose.
// Close after the pong timeout so the reconnect loop can recover.
const WS_PING_INTERVAL_MS = 5_000;
const WS_PONG_TIMEOUT_MS = 12_000;

function backoffDelayMs(attempt: number): number {
  // attempt is 1-indexed (first retry = 1)
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}

export async function cmdServe(): Promise<void> {
  installProxyFromEnv(); // honor HTTP(S)_PROXY for upstream/relay/facilitator calls
  const reportedRelayVersion = relayCliVersion();
  const cfg = loadConfig();

  // Point vault reads + receipt verification at the configured vault (defaults to
  // the consensus-pinned address). Throws on a malformed override so a typo fails
  // here rather than silently rejecting every vault request at serve time.
  setActiveVaultAddress(cfg.vaultAddress);
  const selectedVaultAddress = getVaultAddress();

  // Persistent logs rotate to one backup; the PID file supports deterministic status checks.
  setupFileLogging();
  writePidFile();

  // Empty-passphrase unattended keystores unlock without prompting.
  let passphrase: string;
  if (cfg.operator.noPassphrase) {
    passphrase = "";
    console.log("  ⚠ unattended mode — keystore unlocked without passphrase");
  } else {
    const r = await prompts({
      type: "password",
      name: "passphrase",
      message: "Keystore passphrase",
    });
    if (!r.passphrase) process.exit(130);
    passphrase = r.passphrase;
  }

  if (cfg.vaultAddress) {
    console.log(`  ⚠ vault override active — gating on ${getVaultAddress()} (from config, not the pinned default)`);
  }
  console.log("  loading wallet...");
  const wallet = await loadWallet(cfg.operator.keystorePath, passphrase);
  if (wallet.address.toLowerCase() !== cfg.operator.address.toLowerCase()) {
    throw new Error(
      `keystore address ${wallet.address} does not match config ${cfg.operator.address}`
    );
  }

  // Probe selected-vault identity and reads asynchronously; keep revalidating so
  // a facilitator rotation cannot leave a stale capability advertised forever.
  let vaultPayments = false;
  let vaultRpcCapable = false;
  let vaultIdentityCapable = false;
  let vaultProbeInFlight: Promise<boolean> | null = null;
  let lastVaultIdentityDiagnostic = "";
  let syncAnnouncedVaultCapability: ((capability: boolean) => Promise<void>) | null = null;
  const vaultIdentityProbe = new FacilitatorIdentityProbe(() =>
    inspectFacilitatorVault(cfg.facilitator.url, selectedVaultAddress)
  );
  const applyVaultIdentity = (
    identity: Awaited<ReturnType<typeof inspectFacilitatorVault>>
  ): void => {
    if (identity.status === "match") {
      vaultIdentityCapable = true;
      lastVaultIdentityDiagnostic = "";
    } else {
      const diagnostic = facilitatorVaultError(selectedVaultAddress, identity);
      if (diagnostic !== lastVaultIdentityDiagnostic) {
        console.error(`  ✗ ${diagnostic}`);
        lastVaultIdentityDiagnostic = diagnostic;
      }
      vaultIdentityCapable = retainVaultIdentityAnnouncement(
        identity,
        vaultIdentityCapable,
        vaultIdentityProbe.lastMatchAt,
        Date.now()
      );
    }
    vaultPayments = vaultIdentityCapable && vaultRpcCapable;
  };
  const probeVaultCapability = (forceFreshIdentity = true): Promise<boolean> => {
    if (vaultProbeInFlight) return vaultProbeInFlight;
    const probe = vaultIdentityProbe.check(forceFreshIdentity)
      .then(async (identity) => {
        applyVaultIdentity(identity);
        if (identity.status === "match") {
          await readReservation(cfg.operator.address, cfg.operator.address);
          vaultRpcCapable = true;
        }
        vaultPayments = vaultIdentityCapable && vaultRpcCapable;
        return vaultPayments;
      })
      .catch((err) => {
        vaultRpcCapable = false;
        vaultPayments = false;
        logError("vault capability probe failed; will retry in background", err);
        return false;
      })
      .finally(() => {
        if (vaultProbeInFlight === probe) vaultProbeInFlight = null;
      });
    vaultProbeInFlight = probe;
    return probe;
  };
  void probeVaultCapability();

  // Decrypt provider keys in the runtime config only; the stored config remains encrypted.
  const decryptKey = (label: string, apiKey: ProviderConfig["apiKey"]): string | undefined => {
    if (!isEncryptedSecret(apiKey)) return apiKey;
    try {
      return decryptSecret(apiKey, passphrase);
    } catch (err) {
      console.error(
        `  ✖ failed to decrypt the ${label} API key: ${err instanceof Error ? err.message : err}`
      );
      console.error(`    The wallet unlocked with this passphrase, but the API key was`);
      console.error(`    encrypted with a different one. Re-run \`halo setup\` to`);
      console.error(`    re-enter and re-encrypt the API key with the current passphrase.`);
      process.exit(1);
    }
  };
  for (const p of configProviders(cfg)) {
    p.apiKey = decryptKey(p.slug, p.apiKey);
  }
  // Keep the primary in sync (configProviders returns [cfg.provider] for
  // single-provider configs, so it's already decrypted there; mirror for the
  // multi-provider case where cfg.provider is a separate object).
  cfg.provider.apiKey = configProviders(cfg)[0].apiKey;
  const upstreamApiKey: string | undefined =
    typeof cfg.provider.apiKey === "string" ? cfg.provider.apiKey : undefined;
  // Show only a masked key fingerprint for operator diagnostics.
  const maskKey = (k: string | undefined): string => {
    if (!k) return "(none)";
    if (k.length <= 12) return `set, len ${k.length}`;
    return `${k.slice(0, 6)}…${k.slice(-4)} (len ${k.length})`;
  };
  for (const p of configProviders(cfg)) {
    const k = typeof p.apiKey === "string" ? p.apiKey : undefined;
    // baseUrl is shown so a misconfigured endpoint (e.g. a "near" provider whose
    // URL points somewhere else) is obvious — Halo sends the key to THIS host.
    console.log(`  • ${p.slug}: key ${maskKey(k)}, ${p.models.length} model(s) → ${p.baseUrl}`);
  }

  // Probe each keyed provider with a minimal request; network failure never blocks serve.
  await Promise.all(
    configProviders(cfg).map(async (p) => {
      const k = typeof p.apiKey === "string" ? p.apiKey : undefined;
      if (!k) return; // skip keyless/local providers
      const model = p.models[0];
      if (!model) return;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const wire = wireFormatFor(p.slug);
        const url =
          wire === "anthropic"
            ? `${p.baseUrl.replace(/\/+$/, "")}/messages`
            : `${p.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const headers =
          wire === "anthropic"
            ? anthropicHeaders(k)
            : { "Content-Type": "application/json", Authorization: `Bearer ${k}` };
        const body =
          wire === "anthropic"
            ? chatCompletionsToAnthropicRequest({
                model,
                messages: [{ role: "user", content: "." }],
                max_tokens: 1,
              })
            : { model, messages: [{ role: "user", content: "." }], max_tokens: 1 };
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const probeText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          console.error(
            `  ✖ ${p.slug}: upstream REJECTED the stored key (HTTP ${res.status}) — ${maskKey(k)}.`
          );
          console.error(
            `    This is the key actually loaded for "${p.slug}"; the upstream says it's invalid. ` +
              `Compare it to a key that works in a direct curl (a 1-char typo keeps the same length/prefix). ` +
              `Re-set: halo setup --add-provider --provider ${p.slug} --api-key <key>  then restart serve.`
          );
          // Do not announce models whose provider authentication is broken.
          tripBreakerLogged(p.slug, "operator_auth_failure");
        } else if (res.status === 402) {
          console.error(
            `  ✖ ${p.slug}: upstream accepted the stored key but cannot serve paid requests ` +
              `(HTTP 402, likely out of credits) — ${maskKey(k)}.`
          );
          tripBreakerLogged(p.slug, "credit_exhausted");
        } else if (res.status === 400 && CREDIT_EXHAUSTED_400_RE.test(probeText)) {
          console.error(
            `  ✖ ${p.slug}: upstream accepted the stored key but reports insufficient account credits ` +
              `(HTTP 400) — ${maskKey(k)}.`
          );
          tripBreakerLogged(p.slug, "credit_exhausted");
        } else if (!res.ok) {
          console.log(
            `  • ${p.slug}: key probe reached upstream but returned HTTP ${res.status}; serve will continue`
          );
        } else {
          console.log(`  ✓ ${p.slug}: stored key accepted by upstream`);
        }
      } catch {
        // Network/timeout — don't block serve on a transient probe failure.
        console.log(`  • ${p.slug}: key probe skipped (upstream unreachable right now)`);
      }
    })
  );

  // The X25519 private key remains process-scoped for this serve session.
  const encryptionKeys: OperatorKeyPair = generateOperatorKeypair();
  console.log(`  ✓ E2E encryption pubkey ${encryptionKeys.publicKeyHex.slice(0, 16)}…`);

  // Sign the normalized session key so clients can verify its operator binding.
  const pubkeyNorm = encryptionKeys.publicKeyHex.replace(/^0x/, "").toLowerCase();
  const pubkeyAttestation = await wallet.signMessage(
    `halo-pubkey:${cfg.operator.address.toLowerCase()}:${pubkeyNorm}`
  );

  const facilitator = new Facilitator(
    cfg.facilitator.url,
    cfg.facilitator.apiKey,
    cfg.facilitator.failoverUrls
  );

  const receiptStore = new VaultReceiptStore(path.join(configDir(), "vault-receipts.json"));

  const pendingRehydration = new Map<string, PendingHeldReceipt>();
  for (const r of receiptStore.load()) {
    if (r.operator.toLowerCase() !== cfg.operator.address.toLowerCase()) continue;
    pendingRehydration.set(receiptPairKey(r.consumer, r.operator), {
      consumer: r.consumer,
      operator: r.operator,
      ...r.receipt,
    });
  }
  const persistReceiptSnapshot = (ledgerSnap: ReceiptSnapshot): void =>
    receiptStore.save(durableReceiptSnapshot(pendingRehydration, ledgerSnap));
  const creditLedger = new VaultCreditLedger(persistReceiptSnapshot);
  const redeemer = new OperatorRedeemer(cfg.facilitator.url, creditLedger, (m) => console.log(m));

  // Re-verification is non-blocking and serialized across the boot pass and sweeps.
  let rehydrating = false;
  const rehydrateReceipts = async (): Promise<void> => {
    if (rehydrating) return;
    rehydrating = true;
    try {
      for (const [k, p] of [...pendingRehydration]) {
        const expected = {
          cumulative: p.cumulative,
          signature: p.signature,
          cycle: p.cycle,
        };
        const v = await verifyReceipt({
          consumer: p.consumer,
          operator: p.operator,
          cumulative: p.cumulative,
          signature: p.signature,
        });
        if (!v.ok) {
          if (shouldRetryRehydration(p, v)) continue;
          pendingRehydration.delete(k);
          creditLedger.dropReceipt(p.consumer, p.operator, expected);
          console.log(
            `  ⚠ vault: dropping unrecoverable held receipt from ${abbrevAddr(p.consumer)} (${v.reason})`
          );
          continue;
        }
        if (handoffRehydratedReceipt({
          key: k,
          pending: pendingRehydration,
          receipt: p,
          verification: v,
          ledger: creditLedger,
          persistCurrent: persistReceiptSnapshot,
        })) {
          redeemer.kick(p.consumer, p.operator);
        }
      }
    } finally {
      rehydrating = false;
    }
  };
  void rehydrateReceipts().then(() => {
    let receipts = 0;
    const consumers = new Set<string>();
    let pending = 0n;
    for (const { consumer, operator } of creditLedger.pairsWithRedeemable()) {
      const s = creditLedger.snapshot(consumer, operator);
      if (!s) continue;
      receipts++;
      consumers.add(consumer.toLowerCase());
      const cap = s.ceiling >= 0n && s.held > s.ceiling ? s.ceiling : s.held;
      if (cap > s.redeemed) pending += cap - s.redeemed;
    }
    if (receipts > 0) {
      console.log(
        `  ↻ vault: rehydrated ${receipts} held receipt(s) across ${consumers.size} consumer(s), ${formatUsdcBase(pending, { withDollarSign: true })} pending collection`
      );
    }
  });

  // Retry transient startup verification alongside pending redeems.
  const redeemSweep = setInterval(() => {
    if (pendingRehydration.size > 0) void rehydrateReceipts();
    redeemer.sweep();
  }, 30_000);
  redeemSweep.unref?.();
  // Verify a consumer-pushed receipt against on-chain state, record it (freeing
  // this pair's credit window), and trigger collection. Shared by the WS receipt
  // message and the piggybacked `x-halo-receipt` header.
  const handleReceipt = async (consumer: string, cumulative: bigint, signature: string): Promise<boolean> => {
    if (!isAddress(consumer) || cumulative <= 0n || !signature) return false;
    const v = await verifyReceipt({ consumer, operator: cfg.operator.address, cumulative, signature });
    if (!v.ok) {
      console.warn(`  ⚠ rejecting vault receipt from ${abbrevAddr(consumer)}: ${v.reason}`);
      return false;
    }
    // A fresh chain read prevents uncollectable receipt tails from freeing credit.
    creditLedger.syncOnchain(consumer, cfg.operator.address, v.cycle, v.redeemed, v.locked);
    if (creditLedger.recordReceipt(consumer, cfg.operator.address, { cumulative, signature, cycle: v.cycle })) {
      redeemer.kick(consumer, cfg.operator.address);
    }
    return true;
  };

  // Fire-and-forget warmups apply only to local providers; never spend on hosted-provider probes.
  const localModels = configProviders(cfg)
    .filter((p) => p.slug === "ollama" || p.slug === "lmstudio")
    .flatMap((p) => p.models);
  if (localModels.length > 0) {
    const warmOnce = async () => {
      for (const m of localModels) {
        try {
          await callUpstream(cfg, upstreamApiKey, {
            model: m,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          });
        } catch {
        }
      }
    };
    void warmOnce().then(() =>
      console.log(`  ✓ pre-warmed ${localModels.length} local model(s)`)
    );
    setInterval(() => void warmOnce(), MODEL_WARM_INTERVAL_MS).unref();
  }

  const wsUrl = cfg.relayUrl.replace(/^http/, "ws").replace(/\/+$/, "");

  // Heartbeat is started once on first successful announce and runs for the
  // life of the process across reconnects.
  let heartbeatStarted = false;
  let shuttingDown = false;
  let reconnectAttempt = 0;
  let signalShutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;
  let stopUpdateMonitor = (): void => {};
  const gracefulShutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    stopUpdateMonitor();
    console.log("\n  shutting down");
    // Bound receipt flushing so shutdown cannot hang on the facilitator.
    shutdownPromise = Promise.race([
      redeemer.flush().then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    return shutdownPromise;
  };
  const exitGracefully = (): void => {
    signalShutdownRequested = true;
    void gracefulShutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", exitGracefully);
  process.on("SIGTERM", exitGracefully);
  stopUpdateMonitor = startAutoUpdateMonitor(async () => {
    if (shuttingDown || signalShutdownRequested) return;
    await gracefulShutdown();
    if (signalShutdownRequested) return;
    restartIntoManagedInstall();
  });

  // Resolve, rather than reject, on close; report whether announcement succeeded for retry reset.
  const runOnce = (): Promise<{ announced: boolean }> =>
    new Promise((resolve) => {
      let announced = false;
      // Async handlers re-check this before settlement so an undeliverable response is not charged.
      let wsClosed = false;
      const abortedStreams = new Set<string>();
      console.log(`  connecting to relay: ${wsUrl}`);
      const ws = new WebSocket(wsUrl, {
        perMessageDeflate: false,
        handshakeTimeout: 10_000, // fail upgrade fast if relay is unreachable
        headers: { "X-Halo-Cli-Version": reportedRelayVersion },
      });

      // Application-level keepalive state. lastPongAt seeds at connect time
      // so a relay that immediately goes silent is detected by the watchdog
      // even before the first ping has gone out.
      let lastPongAt = Date.now();
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      const stopKeepalive = (): void => {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = undefined;
        }
      };

      ws.on("open", () => {
        // Combine kernel keepalive with application ping/pong; disable Nagle for immediate control frames.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawSocket = (ws as any)._socket;
        if (rawSocket) {
          rawSocket.setKeepAlive?.(true, 3_000);
          rawSocket.setNoDelay?.(true);
        }
        console.log(`  ✓ connected to relay; waiting for session id...`);
        lastPongAt = Date.now();
        pingTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPongAt > WS_PONG_TIMEOUT_MS) {
            console.log(
              `  ✖ relay silent for >${Math.round(WS_PONG_TIMEOUT_MS / 1000)}s; forcing reconnect`
            );
            stopKeepalive();
            try {
              ws.terminate();
            } catch {
              /* already gone */
            }
            return;
          }
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* will be handled by close/error */
          }
        }, WS_PING_INTERVAL_MS);
      });

      ws.on("message", async (raw) => {
        let msg:
          | InferenceRequestMessage
          | { type: "connected"; peerId: string }
          | { type: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "pong") {
          lastPongAt = Date.now();
          return;
        }

        if (msg.type === "warning") {
          console.warn(`  ⚠ relay warning: ${(msg as { message?: string }).message ?? "upgrade recommended"}`);
          return;
        }

        // First message from the relay carries the peerId — we bind the
        // operator's announce signature to it so a stolen announce payload
        // can't be replayed.
        if (msg.type === "connected" && "peerId" in msg) {
          const peerId = (msg as { peerId: string }).peerId;
          const announceMsg = `halo-announce:${cfg.operator.address.toLowerCase()}:${peerId}`;
          const sendAnnouncement = async (
            capability: boolean,
            promotion: boolean
          ): Promise<void> => {
            const signature = await wallet.signMessage(announceMsg);
            const providers = configProviders(cfg);
            // De-announce unavailable provider models until their breaker recovers.
            const deannounced = breakerDeannouncedModels(cfg);
            const announceModels = allConfiguredModels(cfg).filter((m) => !deannounced.has(m));
            const pricing = await buildPricingAnnounce(cfg);
            const imagePricing = buildImagePricingAnnounce(cfg);
            // Models served by a TEE provider → advertised as confidential-capable
            // so the relay can classify TEE PER MODEL (a multi-provider operator
            // may serve openrouter + near; only the near models are confidential).
            const teeModels = providers
              .filter((p) => isTeeProviderSlug(p.slug) && !isBreakerOpen(p.slug))
              .flatMap((p) => p.models);
            // Also exclude image models whose provider breaker is open, so a
            // broken provider isn't advertised as image-capable.
            const imageModels = providers
              .flatMap((p) => p.imageModels ?? [])
              .filter((m) => !deannounced.has(m));
            ws.send(
              JSON.stringify({
                type: "announce",
                data: {
                  address: cfg.operator.address,
                  cliVersion: reportedRelayVersion,
                  // Primary slug (back-compat single-provider classification).
                  provider: cfg.provider.slug,
                  // Every distinct provider slug this operator fronts.
                  providers: [...new Set(providers.map((p) => p.slug))],
                  models: announceModels,
                  // Subset of `models` that route to a hardware-TEE provider.
                  teeModels: [...new Set(teeModels)],
                  // Subset of `models` served through the image-generation adapter.
                  ...([...new Set(imageModels)].length > 0
                    ? { imageModels: [...new Set(imageModels)] }
                    : {}),
                  pricing,
                  ...(Object.keys(imagePricing).length > 0 ? { imagePricing } : {}),
                  // Per-model context window (tokens) so the relay's /v1/models
                  // can expose it for agents to size context / decide compression.
                  contextLength: await buildContextLengthAnnounce(cfg),
                  // Advertise vault streaming when any provider supports the OpenAI wire; requests re-check their provider.
                  streaming: providers.some((p) => wireFormatFor(p.slug) !== "anthropic"),
                  // Vault routing requires this reservation-verification capability; no legacy fallback is valid.
                  vaultPayments: capability,
                  label: cfg.operator.label,
                  dataRetention: cfg.operator.dataRetention ?? "unknown",
                  encryptionPubkey: encryptionKeys.publicKeyHex,
                  pubkeyAttestation,
                  peerId,
                  signature,
                },
              })
            );
            if (promotion) {
              console.log("  ✓ vault RPC recovered; re-announced vaultPayments capability");
            } else {
              console.log(
                `  ✓ announced as ${abbrevAddr(cfg.operator.address)} (${providers.map((p) => p.slug).join("+")}, ${announceModels.length} models${teeModels.length ? `, ${new Set(teeModels).size} confidential` : ""}${imageModels.length ? `, ${new Set(imageModels).size} image` : ""})`
              );
              announced = true;
              reconnectAttempt = 0;
            }
          };

          const initialVaultCapability = vaultPayments;
          try {
            await sendAnnouncement(initialVaultCapability, false);
          } catch (err) {
            logError("announce signature failed", err);
            ws.close(4000, "announce sign failed");
            return;
          }
          const capabilityAnnouncements = new CapabilityAnnouncementSync(
            initialVaultCapability,
            sendAnnouncement
          );
          syncAnnouncedVaultCapability = async (capability: boolean) => {
            if (wsClosed || ws.readyState !== WebSocket.OPEN) return;
            await capabilityAnnouncements.sync(capability);
          };
          // Keep relay capabilities synchronized with provider breaker state.
          setBreakerChangeHandler(() => {
            if (wsClosed || ws.readyState !== WebSocket.OPEN) return;
            void capabilityAnnouncements.refresh().catch((err) =>
              logError("circuit-breaker re-announce failed", err)
            );
          });
          void (async () => {
            while (!shuttingDown && !wsClosed) {
              const capability = await probeVaultCapability();
              if (ws.readyState !== WebSocket.OPEN || wsClosed) return;
              try {
                await capabilityAnnouncements.sync(capability);
              } catch (err) {
                logError("vault capability re-announce failed; will retry", err);
              }
              await new Promise((resolve) =>
                setTimeout(resolve, VAULT_CAPABILITY_RETRY_MS)
              );
            }
          })();
          if (!heartbeatStarted) {
            heartbeatStarted = true;
            startHeartbeat(cfg, wallet).catch((err) =>
              logError("heartbeat loop crashed", err)
            );
            // Re-probe open breakers; recovery triggers re-announcement.
            startBreakerReprobe(cfg).catch((err) =>
              logError("breaker re-probe loop crashed", err)
            );
          }
          return;
        }

        // Dedicated receipt pushes collect the final tail when no request follows.
        if (msg.type === "receipt") {
          const m = msg as { receiptId?: string; consumer?: string; cumulative?: string; signature?: string };
          let cumulative: bigint;
          try {
            cumulative = BigInt(m.cumulative ?? "0");
          } catch {
            if (m.receiptId && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "receipt-ack", receiptId: m.receiptId, accepted: false }));
            }
            return;
          }
          const accepted = await handleReceipt((m.consumer || "").toLowerCase(), cumulative, m.signature || "");
          if (m.receiptId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "receipt-ack", receiptId: m.receiptId, accepted }));
          }
          return;
        }

        if (msg.type === "stream-abort") {
          const m = msg as StreamAbortMessage;
          if (typeof m.requestId === "string" && m.requestId.length > 0) {
            abortedStreams.add(m.requestId);
            console.warn(
              `  ⚠ relay aborted stream ${m.requestId}${m.reason ? ` (${m.reason})` : ""}; releasing any admitted vault credit`
            );
          }
          return;
        }

        if (msg.type !== "inference-request") return;
        const req = msg as InferenceRequestMessage;
        const requestStartedAt = Date.now();
        await withAbortedStreamCleanup(abortedStreams, req.requestId, async () => {

        // A closed relay socket cannot deliver a response, so skip all paid work and settlement.
        if (wsClosed || ws.readyState !== WebSocket.OPEN) {
          console.warn(
            `  ⚠ WS closed before inference-request could be processed; aborting (consumer not charged)`
          );
          return;
        }

        // Decrypt `_enc` after routing; only the outer `model` remains cleartext.
        let consumerPublicKey: Uint8Array | undefined;
        const encEnvelope = (req.body as { _enc?: unknown })?._enc;
        if (isEncryptedEnvelope(encEnvelope)) {
          try {
            const { plaintext, consumerPublicKey: cpk } = decryptRequest(
              encEnvelope,
              encryptionKeys.privateKey
            );
            consumerPublicKey = cpk;
            const outerModel = (req.body as { model?: unknown })?.model;
            req.body = {
              ...(plaintext as Record<string, unknown>),
              // Outer `model` wins — that's what the relay routed on.
              ...(typeof outerModel === "string" ? { model: outerModel } : {}),
            } as InferenceRequestMessage["body"];
          } catch (err) {
            logError("E2E decryption failed", err);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "inference-response",
                  requestId: req.requestId,
                  status: 400,
                  headers: {},
                  body: { error: { message: "encrypted payload decryption failed" } },
                })
              );
            }
            return;
          }
        }

        const requestedModel =
          typeof req.body.model === "string" ? req.body.model : allConfiguredModels(cfg)[0] || "unknown";

        // Reject open-breaker requests before payment verification or upstream work.
        const brokenSlug = providerForModel(configProviders(cfg), requestedModel).slug;
        if (isBreakerOpen(brokenSlug)) {
          const code = breakerCode(brokenSlug) ?? "provider_error";
          console.warn(
            `  ⛔ instant-reject ${req.requestId}: breaker open for "${brokenSlug}" (${code}); not charging`
          );
          if (ws.readyState === WebSocket.OPEN) {
            const rejected = upstreamProviderErrorResponse(code);
            ws.send(
              JSON.stringify({
                type: "inference-response",
                requestId: req.requestId,
                status: rejected.status,
                headers: {},
                body: rejected.data,
              })
            );
          }
          return;
        }

        let out: { status: number; headers: Record<string, string>; body: unknown };

        // Match relay normalization so whitespace/case variants cannot select a different rail here.
        const paymentMode = (
          (req.headers["x-halo-payment-mode"] as string) || ""
        )
          .trim()
          .toLowerCase();

        // Confidential requests stay buffered because SSE reframing would invalidate the byte-exact proof.
        // The client E2EE public key is the canonical confidential-request marker.
        const teeRequest =
          typeof req.headers["x-client-pub-key"] === "string" ||
          typeof req.headers["x-encryption-version"] === "string";
        const acceptsMedia = requestAcceptsMedia(
          req.body,
          req.headers as Record<string, string | undefined>
        );
        const reqHeaders = req.headers as Record<string, string>;

        // Track admission so every thrown serve releases its credit reservation.
        let creditAdmitted: { consumer: string; ceiling: bigint; cycle: bigint } | null = null;
        let creditAdmit: AdmitResult;
        const imagePrice = imagePriceForModel(cfg, requestedModel);

        try {
          if (paymentMode === "vault") {
            const invalidGenerationControl = invalidVaultTextGenerationControlField(
              req.body,
              imagePrice !== null
            );
            if (invalidGenerationControl !== null) {
              console.warn(
                `  ⚠ rejecting vault text request ${req.requestId}: invalid ${invalidGenerationControl}`
              );
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "inference-response",
                    requestId: req.requestId,
                    status: 400,
                    headers: {},
                    body: {
                      error: {
                        message:
                          invalidGenerationControl === "n"
                            ? "n must be the numeric integer 1 when supplied for a vault text request."
                            : `${invalidGenerationControl} must be a positive finite integer when supplied.`,
                        type: "vault_invalid_generation_control",
                        field: invalidGenerationControl,
                      },
                    },
                  })
                );
              }
              return;
            }
            // Vault mode gates pre-work on a live operator reservation; collection still requires a signed receipt.
            const consumerAddr = (req.headers["x-halo-vault-consumer"] || "").toLowerCase();
            const fmtUsd = (b: bigint) => formatUsdcBase(b, { withDollarSign: true });
            // Concurrent requests share one facilitator identity check; a recent
            // match is reused briefly while deterministic mismatches invalidate it.
            const requestVaultIdentity = await vaultIdentityProbe.check();
            applyVaultIdentity(requestVaultIdentity);
            if (requestVaultIdentity.status === "match" && !vaultRpcCapable) {
              await probeVaultCapability(false);
            }
            const capabilitySync = syncAnnouncedVaultCapability;
            if (capabilitySync) {
              void capabilitySync(vaultPayments).catch((err) =>
                logError("vault capability re-announce failed", err)
              );
            }
            if (!vaultRpcCapable || requestVaultIdentity.status !== "match") {
              out = {
                status: 503,
                headers: {},
                body: {
                  error: {
                    message: "vault payments are unavailable because the configured vault could not be verified against the facilitator",
                    type: "vault_identity_unverified",
                    vault: selectedVaultAddress,
                  },
                },
              };
            } else if (!isAddress(consumerAddr)) {
              out = {
                status: 400,
                headers: {},
                body: { error: { message: "vault mode requires a valid X-Halo-Vault-Consumer header" } },
              };
            } else {
              // Process a piggybacked prior receipt before gating this request.
              const rcptHeader = req.headers["x-halo-receipt"];
              if (typeof rcptHeader === "string" && rcptHeader) {
                try {
                  const r = JSON.parse(Buffer.from(rcptHeader, "base64").toString("utf-8")) as {
                    cumulative?: string;
                    signature?: string;
                  };
                  await handleReceipt(consumerAddr, BigInt(r.cumulative ?? "0"), r.signature || "");
                } catch {
                  /* malformed piggyback receipt — ignore; the gate still protects us */
                }
              }
              // Shared completion sizing keeps consumer reservation, serve gate,
              // and the omitted-limit upstream bound equal.
              const vaultCompletionCeiling = requestCompletionCeilingTokens(req.body);
              const ceilingCost =
                imagePrice !== null
                  ? priceImages(imagePrice, requestedImageCount(req.body))
                  : await priceRequest({
                      cfg,
                      model: requestedModel,
                      promptTokens: estimateRequestPromptTokens(req.body),
                      completionTokens: vaultCompletionCeiling,
                    });
              let chk: ReservationCheck;
              try {
                chk = await checkReservationCached(consumerAddr, cfg.operator.address, ceilingCost);
              } catch (err) {
                logError("vault reservation read failed", err);
                chk = { ok: false, reason: "could not read on-chain reservation", remaining: 0n, cycle: 0n, redeemed: 0n };
              }
              if (!chk.ok) {
                console.warn(
                  `  ⚠ rejecting vault request ${req.requestId}: ${chk.reason} (need ${fmtUsd(ceilingCost)}, have ${fmtUsd(chk.remaining)})`
                );
                // At the lifetime cap, reclaim and fresh reserve replace ordinary extension.
                const advice =
                  chk.reason === "reservation expired"
                    ? "re-reserve to extend it — or, if it has reached its on-chain lifetime cap, reclaim it from your vault first, then re-reserve"
                    : "reserve more from your vault";
                out = {
                  status: 402,
                  headers: {},
                  body: {
                    error: {
                      message: `Vault reservation insufficient: ${chk.reason}. This request needs up to ${fmtUsd(ceilingCost)} reserved; ${advice}.`,
                      type: "vault_reservation_insufficient",
                      requiredUsdcBase: ceilingCost.toString(),
                      remainingUsdcBase: chk.remaining.toString(),
                      vault: getVaultAddress(),
                    },
                  },
                };
              } else {
                // Cap accumulated unreceipted work by configured credit and on-chain locked funds.
                // One larger request may be admitted when nothing is outstanding; refresh from current cycle state.
                const creditWindow = (): bigint =>
                  creditWindowBase() < chk.remaining ? creditWindowBase() : chk.remaining;
                // Align local cumulative accounting with the on-chain collectible ceiling.
                creditLedger.syncOnchain(consumerAddr, cfg.operator.address, chk.cycle, chk.redeemed, chk.remaining);
                creditAdmit = creditLedger.admit(
                  consumerAddr,
                  cfg.operator.address,
                  chk.cycle,
                  ceilingCost,
                  creditWindow()
                );
                if (!creditAdmit.ok && creditAdmit.stale) {
                  // On a stale-cycle refusal, invalidate cache and re-gate once against current chain state.
                  invalidateGate(consumerAddr, cfg.operator.address);
                  try {
                    chk = await checkReservationCached(consumerAddr, cfg.operator.address, ceilingCost);
                  } catch (err) {
                    logError("vault reservation refresh failed", err);
                    chk = { ok: false, reason: "could not refresh on-chain reservation", remaining: 0n, cycle: 0n, redeemed: 0n };
                  }
                  if (chk.ok) {
                    creditLedger.syncOnchain(consumerAddr, cfg.operator.address, chk.cycle, chk.redeemed, chk.remaining);
                    creditAdmit = creditLedger.admit(
                      consumerAddr,
                      cfg.operator.address,
                      chk.cycle,
                      ceilingCost,
                      creditWindow()
                    );
                  } else {
                    creditAdmit = {
                      ok: false,
                      reason: `reservation no longer covers this request after a cycle change${chk.reason ? `: ${chk.reason}` : ""}`,
                      outstanding: 0n,
                    };
                  }
                }
                if (!creditAdmit.ok) {
                console.warn(
                  `  ⚠ rejecting vault request ${req.requestId}: ${creditAdmit.reason}`
                );
                out = {
                  status: 402,
                  headers: {},
                  body: {
                    error: {
                      message: `Vault credit window exceeded: ${creditAdmit.reason}. The operator is awaiting a signed receipt for your prior requests before serving more — push the receipt (or it rides on your next request) to free the window.`,
                      type: "vault_credit_window_exceeded",
                      requiredUsdcBase: ceilingCost.toString(),
                    },
                  },
                };
                } else {
                // Admitted — the ceiling is reserved against the window until we
                // settle (served) or release (failed). Remember it for both.
                creditAdmitted = { consumer: consumerAddr, ceiling: ceilingCost, cycle: chk.cycle };
                if (imagePrice !== null && !acceptsMedia) {
                  creditLedger.releaseInflight(
                    consumerAddr,
                    cfg.operator.address,
                    chk.cycle,
                    ceilingCost
                  );
                  creditAdmitted = null;
                  out = {
                    status: 400,
                    headers: {},
                    body: {
                      error: {
                        message:
                          "Image generation requires a media-capable consumer. Send X-Halo-Accept-Media: 1 and consume halo-media frames.",
                        type: "media_client_required",
                      },
                    },
                  };
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                      JSON.stringify({
                        type: "inference-response",
                        requestId: req.requestId,
                        status: out.status,
                        headers: out.headers,
                        body: out.body,
                      })
                    );
                  }
                  return;
                }
                // Vault streaming emits inference chunks; pre-locked funds preserve the buffered path's risk bound.
                const wantsVaultStream =
                  imagePrice === null &&
                  !teeRequest &&
                  !!req.body &&
                  typeof req.body === "object" &&
                  (req.body as Record<string, unknown>).stream === true &&
                  wireFormatFor(providerForModel(configProviders(cfg), requestedModel).slug) !== "anthropic";
                let upstream: {
                  status: number;
                  data: unknown;
                  usage: UpstreamUsage;
                  respHeaders?: Record<string, string>;
                };
                if (wantsVaultStream) {
                  const sres = await streamUpstream(
                    cfg,
                    upstreamApiKey,
                    req.body,
                    (deltaObj) => {
                      if (abortedStreams.has(req.requestId)) return;
                      if (ws.readyState !== WebSocket.OPEN) return;
                      const data =
                        consumerPublicKey !== undefined
                          ? JSON.stringify(
                              encryptResponse(deltaObj, consumerPublicKey, encryptionKeys.privateKey)
                            )
                          : JSON.stringify(deltaObj);
                      ws.send(
                        JSON.stringify({
                          type: "inference-chunk",
                          requestId: req.requestId,
                          data,
                          encrypted: consumerPublicKey !== undefined,
                        })
                      );
                    },
                    vaultCompletionCeiling
                  );
                  upstream = {
                    status: sres.status,
                    data: sres.ok ? { streamed: true } : sres.errorData,
                    usage: sres.usage,
                    respHeaders: {},
                  };
                } else {
                  upstream =
                    imagePrice !== null
                      ? await callUpstreamImage(cfg, upstreamApiKey, req.body)
                      : await callUpstream(
                          cfg,
                          upstreamApiKey,
                          req.body,
                          reqHeaders,
                          vaultCompletionCeiling
                        );
                }
                const encryptIfNeeded = (data: unknown): unknown =>
                  consumerPublicKey !== undefined
                    ? { _enc: encryptResponse(data, consumerPublicKey, encryptionKeys.privateKey) }
                    : data;
                if (!(upstream.status >= 200 && upstream.status < 300)) {
                  // Upstream failed — no charge owed; consumer simply won't redeem.
                  // Return the request's reserved ceiling to the credit window.
                  creditLedger.releaseInflight(consumerAddr, cfg.operator.address, chk.cycle, ceilingCost);
                  creditAdmitted = null;
                  console.warn(`  ⚠ upstream ${upstream.status} on vault request; nothing to settle`);
                  out = {
                    status: upstream.status,
                    headers: { ...(upstream.respHeaders ?? {}) },
                    body: encryptIfNeeded(upstream.data),
                  };
                } else {
                  // Cap actual usage to the amount gated and reserved for this request.
                  // A small max_tokens gate never bounds a reasoning model's tokens, so the
                  // priced actual can exceed the ceiling; awarding the uncapped price would
                  // over-count the credit ledger and strand a permanent txHash:null indexer row.
                  const imageSettlement =
                    imagePrice !== null
                      ? priceServedImagesForVault(imagePrice, upstream.data, ceilingCost)
                      : null;
                  if (imageSettlement && imageSettlement.servedImageCount === 0) {
                    creditLedger.releaseInflight(
                      consumerAddr,
                      cfg.operator.address,
                      chk.cycle,
                      ceilingCost
                    );
                    creditAdmitted = null;
                    console.warn(
                      `  ⚠ image vault request ${req.requestId} returned no detectable images; released ${fmtUsd(ceilingCost)} reserved credit without settlement`
                    );
                    out = {
                      status: 502,
                      headers: { ...(upstream.respHeaders ?? {}) },
                      body: buildNoImageTerminalBody(),
                    };
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "inference-response",
                          requestId: req.requestId,
                          status: out.status,
                          headers: out.headers,
                          body: out.body,
                        })
                      );
                    }
                    return;
                  }
                  const uncappedAmount =
                    imageSettlement?.uncappedAmount ??
                    (await priceRequest({
                      cfg,
                      model: requestedModel,
                      promptTokens: upstream.usage.prompt_tokens,
                      completionTokens: upstream.usage.completion_tokens,
                      cachedPromptTokens: upstream.usage.cached_prompt_tokens,
                    }));
                  const actualAmount =
                    imageSettlement?.actualAmount ??
                    collectibleServeAmount(uncappedAmount, ceilingCost);
                  const servedTokens = imageSettlement?.tokens ?? upstream.usage.total_tokens;
                  if (uncappedAmount > actualAmount) {
                    console.warn(
                      imageSettlement
                        ? `  ⚠ vault-served at a loss on ${req.requestId}: actual image cost ${fmtUsd(uncappedAmount)} (${imageSettlement.servedImageCount} image(s)) exceeds this request's reserved ceiling ${fmtUsd(ceilingCost)}; collecting ${fmtUsd(actualAmount)} — the model returned more images than the reservation covered for "${requestedModel}"`
                        : `  ⚠ vault-served at a loss on ${req.requestId}: actual cost ${fmtUsd(uncappedAmount)} (${upstream.usage.completion_tokens} completion tok) exceeds this request's reserved ceiling ${fmtUsd(ceilingCost)}; collecting ${fmtUsd(actualAmount)} — the model's output ran past the reserved headroom for "${requestedModel}" (raise the reservation ceiling for this model)`
                    );
                  }
                  if (imageSettlement) {
                    let mediaFrames: MediaChunkFrame[];
                    try {
                      const prepared = prepareImageDeliveryFrames({
                        requestId: req.requestId,
                        responseData: upstream.data,
                        imageSettlement,
                        consumerPublicKey,
                        operatorKeys: encryptionKeys,
                      });
                      mediaFrames = prepared.frames;
                    } catch (err) {
                      creditLedger.releaseInflight(
                        consumerAddr,
                        cfg.operator.address,
                        chk.cycle,
                        ceilingCost
                      );
                      creditAdmitted = null;
                      const type =
                        err instanceof UndeliverableImageResponseError
                          ? err.type
                          : err instanceof UnsupportedImageFormatError
                            ? "unsupported_image_format"
                            : err instanceof MalformedImageError
                              ? "malformed_image"
                              : "image_delivery_failed";
                      const message = err instanceof Error ? err.message : String(err);
                      console.warn(
                        `  ⚠ image vault request ${req.requestId} could not prepare deliverable media (${type}); released ${fmtUsd(ceilingCost)} reserved credit without settlement`
                      );
                      out = {
                        status: type === "image_encryption_required" ? 400 : 502,
                        headers: {},
                        body: { error: { message, type } },
                      };
                      if (ws.readyState === WebSocket.OPEN) {
                        ws.send(
                          JSON.stringify({
                            type: "inference-response",
                            requestId: req.requestId,
                            status: out.status,
                            headers: out.headers,
                            body: out.body,
                          })
                        );
                      }
                      return;
                    }

                    try {
                      for (const frame of mediaFrames) {
                        if (abortedStreams.has(req.requestId)) break;
                        await sendWsJson(ws, frame);
                      }
                    } catch (err) {
                      creditLedger.releaseInflight(
                        consumerAddr,
                        cfg.operator.address,
                        chk.cycle,
                        ceilingCost
                      );
                      creditAdmitted = null;
                      logError("image media delivery failed", err);
                      out = {
                        status: 502,
                        headers: {},
                        body: {
                          error: {
                            message: "image media delivery failed before settlement",
                            type: "image_media_delivery_failed",
                          },
                        },
                      };
                      if (ws.readyState === WebSocket.OPEN) {
                        ws.send(
                          JSON.stringify({
                            type: "inference-response",
                            requestId: req.requestId,
                            status: out.status,
                            headers: out.headers,
                            body: out.body,
                          })
                        );
                      }
                      return;
                    }
                  }
                  // Confidential path: fetch the TEE response signature with the
                  // operator's key and forward it (key never leaves the operator).
                  // Resolve the model's own provider (multi-provider operators).
                  const teeProv = resolveProvider(cfg, req.body);
                  const teeSig = teeRequest
                    ? await fetchTeeSignature(
                        teeProv.provider.baseUrl,
                        teeProv.apiKey,
                        (upstream.data as { id?: string })?.id ?? "",
                        requestedModel
                      )
                    : null;
                  if (
                    releaseAbortedVaultServe({
                      abortedRequestIds: abortedStreams,
                      requestId: req.requestId,
                      creditLedger,
                      consumer: consumerAddr,
                      operator: cfg.operator.address,
                      cycle: chk.cycle,
                      ceiling: ceilingCost,
                    })
                  ) {
                    creditAdmitted = null;
                    console.warn(
                      `  ⚠ vault stream ${req.requestId} aborted by relay; released ${fmtUsd(ceilingCost)} reserved credit without settlement`
                    );
                    out = {
                      status: 499,
                      headers: {},
                      body: { error: { message: "stream aborted before confirmed delivery" } },
                    };
                  } else {
                    // Tell the consumer what to redeem: this request's cost +
                    // token usage. The consumer advances its cumulative receipt by
                    // this and the facilitator submits the redeem (operator paid).
                    out = {
                      status: upstream.status,
                      headers: {
                        ...(upstream.respHeaders ?? {}),
                        ...(teeSig ? { "X-Halo-TEE-Signature": teeSig } : {}),
                        "PAYMENT-RESPONSE": Buffer.from(
                          JSON.stringify({
                            success: true,
                            mode: "vault",
                            amountUsdc: actualAmount.toString(),
                            tokens: servedTokens,
                            operator: cfg.operator.address,
                          }),
                          "utf-8"
                        ).toString("base64"),
                      },
                      body: imageSettlement
                        ? buildImageTerminalBody(imageSettlement)
                        : encryptIfNeeded(upstream.data),
                    };
                    // Discount what we just served from the cached reservation
                    // headroom so the gate cache never approves past coverage.
                    noteServed(consumerAddr, cfg.operator.address, actualAmount);
                    // Replace admitted ceiling with actual cost and retain its checkpoint.
                    const servedCumulative = creditLedger.settleServed(consumerAddr, cfg.operator.address, chk.cycle, ceilingCost, actualAmount);
                    creditAdmitted = null;
                    console.log(
                      imageSettlement
                        ? `  ✓ vault-served ${req.requestId} for ${abbrevAddr(consumerAddr)} — ${fmtUsd(actualAmount)} (${imageSettlement.servedImageCount} image(s)); awaiting redeem`
                        : `  ✓ vault-served ${req.requestId} for ${abbrevAddr(consumerAddr)} — ${fmtUsd(actualAmount)} (${upstream.usage.total_tokens} tok); awaiting redeem`
                    );
                    // Fire-and-forget indexer event. txHash is null — the redeem
                    // happens async (consumer-driven); the verifier reconciles.
                    const durationMs = Date.now() - requestStartedAt;
                    const eventPayload = {
                      id: req.requestId,
                      operator: cfg.operator.address,
                      consumer: consumerAddr,
                      model: req.body.model ?? null,
                      tokens: servedTokens,
                      amountUsdc: actualAmount.toString(),
                      durationMs,
                      timestamp: Date.now(),
                      txHash: null,
                      mode: "vault" as const,
                      // Omit stale-cycle checkpoints rather than risk incorrect attribution.
                      cumulativeCheckpoint:
                        servedCumulative === null ? undefined : servedCumulative.toString(),
                    };
                    const sigMessage = canonicalEventMessage(eventPayload);
                    wallet
                      .signMessage(sigMessage)
                      .then((signature) => postEvent(cfg, { ...eventPayload, signature }))
                      .catch((err) => logError("event post failed", err));
                  }
                }
                }
              }
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "inference-response",
                  requestId: req.requestId,
                  status: out.status,
                  headers: out.headers,
                  body: out.body,
                })
              );
            }
            return;
          }
          if (paymentMode === "budget") {
            // Budget mode draws through `/settle-budget`; the facilitator validates authorization per settlement.
            const sigHeader = req.headers["payment-signature"];
            if (imagePrice !== null) {
              out = {
                status: 402,
                headers: {},
                body: {
                  error: {
                    message: "Image generation is vault-only; send x-halo-payment-mode: vault for image-priced models.",
                    type: "image_vault_required",
                  },
                },
              };
            } else if (!sigHeader) {
              out = {
                status: 400,
                headers: {},
                body: {
                  error: {
                    message:
                      "budget mode requires PAYMENT-SIGNATURE with the BudgetPaymentPayload",
                  },
                },
              };
            } else {
              // Decode base64 → JSON. The payload carries two consumer
              // signatures: the Permit2 PermitSingle (submitted on-chain)
              // and the Halo BudgetPolicy (off-chain facilitator validation).
              let budgetPayload: {
                mode: string;
                policy: { operator: string; maxPerSettlement: string };
              };
              try {
                const decoded = Buffer.from(sigHeader, "base64").toString("utf-8");
                budgetPayload = JSON.parse(decoded);
                if (budgetPayload.mode !== "budget") {
                  throw new Error(`expected mode=budget, got ${budgetPayload.mode}`);
                }
              } catch (err) {
                out = {
                  status: 400,
                  headers: {},
                  body: {
                    error: {
                      message: `malformed budget payload: ${err instanceof Error ? err.message : String(err)}`,
                    },
                  },
                };
                // Send the error response now and skip the rest of the handler.
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "inference-response",
                      requestId: req.requestId,
                      status: out.status,
                      headers: out.headers,
                      body: out.body,
                    })
                  );
                }
                return;
              }

              // Budget authorization is operator-unbound; the routed operator identifies itself as recipient at settlement.

              // Activate (or re-confirm) the budget by submitting the permit
              // onchain. Idempotent — repeated calls for the same
              // (consumer, nonce) just return the existing budgetId.
              const submit = await facilitator.permitSubmit(budgetPayload);
              if (submit.errorReason || !submit.budgetId) {
                out = {
                  status: 400,
                  headers: {},
                  body: {
                    error: {
                      message: `permit activation failed: ${submit.errorReason || "no budgetId returned"}`,
                    },
                  },
                };
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "inference-response",
                      requestId: req.requestId,
                      status: out.status,
                      headers: out.headers,
                      body: out.body,
                    })
                  );
                }
                return;
              }

              // WS-closed guard before spending operator money on upstream.
              if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                console.warn(
                  `  ⚠ WS closed after budget activation; aborting (no upstream charge, no settlement)`
                );
                return;
              }

              // Reject when input cost already exhausts the collectible cap; completion can only increase the loss.
              const witnessCap = BigInt(budgetPayload.policy.maxPerSettlement);
              const fmtUsd = (b: bigint) => formatUsdcBase(b, { withDollarSign: true });
              const inputFloor = await priceRequest({
                cfg,
                model: requestedModel,
                promptTokens: estimateRequestPromptTokens(req.body),
                completionTokens: 0,
              });
              if (inputFloor >= witnessCap) {
                console.warn(
                  `  ⚠ rejecting budget request ${req.requestId}: input cost ${fmtUsd(inputFloor)} ≥ per-prompt cap ${fmtUsd(witnessCap)} (would serve at a loss)`
                );
                out = {
                  status: 402,
                  headers: {},
                  body: {
                    error: {
                      message: `This request's input alone costs ~${fmtUsd(inputFloor)}, at or above your per-prompt cap of ${fmtUsd(witnessCap)}. Raise your per-prompt cap to run it.`,
                      type: "per_prompt_cap_too_low",
                      requiredUsdcBase: inputFloor.toString(),
                      capUsdcBase: witnessCap.toString(),
                    },
                  },
                };
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "inference-response",
                      requestId: req.requestId,
                      status: out.status,
                      headers: out.headers,
                      body: out.body,
                    })
                  );
                }
                return;
              }

              // Streaming is opt-in because content is delivered before settlement.
              const wantsStream =
                !!req.body &&
                typeof req.body === "object" &&
                (req.body as Record<string, unknown>).stream === true;
              const useStreaming =
                process.env.HALO_ENABLE_STREAMING === "1" &&
                wantsStream &&
                wireFormatFor(cfg.provider.slug) !== "anthropic";
              let upstream: { status: number; data: unknown; usage: UpstreamUsage };
              let streamed = false;
              if (useStreaming) {
                const sres = await streamUpstream(cfg, upstreamApiKey, req.body, (deltaObj) => {
                  if (abortedStreams.has(req.requestId)) return;
                  if (ws.readyState !== WebSocket.OPEN) return;
                  const data =
                    consumerPublicKey !== undefined
                      ? JSON.stringify(
                          encryptResponse(deltaObj, consumerPublicKey, encryptionKeys.privateKey)
                        )
                      : JSON.stringify(deltaObj);
                  ws.send(
                    JSON.stringify({
                      type: "inference-chunk",
                      requestId: req.requestId,
                      data,
                      encrypted: consumerPublicKey !== undefined,
                    })
                  );
                });
                streamed = sres.ok;
                upstream = {
                  status: sres.status,
                  data: sres.ok ? { streamed: true } : sres.errorData,
                  usage: sres.usage,
                };
              } else {
                upstream = await callUpstream(cfg, upstreamApiKey, req.body);
              }
              const encryptIfNeeded = (data: unknown): unknown =>
                consumerPublicKey !== undefined
                  ? {
                      _enc: encryptResponse(
                        data,
                        consumerPublicKey,
                        encryptionKeys.privateKey
                      ),
                    }
                  : data;

              const inferenceSucceeded =
                upstream.status >= 200 && upstream.status < 300;

              if (!inferenceSucceeded) {
                // Same money-safety rules as per-request mode: upstream
                // failed, no settlement. Budget remains intact for retry.
                console.warn(
                  `  ⚠ upstream ${upstream.status}; skipping budget settlement (consumer not charged)`
                );
                out = {
                  status: upstream.status,
                  headers: {},
                  body: encryptIfNeeded(upstream.data),
                };
              } else {
                // Compute uncapped actual cost for loss visibility, then enforce the witness cap.
                const uncappedAmount = await priceRequest({
                  cfg,
                  model: requestedModel,
                  promptTokens: upstream.usage.prompt_tokens,
                  completionTokens: upstream.usage.completion_tokens,
                  cachedPromptTokens: upstream.usage.cached_prompt_tokens,
                });
                const actualAmount =
                  uncappedAmount < witnessCap ? uncappedAmount : witnessCap;
                if (uncappedAmount > witnessCap) {
                  console.warn(
                    `  ⚠ served at a loss on ${req.requestId}: cost ${fmtUsd(uncappedAmount)} exceeds per-prompt cap ${fmtUsd(witnessCap)}; collecting ${fmtUsd(witnessCap)} — consumer should raise their per-prompt cap`
                  );
                }

                if (abortedStreams.has(req.requestId)) {
                  console.warn(
                    `  ⚠ budget stream ${req.requestId} aborted by relay; skipping settlement`
                  );
                  out = {
                    status: 499,
                    headers: {},
                    body: { error: { message: "stream aborted before confirmed delivery" } },
                  };
                } else {
                  // WS-closed guard right before money moves.
                  if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                    console.warn(
                      `  ⚠ WS closed mid-budget-request after upstream succeeded; skipping settlement`
                    );
                    return;
                  }

                  const settle = await facilitator.settleBudget({
                    budgetId: submit.budgetId,
                    operator: cfg.operator.address,
                    amount: actualAmount.toString(),
                    voucher: parseVoucherHeader(req.headers["x-halo-voucher"]),
                    metadata: {
                      inferenceId: req.requestId,
                      model: typeof req.body.model === "string" ? req.body.model : undefined,
                      tokens: upstream.usage.total_tokens,
                    },
                  });

                  if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                    console.error(
                      `  ⚠⚠ WS closed during /settle-budget; settlement tx ${settle.transaction || "?"} may have completed onchain but response cannot reach the consumer`
                    );
                    return;
                  }

                  if (!settle.success) {
                    logError("budget settlement failed", settle.errorReason);
                    out = {
                      status: 502,
                      headers: {},
                      body: {
                        error: {
                          message: `settlement failed: ${settle.errorReason || "unknown"}`,
                        },
                      },
                    };
                  } else {
                    out = {
                      status: upstream.status,
                      headers: {
                        "PAYMENT-RESPONSE": Buffer.from(
                          JSON.stringify({
                            success: true,
                            transaction: settle.transaction,
                            spent: settle.spent,
                            remaining: settle.remaining,
                          }),
                          "utf-8"
                        ).toString("base64"),
                      },
                      // When streamed, the deltas already carried the content;
                      // the terminal response only carries settlement (the relay
                      // emits it as a final SSE event and ignores this body).
                      body: streamed ? null : encryptIfNeeded(upstream.data),
                    };

                    const durationMs = Date.now() - requestStartedAt;
                    const eventPayload = {
                      id: req.requestId,
                      operator: cfg.operator.address,
                      // Attribute to the facilitator-recovered budget owner; retain compatibility fallback if absent.
                      consumer: submit.consumer ?? cfg.operator.address,
                      model: req.body.model ?? null,
                      tokens: upstream.usage.total_tokens,
                      amountUsdc: actualAmount.toString(),
                      durationMs,
                      timestamp: Date.now(),
                      txHash: settle.transaction || null,
                      mode: "budget" as const,
                    };
                    const sigMessage = canonicalEventMessage(eventPayload);
                    wallet
                      .signMessage(sigMessage)
                      .then((signature) =>
                        postEvent(cfg, { ...eventPayload, signature })
                      )
                      .catch((err) => logError("event post failed", err));
                  }
                }
              }
            }

            // Send the budget-mode response now and skip the per-request flow.
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "inference-response",
                  requestId: req.requestId,
                  status: out.status,
                  headers: out.headers,
                  body: out.body,
                })
              );
            }
            return;
          }

          out = {
            status: 400,
            headers: {},
            body: {
              error: {
                message:
                  paymentMode === ""
                    ? "x-halo-payment-mode is required"
                    : `unsupported payment mode: ${paymentMode}`,
                type: "unsupported_payment_mode",
              },
            },
          };
        } catch (err) {
          // A thrown serve must release its admitted credit ceiling.
          if (creditAdmitted) {
            creditLedger.releaseInflight(
              creditAdmitted.consumer,
              cfg.operator.address,
              creditAdmitted.cycle,
              creditAdmitted.ceiling
            );
            creditAdmitted = null;
          }
          console.warn(
            `  ⚠ serve failed before response: ${err instanceof Error ? err.message : String(err)}`
          );
          const failed = operatorErrorResponse();
          out = {
            status: failed.status,
            headers: {},
            body: failed.data,
          };
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "inference-response",
              requestId: req.requestId,
              status: out.status,
              headers: out.headers,
              body: out.body,
            })
          );
        }
        });
      });

      // Protocol-level pings from the relay are auto-ponged by the ws
      // library, but the event still fires — treat it as a sign of life
      // so the watchdog stays armed only when the relay is actually silent.
      ws.on("ping", () => {
        lastPongAt = Date.now();
      });

      ws.on("close", (code, reason) => {
        wsClosed = true;
        stopKeepalive();
        setBreakerChangeHandler(null);
        console.log(`  ✖ disconnected (code=${code}, reason=${reason.toString() || "-"})`);
        resolve({ announced });
      });
      ws.on("error", (err) => console.error("  ws error:", err.message));
    });

  // Retry closes with exponential backoff; an explicit positive cap enables bounded CI behavior.
  const maxAttempts = resolveMaxReconnectAttempts();
  const capDisplay = maxAttempts === 0 ? "∞" : String(maxAttempts);
  while (!shuttingDown) {
    const result = await runOnce();
    if (shuttingDown) break;
    if (!result.announced) {
      reconnectAttempt += 1;
    }
    if (maxAttempts > 0 && reconnectAttempt > maxAttempts) {
      console.log(
        `  ✖ exceeded ${maxAttempts} reconnect attempts (HALO_MAX_RECONNECT_ATTEMPTS); exiting`
      );
      process.exit(1);
    }
    // First reconnect is immediate — fast recovery from relay restarts or
    // brief network blips. Subsequent retries use exponential backoff with
    // full jitter to prevent thundering herd when many operators reconnect.
    const delay =
      reconnectAttempt === 0
        ? 0
        : Math.round(backoffDelayMs(reconnectAttempt) * (0.5 + Math.random() * 0.5));
    if (delay > 0) {
      console.log(
        `  reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${capDisplay})`
      );
      await new Promise((r) => setTimeout(r, delay));
    } else {
      console.log(`  reconnecting immediately`);
    }
  }
}

// Display-only ceiling for margin-mode models without upstream catalog pricing.
const MARGIN_UNPRICED_ANNOUNCE_CAP_PER_1K = 0.001;

export async function buildPricingAnnounce(
  cfg: HaloConfig
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // Announce flat rates directly and derive margin rates from available upstream prices.
  const fallbackPer1K = cfg.pricing.fallbackPerRequestUsdc / 1_000_000; // USDC units

  // Multi-provider: price each provider's models with that provider's own
  // pricing block when present (margins differ by gateway), falling back to the
  // operator-wide cfg.pricing.
  for (const provider of configProviders(cfg)) {
    for (const m of provider.models) {
      if (providerServesConfiguredImageModel(provider, m)) continue;
      const pricing = provider.pricing ?? cfg.pricing;
      const flat = pricing.flatUsdcPer1KTokens;
      const marginPct = typeof pricing.marginPercent === "number" ? pricing.marginPercent : 25;
      const proxy = flat !== undefined ? flat : fallbackPer1K;
      if (pricing.mode === "flat" && flat !== undefined) {
        out[m] = flat;
        continue;
      }
      if (pricing.mode === "margin") {
        let upstreamPer1K: number | null = null;
        try {
          upstreamPer1K = await upstreamRatePer1KUsd({
            providerSlug: provider.slug,
            providerBaseUrl: provider.baseUrl,
            model: m,
          });
        } catch {
          upstreamPer1K = null;
        }
        if (upstreamPer1K !== null && upstreamPer1K > 0) {
          out[m] = upstreamPer1K * (1 + marginPct / 100);
          continue;
        }
        // Cap only the announced rate; request-time resolution may recover or use its fixed fallback.
        out[m] =
          flat !== undefined
            ? proxy
            : Math.min(fallbackPer1K, MARGIN_UNPRICED_ANNOUNCE_CAP_PER_1K);
        continue;
      }
      out[m] = proxy;
    }
  }
  return out;
}

export function buildImagePricingAnnounce(cfg: HaloConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const provider of configProviders(cfg)) {
    for (const m of provider.imageModels ?? []) {
      const price = imagePriceForModel(cfg, m);
      if (price !== null) out[m] = price;
    }
  }
  return out;
}

/** Resolve announced context windows from cached provider catalogs, omitting unknown models. */
async function buildContextLengthAnnounce(cfg: HaloConfig): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const provider of configProviders(cfg)) {
    for (const m of provider.models) {
      try {
        const ctx = await upstreamContextLength({
          providerSlug: provider.slug,
          providerBaseUrl: provider.baseUrl,
          model: m,
        });
        if (ctx && ctx > 0) out[m] = ctx;
      } catch {
        /* unknown window — omit */
      }
    }
  }
  return out;
}

interface EventPayload {
  id: string;
  operator: string;
  consumer: string;
  model: string | null;
  tokens: number;
  amountUsdc: string;
  durationMs: number;
  timestamp: number;
  txHash: string | null;
  /** Payment rail this event was served over. Informational — not signed. */
  mode: "vault" | "budget";
  /** Unsigned vault checkpoint used for interval-based redeem attribution. */
  cumulativeCheckpoint?: string;
}

/** Indexer signature contract: `halo-event:{id}:{operator}:{consumer}:{amountUsdc}:{tokens}:{timestamp}`.
 * `txHash` remains body-only because it may be unavailable. */
export function canonicalEventMessage(ev: Omit<EventPayload, "txHash" | "mode" | "cumulativeCheckpoint">): string {
  return `halo-event:${ev.id}:${ev.operator.toLowerCase()}:${ev.consumer.toLowerCase()}:${ev.amountUsdc}:${ev.tokens}:${ev.timestamp}`;
}

function abbrevAddr(addr: string | null | undefined): string {
  if (!addr || addr.length < 10) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}


/** Cap a single log file at 5 MB before rotation. ~2× total disk = 10 MB. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
let logStream: ReturnType<typeof createWriteStream> | null = null;

function serveLogPath(): string {
  return path.join(configDir(), "serve.log");
}

function pidFilePath(): string {
  return path.join(configDir(), "serve.pid");
}

/** Write sensitive upstream diagnostics to the terminal only, bypassing the persistent console tee. */
function debugToTerminal(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    /* a debug write must never crash serving */
  }
}

/** Tee console output to a size-rotated persistent log for post-exit diagnosis. */
function setupFileLogging(): void {
  mkdirSync(configDir(), { recursive: true });
  // Rotate once at startup so the active process writes a fresh bounded log.
  try {
    const existing = serveLogPath();
    if (existsSync(existing) && statSync(existing).size > LOG_ROTATE_BYTES) {
      const rotated = `${existing}.1`;
      if (existsSync(rotated)) unlinkSync(rotated);
      // Use rename via writeFileSync read-then-write fallback if needed;
      // direct fs.renameSync is the cleanest.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("fs").renameSync(existing, rotated);
    }
  } catch {
    /* rotation failure is non-fatal — just keep appending */
  }
  logStream = createWriteStream(serveLogPath(), { flags: "a", mode: 0o600 });

  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  const writeFile = (level: string, args: unknown[]): void => {
    if (!logStream) return;
    try {
      const ts = new Date().toISOString();
      const msg = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      logStream.write(`[${ts}] [${level}] ${msg}\n`);
    } catch {
      /* don't let a log failure crash the process */
    }
  };
  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeFile("info", args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    writeFile("error", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeFile("warn", args);
  };

  // Bookmark each serve session so operators can scan for "when did this
  // process start" without inferring it from line gaps.
  console.log(
    `── serve session start ── pid=${process.pid} node=${process.versions.node}`
  );
}

/** Maintain the serve PID file; doctor validates stale entries with `process.kill(pid, 0)`. */
function writePidFile(): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(pidFilePath(), `${process.pid}\n`, { mode: 0o600 });
  const cleanup = (): void => {
    try {
      // A self-reexec child may already have replaced the pid file. Never let
      // the exiting parent delete a newer process's ownership marker.
      if (require("fs").readFileSync(pidFilePath(), "utf8").trim() === String(process.pid)) {
        unlinkSync(pidFilePath());
      }
    } catch {
      /* already gone */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function logError(label: string, err: unknown): void {
  console.error(`  ✖ ${label}:`, err instanceof Error ? err.message : String(err));
}

export { abbrevAddr };

async function postEvent(cfg: HaloConfig, ev: EventPayload & { signature: string }): Promise<void> {
  const url = `${cfg.indexerUrl.replace(/\/+$/, "")}/v1/events`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ev),
  });
}

async function startHeartbeat(
  cfg: HaloConfig,
  wallet: import("ethers").Wallet | import("ethers").HDNodeWallet
): Promise<void> {
  const url = `${cfg.indexerUrl.replace(/\/+$/, "")}/heartbeat`;
  while (true) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = "0x" + randomBytes(32).toString("hex");
    const msg = `halo-heartbeat:${cfg.operator.address.toLowerCase()}:${ts}:${nonce}`;
    const signature = await wallet.signMessage(msg);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: cfg.operator.address, ts, nonce, signature }),
      });
    } catch {
      /* network flake — next tick */
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
