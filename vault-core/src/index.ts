import { getBytes, keccak256, parseUnits, type TypedDataDomain } from "ethers";
import {
  EIP712_NAME,
  EIP712_VERSION,
  VAULT_ADDRESS,
} from "./consensus.generated.js";

export * from "./consensus.generated.js";

export const VAULT_ABI = [
  "function deposit(uint256 amount, address sessionKey)",
  "function requestWithdraw()",
  "function withdraw(uint256 amount)",
  "function balance(address) view returns (uint256)",
  "function lockedTotal(address) view returns (uint256)",
  "function withdrawable(address) view returns (uint256)",
  "function sessionKey(address) view returns (address)",
  "function reserveNonce(address) view returns (uint256)",
  "function keyEpoch(address) view returns (uint256)",
  "function withdrawRequestedAt(address) view returns (uint64)",
  "function withdrawAuthorized(address) view returns (uint256)",
  "function withdrawTimelock() view returns (uint64)",
  "function redeemGrace() view returns (uint64)",
  "function maxReserveTtl() view returns (uint64)",
  "function ops(address,address) view returns (uint256 locked,uint256 redeemed,uint64 expiry,uint64 created,uint64 cycle)",
];

export const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/** Build the HaloVault EIP-712 domain for the vault being targeted. */
export function vaultDomain(
  chainId: number | bigint,
  verifyingContract: string = VAULT_ADDRESS
): TypedDataDomain {
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId,
    verifyingContract,
  };
}

/** Format six-decimal USDC base units for display. */
export function formatUsdcBase(
  base: bigint,
  opts: { withDollarSign?: boolean } = {}
): string {
  const formatted = (Number(base) / 1_000_000).toFixed(4);
  return opts.withDollarSign ? `$${formatted}` : formatted;
}

export interface OpsState {
  locked: bigint;
  redeemed: bigint;
  expiry: bigint;
  created: bigint;
  cycle: bigint;
}

export interface VaultState {
  balance: bigint;
  lockedTotal: bigint;
  withdrawable: bigint;
  sessionKey: string;
  reserveNonce: bigint;
  keyEpoch: bigint;
}

export interface VaultRedeemRequest {
  consumer: string;
  operator: string;
  cumulative: string;
  cycle: string;
  signature: string;
}

export type VaultRedeemRejectedReason =
  | "invalid-request"
  | "cycle-mismatch"
  | "invalid-receipt"
  | "unavailable";

