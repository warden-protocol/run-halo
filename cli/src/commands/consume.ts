import http from "node:http";
import prompts from "prompts";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { loadConfig, configDir, BASE_NETWORK, BASE_CHAIN_ID } from "../config";
import { loadWallet } from "../wallet";
import {
  generateEphemeralKeypair,
  encryptRequest,
  decryptResponse,
  decryptBytes,
  hexToPubkey,
  isEncryptedEnvelope,
  EncryptedEnvelope,
  BytesEncryptedEnvelope,
  EphemeralKeyPair,
  authenticatedOperatorPubkey,
} from "../encryption";
import {
  MediaChunkFrame,
  reassembleMediaEnvelope,
  trimPadding,
  unpackMediaPlaintext,
} from "../mediaChunks";
import {
  encryptToTee,
  decryptFromTee,
  newClientKey,
  fetchModelAttestation,
  verifyTeeSignature,
  verifiedSignerForModel,
} from "../confidential";
import { installProxyFromEnv } from "../proxy";
import {
  VaultConsumeClient,
  guardVaultFresh,
  priceTokens,
  resolveSessionSigner,
  fmtUsd as fmtVaultUsd,
  type OpsState,
  type SessionKeyMode,
} from "../vault-consume";
import {
  MAX_VAULT_RESERVATION_ATTEMPTS,
  RESERVATION_PRICE_MARGIN_BPS,
  estimateReservationTokens,
  meterVaultResponse,
  priceImages,
  requiredVaultReservationBase,
  selectVaultImageOperatorFromList,
  selectVaultOperatorFromList,
  settlementAmount,
  withReservationMargin,
  type VaultOperatorSelectionReason,
} from "@halo/vault-core";
import { setCliVersionHeader } from "../versionHeader";
import { restartIntoManagedInstall, startAutoUpdateMonitor } from "../update";
import { relayCliVersion } from "../relayVersion";
import { resolveVaultAddress } from "../vault-address";

interface Args {
  port?: number;
  /** Optional bearer token required on /v1/* requests. */
  apiKey?: string;
  /** Per-request spend ceiling in USD. Defaults to $0.10. */
  maxUsdc?: number;
  /** Override the keystore path (defaults to config.operator.keystorePath). */
  keystore?: string;
  /** Bind host. Defaults to 127.0.0.1 — do not expose publicly without auth. */
  host?: string;
  /** Encrypt to the reported TEE key and require the response signer to match. */
  confidential?: boolean;
  /** Base URL of the TEE provider's attestation/key endpoint (default NEAR). */
  teeBaseUrl?: string;
  /** Skip the full DCAP hardware attestation verification (Intel TDX + NVIDIA)
   *  on confidential requests — falls back to signature-only verification.
   *  Default false (hardware verification ON). For debugging only. */
  noAttestationVerify?: boolean;
  /** Disable operator end-to-end encryption on non-confidential requests (sends
   *  the prompt in plaintext through the relay). Default false — E2E is ON when
   *  the chosen operator advertises an encryption key. */
  noE2e?: boolean;
  /** Process-wide USD spend ceiling, runtime-updatable; zero is uncapped. */
  budgetUsdc?: number;
  /** Warn (response header) once cumulative spend reaches this fraction of the
   *  budget, so the agent can tell the user and offer to raise it. Default 0.8. */
  budgetWarnPct?: number;
  /** Vault USD top-up target; zero disables automatic deposits. */
  vaultDeposit?: number;
  /** Reservation batch size; each reservation is also capped by free balance. */
  vaultReserveMultiple?: number;
  /** Session signer: the CLI wallet or browser-compatible derived key. */
  sessionKey?: string;
  /** Self-daemonize: re-spawn the server detached (own session, reparented to
   *  init) and return immediately, so an agent/gateway that launches consume
   *  can't kill it on restart. Idempotent — no-ops if one's already serving. */
  detach?: boolean;
  /** Permit fund movement despite a confirmed pinned/live vault mismatch. */
  force?: boolean;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

interface VaultOperatorPin {
  address: string;
  priceUsdPerMtok: number;
  encryptionPubkey: string | null;
}

interface VaultOperatorSelectionResult {
  pin: VaultOperatorPin | null;
  reason: VaultOperatorSelectionReason;
}

/** Pick the cheapest vault-capable operator, optionally requiring TEE support; return `null` if none qualify. */
async function selectVaultOperator(
  relayBase: string,
  model: string,
  teeOnly: boolean,
  maxPriceUsdPerMtok?: number,
  requireAddress?: string
): Promise<VaultOperatorSelectionResult> {
  try {
    const url = `${relayBase}/v1/operators` + (teeOnly ? "?tee=1" : "");
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { pin: null, reason: "no_operator" };
    const { operators } = (await res.json()) as {
      operators: Array<{
        address: string;
        models: string[];
        encryptionPubkey?: string | null;
        pubkeyAttestation?: string | null;
        pricing?: Record<string, number>;
        tee?: boolean;
        teeModels?: string[];
        vaultPayments?: boolean;
      }>;
    };
    const selection = selectVaultOperatorFromList(operators, model, {
      teeOnly,
      maxPriceUsdPerMtok,
      requireAddress,
      randomizeCheapestTies: !requireAddress,
    });
    if (!selection.selected) return { pin: null, reason: selection.reason };
    const { operator, priceUsdPerMtok } = selection.selected;
    return {
      pin: {
        address: operator.address,
        priceUsdPerMtok,
        encryptionPubkey: authenticatedOperatorPubkey(
          operator.address,
          operator.encryptionPubkey,
          operator.pubkeyAttestation
        ),
      },
      reason: selection.reason,
    };
  } catch {
    return { pin: null, reason: "no_operator" };
  }
}

interface VaultImageOperatorPin {
  address: string;
  priceUsdcPerImage: number;
  encryptionPubkey: string | null;
}

interface VaultImageOperatorSelectionResult {
  pin: VaultImageOperatorPin | null;
  reason: VaultOperatorSelectionReason | "no_encrypted_operator";
}

/** Pick the cheapest vault-capable operator advertising `model` as an EXACT
 *  imageModels member with a positive per-image price (invariant #7 — never fuzzy
 *  matchesModel; a missing per-image unit fails selection, no token fallback). */
export async function selectVaultImageOperator(
  relayBase: string,
  model: string,
  requireAddress?: string
): Promise<VaultImageOperatorSelectionResult> {
  try {
    const res = await fetch(`${relayBase}/v1/operators`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { pin: null, reason: "no_operator" };
    const { operators } = (await res.json()) as {
      operators: Array<{
        address: string;
        models: string[];
        imageModels?: string[];
        imagePricing?: Record<string, number>;
        encryptionPubkey?: string | null;
        pubkeyAttestation?: string | null;
        vaultPayments?: boolean;
      }>;
    };
    const authenticated = operators.flatMap((operator) => {
      const encryptionPubkey = authenticatedOperatorPubkey(
        operator.address,
        operator.encryptionPubkey,
        operator.pubkeyAttestation
      );
      return encryptionPubkey ? [{ ...operator, authenticatedEncryptionPubkey: encryptionPubkey }] : [];
    });
    const selection = selectVaultImageOperatorFromList(authenticated, model, {
      requireAddress,
      randomizeCheapestTies: !requireAddress,
    });
    if (!selection.selected) {
      const pricedSelection = selectVaultImageOperatorFromList(operators, model, { requireAddress });
      return {
        pin: null,
        reason: pricedSelection.selected ? "no_encrypted_operator" : selection.reason,
      };
    }
    const { operator, priceUsdcPerImage } = selection.selected;
    return {
      pin: {
        address: operator.address,
        priceUsdcPerImage,
        encryptionPubkey: operator.authenticatedEncryptionPubkey,
      },
      reason: selection.reason,
    };
  } catch {
    return { pin: null, reason: "no_operator" };
  }
}

/** Send one reserved vault inference and return the shared response shape; redeem actual cost in background. */
export async function vaultSend(
  client: VaultConsumeClient,
  url: string,
  body: unknown,
  opts: {
    forwardHeaders: Record<string, string>;
    signal: AbortSignal;
    operator: string;
    priceUsdPerMtok: number;
    estTokens: number;
  }
): Promise<{ status: number; headers: Headers; body: string; paid: boolean; chargedBase?: string }> {
  const estCost = withReservationMargin(priceTokens(opts.priceUsdPerMtok, opts.estTokens));
  let ops: OpsState;
  let keyEpoch: bigint;
  ({ ops, keyEpoch } = await client.ensureReservation(opts.operator, estCost));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.forwardHeaders,
    // Vault-critical headers win over any forwarded ones.
    "x-halo-payment-mode": "vault",
    "x-halo-operator": opts.operator,
    "x-halo-vault-consumer": await client.consumer(),
  };
  setCliVersionHeader(headers);
  if (!("x-halo-max-price" in headers) && !("X-Halo-Max-Price" in headers)) {
    headers["x-halo-max-price"] = String(opts.priceUsdPerMtok);
  }

  const requestBody = JSON.stringify(body);
  const send = () =>
    fetch(url, { method: "POST", headers, body: requestBody, signal: opts.signal });
  let res = await send();
  let text = await res.text();
  // Re-reserve and replay boundedly because the operator's gate price may advance between attempts.
  for (
    let attempt = 1;
    attempt < MAX_VAULT_RESERVATION_ATTEMPTS && res.status === 402;
    attempt++
  ) {
    const required = requiredVaultReservationBase(text);
    if (required === null) break;
    ({ ops, keyEpoch } = await client.ensureReservation(opts.operator, required));
    res = await send();
    text = await res.text();
  }

  // Meter settlement frames first, then reported usage, regardless of content type.
  const meter = meterVaultResponse(res.headers, text, opts.priceUsdPerMtok);
  const cost = meter.cost;
  if (res.ok && cost > 0n) client.recordAndRedeem(opts.operator, ops, keyEpoch, cost);

  return {
    status: res.status,
    headers: res.headers,
    body: text,
    paid: res.ok && cost > 0n,
    // Gate on res.ok too (mirrors sdk/src/vault.ts payInference): a non-2xx response
    // can still carry a PAYMENT-RESPONSE with amountUsdc > 0, but nothing is redeemed
    // for it, so chargedBase must track `paid` — never report a charge that never landed.
    chargedBase: res.ok && cost > 0n ? cost.toString() : undefined,
  };
}

/**
 * Build the RELAY request for an image-generation send. Always targets
 * `/v1/chat/completions` (the relay has no `/v1/images/generations` route);
 * modality is signalled via `acceptMedia` in the body and header, never the URL.
 */
export function buildImageRelayRequest(
  relayBase: string,
  operator: string,
  consumer: string,
  model: string,
  envelope: EncryptedEnvelope
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-halo-payment-mode": "vault",
    "x-halo-operator": operator,
    "x-halo-vault-consumer": consumer,
    "x-halo-accept-media": "1",
  };
  setCliVersionHeader(headers);
  return {
    url: `${relayBase.replace(/\/+$/, "")}/v1/chat/completions`,
    headers,
    body: { model, acceptMedia: true, _enc: envelope },
  };
}

export interface DecodedImage {
  mime: string;
  bytes: Buffer;
}

export interface ConsumedImageStream {
  images: DecodedImage[];
  /** Base-unit settlement amount parsed from the halo-settlement frame's
   *  `paymentResponse`, or null when no valid settlement rode the stream. */
  settlementBase: bigint | null;
}

/**
 * CLI-local reader for the relay's image (`acceptMedia`) SSE stream: collects
 * `halo-media` frames per `imageIndex`, reassembles + decrypts each image, and
 * captures the `halo-settlement` amount. Throws on a media decode failure so
 * the caller can skip the redeem — never pay for undeliverable images.
 */
export async function consumeImageSseStream(
  res: { body?: ReadableStream<Uint8Array> | null },
  decryptMedia: (envelope: BytesEncryptedEnvelope) => Buffer
): Promise<ConsumedImageStream> {
  const reader = res.body?.getReader();
  if (!reader) return { images: [], settlementBase: null };
  const decoder = new TextDecoder();
  let buf = "";
  const mediaFrames: MediaChunkFrame[] = [];
  let settlementBase: bigint | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const evt = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of evt.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      if (event === "halo-settlement") {
        try {
          const s = JSON.parse(data) as { paymentResponse?: string | null };
          if (s.paymentResponse) settlementBase = settlementAmount(s.paymentResponse);
        } catch {
          /* ignore a malformed settlement frame — stays unmetered below */
        }
        continue;
      }
      if (event === "halo-media") {
        try {
          const frame = JSON.parse(data) as MediaChunkFrame;
          if (frame?.type === "media-chunk") mediaFrames.push(frame);
        } catch {
          /* ignore a malformed media frame */
        }
        continue;
      }
      // halo-status / done / anything else: images never stream text deltas.
    }
  }
  if (mediaFrames.length === 0) return { images: [], settlementBase };
  const byImage = new Map<number, MediaChunkFrame[]>();
  for (const frame of mediaFrames) {
    const imageIndex = frame.imageIndex ?? 0;
    const bucket = byImage.get(imageIndex);
    if (bucket) bucket.push(frame);
    else byImage.set(imageIndex, [frame]);
  }
  const images: DecodedImage[] = [];
  try {
    for (const imageIndex of [...byImage.keys()].sort((a, b) => a - b)) {
      const envelope = reassembleMediaEnvelope(byImage.get(imageIndex) ?? []);
      const padded = decryptMedia(envelope);
      const unpacked = unpackMediaPlaintext(trimPadding(padded));
      images.push({ mime: unpacked.mime, bytes: unpacked.bytes });
    }
  } catch (err) {
    throw new Error(`image media decode failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { images, settlementBase };
}

/**
 * Shape the caller's response as the OpenAI images API: `{created, data:
 * [{b64_json}]}`. Does not write files — the caller decides what to do with
 * the base64.
 */
export function buildImagesResponseBody(
  images: DecodedImage[],
  createdSec: number = Math.floor(Date.now() / 1000)
): { created: number; data: Array<{ b64_json: string }> } {
  return {
    created: createdSec,
    data: images.map((img) => ({ b64_json: img.bytes.toString("base64") })),
  };
}

/** Build the image endpoint's success-only delivery and settlement metadata. */
export function buildImageResponseHeaders(
  operator: string,
  result: { ok: boolean; paid: boolean; chargedBase?: string; images?: unknown[] },
  budget: Record<string, string> = {}
): Record<string, string> {
  const headers = { ...budget };
  if (!result.ok) return headers;
  if (!Array.isArray(result.images) || result.images.length === 0) {
    throw new Error("successful image result has no delivered image");
  }
  if (result.paid && !/^[1-9]\d*$/.test(result.chargedBase ?? "")) {
    throw new Error("paid image result is missing a positive exact base-unit charge");
  }
  headers["X-Halo-Operator"] = operator;
  headers["X-Halo-Paid"] = result.paid ? "true" : "false";
  headers["X-Halo-E2E-Encrypted"] = "true";
  if (result.paid) headers["X-Halo-Charged-Base"] = result.chargedBase!;
  return headers;
}

export function decryptRequiredOperatorE2eResponse(
  body: string,
  operatorPublicKey: Uint8Array,
  ephemeralPrivateKey: Uint8Array
): string {
  const parsed = JSON.parse(body) as { _enc?: unknown };
  const envelopeKeys =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed._enc &&
    typeof parsed._enc === "object" &&
    !Array.isArray(parsed._enc)
      ? Object.keys(parsed._enc).sort()
      : [];
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, "_enc") ||
    envelopeKeys.join(",") !== "alg,ct,epk,nonce,v" ||
    !isEncryptedEnvelope(parsed._enc)
  ) {
    throw new Error("operator response was not an envelope-only encrypted payload");
  }
  return JSON.stringify(
    decryptResponse(parsed._enc as EncryptedEnvelope, operatorPublicKey, ephemeralPrivateKey)
  );
}

function parseJsonOrWrapError(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text || "upstream error", type: "halo_upstream_error" } };
  }
}

/**
 * Model allowlist gate for the image route — mirrors handleCompletion's
 * inline check, extracted as a pure function so `handleImage` can be
 * unit-tested. Returns the 403 `halo_model_not_allowed` response, or null
 * when the model passes (or no allowlist is configured).
 */
export function modelAllowlistGate(
  model: string,
  allowedModels: string[] | undefined
): { status: number; body: unknown } | null {
  if (!allowedModels || !allowedModels.length) return null;
  if (allowedModels.includes(model)) return null;
  return {
    status: 403,
    body: {
      error: {
        message: `model ${model || "(none)"} is not in this consumer's allowlist (${allowedModels.join(", ")})`,
        type: "halo_model_not_allowed",
      },
    },
  };
}

/** The subset of the session budget state the image budget gate/accrual need. */
export interface SessionBudgetState {
  spentBase: bigint;
  reservedBase: bigint;
  budgetBase: bigint;
}

/**
 * Reserve-then-accrue admission for handleImage's cumulative --budget-usdc
 * cap — mirrors handleCompletion's inline gate. On admission, bumps
 * `budget.reservedBase` by `ceilingBase`; on refusal, leaves state untouched
 * and returns the same `halo_over_budget`/`over_budget` shape.
 */
export function reserveImageBudget(
  budget: SessionBudgetState,
  ceilingBase: bigint,
  budgetUrl: string
): { admitted: true } | { admitted: false; body: unknown } {
  if (budget.budgetBase <= 0n) return { admitted: true };
  const usd = (b: bigint) => (Number(b) / 1_000_000).toFixed(4);
  if (budget.spentBase + budget.reservedBase + ceilingBase > budget.budgetBase) {
    return {
      admitted: false,
      body: {
        error: {
          message: `Spending budget would be exceeded: $${usd(budget.spentBase)} spent${
            budget.reservedBase > 0n ? ` (+$${usd(budget.reservedBase)} in flight)` : ""
          } of the $${usd(budget.budgetBase)} cap, and this request reserves up to $${usd(
            ceilingBase
          )}. Ask the user to approve more, then raise it without restarting: POST ${budgetUrl} {"limitUsd": <new total>}.`,
          type: "halo_over_budget",
          code: "over_budget",
          spentUsd: Number(usd(budget.spentBase)),
          limitUsd: Number(usd(budget.budgetBase)),
        },
      },
    };
  }
  budget.reservedBase += ceilingBase;
  return { admitted: true };
}