export type VaultRedeemResponse =
  | {
      status: "rejected";
      reason: VaultRedeemRejectedReason;
      error: string;
    }
  | {
      status: "pending";
      transaction: string;
      cumulative: string;
      cycle: string;
      coalesced: boolean;
    }
  | {
      status: "already-redeemed";
      redeemed: string;
      cycle: string;
    }
  | {
      status: "confirmed";
      transaction: string;
      cumulative: string;
      cycle: string;
    }
  | {
      status: "reverted";
      transaction: string;
      cumulative: string;
      cycle: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUintString(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  if (value.length > 78) return false;
  return BigInt(value) <= (1n << 256n) - 1n;
}

function isTransactionHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Parse the facilitator's cycle-aware redeem response without trusting JSON shape. */
export function parseVaultRedeemResponse(value: unknown): VaultRedeemResponse | null {
  if (!isRecord(value) || typeof value.status !== "string") return null;
  switch (value.status) {
    case "rejected": {
      const reasons: readonly VaultRedeemRejectedReason[] = [
        "invalid-request",
        "cycle-mismatch",
        "invalid-receipt",
        "unavailable",
      ];
      if (
        typeof value.reason !== "string" ||
        !reasons.includes(value.reason as VaultRedeemRejectedReason) ||
        typeof value.error !== "string" ||
        value.error.length === 0
      ) {
        return null;
      }
      return {
        status: "rejected",
        reason: value.reason as VaultRedeemRejectedReason,
        error: value.error,
      };
    }
    case "pending":
      return isTransactionHash(value.transaction) &&
        isUintString(value.cumulative) &&
        isUintString(value.cycle) &&
        typeof value.coalesced === "boolean"
        ? {
            status: "pending",
            transaction: value.transaction,
            cumulative: value.cumulative,
            cycle: value.cycle,
            coalesced: value.coalesced,
          }
        : null;
    case "already-redeemed":
      return isUintString(value.redeemed) && isUintString(value.cycle)
        ? { status: "already-redeemed", redeemed: value.redeemed, cycle: value.cycle }
        : null;
    case "confirmed":
    case "reverted":
      return isTransactionHash(value.transaction) &&
        isUintString(value.cumulative) &&
        isUintString(value.cycle)
        ? {
            status: value.status,
            transaction: value.transaction,
            cumulative: value.cumulative,
            cycle: value.cycle,
          }
        : null;
    default:
      return null;
  }
}

export type VaultRedeemDisposition = "collected" | "retry" | "uncollectable";

/** Decide whether a client keeps or clears its signed receipt after a typed response. */
export function vaultRedeemDisposition(
  response: VaultRedeemResponse,
  expected?: Pick<VaultRedeemRequest, "cumulative" | "cycle">
): VaultRedeemDisposition {
  switch (response.status) {
    case "confirmed": {
      const matches =
        !expected ||
        (isUintString(expected.cumulative) &&
          response.cycle === expected.cycle &&
          BigInt(response.cumulative) >= BigInt(expected.cumulative));
      return matches ? "collected" : "retry";
    }
    case "already-redeemed": {
      const matches =
        !expected ||
        (isUintString(expected.cumulative) &&
          response.cycle === expected.cycle &&
          BigInt(response.redeemed) >= BigInt(expected.cumulative));
      return matches ? "collected" : "retry";
    }
    case "pending":
    case "reverted":
      return "retry";
    case "rejected":
      return response.reason === "cycle-mismatch" || response.reason === "invalid-receipt"
        ? "uncollectable"
        : "retry";
  }
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Relationship between the registered session key and the intended signer. */
export type SessionKeyStatus = "unregistered" | "match" | "mismatch";

/** Compare a registered session key with the signer, case-insensitively. */
export function classifySessionKey(
  registered: string,
  expected: string
): SessionKeyStatus {
  const r = (registered || "").toLowerCase();
  const e = (expected || "").toLowerCase();
  if (r === "" || r === ZERO_ADDRESS) return "unregistered";
  return r === e ? "match" : "mismatch";
}

/** Changing these bytes changes every derived address and requires migration. */
export const SUBKEY_DERIVATION_MESSAGE =
  "Halo — create in-browser agent sub-wallet (v2).\n" +
  "Signing derives a wallet the agent uses to pay for tools autonomously.\n" +
  "The agent can ONLY spend USDC you load into this sub-wallet.";

/** Exact message signed to derive an owner's session sub-wallet. */
export function subKeyDerivationMessage(owner: string): string {
  return `${SUBKEY_DERIVATION_MESSAGE}\n${owner.toLowerCase()}`;
}

/** Derive the deterministic session private key from the owner's signature. */
export function deriveSubKeyPrivateKey(signature: string): string {
  return keccak256(getBytes(signature));
}

export const PRICE_DP = 12;
export const RESERVATION_PRICE_MARGIN_BPS = 2_000n;
/** Maximum stripped source image accepted by image-edit consumers. */
export const IMAGE_EDIT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** Maximum serialized image-edit relay body. */
export const IMAGE_EDIT_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Maximum UTF-8 edit prompt size accepted by the v1 encrypted schema. */
export const IMAGE_EDIT_MAX_PROMPT_BYTES = 32 * 1024;
/** Maximum requested outputs in one v1 edit. */
export const IMAGE_EDIT_MAX_OUTPUT_IMAGES = 10;

export const IMAGE_EDIT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ImageEditMimeType = (typeof IMAGE_EDIT_MIME_TYPES)[number];

export interface ImageEditPlaintextV1 {
  prompt: string;
  n: number;
  image: {
    mime: ImageEditMimeType;
    b64_json: string;
  };
}

export type ImageEditPlaintextErrorCode =
  | "invalid_utf8"
  | "invalid_json"
  | "invalid_schema"
  | "invalid_prompt"
  | "invalid_image_count"
  | "invalid_image_mime"
  | "invalid_image_base64"
  | "image_too_large";

export class ImageEditPlaintextError extends Error {
  readonly code: ImageEditPlaintextErrorCode;

  constructor(code: ImageEditPlaintextErrorCode, message: string) {
    super(message);
    this.name = "ImageEditPlaintextError";
    this.code = code;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Return decoded bytes only for canonical padded RFC 4648 base64. */
export function canonicalBase64DecodedLength(value: string): number | null {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    /[\r\n]/.test(value) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  if (dataLength === 0) return null;

  // Reject non-zero unused bits so one byte string has one canonical spelling.
  if (padding === 2) {
    const sextet = BASE64_ALPHABET.indexOf(value[dataLength - 1]);
    if (sextet < 0 || (sextet & 0x0f) !== 0) return null;
  } else if (padding === 1) {
    const sextet = BASE64_ALPHABET.indexOf(value[dataLength - 1]);
    if (sextet < 0 || (sextet & 0x03) !== 0) return null;
  }
  return (value.length / 4) * 3 - padding;
}

/** Validate the exact, one-source-image v1 edit plaintext object. */
export function validateImageEditPlaintext(value: unknown): ImageEditPlaintextV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["prompt", "n", "image"])) {
    throw new ImageEditPlaintextError(
      "invalid_schema",
      "image edit plaintext must contain exactly prompt, n, and image"
    );
  }
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) {
    throw new ImageEditPlaintextError("invalid_prompt", "image edit prompt must be non-empty");
  }
  if (new TextEncoder().encode(value.prompt).length > IMAGE_EDIT_MAX_PROMPT_BYTES) {
    throw new ImageEditPlaintextError(
      "invalid_prompt",
      `image edit prompt exceeds ${IMAGE_EDIT_MAX_PROMPT_BYTES} UTF-8 bytes`
    );
  }
  if (
    typeof value.n !== "number" ||
    !Number.isInteger(value.n) ||
    value.n < 1 ||
    value.n > IMAGE_EDIT_MAX_OUTPUT_IMAGES
  ) {
    throw new ImageEditPlaintextError(
      "invalid_image_count",
      `image edit n must be an integer from 1 to ${IMAGE_EDIT_MAX_OUTPUT_IMAGES}`
    );
  }
  if (!isRecord(value.image) || !hasExactKeys(value.image, ["mime", "b64_json"])) {
    throw new ImageEditPlaintextError(
      "invalid_schema",
      "image edit image must contain exactly mime and b64_json"
    );
  }
  if (
    typeof value.image.mime !== "string" ||
    !(IMAGE_EDIT_MIME_TYPES as readonly string[]).includes(value.image.mime)
  ) {
    throw new ImageEditPlaintextError(
      "invalid_image_mime",
      `image edit mime must be one of ${IMAGE_EDIT_MIME_TYPES.join(", ")}`
    );
  }
  if (typeof value.image.b64_json !== "string") {
    throw new ImageEditPlaintextError(
      "invalid_image_base64",
      "image edit b64_json must be canonical padded base64"
    );
  }
  const decodedLength = canonicalBase64DecodedLength(value.image.b64_json);
  if (decodedLength === null) {
    throw new ImageEditPlaintextError(
      "invalid_image_base64",
      "image edit b64_json must be canonical padded base64"
    );
  }
  if (decodedLength > IMAGE_EDIT_MAX_INPUT_BYTES) {
    throw new ImageEditPlaintextError(
      "image_too_large",
      `image edit source exceeds ${IMAGE_EDIT_MAX_INPUT_BYTES} decoded bytes`
    );
  }
  return {
    prompt: value.prompt,
    n: value.n,
    image: {
      mime: value.image.mime as ImageEditMimeType,
      b64_json: value.image.b64_json,
    },
  };
}