/** Refuse an image request whose announced per-image ceiling exceeds --max-usdc. */
export function imagePerRequestCapGate(
  ceilingBase: bigint,
  maxAmountBase: bigint
): { status: 402; body: unknown } | null {
  if (ceilingBase <= maxAmountBase) return null;
  return {
    status: 402,
    body: {
      error: {
        message: `Image request ceiling of $${(Number(ceilingBase) / 1_000_000).toFixed(4)} exceeds the per-request cap of $${(Number(maxAmountBase) / 1_000_000).toFixed(4)}. Raise it with --max-usdc, request fewer images, or route to a cheaper operator.`,
        type: "halo_over_cap",
        code: "over_cap",
        requiredUsdcBase: ceilingBase.toString(),
        maxUsdcBase: maxAmountBase.toString(),
      },
    },
  };
}

/** Release a prior `reserveImageBudget` admission. Mirrors handleCompletion's
 * `release()` — idempotent at the call site (callers guard with their own
 * "was this reserved" flag) and clamped so a release can never underflow
 * `reservedBase` below zero. */
export function releaseImageBudget(budget: SessionBudgetState, ceilingBase: bigint): void {
  budget.reservedBase -= ceilingBase;
  if (budget.reservedBase < 0n) budget.reservedBase = 0n;
}

/** Accrue a completed image result's actual charge into the cumulative
 * session budget — mirrors handleCompletion's accrual exactly, including
 * the `chargedBase` decimal-string guard. */
export function accrueImageBudget(
  budget: { spentBase: bigint },
  result: { paid: boolean; chargedBase?: string }
): void {
  if (result.paid && result.chargedBase && /^\d+$/.test(result.chargedBase)) {
    budget.spentBase += BigInt(result.chargedBase);
  }
}

/**
 * Send one image-generation inference over the HaloVault rail — the image
 * analog of `vaultSend`. Reservation is sized from the ANNOUNCED per-image
 * price, never token pricing (invariant #7). The redeemed amount is metered
 * ONLY from the operator's settlement (invariant #2), CAPPED to what the
 * DECODED image count justifies, and refused outright when a positive
 * settlement is claimed alongside ZERO decoded images (invariant #1/#3):
 * never charge more than images actually delivered, and never trust an
 * operator-claimed settlement over what was actually decoded.
 */
export async function vaultSendImage(
  client: VaultConsumeClient,
  relayBase: string,
  opts: {
    operator: string;
    priceUsdcPerImage: number;
    imageCount: number;
    model: string;
    envelope: EncryptedEnvelope;
    ephemeralPrivateKey: Uint8Array;
    operatorPublicKey: Uint8Array;
    signal: AbortSignal;
  }
): Promise<{
  ok: boolean;
  status: number;
  images: DecodedImage[];
  paid: boolean;
  chargedBase?: string;
  errorBody?: unknown;
}> {
  const estCost = withReservationMargin(priceImages(opts.priceUsdcPerImage, opts.imageCount));
  let ops: OpsState;
  let keyEpoch: bigint;
  ({ ops, keyEpoch } = await client.ensureReservation(opts.operator, estCost));

  const consumer = await client.consumer();
  const send = (): Promise<Response> => {
    const built = buildImageRelayRequest(relayBase, opts.operator, consumer, opts.model, opts.envelope);
    return fetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body),
      signal: opts.signal,
    });
  };

  let res = await send();
  // Reserve-and-replay on a reservation-gate rejection (invariant #5), mirroring
  // vaultSend/sdk payInference — the gate price can advance more than once.
  for (
    let attempt = 1;
    attempt < MAX_VAULT_RESERVATION_ATTEMPTS && res.status === 402;
    attempt++
  ) {
    const text = await res.text();
    const required = requiredVaultReservationBase(text);
    if (required === null) {
      return { ok: false, status: res.status, images: [], paid: false, errorBody: parseJsonOrWrapError(text) };
    }
    ({ ops, keyEpoch } = await client.ensureReservation(opts.operator, required));
    res = await send();
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, images: [], paid: false, errorBody: parseJsonOrWrapError(text) };
  }

  const isSse = (res.headers.get("content-type") || "").includes("text/event-stream");
  if (!isSse) {
    // The relay opens the media stream whenever acceptMedia is honored for an
    // image-capable operator; a 2xx that ISN'T SSE means no media (and no
    // settlement) ever rode this response — nothing to decode, nothing to redeem.
    return {
      ok: false,
      status: 502,
      images: [],
      paid: false,
      errorBody: {
        error: {
          message: "operator response did not open an image media stream",
          type: "image_media_decode_failed",
        },
      },
    };
  }

  // PAYMENT-RESPONSE header path (belt-and-suspenders): in practice a streamed
  // image serve always flushes headers before settlement is known (the relay
  // can only emit it as a trailing halo-settlement SSE event once headers are
  // sent), so this is expected to be absent on the happy path — checked first
  // in case a short-circuit response ever carries it.
  let cost: bigint | null = null;
  const headerSettlement = res.headers.get("PAYMENT-RESPONSE");
  if (headerSettlement) cost = settlementAmount(headerSettlement);

  const decryptMedia = (envelope: BytesEncryptedEnvelope): Buffer =>
    decryptBytes(envelope, opts.ephemeralPrivateKey, opts.operatorPublicKey).plaintext;

  let stream: ConsumedImageStream;
  try {
    stream = await consumeImageSseStream(res, decryptMedia);
  } catch (err) {
    // Decode failed — never redeem for media the consumer couldn't decrypt.
    return {
      ok: false,
      status: 502,
      images: [],
      paid: false,
      errorBody: { error: { message: errMsg(err), type: "image_media_decode_failed" } },
    };
  }
  if (cost === null) cost = stream.settlementBase;

  // Invariant #1/#3: the redeemed amount must be justified by images actually
  // DECODED, never by a bare positive settlement the operator merely claims.
  // A non-compliant operator could send no halo-media frames, with or without a
  // settlement. Never report that as successful encrypted delivery; a positive
  // settlement would additionally risk paying for nothing.
  if (stream.images.length === 0) {
    return {
      ok: false,
      status: 502,
      images: [],
      paid: false,
      errorBody: {
        error: {
          message:
            cost !== null && cost > 0n
              ? "operator claimed a settlement but delivered no images"
              : "operator delivered no images",
          type: "image_no_media_delivered",
        },
      },
    };
  }

  // Invariant #2: meter from the operator settlement ONLY. No token-price
  // fallback for images — an unmeterable response is left unmetered, never
  // guessed from the client-requested `n` or any other estimate. Cap the
  // redeemed amount to what the DECODED image count justifies (invariant #1):
  // never pay more than `priceImages(perImage, decodedCount)`, even when the
  // operator's settlement claims more — e.g. it settled for the requested `n`
  // but fewer images' frames actually made it through decode.
  const justified = priceImages(opts.priceUsdcPerImage, stream.images.length);
  const paidCost =
    stream.images.length > 0 && cost !== null && cost > 0n
      ? cost <= justified
        ? cost
        : justified
      : null;
  if (paidCost !== null) {
    client.recordAndRedeem(opts.operator, ops, keyEpoch, paidCost);
  }

  return {
    ok: true,
    status: res.status,
    images: stream.images,
    paid: paidCost !== null,
    chargedBase: paidCost !== null ? paidCost.toString() : undefined,
  };
}

/** Probe a local consume /health. Returns the health info if a halo consume is
 *  serving there, "other" if something else holds the port, or null if nothing. */
async function probeConsumeHealth(
  host: string,
  port: number
): Promise<{ wallet: string } | "other" | null> {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return "other";
    const j = (await r.json()) as { status?: string; wallet?: string };
    return j && j.status === "ok" && typeof j.wallet === "string" ? { wallet: j.wallet } : "other";
  } catch {
    return null;
  }
}

/** Re-exec detached with file logs; no-op when a consume server already owns the port. */
async function runDetached(
  cfg: { operator: { noPassphrase?: boolean } },
  port: number,
  host: string
): Promise<void> {
  const existing = await probeConsumeHealth(host, port);
  if (existing && existing !== "other") {
    console.log(
      `  ✓ halo consume already running on http://${host}:${port}/v1 (wallet ${existing.wallet}) — nothing to start.`
    );
    return;
  }
  if (existing === "other") {
    console.error(`  ✗ port ${port} is held by a non-halo service. Free it, or use --port <other>.`);
    process.exit(1);
  }
  // A detached server can't be prompted for a passphrase.
  if (!cfg.operator.noPassphrase && process.env.HALO_PASSPHRASE == null) {
    console.error(
      `  ✗ --detach needs an unattended keystore: create one with \`halo setup --no-wallet-passphrase\`,\n` +
        `    or export HALO_PASSPHRASE before launching (a background process can't be prompted).`
    );
    process.exit(1);
  }
  const logPath = path.join(configDir(), "consume.log");
  let fd: number;
  try {
    fd = openSync(logPath, "a");
  } catch {
    fd = openSync("/dev/null", "a");
  }
  // Re-exec the same interpreter + entry, dropping --detach so the child is the
  // real server. (Requires the built/installed CLI — `node dist/index.js`.)
  const childArgs = process.argv.slice(1).filter((a) => a !== "--detach");
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  const pid = child.pid;
  // Confirm it bound before reporting success.
  const deadline = Date.now() + 12_000;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    const h = await probeConsumeHealth(host, port);
    if (h && h !== "other") {
      up = true;
      break;
    }
  }
  if (up) {
    console.log(`  ✓ halo consume started detached (pid ${pid}) on http://${host}:${port}/v1`);
    console.log(`    it survives gateway restarts; logs → ${logPath}`);
    console.log(`    point your agent at the endpoint and don't relaunch per session (calling this again no-ops).`);
  } else {
    console.error(`  ⚠ launched detached (pid ${pid}) but it didn't report healthy within 12s — check ${logPath}`);
    process.exit(1);
  }
}

/** Close the server and flush vault redeems within one bounded shutdown deadline. */
export function drainForShutdown(
  closeServer: () => Promise<void>,
  flushRedeems: (() => Promise<void>) | null,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((done) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    setTimeout(finish, timeoutMs).unref();
    const flushed = flushRedeems ? flushRedeems().catch(() => {}) : Promise.resolve();
    void Promise.all([closeServer(), flushed]).then(finish);
  });
}