/** Decode strict UTF-8 JSON and validate the v1 edit plaintext. */
export function parseImageEditPlaintext(bytes: Uint8Array): ImageEditPlaintextV1 {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImageEditPlaintextError("invalid_utf8", "image edit plaintext is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImageEditPlaintextError("invalid_json", "image edit plaintext is not valid JSON");
  }
  return validateImageEditPlaintext(parsed);
}

/** Validate and encode the canonical v1 edit plaintext for v2 encryption. */
export function serializeImageEditPlaintext(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(validateImageEditPlaintext(value)));
}

/** USD-per-1M-tokens to USDC base-unit cost, rounded up. */
export function priceTokens(usdPerMtok: number, tokens: number): bigint {
  if (!Number.isFinite(usdPerMtok) || usdPerMtok < 0) {
    throw new Error(`priceTokens: price must be a finite non-negative number (got ${usdPerMtok})`);
  }
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`priceTokens: tokens must be a finite non-negative number (got ${tokens})`);
  }
  const priceBase = parseUnits(usdPerMtok.toFixed(PRICE_DP), PRICE_DP);
  if (usdPerMtok > 0 && priceBase === 0n) {
    throw new Error(
      `priceTokens: price ${usdPerMtok} USD/Mtok is positive but rounds to 0 at ${PRICE_DP} decimals — refusing to serve unpriced`
    );
  }
  const microUsd = BigInt(Math.max(0, Math.ceil(tokens))) * priceBase;
  const denom = 10n ** BigInt(PRICE_DP);
  return (microUsd + denom - 1n) / denom;
}

/** USD per image to USDC base-unit cost, rounded up. */
export function priceImages(usdcPerImage: number, imageCount: number): bigint {
  if (!Number.isFinite(usdcPerImage) || usdcPerImage < 0) {
    throw new Error(`priceImages: price must be a finite non-negative number (got ${usdcPerImage})`);
  }
  if (!Number.isFinite(imageCount) || imageCount < 0) {
    throw new Error(`priceImages: count must be a finite non-negative number (got ${imageCount})`);
  }
  const priceBase = parseUnits(usdcPerImage.toFixed(PRICE_DP), PRICE_DP);
  if (usdcPerImage > 0 && priceBase === 0n) {
    throw new Error(
      `priceImages: price ${usdcPerImage} USDC/image is positive but rounds to 0 at ${PRICE_DP} decimals — refusing to serve unpriced`
    );
  }
  const scaledUsd = BigInt(Math.max(0, Math.ceil(imageCount))) * priceBase;
  const denom = 10n ** BigInt(PRICE_DP - 6);
  return (scaledUsd + denom - 1n) / denom;
}

/** Add reservation headroom, rounding up to whole base units. */
export function withReservationMargin(
  estimatedCost: bigint,
  marginBps: bigint = RESERVATION_PRICE_MARGIN_BPS
): bigint {
  if (estimatedCost < 0n || marginBps < 0n) {
    throw new Error("withReservationMargin: cost and margin must be non-negative");
  }
  if (estimatedCost === 0n || marginBps === 0n) return estimatedCost;
  const bps = 10_000n;
  return (estimatedCost * (bps + marginBps) + bps - 1n) / bps;
}

/** Classify reservation revival; `capSafetyMarginSec` reserves mining time. */
export function classifyReservationRevival(
  ops: { locked: bigint; expiry: bigint; created: bigint },
  maxReserveTtl: bigint,
  redeemGrace: bigint,
  nowSec: bigint,
  capSafetyMarginSec: bigint = 0n
): "live_or_revivable" | "serve_as_is" | "reclaimable" | "wedged" {
  if (ops.locked === 0n || ops.expiry === 0n) return "live_or_revivable";
  if (ops.created + maxReserveTtl > nowSec + capSafetyMarginSec) return "live_or_revivable";
  if (nowSec < ops.expiry) return "serve_as_is";
  if (nowSec > ops.expiry + redeemGrace) return "reclaimable";
  return "wedged";
}