export async function cmdConsume(args: Args): Promise<void> {
  // Route outbound through a proxy if the env asks for it (relay + Intel PCS
  // attestation collateral). No-op when no proxy var is set.
  installProxyFromEnv();
  relayCliVersion();
  const cfg = loadConfig();
  // Flags override the persisted consume profile (set by `halo setup`), which
  // overrides the built-in defaults.
  // Default 8799 — deliberately NOT the indexer's 8789 (a frequent local clash).
  const port = args.port ?? cfg.consume?.port ?? 8799;
  const host = args.host ?? "127.0.0.1";

  // Detached mode survives gateway process-group termination and is idempotent per port.
  if (args.detach) {
    await runDetached(cfg, port, host);
    return;
  }
  const keystorePath = args.keystore ?? cfg.operator.keystorePath;
  // USD → USDC base units (6 decimals). Default $0.10.
  const maxAmountBase = BigInt(
    Math.round((args.maxUsdc ?? cfg.consume?.maxUsdc ?? 0.1) * 1_000_000)
  );

  // Track cumulative session spend separately from per-request caps; the limit is runtime-mutable.
  const budget = {
    spentBase: 0n,
    // Reserve each request ceiling before async work, then reconcile to actual charge.
    reservedBase: 0n,
    budgetBase: BigInt(Math.round((args.budgetUsdc ?? 0) * 1_000_000)),
    warnPct: typeof args.budgetWarnPct === "number" ? args.budgetWarnPct : 0.8,
  };
  const usd = (b: bigint) => (Number(b) / 1_000_000).toFixed(4);
  /** Budget headers for every response so the agent always knows where it stands. */
  const budgetHeaders = (): Record<string, string> => {
    if (budget.budgetBase <= 0n) return {}; // uncapped → no budget headers
    const remaining = budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n;
    const h: Record<string, string> = {
      "X-Halo-Budget-Limit": usd(budget.budgetBase),
      "X-Halo-Budget-Spent": usd(budget.spentBase),
      "X-Halo-Budget-Remaining": usd(remaining),
    };
    // Warn band: spent ≥ warnPct × budget (and not yet over). The agent reads
    // this and can tell the user + offer to raise the limit (POST /v1/budget).
    const warnAt = (budget.budgetBase * BigInt(Math.round(budget.warnPct * 1000))) / 1000n;
    if (budget.spentBase >= warnAt && budget.spentBase < budget.budgetBase) {
      h["X-Halo-Budget-Warning"] = "true";
      h["X-Halo-Budget-Message"] = `Spending budget ${Math.round(
        (Number(budget.spentBase) / Number(budget.budgetBase)) * 100
      )}% used ($${usd(budget.spentBase)} of $${usd(budget.budgetBase)}). Ask the user to raise it (POST /v1/budget {"limitUsd": N}) before it's exhausted.`;
    }
    return h;
  };
  // Consume profile guards: a default model for requests that omit one, and an
  // allowlist of models the agent will pay for (refuse anything else pre-payment).
  const defaultModel = cfg.consume?.defaultModel;
  const allowedModels = cfg.consume?.allowedModels;
  // Confidential (TEE) mode: route only to TEE operators and E2E-encrypt the
  // prompt to the enclave. The base URL is the TEE provider's public
  // attestation/key endpoint (NEAR by default).
  const confidential = args.confidential === true;
  const teeBaseUrl = (args.teeBaseUrl ?? "https://cloud-api.near.ai/v1").replace(/\/+$/, "");

  // Passphrase resolution, mirroring `serve`: unattended (empty) when the
  // keystore was created with --no-wallet-passphrase, else HALO_PASSPHRASE env
  // (for headless/daemon launch), else an interactive prompt.
  let passphrase: string;
  if (cfg.operator.noPassphrase) {
    passphrase = "";
  } else if (typeof process.env.HALO_PASSPHRASE === "string") {
    passphrase = process.env.HALO_PASSPHRASE;
  } else {
    const r = await prompts({ type: "password", name: "passphrase", message: "Keystore passphrase" });
    if (!r.passphrase) process.exit(130);
    passphrase = r.passphrase;
  }

  const wallet = await loadWallet(keystorePath, passphrase);
  const relayBase = cfg.relayUrl.replace(/\/+$/, "");
  const completionsUrl = `${relayBase}/v1/chat/completions`;
  const modelsUrl = `${relayBase}/v1/models`;

  // Browser mode derives the same shared session key as the web app.
  if (args.sessionKey && args.sessionKey !== "wallet" && args.sessionKey !== "browser") {
    console.error(`  ✗ --session-key must be "wallet" or "browser" (got "${args.sessionKey}").`);
    process.exit(1);
  }
  const sessionKeyMode: SessionKeyMode = args.sessionKey === "browser" ? "browser" : "wallet";
  const vaultSessionSigner = await resolveSessionSigner(wallet, sessionKeyMode);
  const vaultSessionKeyAddr = vaultSessionSigner
    ? await vaultSessionSigner.getAddress()
    : wallet.address;
  const vaultAddress = resolveVaultAddress(cfg.vaultAddress);
  const vault = new VaultConsumeClient(
    wallet,
    {
      facilitatorUrl: cfg.facilitator?.url ?? "https://facilitator.runhalo.xyz",
      rpcUrl: (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim(),
      chainId: BASE_CHAIN_ID,
      vaultAddress,
      // Push receipts to the operator; self-redeem remains the fallback.
      relayUrl: relayBase,
      // Omit the override when unset to preserve the client default.
      ...(args.vaultReserveMultiple && args.vaultReserveMultiple > 0
        ? { reserveMultiple: BigInt(Math.floor(args.vaultReserveMultiple)) }
        : {}),
      autoTopUpUsd: args.vaultDeposit,
      // Persist pending redeems per wallet across restarts.
      pendingStorePath: path.join(configDir(), `vault-pending-${wallet.address.toLowerCase()}.json`),
    },
    vaultSessionSigner
  );
  // Refuse every unverifiable or mismatched facilitator identity before replay or funding.
  const facilitatorUrl = cfg.facilitator?.url ?? "https://facilitator.runhalo.xyz";
  if (!(await guardVaultFresh(facilitatorUrl, vaultAddress, { force: args.force }))) {
    process.exit(1);
  }
  // Resume any redeems a prior process left pending (restart-durable settlement).
  // After the freshness gate, so a stale vault never replays receipts.
  vault.resumePendingRedeems();
  if (args.vaultDeposit && args.vaultDeposit > 0) {
    // Auto-managed: top the vault up to the target from the wallet's USDC on
    // startup so the first request has reservable funds. Fails loud (and the
    // sidecar still starts in case the agent only hits read endpoints).
    try {
      const target = BigInt(Math.round(args.vaultDeposit * 1_000_000));
      const tx = await vault.ensureDeposit(target);
      console.log(
        tx
          ? `  ✓ vault topped up to $${args.vaultDeposit.toFixed(2)} (deposit ${tx.slice(0, 10)}…)`
          : `  ✓ vault already funded ≥ $${args.vaultDeposit.toFixed(2)}`
      );
    } catch (e) {
      console.error(`  ⚠ vault auto-deposit failed: ${errMsg(e)}`);
      console.error(`    Fund ${wallet.address} with USDC + a little ETH on Base, or run: halo vault deposit <usd>`);
    }
  }
  // Fail closed when the registered receipt signer differs from the selected key.
  try {
    const sk = await vault.checkSessionKey();
    if (sk.status === "mismatch") {
      const browser = sessionKeyMode === "browser";
      console.error(
        `\n  ✗ VAULT SESSION-KEY MISMATCH — refusing to start the vault rail.\n` +
          `    Wallet ${wallet.address} has session key ${sk.registered} registered on-chain,\n` +
          `    but this CLI signs with ${sk.expected}${browser ? " (browser-derived; --session-key browser)" : " (this wallet)"}.\n` +
          `    Receipts this CLI signs would revert (BadSignature) and the operator would\n` +
          `    serve work it can never be paid for. Common causes: mixing the Halo browser app\n` +
          `    and the CLI on one wallet, or the wrong --session-key mode.\n` +
          `    Fix: try the other mode (--session-key ${browser ? "wallet" : "browser"}), use a\n` +
          `    DEDICATED wallet for the CLI, or rotate the key with setSessionKey(${sk.expected})\n` +
          `    (needs no active reservations).\n`
      );
      process.exit(1);
    }
  } catch (e) {
    console.error(
      `  ⚠ could not verify the vault session key at startup (${errMsg(e)}); ` +
        `the client re-checks fail-closed before it serves.`
    );
  }

  // Last-resort handlers log request-path failures without terminating the long-lived sidecar.
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error(`  ⚠ uncaught exception (kept alive): ${errMsg(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error(`  ⚠ unhandled rejection (kept alive): ${errMsg(reason)}`);
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { error: { message: errMsg(err), type: "halo_internal_error" } });
    });
  });
  // A malformed/oversized request line or a client that resets mid-handshake
  // emits 'clientError'; without a handler Node can surface it as an uncaught
  // error. Respond 400 if the socket is still writable, else just close.
  server.on("clientError", (_err, socket) => {
    try {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      else socket.destroy();
    } catch {
      /* socket already gone */
    }
  });
  // Bind errors are fatal; otherwise the crash net could leave a live process with no listener.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n  ✗ port ${port} is already in use on ${host}.\n` +
          `    Another process (another consume, or anything else) is holding it.\n` +
          `    Start consume on a free port, e.g.  halo consume --port 8800\n` +
          `    then point your agent at  http://${host}:8800/v1\n`
      );
    } else {
      console.error(`\n  ✗ server error (${err.code || "unknown"}): ${errMsg(err)}\n`);
    }
    process.exit(1);
  });
  // Bound slow headers/bodies while keeping request and keepalive timeouts above legitimate inference latency.
  server.requestTimeout = 360_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 75_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || "").split("?")[0];

    // Health is unauthenticated and reports endpoint-default confidentiality without spending.
    if (req.method === "GET" && (url === "/health" || url === "/healthz")) {
      return sendJson(res, 200, {
        status: "ok",
        wallet: wallet.address,
        network: BASE_NETWORK,
        confidential,
      });
    }

    // Bearer gate (if configured) on everything that can spend or query upstream.
    if (args.apiKey && !bearerOk(req, args.apiKey)) {
      return sendJson(res, 401, { error: { message: "missing or invalid bearer token", type: "halo_auth_error" } });
    }

    // Model list — proxied from the relay, no payment.
    if (req.method === "GET" && url === "/v1/models") {
      try {
        const upstream = await fetch(modelsUrl, { signal: AbortSignal.timeout(15_000) });
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
      } catch (err) {
        sendJson(res, 502, {
          error: { message: `relay unreachable for model list (${errMsg(err)}). Check ${relayBase}/health.`, type: "halo_upstream_error" },
        });
      }
      return;
    }

    // Proxy this wallet's indexer standing alongside local session budget; no payment.
    if (req.method === "GET" && url === "/v1/account") {
      let stats: Record<string, unknown> = { error: "indexer unreachable" };
      try {
        const r = await fetch(`${cfg.indexerUrl.replace(/\/+$/, "")}/points/${wallet.address}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (r.ok) {
          const p = (await r.json()) as Record<string, unknown>;
          stats = {
            consumePoints: p.consumePoints ?? 0,
            consumeTier: p.consumeTier ?? null,
            consumeStreakDays: p.consumeStreakDays ?? 0,
            consumeStreakMultiplier: p.consumeStreakMultiplier ?? 1,
            requestsConsumed: p.requestsConsumed ?? 0,
            tokensConsumed: p.tokensConsumed ?? 0,
            usdcSpentTotal: Number((Number(p.usdcSpentBase ?? 0) / 1_000_000).toFixed(4)),
            season: p.season ?? null,
          };
        }
      } catch {
        /* indexer down — return the wallet + budget anyway */
      }
      return sendJson(res, 200, {
        address: wallet.address,
        network: BASE_NETWORK,
        league: stats,
        sessionBudget: {
          capped: budget.budgetBase > 0n,
          limitUsd: Number(usd(budget.budgetBase)),
          spentUsd: Number(usd(budget.spentBase)),
          remainingUsd: Number(usd(budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n)),
        },
        // Pair this wallet with a dashboard to view it in the UI: run `halo link`.
        dashboardHint: "run `halo link` to pair this wallet with a dashboard",
      });
    }

    if (req.method === "POST" && url === "/v1/chat/completions") {
      return handleCompletion(req, res);
    }

    if (req.method === "POST" && url === "/v1/images/generations") {
      return handleImage(req, res);
    }

    // GET reports budget state; authenticated POST changes only the ceiling, never accrued spend.
    if (url === "/v1/budget") {
      if (req.method === "GET") {
        return sendJson(res, 200, {
          limitUsd: Number(usd(budget.budgetBase)),
          spentUsd: Number(usd(budget.spentBase)),
          remainingUsd: Number(usd(budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n)),
          capped: budget.budgetBase > 0n,
        });
      }
      if (req.method === "POST") {
        let body: { limitUsd?: number };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: { message: "body must be JSON {\"limitUsd\": N}", type: "halo_request_error" } });
        }
        if (typeof body.limitUsd !== "number" || body.limitUsd < 0) {
          return sendJson(res, 400, { error: { message: "limitUsd must be a non-negative number (0 = uncapped)", type: "halo_request_error" } });
        }
        budget.budgetBase = BigInt(Math.round(body.limitUsd * 1_000_000));
        console.log(`  ℹ budget updated → $${usd(budget.budgetBase)} (spent so far $${usd(budget.spentBase)})`);
        return sendJson(res, 200, {
          limitUsd: Number(usd(budget.budgetBase)),
          spentUsd: Number(usd(budget.spentBase)),
          remainingUsd: Number(usd(budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n)),
          capped: budget.budgetBase > 0n,
        });
      }
    }

    return sendJson(res, 404, { error: { message: `no route for ${req.method} ${url}`, type: "halo_not_found" } });
  }

  async function handleCompletion(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t0 = Date.now();
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      return sendJson(res, 413, { error: { message: errMsg(err), type: "halo_request_error" } });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: { message: "request body is not valid JSON", type: "halo_request_error" } });
    }

    // Cancel signal: if the client (agent) gives up and disconnects — a common
    // case, agents have their own timeouts — abort the upstream call so we stop
    // paying for a response nobody is waiting for.
    const ac = new AbortController();

    // Reserve the request ceiling synchronously so parallel calls cannot oversubscribe cumulative budget.
    // Release and reconcile on every response path.
    let reserved = false;
    const release = (): void => {
      if (!reserved) return;
      reserved = false;
      budget.reservedBase -= maxAmountBase;
      if (budget.reservedBase < 0n) budget.reservedBase = 0n;
    };
    if (budget.budgetBase > 0n) {
      if (budget.spentBase + budget.reservedBase + maxAmountBase > budget.budgetBase) {
        res.writeHead(402, { "Content-Type": "application/json", ...budgetHeaders() });
        res.end(
          JSON.stringify({
            error: {
              message: `Spending budget would be exceeded: $${usd(budget.spentBase)} spent${
                budget.reservedBase > 0n ? ` (+$${usd(budget.reservedBase)} in flight)` : ""
              } of the $${usd(budget.budgetBase)} cap, and this request reserves up to $${usd(
                maxAmountBase
              )}. Ask the user to approve more, then raise it without restarting: POST ${`http://${host}:${port}`}/v1/budget {"limitUsd": <new total>}.`,
              type: "halo_over_budget",
              code: "over_budget",
              spentUsd: Number(usd(budget.spentBase)),
              limitUsd: Number(usd(budget.budgetBase)),
            },
          })
        );
        return;
      }
      budget.reservedBase += maxAmountBase;
      reserved = true;
    }
    // One handler covers both outcomes: release the reservation always, and if
    // the response closed before we finished writing it (client disconnected),
    // abort the in-flight upstream call.
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
      release();
    });

    // Force buffered upstream responses, then synthesize SSE for clients that require `stream:true`.
    const wantStream = parsed.stream === true;
    if (wantStream) delete parsed.stream;

    // Apply the consume profile's default model when the client omits one.
    if ((parsed.model === undefined || parsed.model === "") && defaultModel) {
      parsed.model = defaultModel;
    }
    // Allowlist guard: refuse to pay for a model outside the configured set,
    // BEFORE any payment is signed.
    if (allowedModels && allowedModels.length) {
      const m = typeof parsed.model === "string" ? parsed.model : "";
      if (!allowedModels.includes(m)) {
        return sendJson(res, 403, {
          error: {
            message: `model ${m || "(none)"} is not in this consumer's allowlist (${allowedModels.join(", ")})`,
            type: "halo_model_not_allowed",
          },
        });
      }
    }

    // Forward x-halo-* routing hints (model/operator/price/privacy) transparently.
    const forwardHeaders = collectHaloHeaders(req);

    // Confidential is required either globally (`--confidential`) or per-request
    // via the `X-Halo-Confidential` header — so an agent can demand confidential
    // for a specific call without running a confidential-only endpoint.
    const wantConfidential =
      confidential ||
      /^(1|true|required|yes)$/i.test(String(req.headers["x-halo-confidential"] || ""));

    // Confidential mode encrypts to the reported TEE key and fails closed on setup.
    const errCtx = {
      wallet: wallet.address,
      network: BASE_NETWORK,
      maxUsd: Number(maxAmountBase) / 1_000_000,
      relay: relayBase,
      confidential: wantConfidential,
    };

    // Vault rail: capture the prompt-size estimate (to size the reservation)
    // BEFORE confidential/E2E mutate `parsed`, and pin ONE operator to reserve
    // against, encrypt to, and meter (TEE-only when confidential).
    // Shared reasoning headroom keeps reservation and operator gate equal.
    const vaultEstTokens = estimateReservationTokens(parsed);
    const maxPriceUsdPerMtok =
      Number(maxAmountBase) /
      Math.max(1, vaultEstTokens) /
      (1 + Number(RESERVATION_PRICE_MARGIN_BPS) / 10_000);
    const m = typeof parsed.model === "string" ? parsed.model : "";
    // If the caller explicitly pinned an operator (X-Halo-Operator, e.g. a
    // settlement sweep targeting every operator), honor it; otherwise fall back
    // to the default cheapest-tier selection.
    const pinned = (forwardHeaders["x-halo-operator"] || "").trim() || undefined;
    const selection = m
      ? await selectVaultOperator(
          relayBase,
          m,
          wantConfidential,
          maxPriceUsdPerMtok,
          pinned
        )
      : { pin: null, reason: "no_operator" as VaultOperatorSelectionReason };
    const vaultPin = selection.pin;
    if (!vaultPin) {
      const overPriceCeiling =
        selection.reason === "out_of_range" ||
        selection.reason === "pinned_out_of_range";
      const message =
        selection.reason === "pinned_not_vault_capable"
          ? `pinned operator ${pinned} serves "${m}" but is not vault-capable. Upgrade that operator to announce vaultPayments, or drop X-Halo-Operator to choose a vault-capable operator.`
          : selection.reason === "pinned_free_model"
            ? `pinned operator ${pinned} advertises "${m}" as free. A zero-price model cannot produce a redeemable vault receipt; use a metered model.`
            : selection.reason === "free_model"
              ? `model "${m}" is advertised as free. A zero-price model cannot produce a redeemable vault receipt; use a metered model.`
              : overPriceCeiling
                ? `no eligible operator for "${m}" is within the $${(Number(maxAmountBase) / 1_000_000).toFixed(2)} per-request cap.`
                : pinned
                  ? `pinned operator ${pinned} is unavailable or not advertising a usable price for "${m}"${wantConfidential ? " (confidential)" : ""}. Drop X-Halo-Operator to use the cheapest eligible operator.`
                  : `no priced${wantConfidential ? " confidential" : ""} vault-capable operator is online for "${m}".`;
      return sendJson(
        res,
        overPriceCeiling ? 402 : 503,
        actionableError(
          overPriceCeiling ? 402 : 503,
          JSON.stringify({ error: { message } }),
          errCtx
        )
      );
    }
    forwardHeaders["x-halo-operator"] = vaultPin.address;

    let teeClientKey: string | null = null;
    let teeSigner: string | null = null;
    if (wantConfidential) {
      const model = typeof parsed.model === "string" ? parsed.model : "";
      try {
        const att = await fetchModelAttestation(teeBaseUrl, model);
        // Verify available hardware evidence and signer binding before encryption.
        if (!args.noAttestationVerify) {
          const verifiedSigner = await verifiedSignerForModel(teeBaseUrl, model);
          if (att.signingAddress.toLowerCase() !== verifiedSigner) {
            throw new Error(
              `attested signer ${att.signingAddress} does not match the configured-verifier signer ${verifiedSigner}`
            );
          }
        }
        teeSigner = att.signingAddress;
        const ck = newClientKey();
        teeClientKey = ck.privateKey;
        if (Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map((m) => {
            const mm = m as { content?: unknown };
            return mm && typeof mm.content === "string"
              ? { ...mm, content: encryptToTee(mm.content, att.signingPublicKey) }
              : m;
          });
        }
        forwardHeaders["x-halo-tee"] = "true";
        forwardHeaders["x-signing-algo"] = "ecdsa";
        forwardHeaders["x-client-pub-key"] = ck.pubHex;
      } catch (e) {
        // Fails closed — never silently downgrade a confidential request to plaintext.
        const detail = errMsg(e);
        // "Failed to get collateral" is the DCAP verifier unable to fetch the
        // Intel quote's collateral — almost always egress to Intel's PCS, not a
        // bad model. Say so, since the generic "TEE unavailable" misleads.
        const hint = /collateral/i.test(detail)
          ? `This is the hardware-attestation collateral fetch from Intel's PCS (api.trustedservices.intel.com) failing — ensure THIS process can reach it (firewall/VPN, and set HTTPS_PROXY if you use a proxy). It auto-retries transient blips. To bypass the hardware check (less private — trusts the attestation source), restart consume with --no-attestation-verify.`
          : `The model may not support confidential inference, or the TEE provider is briefly unavailable. Retry, pick a model with confidential available (${relayBase}/v1/models), or drop the X-Halo-Confidential header to run non-confidential.`;
        return sendJson(res, 502, {
          error: {
            message: `Confidential setup failed for "${model}": ${detail}. ${hint}`,
            type: "halo_confidential_error",
            code: "confidential_setup_failed",
          },
        });
      }
    }

    // Non-confidential E2E encrypts to and pins the selected operator; missing keys fall back to plaintext.
    let e2eEphemeralPriv: Uint8Array | null = null;
    let e2eOperatorPub: Uint8Array | null = null;
    if (!wantConfidential && !args.noE2e) {
      // Encrypt to the same operator that owns the reservation.
      const op = vaultPin.encryptionPubkey
        ? { address: vaultPin.address, encryptionPubkey: vaultPin.encryptionPubkey }
        : null;
      if (op) {
        try {
          const operatorPub = hexToPubkey(op.encryptionPubkey);
          const eph = generateEphemeralKeypair();
          // Keep routing fields cleartext and seal the remaining request in `_enc`.
          const { model: routeModel, ...rest } = parsed as { model?: unknown } & Record<string, unknown>;
          const envelope = encryptRequest(rest, operatorPub, eph);
          parsed = { model: routeModel, _enc: envelope } as Record<string, unknown>;
          forwardHeaders["x-halo-operator"] = op.address;
          e2eEphemeralPriv = eph.privateKey;
          e2eOperatorPub = operatorPub;
        } catch {
          // Encryption setup failed — fall through to plaintext rather than block.
          e2eEphemeralPriv = null;
          e2eOperatorPub = null;
        }
      }
    }

    try {
      const result = await vaultSend(vault, completionsUrl, parsed, {
        forwardHeaders,
        signal: ac.signal,
        operator: vaultPin.address,
        priceUsdPerMtok: vaultPin.priceUsdPerMtok,
        estTokens: vaultEstTokens,
      });
      // Accrue what was actually charged into the session budget, then attach the
      // live budget headers (limit/spent/remaining + warning band) so the agent
      // always knows where it stands and can warn the user before it runs out.
      if (result.paid && result.chargedBase && /^\d+$/.test(result.chargedBase)) {
        budget.spentBase += BigInt(result.chargedBase);
      }
      const headers: Record<string, string> = { "Content-Type": "application/json", ...budgetHeaders() };
      const operator = result.headers.get("X-Halo-Operator");
      if (operator) headers["X-Halo-Operator"] = operator;
      const deprecationWarning = result.headers.get("X-Halo-Deprecation-Warning");
      if (deprecationWarning) {
        headers["X-Halo-Deprecation-Warning"] = deprecationWarning;
      }
      headers["X-Halo-Paid"] = result.paid ? "true" : "false";
      if (result.paid && result.chargedBase && /^\d+$/.test(result.chargedBase)) {
        headers["X-Halo-Charged-Base"] = result.chargedBase;
      }
      logReq({
        model: typeof parsed.model === "string" ? parsed.model : "(none)",
        status: result.status,
        paid: result.paid,
        chargedBase: result.chargedBase,
        operator,
        confidential: wantConfidential,
        ms: Date.now() - t0,
      });
      // Echo whether this call was confidential so the agent can assert it.
      headers["X-Halo-Confidential"] = wantConfidential ? "true" : "false";
      let outBody = result.body;
      if (wantConfidential && teeClientKey && result.status >= 200 && result.status < 300) {
        // Decrypt and require the forwarded response signature to match the attested signer.
        try {
          const j = JSON.parse(result.body) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          for (const ch of j.choices ?? []) {
            if (ch.message && typeof ch.message.content === "string") {
              ch.message.content = decryptFromTee(ch.message.content, teeClientKey);
            }
          }
          outBody = JSON.stringify(j);
        } catch (e) {
          return sendJson(res, 502, {
            error: { message: `confidential response decrypt failed: ${errMsg(e)}`, type: "halo_confidential_error" },
          });
        }
        const sigB64 = result.headers.get("X-Halo-TEE-Signature") || "";
        headers["X-Halo-TEE-Verified"] =
          sigB64 && teeSigner && verifyTeeSignature(sigB64, teeSigner) ? "true" : "false";
      }
      // Operator-E2E: decrypt the operator's `_enc` reply (relay never saw it in
      // the clear). Marks the response so the agent knows it was relay-blind.
      if (e2eEphemeralPriv && e2eOperatorPub && result.status >= 200 && result.status < 300) {
        try {
          outBody = decryptRequiredOperatorE2eResponse(
            result.body,
            e2eOperatorPub,
            e2eEphemeralPriv
          );
          headers["X-Halo-E2E-Encrypted"] = "true";
        } catch (e) {
          return sendJson(res, 502, {
            error: { message: `E2E response decrypt failed: ${errMsg(e)}`, type: "halo_e2e_error" },
          });
        }
      }
      // Normalize non-2xx responses to actionable OpenAI JSON, including for stream requests.
      if (result.status >= 400) {
        return sendJson(res, result.status, actionableError(result.status, result.body, errCtx));
      }
      if (wantStream) {
        return sendBufferedAsSse(res, outBody, headers);
      }
      res.writeHead(result.status, headers);
      res.end(outBody);
    } catch (err) {
      // Client gave up and disconnected — the response socket is already gone.
      // Nothing to send; don't log it as an upstream fault.
      if (ac.signal.aborted) {
        logReq({ model: typeof parsed.model === "string" ? parsed.model : "(none)", status: 0, paid: false, confidential: wantConfidential, ms: Date.now() - t0, note: "client disconnected" });
        return;
      }
      logReq({ model: typeof parsed.model === "string" ? parsed.model : "(none)", status: 502, paid: false, confidential: wantConfidential, ms: Date.now() - t0, note: errMsg(err) });
      return sendJson(res, 502, actionableError(502, JSON.stringify({ error: { message: errMsg(err) } }), errCtx));
    }
  }

  /**
   * halo consume's OpenAI-compatible images endpoint. Consume always uses
   * HaloVault. On success this returns `{created, data:[{b64_json}]}` and
   * leaves file handling to the caller.
   */
  async function handleImage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t0 = Date.now();

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      return sendJson(res, 413, { error: { message: errMsg(err), type: "halo_request_error" } });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: { message: "request body is not valid JSON", type: "halo_request_error" } });
    }

    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    if (!model) {
      return sendJson(res, 400, { error: { message: "model is required", type: "halo_request_error" } });
    }
    // Allowlist guard: refuse to pay for a model outside the configured set,
    // BEFORE any payment is signed — mirrors handleCompletion's gate,
    // extracted as `modelAllowlistGate` so it's unit-testable without
    // booting the HTTP server (handleImage is a closure nested in
    // `cmdConsume`, not independently callable).
    const allowlistGate = modelAllowlistGate(model, allowedModels);
    if (allowlistGate) {
      return sendJson(res, allowlistGate.status, allowlistGate.body);
    }
    // n defaults to 1, mirroring the operator's own requestedImageCount default
    // (serve.ts) — explicitly re-sent below so the reservation size and the
    // request the operator prices against can never drift.
    const n =
      typeof parsed.n === "number" && Number.isFinite(parsed.n) && parsed.n > 0
        ? Math.ceil(parsed.n)
        : 1;

    const ac = new AbortController();
    // Cumulative --budget-usdc gate (mirrors handleCompletion's reserve-then-
    // accrue guard). Unlike the token path, the per-request ceiling can't be
    // sized yet — image pricing is per operator+model
    // (`priceImages(pin.priceUsdcPerImage, n)`), so it's only known once an
    // operator is selected below. This closure is registered now (alongside
    // the existing abort-on-close wiring) so the reservation is released on
    // EVERY response-close path — success, failure, abort, or a thrown error —
    // exactly like handleCompletion's `release()`; `imageBudgetReserved` stays
    // false (a no-op release) for any early return before the reservation is
    // actually taken below.
    let imageBudgetReserved = false;
    let imageCeilingBase = 0n;
    const releaseImageBudgetReservation = (): void => {
      if (!imageBudgetReserved) return;
      imageBudgetReserved = false;
      releaseImageBudget(budget, imageCeilingBase);
    };
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
      releaseImageBudgetReservation();
    });

    // Invariant #7: select the vault-capable operator advertising `model`
    // as an EXACT imageModels member with a positive announced per-image
    // price. Never falls back to token pricing. Honors an explicit
    // X-Halo-Operator pin, mirroring the token vault path.
    const pinned = (collectHaloHeaders(req)["x-halo-operator"] || "").trim() || undefined;
    const selection = await selectVaultImageOperator(relayBase, model, pinned);
    if (!selection.pin) {
      const free = selection.reason === "free_model" || selection.reason === "pinned_free_model";
      const noEncryption = selection.reason === "no_encrypted_operator";
      const message = noEncryption
        ? pinned
          ? `pinned operator ${pinned} does not advertise an authenticated E2E key required for encrypted image delivery.`
          : `No image operator with an authenticated E2E key is online for "${model}".`
        : free
          ? `Image model "${model}" is advertised as free and cannot produce a redeemable vault receipt. Use a metered image model.`
          : pinned
            ? `pinned operator ${pinned} is unavailable or not advertising a usable per-image price for "${model}". Drop X-Halo-Operator to use the cheapest eligible image operator.`
            : `No priced image operator is online for "${model}". Image generation needs a vault operator advertising a positive per-image price for this exact model.`;
      return sendJson(res, 503, {
        error: {
          message,
          type: noEncryption ? "halo_e2e_error" : "halo_no_operator",
          code: noEncryption ? "image_operator_no_encryption_key" : "no_image_operator",
        },
      });
    }
    const pin = selection.pin;
    // E2E required for image delivery (media only ever travels encrypted).
    if (!pin.encryptionPubkey) {
      return sendJson(res, 503, {
        error: {
          message: `Image generation for "${model}" requires an operator E2E key so encrypted media can be delivered; the selected operator (${pin.address}) advertised none.`,
          type: "halo_e2e_error",
          code: "image_operator_no_encryption_key",
        },
      });
    }

    // Reserve this request's ceiling against the session budget BEFORE paying
    // (mirrors handleCompletion's reserve-then-accrue gate exactly). Sized
    // here rather than upfront because the per-image ceiling depends on the
    // operator just selected above.
    imageCeilingBase = priceImages(pin.priceUsdcPerImage, n);
    const perRequestCap = imagePerRequestCapGate(imageCeilingBase, maxAmountBase);
    if (perRequestCap) {
      return sendJson(res, perRequestCap.status, perRequestCap.body, budgetHeaders());
    }
    const budgetAdmission = reserveImageBudget(budget, imageCeilingBase, `http://${host}:${port}/v1/budget`);
    if (!budgetAdmission.admitted) {
      return sendJson(res, 402, budgetAdmission.body, budgetHeaders());
    }
    imageBudgetReserved = true;
    // The res.on("close") release listener was registered before the async
    // operator-selection above, so a client disconnect DURING selection fires
    // the one-shot "close" while imageBudgetReserved was still false (a no-op
    // release) — which would then strand this ceiling in budget.reservedBase
    // forever (no future close event can fire). Re-check the abort signal
    // (set by that same close handler) now that the reservation is taken, and
    // release it explicitly. No await sits between the reserve above and this
    // check, so the flag/release stays exactly-once.
    if (ac.signal.aborted) {
      releaseImageBudgetReservation();
      return;
    }

    let operatorPublicKey: Uint8Array;
    let ephemeral: EphemeralKeyPair;
    let envelope: EncryptedEnvelope;
    try {
      operatorPublicKey = hexToPubkey(pin.encryptionPubkey);
      ephemeral = generateEphemeralKeypair();
      // Encrypt everything except `model` (kept cleartext for relay routing,
      // mirroring handleCompletion's E2E path); `n` is re-sent normalized so
      // the operator prices exactly what we reserved for.
      const { model: _dropModel, n: _dropN, ...rest } = parsed;
      envelope = encryptRequest({ ...rest, n }, operatorPublicKey, ephemeral);
    } catch (err) {
      return sendJson(res, 502, {
        error: { message: `E2E encryption setup failed: ${errMsg(err)}`, type: "halo_e2e_error" },
      });
    }

    try {
      const result = await vaultSendImage(vault, relayBase, {
        operator: pin.address,
        priceUsdcPerImage: pin.priceUsdcPerImage,
        imageCount: n,
        model,
        envelope,
        ephemeralPrivateKey: ephemeral.privateKey,
        operatorPublicKey,
        signal: ac.signal,
      });

      // Accrue what was actually charged into the session budget — mirrors
      // handleCompletion's accrual — before status/ok branching, same as the
      // text path.
      accrueImageBudget(budget, result);

      logReq({
        model,
        status: result.status,
        paid: result.paid,
        chargedBase: result.chargedBase,
        operator: pin.address,
        confidential: false,
        ms: Date.now() - t0,
      });

      if (!result.ok) {
        return sendJson(
          res,
          result.status >= 400 ? result.status : 502,
          result.errorBody ?? {
            error: { message: "image generation failed", type: "halo_upstream_error" },
          }
        );
      }

      return sendJson(
        res,
        200,
        buildImagesResponseBody(result.images),
        buildImageResponseHeaders(pin.address, result, budgetHeaders())
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logReq({ model, status: 0, paid: false, confidential: false, ms: Date.now() - t0, note: "client disconnected" });
        return;
      }
      logReq({ model, status: 502, paid: false, confidential: false, ms: Date.now() - t0, note: errMsg(err) });
      return sendJson(res, 502, { error: { message: errMsg(err), type: "halo_upstream_error" } });
    }
  }

  server.listen(port, host, () => {
    console.log(`halo consume`);
    console.log(`  endpoint : http://${host}:${port}/v1`);
    console.log(`  wallet   : ${wallet.address}  (Base mainnet)`);
    console.log(`  relay    : ${relayBase}`);
    console.log(`  rail     : vault (settle ACTUAL tokens; deposit-backed)`);
    console.log(
      `  session  : ${sessionKeyMode === "browser" ? `browser-derived ${vaultSessionKeyAddr} (shared with the Halo web app)` : "wallet (this wallet signs receipts)"}`
    );
    console.log(
      `  budget   : ${budget.budgetBase > 0n ? `$${usd(budget.budgetBase)} cumulative (warn at ${Math.round(budget.warnPct * 100)}%)` : "uncapped (set --budget-usdc to bound an agent)"}`
    );
    console.log(`  auth     : ${args.apiKey ? "bearer token required" : "none (localhost only)"}`);
    console.log(`\n  point an OpenAI-compatible client at the endpoint above. Fund the wallet with USDC on Base.\n`);
  });

  // Keep the process alive until interrupted. Auto-update and SIGINT/SIGTERM
  // share the same bounded drain: shutdown() awaits the pending-receipt flush so
  // the auto-update restart's process.exit() can't truncate an in-flight redeem.
  await new Promise<void>((resolve) => {
    let shutdownPromise: Promise<void> | null = null;
    let signalShutdownRequested = false;
    let stopUpdateMonitor = (): void => {};
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      console.log("\n  shutting down…");
      stopUpdateMonitor();
      shutdownPromise = drainForShutdown(
        () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeIdleConnections?.();
          }),
        () => vault.flushRedeems(),
        5000
      );
      return shutdownPromise;
    };
    const signalShutdown = (): void => {
      signalShutdownRequested = true;
      void shutdown().then(resolve);
    };
    process.on("SIGINT", signalShutdown);
    process.on("SIGTERM", signalShutdown);
    stopUpdateMonitor = startAutoUpdateMonitor(async () => {
      if (shutdownPromise || signalShutdownRequested) return;
      await shutdown();
      if (signalShutdownRequested) return;
      restartIntoManagedInstall();
    });
  });
}

function bearerOk(req: http.IncomingMessage, expected: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] === expected : false;
}

function collectHaloHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase().startsWith("x-halo-") && typeof v === "string") out[k] = v;
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  // Error reporting must not throw after headers are sent or terminate the daemon.
  try {
    if (res.headersSent || res.writableEnded) {
      res.end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(body));
  } catch (e) {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ failed to send response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Truncate an address for logs (0xabcd…ef01), mirroring the relay/indexer. */
function shortAddr(a?: string | null): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "-";
}

/** Emit one concise completion diagnostic. */
function logReq(info: {
  model: string;
  status: number;
  paid: boolean;
  chargedBase?: string;
  operator?: string | null;
  confidential: boolean;
  ms: number;
  note?: string;
}): void {
  const charged =
    info.chargedBase && /^\d+$/.test(info.chargedBase) ? `$${(Number(info.chargedBase) / 1_000_000).toFixed(4)}` : "$0";
  const statusStr = info.status === 0 ? "---" : String(info.status);
  // eslint-disable-next-line no-console
  console.log(
    `  ▸ ${statusStr} ${info.model} paid=${info.paid} ${charged} op=${shortAddr(info.operator)}${
      info.confidential ? " conf" : ""
    } ${info.ms}ms${info.note ? ` (${info.note})` : ""}`
  );
}