/** Parse a positive reservation requirement from a typed 402 error. */
export function requiredVaultReservationBase(payload: unknown): bigint | null {
  let decoded = payload;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  if (!decoded || typeof decoded !== "object") return null;
  const error = (decoded as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const value = error as { type?: unknown; requiredUsdcBase?: unknown };
  if (
    value.type !== "vault_reservation_insufficient" ||
    typeof value.requiredUsdcBase !== "string" ||
    !/^\d+$/.test(value.requiredUsdcBase)
  ) {
    return null;
  }
  const required = BigInt(value.requiredUsdcBase);
  return required > 0n ? required : null;
}

/** OpenAI's published per-message overhead: role + delimiter tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Conservative image-token fallback for an unrecognized or omitted model. */
export const IMAGE_PROMPT_TOKENS = 1600;

/** Legacy low-detail fallback retained for callers that cannot supply a model. */
export const LOW_DETAIL_IMAGE_PROMPT_TOKENS = 85;

const OPENAI_HIGH_DETAIL_MAX_TILES = 8;
const OPENAI_HIGH_DETAIL_PATCH_BUDGET = 1536;
const OPENAI_LOW_DETAIL_PATCH_BUDGET = 256;
const CLAUDE_STANDARD_IMAGE_TOKEN_CAP = 1568;
const CLAUDE_HIGH_RES_IMAGE_TOKEN_CAP = 4784;

type ImageTokenProfile =
  | { kind: "tiles"; base: number; perTile: number }
  | { kind: "patches"; multiplier: number }
  | { kind: "cap"; tokens: number };

function modelLeaf(model: string): string {
  const leaf = (model || "").trim().toLowerCase().split("/").pop() ?? "";
  return leaf.split(":", 1)[0];
}

function isModelFamily(model: string, family: string): boolean {
  return (
    model === family ||
    (model.startsWith(family) && /^-\d{4}-\d{2}-\d{2}$/.test(model.slice(family.length)))
  );
}

function imageTokenProfile(model: string): ImageTokenProfile | null {
  const m = modelLeaf(model);
  if (isModelFamily(m, "gpt-5.4-mini") || isModelFamily(m, "gpt-5-mini")) {
    return { kind: "patches", multiplier: 1.62 };
  }
  if (isModelFamily(m, "gpt-5.4-nano") || isModelFamily(m, "gpt-5-nano")) {
    return { kind: "patches", multiplier: 2.46 };
  }
  if (isModelFamily(m, "gpt-4.1-mini")) return { kind: "patches", multiplier: 1.62 };
  if (isModelFamily(m, "gpt-4.1-nano")) return { kind: "patches", multiplier: 2.46 };
  if (isModelFamily(m, "o4-mini")) return { kind: "patches", multiplier: 1.72 };
  if (isModelFamily(m, "gpt-4o-mini")) {
    return { kind: "tiles", base: 2833, perTile: 5667 };
  }
  if (isModelFamily(m, "gpt-5") || m === "gpt-5-chat-latest") {
    return { kind: "tiles", base: 70, perTile: 140 };
  }
  if (
    isModelFamily(m, "gpt-4o") ||
    isModelFamily(m, "gpt-4.1") ||
    isModelFamily(m, "gpt-4.5")
  ) {
    return { kind: "tiles", base: 85, perTile: 170 };
  }
  if (isModelFamily(m, "o1") || isModelFamily(m, "o1-pro") || isModelFamily(m, "o3")) {
    return { kind: "tiles", base: 75, perTile: 150 };
  }
  if (isModelFamily(m, "computer-use-preview")) {
    return { kind: "tiles", base: 65, perTile: 129 };
  }
  if (
    isModelFamily(m, "claude-fable-5") ||
    isModelFamily(m, "claude-mythos-5") ||
    isModelFamily(m, "claude-opus-4-8") ||
    isModelFamily(m, "claude-opus-4.8") ||
    isModelFamily(m, "claude-opus-4-7") ||
    isModelFamily(m, "claude-opus-4.7") ||
    isModelFamily(m, "claude-sonnet-5")
  ) {
    return { kind: "cap", tokens: CLAUDE_HIGH_RES_IMAGE_TOKEN_CAP };
  }
  if (m.startsWith("claude-")) {
    return { kind: "cap", tokens: CLAUDE_STANDARD_IMAGE_TOKEN_CAP };
  }
  return null;
}

/** Conservative image tokens for a model/detail pair when image dimensions are unavailable. */
export function estimateImagePromptTokens(model: string, detail?: unknown): number {
  const profile = imageTokenProfile(model);
  if (!profile) {
    if ((model || "").trim()) return IMAGE_PROMPT_TOKENS;
    return detail === "low" ? LOW_DETAIL_IMAGE_PROMPT_TOKENS : IMAGE_PROMPT_TOKENS;
  }
  if (profile.kind === "cap") {
    return Math.max(IMAGE_PROMPT_TOKENS, profile.tokens);
  }
  if (profile.kind === "tiles") {
    if (detail === "low") return profile.base;
    return Math.max(
      IMAGE_PROMPT_TOKENS,
      profile.base + OPENAI_HIGH_DETAIL_MAX_TILES * profile.perTile
    );
  }
  const patchBudget =
    detail === "low" ? OPENAI_LOW_DETAIL_PATCH_BUDGET : OPENAI_HIGH_DETAIL_PATCH_BUDGET;
  const fallback = detail === "low" ? LOW_DETAIL_IMAGE_PROMPT_TOKENS : IMAGE_PROMPT_TOKENS;
  return Math.max(fallback, Math.ceil(patchBudget * profile.multiplier));
}

/** Max nesting depth walked for tool-result-wrapped content (cycle/DoS guard). */
const IMAGE_NESTING_MAX_DEPTH = 6;

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  return (
    p.type === "image_url" ||
    p.type === "image" ||
    p.type === "input_image" ||
    p.type === "output_image" ||
    "image_url" in p ||
    "image" in p
  );
}