/** Convert a buffered completion to OpenAI SSE, preserving content, tool calls, and finish reason. */
interface BufferedToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
function sendBufferedAsSse(
  res: http.ServerResponse,
  bufferedBody: string,
  haloHeaders: Record<string, string>
): void {
  let parsed: {
    id?: string;
    model?: string;
    created?: number;
    choices?: Array<{
      message?: { role?: string; content?: string | null; tool_calls?: BufferedToolCall[] };
      finish_reason?: string;
    }>;
    usage?: unknown;
  };
  try {
    parsed = JSON.parse(bufferedBody);
  } catch {
    // Not JSON we recognize — fall back to a plain non-stream JSON reply.
    sendJson(res, 200, { error: { message: "upstream returned a non-JSON body", type: "halo_upstream_error" } });
    return;
  }
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content ?? "";
  const toolCalls = choice?.message?.tool_calls;
  const id = parsed.id || "chatcmpl-halo";
  const model = parsed.model || "";
  const created = parsed.created || Math.floor(Date.now() / 1000);
  // Honour the real finish_reason: "tool_calls" when the model asked for a tool,
  // else "stop". Mislabeling it "stop" when tool_calls exist makes the agent
  // ignore the tools.
  const finish = choice?.finish_reason || (toolCalls && toolCalls.length ? "tool_calls" : "stop");
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  try {
    // haloHeaders carries the X-Halo-* metadata (and a JSON content-type we
    // override). SSE content-type must win.
    const sseHeaders: Record<string, string> = {
      ...haloHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    res.writeHead(200, sseHeaders);
    const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    write(chunk({ role: "assistant" }, null));
    if (content) write(chunk({ content }, null));
    // Tool calls: stream each with the `index` the OpenAI delta format requires.
    if (toolCalls && toolCalls.length) {
      write(
        chunk(
          {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: tc.type ?? "function",
              function: {
                name: tc.function?.name,
                arguments: tc.function?.arguments ?? "",
              },
            })),
          },
          null
        )
      );
    }
    write(chunk({}, finish));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    try {
      res.destroy();
    } catch {
      /* gone */
    }
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ SSE write failed: ${errMsg(e)}`);
  }
}

/** Convert rail failures to actionable OpenAI errors whose remedy is in `error.message`. */
function actionableError(
  status: number,
  rawBody: string,
  ctx: { wallet: string; network: string; maxUsd: number; relay: string; confidential: boolean }
): { error: { message: string; type: string; code?: string; walletAddress?: string; network?: string } } {
  let inner = "";
  try {
    const j = JSON.parse(rawBody) as { error?: { message?: string } | string };
    inner = typeof j.error === "string" ? j.error : j.error?.message || "";
  } catch {
    inner = rawBody.slice(0, 200);
  }
  const low = inner.toLowerCase();

  // No operator online for the model.
  if (status === 503 || low.includes("no operators")) {
    const teeHint = ctx.confidential
      ? " For confidential, the model also needs a TEE operator online — check the `confidential` flag per model."
      : "";
    return {
      error: {
        message: `${inner || "No operator is currently serving this model."} → See available models at ${ctx.relay}/v1/models and pick one with operators > 0, or try again shortly.${teeHint}`,
        type: "halo_no_operator",
        code: "no_operator",
      },
    };
  }
  // Per-request cap (operator price exceeds the consumer's ceiling).
  if (low.includes("over_cap") || low.includes("exceeds") || low.includes("cap")) {
    return {
      error: {
        message: `${inner} → The operator's price is above your per-request cap of $${ctx.maxUsd.toFixed(2)}. Raise it with --max-usdc (or the X-Halo-Max-Price header), or route to a cheaper operator.`,
        type: "halo_over_cap",
        code: "over_cap",
      },
    };
  }
  // Put the full wallet address before truncatable payment detail and expose it structurally.
  if (status === 402 || low.includes("insufficient") || low.includes("balance") || low.includes("payment required")) {
    const net = "Base mainnet";
    return {
      error: {
        message: `Payment rejected — fund your consumer wallet with USDC on ${net}: ${ctx.wallet}${inner ? `  (${inner})` : ""}`,
        type: "halo_payment_required",
        code: "insufficient_funds",
        walletAddress: ctx.wallet,
        network: ctx.network,
      },
    };
  }
  // Generic upstream/relay fault.
  return {
    error: {
      message: `${inner || "Upstream request failed."} → Check the relay/operator status (${ctx.relay}/health) and retry; if it persists, the operator serving this model may be down.`,
      type: "halo_upstream_error",
    },
  };
}