/** Best-effort serialized char length of a content part; 0 for non-JSON input. */
function partCharLength(part: unknown): number {
  try {
    const s = JSON.stringify(part);
    return typeof s === "string" ? s.length : 0;
  } catch {
    return 0; // cyclic / BigInt / non-serializable — untrusted input, never throw
  }
}

/** Bounded token estimate for an image part under the request's model. */
function imagePartTokens(part: unknown, model: string): number {
  const p = part as { image_url?: unknown; detail?: unknown };
  const iu = p.image_url;
  const detail =
    (iu && typeof iu === "object" ? (iu as { detail?: unknown }).detail : undefined) ?? p.detail;
  return estimateImagePromptTokens(model, detail);
}

/** Walk message content (recursing into nested tool-result content) into text chars + image tokens. */
function accumulateContent(
  content: unknown,
  depth: number,
  acc: { chars: number; imageTokens: number },
  model: string
): void {
  if (typeof content === "string") {
    acc.chars += content.length;
    return;
  }
  if (!Array.isArray(content) || depth >= IMAGE_NESTING_MAX_DEPTH) return;
  for (const part of content) {
    if (isImagePart(part)) {
      acc.imageTokens += imagePartTokens(part, model);
    } else if (
      part &&
      typeof part === "object" &&
      Array.isArray((part as { content?: unknown }).content)
    ) {
      // Nested content (e.g. Anthropic tool_result wrapping an image) — recurse so a
      // nested image is bounded, not char-counted via its serialized base64.
      accumulateContent((part as { content?: unknown }).content, depth + 1, acc, model);
    } else {
      acc.chars += partCharLength(part);
    }
  }
}

/** Shared prompt-token estimate for the consumer reserve and the operator gate (invariant #7). */
export function estimatePromptTokens(messages: unknown, model = ""): number {
  if (!Array.isArray(messages)) return 0;
  const acc = { chars: 0, imageTokens: 0 };
  for (const message of messages) {
    if (message && typeof message === "object") {
      const m = message as Record<string, unknown>;
      accumulateContent(m.content, 0, acc, model);
      if (m.tool_calls !== undefined) acc.chars += partCharLength(m.tool_calls);
      if (m.function_call !== undefined) acc.chars += partCharLength(m.function_call);
      if (typeof m.tool_call_id === "string") acc.chars += m.tool_call_id.length;
    }
  }
  return Math.ceil(acc.chars / 4) + acc.imageTokens + messages.length * MESSAGE_OVERHEAD_TOKENS;
}

export function estimateTokens(messages: unknown, maxTokens: number): number {
  return estimatePromptTokens(messages) + maxTokens;
}

/** Prompt tokens for a full chat request: messages (incl. tool-call fields) + forwarded tool/function schemas. */
export function estimateRequestPromptTokens(body: unknown): number {
  if (Array.isArray(body)) return estimatePromptTokens(body); // tolerate a bare messages array
  if (!body || typeof body !== "object") return 0;
  const b = body as { model?: unknown; messages?: unknown; tools?: unknown; functions?: unknown };
  const model = typeof b.model === "string" ? b.model : "";
  let tokens = estimatePromptTokens(b.messages, model);
  if (b.tools !== undefined) tokens += Math.ceil(partCharLength(b.tools) / 4);
  if (b.functions !== undefined) tokens += Math.ceil(partCharLength(b.functions) / 4);
  return tokens;
}

/** Heuristically detect model families that reason by default. */
export function isReasoningModel(model: string): boolean {
  const m = (model || "").toLowerCase();
  if (!m) return false;
  return (
    /(^|[/:._-])o[1-9]\d*([._:\-]|$)/.test(m) ||
    m.includes("gpt-5") ||
    m.includes("gemini-2.5") ||
    m.includes("grok-4") ||
    m.includes("grok-3-mini") ||
    m.includes("reasoner") ||
    m.includes("reasoning") ||
    m.includes("deepseek-r") ||
    m.includes("magistral") ||
    m.includes("qwq") ||
    /glm-(4\.[5-9]|[5-9])/.test(m) || // Zhipu GLM-4.5+/5 hybrid-reasoning (thinking on by default); excludes glm-4 / glm-4.1
    (/minimax-m\d/.test(m) && !m.includes("-her")) || // MiniMax M-series (M1/M2/M3) reasoning-first; excludes minimax-text-01 and the M2-her dialogue variant
    m.includes("thinking")
  );
}

/** Shared minimum completion ceiling for models that reason by default. */
export const REASONING_COMPLETION_FLOOR = 8192;

/** Completion ceiling used when a request supplies neither valid limit field. */
export const DEFAULT_COMPLETION_CEILING_TOKENS = 1024;

/** Size a completion ceiling without changing the upstream request limit. */
export function completionCeilingTokens(
  model: string,
  maxTokens: number,
  maxCompletionTokens?: number
): number {
  const budget = Math.max(
    Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0,
    typeof maxCompletionTokens === "number" &&
      Number.isFinite(maxCompletionTokens) &&
      maxCompletionTokens > 0
      ? Math.floor(maxCompletionTokens)
      : 0
  );
  if (!isReasoningModel(model)) return budget;
  return Math.max(budget, REASONING_COMPLETION_FLOOR);
}

function validCompletionLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const tokens = Math.floor(value);
  return tokens > 0 ? tokens : undefined;
}

/** Derive the shared reserve/gate completion ceiling from a full request body. */
export function requestCompletionCeilingTokens(body: unknown): number {
  const b =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as {
          model?: unknown;
          max_tokens?: unknown;
          max_completion_tokens?: unknown;
        })
      : {};
  const model = typeof b.model === "string" ? b.model : "";
  const maxTokens = validCompletionLimit(b.max_tokens);
  const maxCompletionTokens = validCompletionLimit(b.max_completion_tokens);
  return completionCeilingTokens(
    model,
    maxTokens ?? (maxCompletionTokens === undefined ? DEFAULT_COMPLETION_CEILING_TOKENS : 0),
    maxCompletionTokens
  );
}

/** Consumer reservation token count: full request prompt + reasoning-aware completion ceiling (invariant #7). */
export function estimateReservationTokens(body: unknown): number {
  if (!body || typeof body !== "object") return 0;
  return estimateRequestPromptTokens(body) + requestCompletionCeilingTokens(body);
}

export interface ComputeReserveAmountParams {
  estCost: bigint;
  locked: bigint;
  withdrawable: bigint;
  reserveMultiple: bigint;
  liquiditySlots: bigint;
  live: boolean;
}

export function computeReserveAmount(p: ComputeReserveAmountParams): bigint {
  const target = p.estCost * p.reserveMultiple;
  let amount = target > p.locked ? target - p.locked : 0n;
  const needed = p.locked >= p.estCost ? 0n : p.estCost - p.locked;
  const cap = p.liquiditySlots > 0n ? p.withdrawable / p.liquiditySlots : p.withdrawable;
  if (amount > cap) amount = cap;
  if (amount < needed) amount = needed;
  if (amount > p.withdrawable) amount = p.withdrawable;
  if (amount === 0n && !p.live && p.withdrawable > 0n) amount = 1n;
  return amount;
}

export interface AdvanceCumulativeReceiptParams {
  previous: bigint;
  cost: bigint;
  locked: bigint;
  redeemed: bigint;
  priorCeiling?: bigint;
}

/** Advance a cumulative receipt without exceeding its observed cycle ceiling. */
export function advanceCumulativeReceipt(
  p: AdvanceCumulativeReceiptParams
): { cumulative: bigint; ceiling: bigint } {
  if (p.previous < 0n || p.cost < 0n || p.locked < 0n || p.redeemed < 0n) {
    throw new Error("advanceCumulativeReceipt: amounts must be non-negative");
  }
  const observed = p.locked + p.redeemed;
  let ceiling = p.priorCeiling ?? 0n;
  if (observed > ceiling) ceiling = observed;
  if (p.previous > ceiling) ceiling = p.previous;
  const next = p.previous + p.cost;
  return { cumulative: next > ceiling ? ceiling : next, ceiling };
}

export type RedeemErrorClass = "collected" | "uncollectable" | "transient";

export function classifyRedeemError(error: string): RedeemErrorClass {
  if (/StaleReceipt|ExceedsReservation|already\s+(redeemed|collected|settled)/i.test(error))
    return "collected";
  // A receipt from a superseded cycle can never redeem.
  if (/BadSignature|NoSessionKey|does not recover|superseded/i.test(error))
    return "uncollectable";
  return "transient";
}

export function matchesModel(advertised: string, requested: string): boolean {
  if (advertised === "" || requested === "") return advertised === requested;
  return (
    advertised === requested ||
    advertised.includes(requested) ||
    requested.includes(advertised)
  );
}

export function resolveModelPriceUsdPerMtok(
  models: string[],
  pricing: Record<string, number> | undefined,
  requested: string
): number | null {
  const exact = pricing?.[requested];
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0) return exact * 1000;
  const match = models.find(
    (model) =>
      matchesModel(model, requested) &&
      typeof pricing?.[model] === "number" &&
      Number.isFinite(pricing[model]) &&
      pricing[model] >= 0
  );
  return match && pricing ? pricing[match] * 1000 : null;
}

export function resolveImagePriceUsdc(
  imageModels: string[] | undefined,
  imagePricing: Record<string, number> | undefined,
  requested: string
): number | null {
  const exact = imagePricing?.[requested];
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0) return exact;
  const match = (imageModels ?? []).find(
    (model) =>
      matchesModel(model, requested) &&
      typeof imagePricing?.[model] === "number" &&
      Number.isFinite(imagePricing[model]) &&
      imagePricing[model] >= 0
  );
  return match && imagePricing ? imagePricing[match] : null;
}

export interface VaultOperatorAdvertisement {
  address: string;
  models: string[];
  pricing?: Record<string, number>;
  imageModels?: string[];
  imageEditModels?: string[];
  imagePricing?: Record<string, number>;
  tee?: boolean;
  teeModels?: string[];
  vaultPayments?: boolean;
  encryptionPubkey?: string | null;
}

export interface VaultOperatorCandidate<T extends VaultOperatorAdvertisement> {
  operator: T;
  priceUsdPerMtok: number;
}

export interface VaultImageOperatorCandidate<T extends VaultOperatorAdvertisement> {
  operator: T;
  priceUsdcPerImage: number;
}

export type VaultOperatorSelectionReason =
  | "selected"
  | "no_operator"
  | "no_vault_operator"
  | "no_tee_operator"
  | "unpriced"
  | "free_model"
  | "out_of_range"
  | "pinned_not_found"
  | "pinned_not_vault_capable"
  | "pinned_not_tee_capable"
  | "pinned_unpriced"
  | "pinned_free_model"
  | "pinned_out_of_range";

export interface VaultOperatorSelection<T extends VaultOperatorAdvertisement> {
  selected: VaultOperatorCandidate<T> | null;
  candidates: Array<VaultOperatorCandidate<T>>;
  reason: VaultOperatorSelectionReason;
}

export interface VaultImageOperatorSelection<T extends VaultOperatorAdvertisement> {
  selected: VaultImageOperatorCandidate<T> | null;
  candidates: Array<VaultImageOperatorCandidate<T>>;
  reason: VaultOperatorSelectionReason;
}

/** Select a positively priced, vault-capable operator and retain failure detail. */
export function selectVaultOperatorFromList<T extends VaultOperatorAdvertisement>(
  operators: T[],
  model: string,
  opts: {
    teeOnly?: boolean;
    maxPriceUsdPerMtok?: number;
    requireAddress?: string;
    randomizeCheapestTies?: boolean;
  } = {}
): VaultOperatorSelection<T> {
  const teeOnly = opts.teeOnly === true;
  const want = opts.requireAddress?.toLowerCase();
  const addressPool = want
    ? operators.filter((operator) => operator.address.toLowerCase() === want)
    : operators;
  if (want && addressPool.length === 0) {
    return { selected: null, candidates: [], reason: "pinned_not_found" };
  }

  const modelPool = addressPool.filter((operator) =>
    operator.models.some((advertised) => matchesModel(advertised, model))
  );
  if (modelPool.length === 0) {
    return { selected: null, candidates: [], reason: "no_operator" };
  }

  const vaultPool = modelPool.filter((operator) => operator.vaultPayments === true);
  if (vaultPool.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_not_vault_capable" : "no_vault_operator",
    };
  }

  const servesTee = (operator: T): boolean =>
    operator.teeModels !== undefined
      ? operator.teeModels.some((advertised) => matchesModel(advertised, model))
      : operator.tee === true;
  const capabilityPool = teeOnly ? vaultPool.filter(servesTee) : vaultPool;
  if (capabilityPool.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_not_tee_capable" : "no_tee_operator",
    };
  }

  const resolved = capabilityPool.map((operator) => ({
    operator,
    priceUsdPerMtok: resolveModelPriceUsdPerMtok(operator.models, operator.pricing, model),
  }));
  const positivelyPriced = resolved.filter(
    (candidate): candidate is VaultOperatorCandidate<T> =>
      candidate.priceUsdPerMtok !== null && candidate.priceUsdPerMtok > 0
  );
  if (positivelyPriced.length === 0) {
    const free = resolved.some((candidate) => candidate.priceUsdPerMtok === 0);
    return {
      selected: null,
      candidates: [],
      reason: free
        ? want
          ? "pinned_free_model"
          : "free_model"
        : want
          ? "pinned_unpriced"
          : "unpriced",
    };
  }

  const withinPrice = positivelyPriced
    .filter(
      (candidate) =>
        opts.maxPriceUsdPerMtok === undefined ||
        candidate.priceUsdPerMtok <= opts.maxPriceUsdPerMtok
    )
    .sort((a, b) => a.priceUsdPerMtok - b.priceUsdPerMtok);
  if (withinPrice.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_out_of_range" : "out_of_range",
    };
  }

  const best = withinPrice[0].priceUsdPerMtok;
  const cheapest = withinPrice.filter(
    (candidate) => candidate.priceUsdPerMtok <= best + 1e-9
  );
  const selected = opts.randomizeCheapestTies
    ? cheapest[Math.floor(Math.random() * cheapest.length)]
    : cheapest[0];
  return { selected, candidates: withinPrice, reason: "selected" };
}

/** Select an image-capable vault operator by exact imageModels match and, when requested, exact imageEditModels match. Missing positive image price is unselectable and never falls back to token pricing (invariant #7). */
export function selectVaultImageOperatorFromList<T extends VaultOperatorAdvertisement>(
  operators: T[],
  model: string,
  opts: {
    requireAddress?: string;
    randomizeCheapestTies?: boolean;
    requireEditCapability?: boolean;
  } = {}
): VaultImageOperatorSelection<T> {
  const want = opts.requireAddress?.toLowerCase();
  const addressPool = want
    ? operators.filter((operator) => operator.address.toLowerCase() === want)
    : operators;
  if (want && addressPool.length === 0) {
    return { selected: null, candidates: [], reason: "pinned_not_found" };
  }

  const modelPool = addressPool.filter(
    (operator) =>
      operator.imageModels?.includes(model) &&
      (!opts.requireEditCapability || operator.imageEditModels?.includes(model))
  );
  if (modelPool.length === 0) {
    return { selected: null, candidates: [], reason: "no_operator" };
  }

  const vaultPool = modelPool.filter((operator) => operator.vaultPayments === true);
  if (vaultPool.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_not_vault_capable" : "no_vault_operator",
    };
  }

  const resolved = vaultPool.map((operator) => ({
    operator,
    priceUsdcPerImage:
      typeof operator.imagePricing?.[model] === "number" &&
      Number.isFinite(operator.imagePricing[model]) &&
      operator.imagePricing[model] >= 0
        ? operator.imagePricing[model]
        : null,
  }));
  const positivelyPriced = resolved.filter(
    (candidate): candidate is VaultImageOperatorCandidate<T> =>
      candidate.priceUsdcPerImage !== null && candidate.priceUsdcPerImage > 0
  );
  if (positivelyPriced.length === 0) {
    const free = resolved.some((candidate) => candidate.priceUsdcPerImage === 0);
    return {
      selected: null,
      candidates: [],
      reason: free
        ? want
          ? "pinned_free_model"
          : "free_model"
        : want
          ? "pinned_unpriced"
          : "unpriced",
    };
  }

  const withinPrice = positivelyPriced.sort(
    (a, b) => a.priceUsdcPerImage - b.priceUsdcPerImage
  );
  const best = withinPrice[0].priceUsdcPerImage;
  const cheapest = withinPrice.filter(
    (candidate) => candidate.priceUsdcPerImage <= best + 1e-12
  );
  const selected = opts.randomizeCheapestTies
    ? cheapest[Math.floor(Math.random() * cheapest.length)]
    : cheapest[0];
  return { selected, candidates: withinPrice, reason: "selected" };
}

export function decodeBase64(value: string): string {
  const buffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from(input: string, encoding: "base64"): { toString(encoding: "utf-8"): string } };
    }
  ).Buffer;
  return buffer ? buffer.from(value, "base64").toString("utf-8") : atob(value);
}

export function settlementAmount(paymentResponse: string): bigint | null {
  try {
    const decoded = JSON.parse(decodeBase64(paymentResponse)) as { amountUsdc?: unknown };
    return typeof decoded.amountUsdc === "string" && /^\d+$/.test(decoded.amountUsdc)
      ? BigInt(decoded.amountUsdc)
      : null;
  } catch {
    return null;
  }
}

export interface SseDataFrame {
  event: string;
  data: string[];
}

export function parseSseDataFrames(body: string): SseDataFrame[] {
  const frames: SseDataFrame[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    frames.push({ event, data });
  }
  return frames;
}

export interface ParsedVaultSettlement {
  present: boolean;
  amount: bigint;
}

export function parseVaultSettlement(headers: Headers, body: string): ParsedVaultSettlement {
  const header = headers.get("PAYMENT-RESPONSE");
  if (header) {
    const amount = settlementAmount(header);
    if (amount !== null) return { present: true, amount };
  }
  // Content-Type is operator-controlled, so settlement discovery cannot trust it.
  for (const { event, data } of parseSseDataFrames(body)) {
    if (event !== "halo-settlement" || data.length === 0) continue;
    try {
      const envelope = JSON.parse(data.join("\n")) as { paymentResponse?: unknown };
      if (typeof envelope.paymentResponse !== "string") continue;
      const amount = settlementAmount(envelope.paymentResponse);
      if (amount !== null) return { present: true, amount };
    } catch {
      // Malformed frames do not invalidate a later settlement.
    }
  }
  return { present: false, amount: 0n };
}

export function reportedUsageTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const finite = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  const total = finite(value.total_tokens);
  if (total !== undefined) return total;
  const prompt = finite(value.prompt_tokens);
  const completion = finite(value.completion_tokens);
  return prompt !== undefined || completion !== undefined
    ? (prompt ?? 0) + (completion ?? 0)
    : undefined;
}

export function usageTokensFromSseBody(body: string): number | undefined {
  let tokens: number | undefined;
  for (const { data } of parseSseDataFrames(body)) {
    if (data.length === 0) continue;
    const payload = data.join("\n");
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { usage?: unknown };
      const reported = reportedUsageTokens(parsed.usage);
      if (reported !== undefined) tokens = reported;
    } catch {
      // Non-JSON frames may coexist with usage frames.
    }
  }
  return tokens;
}

/** Read reported usage from JSON or SSE without trusting Content-Type. */
export function usageTokensFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { usage?: unknown };
    const reported = reportedUsageTokens(parsed.usage);
    if (reported !== undefined) return reported;
  } catch {
    // The body may be SSE.
  }
  return usageTokensFromSseBody(body);
}

export interface VaultMeterResult {
  /** Base-unit amount to redeem for this response; 0n when unmeterable. */
  cost: bigint;
  /** The operator provided an explicit settlement (header or halo-settlement frame). */
  settled: boolean;
  /** Whether settlement or reported usage supplied the cost. */
  metered: boolean;
}

/** Prefer an explicit settlement, then reported usage; never estimate a charge. */
export function meterVaultResponse(
  headers: Headers,
  body: string,
  priceUsdPerMtok: number
): VaultMeterResult {
  const settlement = parseVaultSettlement(headers, body);
  if (settlement.present) return { cost: settlement.amount, settled: true, metered: true };
  const usageTokens = usageTokensFromBody(body);
  if (usageTokens !== undefined) {
    return { cost: priceTokens(priceUsdPerMtok, usageTokens), settled: false, metered: true };
  }
  return { cost: 0n, settled: false, metered: false };
}

/** Bound reserve-and-replay attempts when the operator ceiling advances. */
export const MAX_VAULT_RESERVATION_ATTEMPTS = 3;
