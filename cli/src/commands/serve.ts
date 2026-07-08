/**
 * halo serve — operator process.
 *
 * Opens an outbound WebSocket to the relay, announces models, and handles
 * inference-request messages with full x402 semantics via the configured
 * facilitator (CDP by default).
 */
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
} from "../config";
import { loadWallet } from "../wallet";
import { Facilitator } from "../cdp-facilitator";
import {
  computeActualAmount,
  priceRequest,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  x402Verify,
  x402Settle,
} from "../x402-server";
import { wireFormatFor, isTeeProviderSlug } from "../providers";
import {
  anthropicHeaders,
  anthropicResponseToChatCompletion,
  chatCompletionsToAnthropicRequest,
  OpenAIChatRequest,
} from "../anthropic-adapter";
import { upstreamRatePer1KUsd, upstreamContextLength, estimatePromptTokens } from "../pricing";
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
import { VaultCreditLedger, creditWindowBase, AdmitResult } from "../vaultCredit";
import { OperatorRedeemer } from "../vaultRedeemer";
import { completionCeilingTokens, formatUsdcBase } from "@halo/vault-core";
import { isAddress } from "ethers";
import { decryptSecret, isEncryptedSecret } from "../secret";
import { sanitizeChatRequest, sanitizeMessages } from "../sanitize";
import { installProxyFromEnv } from "../proxy";
import {
  decryptRequest,
  encryptResponse,
  generateOperatorKeypair,
  isEncryptedEnvelope,
  OperatorKeyPair,
} from "../encryption";
import { HALO_VERSION } from "../version";
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
    [k: string]: unknown;
  };
}

// Timeout for the upstream provider fetch. Must be shorter than the relay's
// INFERENCE_TIMEOUT_MS (120s) so the operator can send a proper error response
// instead of letting the relay time out and return 504.
const UPSTREAM_TIMEOUT_MS = 90_000;
// Re-ping local models inside Ollama's default 5-min keep_alive window.
const MODEL_WARM_INTERVAL_MS = 4 * 60_000;
const VAULT_CAPABILITY_RETRY_MS = 60_000;

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

/** Consumer voucher (Phase 1), forwarded verbatim to the facilitator. */
type SignedVoucher = {
  voucher: { budgetId: string; operator: string; cumulative: string; expiry: number };
  signature: string;
};

/**
 * Parse the consumer's base64(JSON) X-Halo-Voucher header into the shape the
 * facilitator expects, or undefined when absent/malformed. The operator forwards
 * it verbatim — it does NOT verify it (the facilitator holds the sessionKey and
 * does the cryptographic check), so a bad header simply degrades to "no voucher".
 */
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

// Consumer→TEE end-to-end-encryption headers (NEAR confidential path). The
// consumer encrypts the message content to the model TEE's key; these carry the
// ephemeral pubkey + scheme. The operator forwards them verbatim to the upstream
// enclave and CANNOT read the content — it relays ciphertext only.
const E2EE_REQ_HEADERS = ["x-client-pub-key", "x-encryption-version", "x-signing-algo"];

// Upstream RESPONSE headers safe to relay back to the consumer (TEE attestation
// / response-signature material for client-side verification). Allowlisted so a
// hostile upstream can't echo arbitrary operator-side metadata. Exact NEAR names
// are confirmed against the live endpoint in the integration spike; the response
// body's chat id also lets the consumer fetch the signature directly from NEAR.
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

/**
 * Confidential (TEE) per-response signature. NEAR's `/v1/signature/{id}` REQUIRES
 * the provider API key (confirmed live; the attestation report is public, this is
 * not). So the operator — which holds the key — fetches it and forwards the
 * {text,signature,signing_address} blob to the consumer; the KEY NEVER LEAVES THE
 * OPERATOR. The consumer fetches the public attestation itself and verifies this
 * signature recovers to the attested signer (ethers.verifyMessage). A malicious
 * operator can't forge it (must recover to the attested address) — only withhold
 * it, in which case client verification fails closed. Returns base64 of the
 * payload, or null on any failure (inference confidentiality is unaffected).
 */
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

async function callUpstream(
  cfg: HaloConfig,
  _apiKey: string | undefined,
  body: InferenceRequestMessage["body"],
  reqHeaders?: Record<string, string>
): Promise<{ status: number; data: unknown; usage: UpstreamUsage; respHeaders: Record<string, string> }> {
  const zeroUsage: UpstreamUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  // Multi-provider: the model in the body picks the gateway + key (a single
  // operator may front several). `_apiKey` is retained for signature stability
  // but the resolved provider's own key is authoritative.
  const { provider, apiKey } = resolveProvider(cfg, body);
  const wire = wireFormatFor(provider.slug);
  const base = provider.baseUrl.replace(/\/+$/, "");

  // Privacy boundary: strip consumer-identifying or tracking metadata from
  // the request body before it leaves the operator's process. The allowlist
  // applies to both wire formats — for the anthropic path the chat→messages
  // translator already picks its own fields, but sanitizing first means we
  // never carry stripped fields through any code path that touches the body.
  const { sanitized, report } = sanitizeChatRequest(body);
  if (sanitized.messages !== undefined) {
    sanitized.messages = sanitizeMessages(sanitized.messages);
  }
  // This is the BUFFERED call — it parses one JSON response. `stream` is in
  // the sanitizer allowlist, so a consumer's stream:true would otherwise reach
  // the upstream, make it answer SSE, and break the parse. Strip it here;
  // streaming requests go through streamUpstream (which forces stream:true).
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
        status: 500,
        data: { error: { message: "anthropic provider requires an API key" } },
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

  // On non-2xx, never pass the raw upstream body to the consumer. A misbehaving
  // or hostile upstream (custom proxy, self-hosted gateway, dev fork) could echo
  // request headers or other operator-side metadata in its error body. We
  // sanitize to a fixed safe shape — `message`/`type`/`code` only, all coerced
  // to strings — and log the full original to operator stderr so the operator
  // can still debug locally.
  if (!res.ok) {
    // Auth failures are almost always a stale/wrong key configured for THIS
    // provider — name it explicitly (with a masked fingerprint of the key that
    // was actually sent) so the operator can compare against a known-good key
    // and re-set the right gateway, instead of seeing a generic browser error.
    if (res.status === 401 || res.status === 403) {
      const masked = apiKey
        ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)} (len ${apiKey.length})`
        : "(no key sent)";
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
    return {
      status: res.status,
      data: sanitizeUpstreamError(parsed, res.status),
      usage: zeroUsage,
      respHeaders: {},
    };
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

/**
 * Streaming upstream call (Phase 2.2) — OpenAI wire format only. Calls upstream
 * with stream:true + usage, parses the SSE deltas, invokes `onDelta(deltaObj)`
 * for each content delta (the caller seals + forwards it), and captures the
 * final usage. Returns ok:false with a sanitized error body when upstream fails;
 * the caller falls back to (or surfaces) a buffered error. Anthropic wire and
 * non-streaming requests use the buffered `callUpstream` path unchanged.
 */
async function streamUpstream(
  cfg: HaloConfig,
  _apiKey: string | undefined,
  body: InferenceRequestMessage["body"],
  onDelta: (deltaObj: unknown) => void
): Promise<{ status: number; usage: UpstreamUsage; ok: boolean; errorData?: unknown }> {
  const zeroUsage: UpstreamUsage = { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 };
  const { sanitized } = sanitizeChatRequest(body);
  if (sanitized.messages !== undefined) sanitized.messages = sanitizeMessages(sanitized.messages);
  // Per-model provider resolution (multi-provider operators) — see callUpstream.
  const { provider, apiKey } = resolveProvider(cfg, body);
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
    return { status: 504, usage: zeroUsage, ok: false, errorData: { error: { message: msg } } };
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
    if (process.env.HALO_DEBUG_UPSTREAM_ERRORS === "1") {
      // Terminal-only: the body can echo the prompt, so it must not hit serve.log.
      debugToTerminal(`  upstream(stream) ${res.status} body: ${text.slice(0, 2000)}`);
    }
    return { status: res.status, usage: zeroUsage, ok: false, errorData: sanitizeUpstreamError(parsed, res.status) };
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
    return {
      status: 502,
      usage,
      ok: false,
      errorData: { error: { message: err instanceof Error ? err.message : String(err) } },
    };
  }
  clearTimeout(timer);
  return { status: 200, usage, ok: true };
}

/**
 * Strip an upstream error body down to a fixed safe shape. Preserves the
 * standard OpenAI-error fields (`message`, `type`, `code`) when present and
 * non-empty strings — drops everything else. Prevents a hostile or
 * misconfigured upstream from leaking operator-side request metadata back to
 * the consumer.
 */
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

// Reconnect strategy: try forever by default, with exponential backoff capped
// at BACKOFF_MAX_MS. A successful connect (we got an "announce" through)
// resets the counter so a long-running operator that flakes once doesn't
// accumulate failures across days.
//
// Earlier versions hard-capped at 10 attempts and then `process.exit(1)`.
// That hurt persistence: a 5-minute network outage or a relay redeploy was
// enough to silently drop the operator offline permanently. Now the default
// is unlimited — the only ways serve stops are SIGINT/SIGTERM or an explicit
// --max-reconnect-attempts limit. For unattended operators this is the right
// default; for CI smoke tests you can still set a cap.
//
// BASE = 500ms because a clean disconnect is usually a momentary blip; we'd
// rather come back online in half a second than wait a full one.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 0; // 0 = unlimited

/** Resolve the reconnect-attempt cap. Env var HALO_MAX_RECONNECT_ATTEMPTS wins, then default. */
function resolveMaxReconnectAttempts(): number {
  const envVal = process.env.HALO_MAX_RECONNECT_ATTEMPTS;
  if (envVal !== undefined) {
    const n = parseInt(envVal, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_MAX_RECONNECT_ATTEMPTS;
}

// Application-level keepalive between the operator and the relay. The `ws`
// library auto-pongs at the protocol layer, but that doesn't tell *us* the
// relay is still reachable — so we send `{type:"ping"}` on a timer and
// expect `{type:"pong"}` back, force-closing the socket if the relay falls
// silent.
//
// 5s ping cadence (was 10s): keeps the connection actively non-idle from the
// perspective of any intermediate proxy / NAT / Fly edge that might prune
// "quiet" connections at 30-60s idle. Doubling the rate is cheap (2 ws frames
// of ~30 bytes per peer per second relay-wide) and dramatically shrinks the
// window where a silently-dead connection goes undetected.
//
// 12s pong timeout (was 15s): still > 2× ping interval, so a single dropped
// ping doesn't false-evict, but cuts detection lag if pings stop landing.
const WS_PING_INTERVAL_MS = 5_000;
const WS_PONG_TIMEOUT_MS = 12_000;

function backoffDelayMs(attempt: number): number {
  // attempt is 1-indexed (first retry = 1)
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}

export async function cmdServe(): Promise<void> {
  installProxyFromEnv(); // honor HTTP(S)_PROXY for upstream/relay/facilitator calls
  const cfg = loadConfig();

  // Point vault reads + receipt verification at the configured vault (defaults to
  // the consensus-pinned address). Throws on a malformed override so a typo fails
  // here rather than silently rejecting every vault request at serve time.
  setActiveVaultAddress(cfg.vaultAddress);

  // File logging + PID file. Both survive terminal close and process exit
  // so post-hoc diagnosis works (Hermes / doctor / `tail -f`). Rotation is
  // size-based: when the active log crosses LOG_ROTATE_BYTES we move it to
  // serve.log.1 (overwriting any previous .1) and open a fresh one. Keeps
  // disk usage bounded at ~2 × LOG_ROTATE_BYTES.
  setupFileLogging();
  writePidFile();

  // Unattended mode: the operator opted out of a wallet passphrase at setup
  // time. The keystore was created with empty-string encryption so we can
  // unlock it without prompting. The security trade-off was documented and
  // accepted then; no point repeating the warning every restart.
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

  // Probe vault-read capability in parallel with the rest of startup so a slow
  // RPC never delays the relay connection. Using the operator as both keys is a
  // harmless read: an empty reservation still proves RPC + pinned-vault access.
  // A failed probe is retried while connected; success re-announces on the live
  // socket, so a transient boot failure does not latch until process restart.
  let vaultPayments = false;
  let vaultProbeInFlight: Promise<boolean> | null = null;
  const probeVaultCapability = (): Promise<boolean> => {
    if (vaultPayments) return Promise.resolve(true);
    if (vaultProbeInFlight) return vaultProbeInFlight;
    const probe = readReservation(cfg.operator.address, cfg.operator.address)
      .then(() => {
        vaultPayments = true;
        return true;
      })
      .catch((err) => {
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

  // Resolve the plaintext upstream API key(s) for this serve session. Two
  // on-disk shapes are supported per provider:
  //   - plaintext string (legacy / explicit opt-out)
  //   - EncryptedSecret  → decrypted with the keystore passphrase we just used
  //                        to unlock the wallet (same passphrase, same scrypt
  //                        KDF as encryptSecret in setup).
  // A multi-provider operator may carry several keys (e.g. OpenRouter + NEAR);
  // each is decrypted IN PLACE on the runtime config object so `resolveProvider`
  // hands `callUpstream` a usable Bearer token per model. The plaintext lives
  // only in this process for its lifetime; the on-disk config is unchanged.
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
  // Back-compat handle still referenced by warm-up + a few call sites.
  const upstreamApiKey: string | undefined =
    typeof cfg.provider.apiKey === "string" ? cfg.provider.apiKey : undefined;
  // Per-provider key fingerprint so the operator can eyeball that the RIGHT key
  // is loaded for each gateway (the #1 cause of upstream 401s is a stale/rotated
  // key in the running process vs the one the operator tests by hand). Masked —
  // first 6 + last 4 + length — never the full secret.
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

  // Live auth probe: settle "is the stored key valid?" with the upstream itself,
  // BEFORE any consumer request, so a stale/typo'd key (which looks right in the
  // masked fingerprint — same prefix/suffix/length, different middle) surfaces as
  // a clear startup failure instead of a confusing "Invalid or expired API key"
  // in the consumer's browser. One ~free 1-token call per keyed openai-compat
  // provider; best-effort (a network blip just skips, never blocks serve).
  await Promise.all(
    configProviders(cfg).map(async (p) => {
      const k = typeof p.apiKey === "string" ? p.apiKey : undefined;
      if (!k || wireFormatFor(p.slug) !== "openai-compat") return; // skip keyless/local + anthropic-wire
      const model = p.models[0];
      if (!model) return;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const res = await fetch(`${p.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "." }], max_tokens: 1 }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (res.status === 401 || res.status === 403) {
          console.error(
            `  ✖ ${p.slug}: upstream REJECTED the stored key (HTTP ${res.status}) — ${maskKey(k)}.`
          );
          console.error(
            `    This is the key actually loaded for "${p.slug}"; the upstream says it's invalid. ` +
              `Compare it to a key that works in a direct curl (a 1-char typo keeps the same length/prefix). ` +
              `Re-set: halo setup --add-provider --provider ${p.slug} --api-key <key>  then restart serve.`
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

  // Generate the session-scoped X25519 keypair for end-to-end prompt
  // encryption. The pubkey rides in `announce`; the privkey lives only in
  // this process for the lifetime of `serve`. On process restart both are
  // gone — past ciphertext is provably unbreakable, even by us.
  const encryptionKeys: OperatorKeyPair = generateOperatorKeypair();
  console.log(`  ✓ E2E encryption pubkey ${encryptionKeys.publicKeyHex.slice(0, 16)}…`);

  // Bind the E2E pubkey to the operator's on-chain identity: sign
  // `halo-pubkey:{address}:{pubkey}` once (the pubkey is stable for this serve
  // process). The relay forwards this to consumers so they can verify the key is
  // genuinely ours — a relay can't substitute its own key to read plaintext
  // (MITM) without an operator signature it can't forge. Normalized (no 0x,
  // lowercase) to match what the relay reconstructs from the announced pubkey.
  const pubkeyNorm = encryptionKeys.publicKeyHex.replace(/^0x/, "").toLowerCase();
  const pubkeyAttestation = await wallet.signMessage(
    `halo-pubkey:${cfg.operator.address.toLowerCase()}:${pubkeyNorm}`
  );

  const facilitator = new Facilitator(
    cfg.facilitator.url,
    cfg.facilitator.apiKey,
    cfg.facilitator.failoverUrls
  );

  // Operator-driven vault redeem (issue #369): the operator holds the consumer's
  // signed cumulative receipts, bounds un-receipted serving via a per-consumer
  // credit window, and redeems the receipts itself (with retry) — so served work
  // can never go uncollected because a consumer didn't bother to redeem.
  const creditLedger = new VaultCreditLedger();
  const redeemer = new OperatorRedeemer(cfg.facilitator.url, creditLedger, (m) => console.log(m));
  // Periodic sweep: re-attempt any receipt whose redeem failed transiently and
  // got no follow-up receipt, so it's collected before the reservation expires.
  const redeemSweep = setInterval(() => redeemer.sweep(), 30_000);
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
    // Seed the collectable ceiling from this FRESH (uncached) on-chain read before
    // recording, so a receipt whose cumulative runs past the reservation frees the
    // credit window only up to what it can actually redeem (`redeemed + locked`),
    // never the uncollectable tail (#437).
    creditLedger.syncOnchain(consumer, cfg.operator.address, v.cycle, v.redeemed, v.locked);
    if (creditLedger.recordReceipt(consumer, cfg.operator.address, { cumulative, signature, cycle: v.cycle })) {
      redeemer.kick(consumer, cfg.operator.address);
    }
    return true;
  };

  // Warm the facilitator address cache at startup so the first inference
  // request doesn't pay the latency of a /supported fetch.
  const facilitatorAddress = await facilitator.getFacilitatorAddress();
  if (facilitatorAddress) {
    console.log(`  ✓ facilitator address ${abbrevAddr(facilitatorAddress)} (upto scheme enabled)`);
  } else {
    console.log(`  ⚠ facilitator /supported not available — falling back to exact scheme`);
  }

  // Keep LOCAL models resident so the first paid inference doesn't also pay a
  // cold model load (Ollama unloads after ~5 min idle; LM Studio JIT-loads).
  // Hosted providers are always warm and a ping there costs real money — never
  // ping them. Fire-and-forget; a failed warm just means a slower first serve.
  // Multi-provider: warm only the local providers' models (callUpstream routes
  // each ping to its provider by model).
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
          // best-effort
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
    // Best-effort: collect any held receipts before exit (issue #369), bounded
    // so shutdown never hangs on a slow facilitator. Auto-update deliberately
    // uses this exact same drain as an operator-requested restart.
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

  // Run the WS lifecycle. Resolves when the socket closes; never rejects —
  // failures bubble up as a close event so the supervisor can decide whether
  // to retry. Returns true if we got far enough to announce (which resets
  // the retry counter).
  const runOnce = (): Promise<{ announced: boolean }> =>
    new Promise((resolve) => {
      let announced = false;
      // Flag flipped by the close handler. Async inference handlers check this
      // before calling x402Settle — if the WS dropped mid-request (relay
      // superseded our peer, network blip, etc.), we MUST NOT settle. The
      // consumer can no longer receive the response, so charging them would
      // be theft. This is checked at multiple points because settle is the
      // last thing that runs and the WS can close at any point during the
      // upstream call.
      let wsClosed = false;
      console.log(`  connecting to relay: ${wsUrl}`);
      const ws = new WebSocket(wsUrl, {
        perMessageDeflate: false, // small JSON frames don't compress; skip the CPU cost
        handshakeTimeout: 10_000, // fail upgrade fast if relay is unreachable
        headers: { "X-Halo-Cli-Version": HALO_VERSION },
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
        // TCP keepalive: OS sends probes every 3s (was 5s) so dead sockets
        // are detected at the kernel level fast. Combined with the app-level
        // 5s ping/pong above, the operator catches silent drops in ~6-12s
        // worst case rather than the previous ~15-25s.
        // setNoDelay disables Nagle so ping frames are sent immediately.
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
            const announceModels = allConfiguredModels(cfg);
            // Models served by a TEE provider → advertised as confidential-capable
            // so the relay can classify TEE PER MODEL (a multi-provider operator
            // may serve openrouter + near; only the near models are confidential).
            const teeModels = providers
              .filter((p) => isTeeProviderSlug(p.slug))
              .flatMap((p) => p.models);
            ws.send(
              JSON.stringify({
                type: "announce",
                data: {
                  address: cfg.operator.address,
                  cliVersion: HALO_VERSION,
                  // Primary slug (back-compat single-provider classification).
                  provider: cfg.provider.slug,
                  // Every distinct provider slug this operator fronts.
                  providers: [...new Set(providers.map((p) => p.slug))],
                  models: announceModels,
                  // Subset of `models` that route to a hardware-TEE provider.
                  teeModels: [...new Set(teeModels)],
                  pricing: await buildPricingAnnounce(cfg),
                  // Per-model context window (tokens) so the relay's /v1/models
                  // can expose it for agents to size context / decide compression.
                  contextLength: await buildContextLengthAnnounce(cfg),
                  // We serve stream:true vault requests as inference-chunk
                  // frames on the OpenAI wire (streamUpstream doesn't speak
                  // the anthropic SSE shape). Consumers gate stream:true on
                  // this flag so operators without it never receive the flag.
                  // True when ANY provider speaks the OpenAI wire; per-request
                  // serving still re-checks the model's own provider.
                  streaming: providers.some((p) => wireFormatFor(p.slug) !== "anthropic"),
                  // Rollout capability marker: the relay routes vault-mode requests
                  // ONLY to operators that announce on-chain reservation verification —
                  // there is NO legacy fallback (a vault reservation is bound on-chain
                  // to a specific operator, so a legacy operator can't honor it). While
                  // a model has no eligible operator, vault requests for it 503
                  // (no_vault_operator); non-vault requests are unaffected.
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
                `  ✓ announced as ${abbrevAddr(cfg.operator.address)} (${providers.map((p) => p.slug).join("+")}, ${announceModels.length} models${teeModels.length ? `, ${new Set(teeModels).size} confidential` : ""})`
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
          if (!initialVaultCapability) {
            void (async () => {
              while (!shuttingDown && !wsClosed) {
                if (await probeVaultCapability()) {
                  if (ws.readyState !== WebSocket.OPEN || wsClosed) return;
                  try {
                    await sendAnnouncement(true, true);
                    return;
                  } catch (err) {
                    logError("vault capability re-announce failed; will retry", err);
                  }
                }
                await new Promise((resolve) =>
                  setTimeout(resolve, VAULT_CAPABILITY_RETRY_MS)
                );
              }
            })();
          }
          if (!heartbeatStarted) {
            heartbeatStarted = true;
            startHeartbeat(cfg, wallet).catch((err) =>
              logError("heartbeat loop crashed", err)
            );
          }
          return;
        }

        // Consumer-pushed cumulative receipt for prior vault work, routed by the
        // relay (operator-driven redeem, issue #369). Off the serve path: verify,
        // record (frees the credit window), and collect. The tail of a burst (no
        // follow-up request to piggyback on) relies on this dedicated push.
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

        if (msg.type !== "inference-request") return;
        const req = msg as InferenceRequestMessage;
        const requestStartedAt = Date.now();

        // Early bail: if the WS is already gone by the time the handler runs,
        // there's nothing useful we can do. Don't decrypt, don't verify, don't
        // call upstream (which would cost the operator real money for a request
        // that can't be answered), don't settle.
        if (wsClosed || ws.readyState !== WebSocket.OPEN) {
          console.warn(
            `  ⚠ WS closed before inference-request could be processed; aborting (consumer not charged)`
          );
          return;
        }

        // ── E2E decryption (Phase 0) ────────────────────────────────────────
        // If the consumer sent an `_enc` envelope, decrypt it now so the rest
        // of the handler sees a normal OpenAI-compat body. The relay tunneled
        // ciphertext blindly; we are the first party in the chain that can
        // read the prompt.
        //
        // The outer body carries `model` in cleartext (the relay needs it for
        // routing). The decrypted plaintext carries everything else.
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
        // Completion ceiling drives the prompt-blind 402 quote. The consumer
        // sends max_tokens on BOTH the challenge probe and the retry, so this
        // value is identical across the two calls and the quote stays stable.
        // NB: this feeds the x402/exact quote too, where the consumer pays the
        // QUOTE (not actual) — so it must stay the raw request budget. The vault
        // gate applies its own reasoning-headroom ceiling below (#421); it can,
        // because vault settles ACTUAL (never the quote).
        const estimatedCompletionTokens =
          typeof req.body.max_tokens === "number" ? req.body.max_tokens : 500;
        let out: { status: number; headers: Record<string, string>; body: unknown };

        // Payment-mode detection. Budget mode (Permit2 pre-authorization) and
        // per-request mode (EIP-3009 single-use) coexist; the consumer's
        // x-halo-payment-mode header (default "exact") picks. See
        // docs/BUDGET_MODE.md.
        // Normalize identically to the relay (trim + lowercase) so a whitespace
        // variant like "vault " can't fall through to the exact/x402 path after
        // the relay already routed it as vault. The relay normalizes before
        // forwarding too; this is defense-in-depth for any non-relay caller.
        const paymentMode = (
          (req.headers["x-halo-payment-mode"] as string) || "exact"
        )
          .trim()
          .toLowerCase();

        // Confidential (TEE) E2EE request: the consumer encrypted the content to
        // the upstream enclave's key (NEAR). We forward the E2EE headers + the
        // upstream's response signature untouched, and force the BUFFERED path so
        // the model TEE's byte-exact response signature survives (the relay
        // re-frames streamed SSE, which would invalidate it).
        // A confidential request is signalled by the consumer's E2EE client
        // pubkey (the canonical marker; x-encryption-version is an alt some
        // clients send). Drives the signature fetch + buffered path.
        const teeRequest =
          typeof req.headers["x-client-pub-key"] === "string" ||
          typeof req.headers["x-encryption-version"] === "string";
        const reqHeaders = req.headers as Record<string, string>;

        // Credit-window reservation held across this serve (issue #369): set when
        // a vault request is admitted, cleared once it's settled/released. The
        // catch releases it so a thrown serve can't strand the window.
        let creditAdmitted: { consumer: string; ceiling: bigint; cycle: bigint } | null = null;
        let creditAdmit: AdmitResult;

        try {
          if (paymentMode === "vault") {
            // ── VAULT MODE PATH (RFC v2) ──────────────────────────────────
            // The consumer has locked funds on-chain reserved exclusively to
            // this operator and settles afterward with a session-key receipt
            // (the facilitator submits it). We GATE: read the on-chain
            // reservation and refuse unless it covers this request's cost
            // ceiling and hasn't expired — so we never serve value we can't
            // collect. No x402 verify/settle on this path.
            const consumerAddr = (req.headers["x-halo-vault-consumer"] || "").toLowerCase();
            const fmtUsd = (b: bigint) => formatUsdcBase(b, { withDollarSign: true });
            if (!isAddress(consumerAddr)) {
              out = {
                status: 400,
                headers: {},
                body: { error: { message: "vault mode requires a valid X-Halo-Vault-Consumer header" } },
              };
            } else {
              // Piggybacked receipt for prior work (issue #369): `x-halo-receipt`
              // is base64(JSON{cumulative, signature}) for THIS consumer. Process
              // it BEFORE gating so a receipt riding on this request frees the
              // credit window in time to admit it. Free for mid-burst calls; the
              // burst tail uses the dedicated WS `receipt` push instead.
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
              // Cost ceiling = exact prompt tokens + the completion ceiling.
              // Size the completion ceiling with reasoning headroom (#421): a small
              // max_tokens does not bound a reasoning model's reasoning tokens, so
              // gating on max_tokens alone under-prices the ceiling and the operator
              // undercollects. SHARED with the consumer's reserve sizing
              // (@halo/vault-core `completionCeilingTokens`) so the reservation covers
              // this gate price without a reserve-and-replay round trip (invariant
              // #5/#7). Vault-only: unlike the x402/exact quote above, the vault path
              // settles ACTUAL (capped to this ceiling), so headroom never overcharges
              // — it only reserves/locks more (reclaimable). Deterministic in the
              // request body, so the challenge-probe and retry quotes still match.
              const vaultCompletionCeiling = completionCeilingTokens(
                requestedModel,
                estimatedCompletionTokens,
                typeof req.body.max_completion_tokens === "number"
                  ? req.body.max_completion_tokens
                  : undefined
              );
              const ceilingCost = await priceRequest({
                cfg,
                model: requestedModel,
                promptTokens: estimatePromptTokens((req.body as { messages?: unknown }).messages),
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
                out = {
                  status: 402,
                  headers: {},
                  body: {
                    error: {
                      message: `Vault reservation insufficient: ${chk.reason}. This request needs up to ${fmtUsd(ceilingCost)} reserved; reserve more from your vault.`,
                      type: "vault_reservation_insufficient",
                      requiredUsdcBase: ceilingCost.toString(),
                      remainingUsdcBase: chk.remaining.toString(),
                      vault: getVaultAddress(),
                    },
                  },
                };
              } else {
                // Window = configured credit cap, never above the on-chain
                // collectible (`locked`) — we won't float more than funds exist
                // to back. Caps the ACCUMULATION of un-receipted work; a lone
                // request larger than the window is still admitted (bounded by
                // `locked`), so worst-case ghosting loss is max(window, one
                // request's ceiling) — see vaultCredit.ts admit().
                // Recomputed from `chk` so a stale-cycle refresh below uses the
                // refreshed reservation's `remaining`.
                const creditWindow = (): bigint =>
                  creditWindowBase() < chk.remaining ? creditWindowBase() : chk.remaining;
                // Align process-local cumulative accounting with the durable
                // on-chain baseline before the synchronous admission check —
                // `redeemed` and `locked` (== chk.remaining) together bound the
                // collectable ceiling a held receipt may free the window to (#437).
                creditLedger.syncOnchain(consumerAddr, cfg.operator.address, chk.cycle, chk.redeemed, chk.remaining);
                creditAdmit = creditLedger.admit(
                  consumerAddr,
                  cfg.operator.address,
                  chk.cycle,
                  ceilingCost,
                  creditWindow()
                );
                if (!creditAdmit.ok && creditAdmit.stale) {
                  // Our cached reservation view lagged a cycle bump: a receipt for
                  // the NEW generation advanced the ledger (via the uncached verify
                  // path) while this request read the gate cache. Don't serve on
                  // stale coverage or strand the window — drop the cache, refresh
                  // from chain, and re-gate ONCE against the current cycle.
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
                // Reservation covers it — serve. stream:true pumps deltas to
                // the consumer as inference-chunk frames (relay → SSE). Unlike
                // budget mode this needs no opt-in flag: the reservation
                // already locks funds on-chain BEFORE serving, and redeem
                // happens after delivery on the buffered path too — streaming
                // adds no new funds risk.
                const wantsVaultStream =
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
                  const sres = await streamUpstream(cfg, upstreamApiKey, req.body, (deltaObj) => {
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
                  upstream = {
                    status: sres.status,
                    data: sres.ok ? { streamed: true } : sres.errorData,
                    usage: sres.usage,
                    respHeaders: {},
                  };
                } else {
                  upstream = await callUpstream(cfg, upstreamApiKey, req.body, reqHeaders);
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
                  // Price the actual usage, then cap it to THIS request's gated
                  // ceiling (issue #421). `ceilingCost` is what the serve gate
                  // verified against the reservation and what the credit ledger
                  // reserved as in-flight (`admit`), so capping here keeps
                  // `settleServed` symmetric with the admission — it never books
                  // more `served` than was gated. A small `max_tokens` gate never
                  // bounds a reasoning model's reasoning tokens, so the priced
                  // actual can exceed the ceiling; awarding the uncapped price would
                  // over-count the credit ledger and strand a permanent txHash:null
                  // indexer row (the consumer's cumulative receipt is itself capped
                  // to locked+redeemed). `ceilingCost <= chk.remaining` (the gate
                  // required it to admit), so the cap is always collectible on-chain
                  // too. Mirrors the budget (witnessCap) and x402
                  // (computeActualAmount) paths, which cap actual settlement to the
                  // per-request ceiling.
                  const uncappedAmount = await priceRequest({
                    cfg,
                    model: requestedModel,
                    promptTokens: upstream.usage.prompt_tokens,
                    completionTokens: upstream.usage.completion_tokens,
                    cachedPromptTokens: upstream.usage.cached_prompt_tokens,
                  });
                  const actualAmount = collectibleServeAmount(uncappedAmount, ceilingCost);
                  if (uncappedAmount > actualAmount) {
                    console.warn(
                      `  ⚠ vault-served at a loss on ${req.requestId}: actual cost ${fmtUsd(uncappedAmount)} (${upstream.usage.completion_tokens} completion tok) exceeds this request's reserved ceiling ${fmtUsd(ceilingCost)}; collecting ${fmtUsd(actualAmount)} — the model's output ran past the reserved headroom for "${requestedModel}" (raise the reservation ceiling for this model)`
                    );
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
                          tokens: upstream.usage.total_tokens,
                          operator: cfg.operator.address,
                        }),
                        "utf-8"
                      ).toString("base64"),
                    },
                    body: encryptIfNeeded(upstream.data),
                  };
                  // Discount what we just served from the cached reservation
                  // headroom so the gate cache never approves past coverage.
                  noteServed(consumerAddr, cfg.operator.address, actualAmount);
                  // True up the credit window: replace this request's reserved
                  // ceiling with its ACTUAL served cost (issue #369).
                  creditLedger.settleServed(consumerAddr, cfg.operator.address, chk.cycle, ceilingCost, actualAmount);
                  creditAdmitted = null;
                  console.log(
                    `  ✓ vault-served ${req.requestId} for ${abbrevAddr(consumerAddr)} — ${fmtUsd(actualAmount)} (${upstream.usage.total_tokens} tok); awaiting redeem`
                  );
                  // Fire-and-forget indexer event. txHash is null — the redeem
                  // happens async (consumer-driven); the verifier reconciles.
                  const durationMs = Date.now() - requestStartedAt;
                  const eventPayload = {
                    id: req.requestId,
                    operator: cfg.operator.address,
                    consumer: consumerAddr,
                    model: req.body.model ?? null,
                    tokens: upstream.usage.total_tokens,
                    amountUsdc: actualAmount.toString(),
                    durationMs,
                    timestamp: Date.now(),
                    txHash: null,
                    mode: "vault" as const,
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
            // ── BUDGET MODE PATH ──────────────────────────────────────────
            // Consumer pre-authorized a Permit2 budget; this inference draws
            // down per-prompt amount via /settle-budget. No 402 dance, no
            // per-request signature verification — the facilitator validates
            // the budget on every settle call.
            const sigHeader = req.headers["payment-signature"];
            if (!sigHeader) {
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

              // Budget mode is operator-unbound — the facilitator selects
              // which operator can settle (via the relay's routing). The
              // operator processes whatever budget-mode request the relay
              // forwards and tags itself as the recipient at settle time.

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

              // Operator self-protection: never serve at a GUARANTEED loss. The
              // consumer's signed per-settlement cap is the most we can collect
              // for this step. If the INPUT cost alone (exact prompt tokens,
              // margin included) already meets/exceeds that cap, any completion
              // makes us lose money — so reject up front with an actionable
              // error instead of serving and silently capping to a loss. (A big
              // COMPLETION can still push actual over the cap after the fact;
              // that case is logged as a loss at settle time below.)
              const witnessCap = BigInt(budgetPayload.policy.maxPerSettlement);
              const fmtUsd = (b: bigint) => formatUsdcBase(b, { withDollarSign: true });
              const inputFloor = await priceRequest({
                cfg,
                model: requestedModel,
                promptTokens: estimatePromptTokens(
                  (req.body as { messages?: unknown }).messages
                ),
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

              // Streaming (Phase 2.2): pump deltas to the consumer as they arrive
              // when the operator enabled it (HALO_ENABLE_STREAMING) AND the
              // consumer asked (stream:true) AND the provider uses the OpenAI
              // wire. Each delta is sealed per-chunk by reusing encryptResponse.
              // Bounded funds-safety tradeoff — content is delivered BEFORE
              // settle — so it's operator-opt-in until escrow locks funds.
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
                // Price the actual usage, then cap at the witness per-settlement
                // limit (defense-in-depth; the facilitator also enforces it).
                // We compute the UNCAPPED price first so a completion that pushes
                // cost over the cap is surfaced as a loss — the pre-serve floor
                // only catches input-only overruns, so this is the post-hoc
                // signal that the consumer's per-prompt cap is too low.
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

                  // Fire-and-forget indexer event for league attribution.
                  const durationMs = Date.now() - requestStartedAt;
                  const eventPayload = {
                    id: req.requestId,
                    operator: cfg.operator.address,
                    // The facilitator recovers the real consumer (budget owner)
                    // from the permit signature and returns it on permitSubmit.
                    // Fall back to the operator only if an older facilitator
                    // didn't supply it (keeps league attribution correct).
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

          // ── PER-REQUEST MODE PATH (unchanged) ───────────────────────────
          // Phase 1: verify payment (no money movement).
          // The 402 quote is intentionally PROMPT-BLIND. The consumer's first
          // (challenge) request sends only { model, max_tokens } — the prompt
          // never crosses the wire in plaintext (E2E privacy), so the operator
          // cannot see prompt tokens at quote time. We therefore quote on the
          // completion ceiling alone and MUST re-verify on the same basis,
          // otherwise the retry (which carries the decrypted prompt) re-prices
          // higher than the consumer signed and the payment is wrongly rejected
          // (signed < required). In `exact` mode the operator collects exactly
          // the signed amount regardless, so prompt-blind quoting costs nothing
          // here; token-accurate per-prompt billing is what budget mode (Permit2
          // sign-a-cap / settle-actual) is for. See docs/BUDGET_MODE.md.
          const verified = await x402Verify({
            cfg,
            facilitator,
            paymentSignatureHeader: req.headers["payment-signature"],
            requestPath: req.path,
            pricing: {
              cfg,
              model: requestedModel,
              promptTokens: 0,
              completionTokens: estimatedCompletionTokens,
            },
            facilitatorAddress,
          });

          if (verified.kind === "challenge") {
            out = {
              status: 402,
              headers: {
                "PAYMENT-REQUIRED": encodePaymentRequiredHeader(verified.paymentRequired),
              },
              body: {
                error: "payment required",
                amount: verified.paymentRequired.maxAmountRequired,
                asset: verified.paymentRequired.asset,
                network: verified.paymentRequired.network,
              },
            };
          } else if (verified.kind === "rejected") {
            out = {
              status: 402,
              headers: {
                "PAYMENT-REQUIRED": encodePaymentRequiredHeader(verified.paymentRequired),
              },
              body: { error: "payment rejected", reason: verified.reason },
            };
          } else {
            // Phase 2: run inference, then settle with actual token usage.
            // Last-ditch check before spending real operator money on the
            // upstream call. x402Verify above involves HTTP to the facilitator
            // and can take a moment; the WS may have closed during it.
            if (wsClosed || ws.readyState !== WebSocket.OPEN) {
              console.warn(
                `  ⚠ WS closed after verify but before upstream call; aborting (no upstream charge to operator, no settlement to consumer)`
              );
              return;
            }
            const upstream = await callUpstream(cfg, upstreamApiKey, req.body, reqHeaders);

            // Encrypt the response body if the consumer used E2E. Shared
            // between success and failure paths — failure responses (errors
            // from the upstream) are also encrypted when E2E was requested.
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
              // Upstream failed (rate limit, auth error, model unavailable,
              // provider outage, malformed response, …). Do NOT settle —
              // the consumer should not pay for an inference that didn't run.
              //
              // The signed Permit2 / EIP-3009 authorization expires harmlessly
              // at `validBefore`; no money moves; no gas burned. The consumer
              // is free to retry with the same wallet (against this operator
              // once it recovers, or against a different one).
              //
              // The whole point of the x402 `upto` scheme is to defer the
              // settlement decision until after inference; this is the
              // failure-branch use of that capability. Indexer event-post is
              // also skipped — league points only accrue on settled work.
              console.warn(
                `  ⚠ upstream ${upstream.status}; skipping settlement (consumer not charged)`
              );
              out = {
                status: upstream.status,
                // No PAYMENT-RESPONSE header — nothing was settled. The
                // consumer's frontend sees the absence and knows the
                // signature is still spendable until validBefore.
                headers: {},
                body: encryptIfNeeded(upstream.data),
              };
            } else {
              // Inference succeeded. Charge only for tokens actually consumed
              // (upto invariant: actual ≤ signed max).
              //
              // CRITICAL: before settling, confirm our WebSocket to the relay
              // is still open. If it dropped during the async upstream call
              // (relay superseded us, network blip, etc.), the consumer can
              // never receive the response — charging them would be theft.
              // The relay has already returned 504 "operator dropped" to the
              // consumer by the time we get here in that case. Skip settlement,
              // skip the indexer event, and exit the handler cleanly.
              if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                console.warn(
                  `  ⚠ WS closed mid-request after upstream succeeded; skipping settlement (consumer not charged for an undeliverable response)`
                );
                return;
              }

              const actualAmount = await computeActualAmount(
                {
                  cfg,
                  model: requestedModel,
                  promptTokens: upstream.usage.prompt_tokens,
                  completionTokens: upstream.usage.completion_tokens,
                  cachedPromptTokens: upstream.usage.cached_prompt_tokens,
                },
                verified.signedAmount
              );

              // Settle after inference — money only moves if we got here.
              const settlement = await x402Settle({
                facilitator,
                payload: verified.payload,
                paymentRequired: verified.paymentRequired,
                actualAmount,
              });

              // Belt-and-suspenders: x402Settle is an HTTP call to the
              // facilitator and can take seconds. If the WS dropped during it,
              // the settlement itself completed onchain (irreversible) but at
              // least log the inconsistency so we can investigate. There's
              // no in-protocol way to undo an already-completed settlement.
              if (wsClosed || ws.readyState !== WebSocket.OPEN) {
                console.error(
                  `  ⚠⚠ WS closed during x402Settle call; settlement tx ${settlement.transaction || "?"} ` +
                    `may have completed onchain but the response can no longer reach the consumer`
                );
                // Don't try to send response back; don't post event either.
                return;
              }

              if (!settlement.success) {
                // Settlement failed (e.g. authorization expired during a slow
                // inference, or an onchain revert). Do NOT post an indexer event
                // — there is no onchain transfer to verify, so it would be an
                // orphan tx-less row that can never earn league points and just
                // clutters the dashboard. The consumer still receives the
                // inference (we already paid upstream and can't un-charge that),
                // but with no PAYMENT-RESPONSE so it's recorded as unsettled.
                logError("settlement failed after inference", settlement.errorReason);
                out = {
                  status: upstream.status,
                  headers: {},
                  body: encryptIfNeeded(upstream.data),
                };
              } else {
                // What the consumer was ACTUALLY charged on-chain. EIP-3009
                // (exact) can only settle the full signed `value`, so the charge
                // is the signed ceiling regardless of token count — reporting the
                // discounted actualAmount here would under-state the consumer's
                // real spend AND give the indexer an amount that doesn't match the
                // on-chain transfer. Only the upto/Permit2 scheme settles the
                // discounted actual, so the discount applies there.
                const chargedAmount =
                  verified.paymentRequired.scheme === "exact"
                    ? verified.signedAmount
                    : actualAmount;
                // Confidential path: forward the TEE response signature (operator
                // fetches it with its key, which never leaves the operator).
                // Resolve the model's own provider (multi-provider operators).
                const teeProvX = resolveProvider(cfg, req.body);
                const teeSig = teeRequest
                  ? await fetchTeeSignature(
                      teeProvX.provider.baseUrl,
                      teeProvX.apiKey,
                      (upstream.data as { id?: string })?.id ?? "",
                      (req.body as { model?: string })?.model ?? ""
                    )
                  : null;
                out = {
                  status: upstream.status,
                  headers: {
                    ...upstream.respHeaders,
                    ...(teeSig ? { "X-Halo-TEE-Signature": teeSig } : {}),
                    "PAYMENT-RESPONSE": encodePaymentResponseHeader({
                      ...settlement,
                      amount: settlement.amount ?? chargedAmount.toString(),
                    }),
                  },
                  body: encryptIfNeeded(upstream.data),
                };

                // Fire-and-forget signed event for indexer attribution — only on
                // successful settlement (there is a real onchain transfer to verify).
                const durationMs = Date.now() - requestStartedAt;
                const eventPayload = {
                  id: req.requestId,
                  operator: cfg.operator.address,
                  consumer: verified.consumer,
                  model: req.body.model ?? null,
                  tokens: upstream.usage.total_tokens,
                  amountUsdc: chargedAmount.toString(),
                  durationMs,
                  timestamp: Date.now(),
                  txHash: settlement.transaction || null,
                  mode: "exact" as const,
                };
                const sigMessage = canonicalEventMessage(eventPayload);
                wallet
                  .signMessage(sigMessage)
                  .then((signature) => postEvent(cfg, { ...eventPayload, signature }))
                  .catch((err) => logError("event post failed", err));
              }
            }
          }
        } catch (err) {
          // A thrown serve must not strand the credit window — return the
          // admitted request's reserved ceiling (issue #369).
          if (creditAdmitted) {
            creditLedger.releaseInflight(
              creditAdmitted.consumer,
              cfg.operator.address,
              creditAdmitted.cycle,
              creditAdmitted.ceiling
            );
            creditAdmitted = null;
          }
          out = {
            status: 502,
            headers: {},
            body: { error: err instanceof Error ? err.message : String(err) },
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

      // Protocol-level pings from the relay are auto-ponged by the ws
      // library, but the event still fires — treat it as a sign of life
      // so the watchdog stays armed only when the relay is actually silent.
      ws.on("ping", () => {
        lastPongAt = Date.now();
      });

      ws.on("close", (code, reason) => {
        wsClosed = true;
        stopKeepalive();
        console.log(`  ✖ disconnected (code=${code}, reason=${reason.toString() || "-"})`);
        resolve({ announced });
      });
      ws.on("error", (err) => console.error("  ws error:", err.message));
    });

  // Supervisor: run, then retry on close with exponential backoff. By
  // default this loop never exits on its own — only SIGINT/SIGTERM stops it.
  // Set HALO_MAX_RECONNECT_ATTEMPTS to a positive integer to opt back into
  // the old "exit after N failures" behavior (useful for CI smoke tests).
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

// Display-only ceiling (USD per 1K tokens) for the ADVERTISED price of a
// margin-mode model the upstream doesn't price (no catalog entry). $0.001/1K =
// $1/1M — roughly the honest effective rate of the $0.01 per-request fallback on
// a realistic ~10k-token confidential request, and far saner than the ~$10/1M
// the raw per-request fallback would otherwise show.
const MARGIN_UNPRICED_ANNOUNCE_CAP_PER_1K = 0.001;

async function buildPricingAnnounce(
  cfg: HaloConfig
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // Announce per-model prices in USDC per 1K tokens (float).
  //   flat   — the explicit configured rate (model-agnostic).
  //   margin — the REAL upstream per-model rate × (1 + margin), so expensive
  //            models (e.g. Opus) advertise high and cheap models advertise
  //            low. This is what lets the relay/frontend show price and gate
  //            model choice against a per-prompt cap. Falls back to the
  //            fallback-per-request proxy only when the upstream rate is
  //            unknown (unsupported provider/model, network error) or the
  //            provider is free (Ollama → operator should be on flat mode).
  // Re-evaluated on every (re)announce; the upstream rate is cached ~5 min, so
  // a long-lived connection can carry a slightly stale price until it
  // reconnects — acceptable, as upstream prices change rarely.
  const fallbackPer1K = cfg.pricing.fallbackPerRequestUsdc / 1_000_000; // USDC units

  // Multi-provider: price each provider's models with that provider's own
  // pricing block when present (margins differ by gateway), falling back to the
  // operator-wide cfg.pricing.
  for (const provider of configProviders(cfg)) {
    const pricing = provider.pricing ?? cfg.pricing;
    const flat = pricing.flatUsdcPer1KTokens;
    const marginPct = typeof pricing.marginPercent === "number" ? pricing.marginPercent : 25;
    const proxy = flat !== undefined ? flat : fallbackPer1K;
    for (const m of provider.models) {
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
        // upstreamPer1K === 0 (free provider) or null (unknown — the model isn't
        // in the upstream's price catalog, e.g. a NEAR model with no /v1/models
        // pricing entry). The old behavior advertised `fallbackPer1K`, but that's
        // the per-REQUEST fallback ($0.01) read as a per-1K rate → an absurd
        // ~$10/1M. When the operator set no explicit flat, clamp the ADVERTISED
        // per-1K to a sane ceiling so the catalog doesn't show a wild number.
        // (Settlement is unaffected — priceRequest still charges the real
        // per-request fallback; this only fixes the displayed/announced rate.)
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

/**
 * Per-model context window (tokens) to announce, so the relay's /v1/models can
 * expose it and agents can size context / decide when to compress. Sourced from
 * the provider's `/models` `context_length` (same cached fetch as pricing).
 * Models the provider doesn't report a window for are simply omitted.
 */
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
  /** Payment rail this event was served over. Drives indexer league awarding:
   *  vault rows are credited on-redeem by the vault settlement watcher, budget/
   *  exact rows by the settlement verifier. Informational — not signed. */
  mode: "vault" | "budget" | "exact";
}

/**
 * Canonical message signed by the operator so the indexer can verify each
 * event was emitted by the operator it attributes points to. Shape is locked:
 *   halo-event:{id}:{operator}:{consumer}:{amountUsdc}:{tokens}:{timestamp}
 *
 * txHash is carried in the event body for indexer settlement verification
 * but is not included in the signature (CDP can fail to return a tx hash;
 * adding it to the signature would reject legitimate events).
 */
export function canonicalEventMessage(ev: Omit<EventPayload, "txHash" | "mode">): string {
  return `halo-event:${ev.id}:${ev.operator.toLowerCase()}:${ev.consumer.toLowerCase()}:${ev.amountUsdc}:${ev.tokens}:${ev.timestamp}`;
}

function abbrevAddr(addr: string | null | undefined): string {
  if (!addr || addr.length < 10) return String(addr);
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── File logging + PID file ─────────────────────────────────────────────────

/** Cap a single log file at 5 MB before rotation. ~2× total disk = 10 MB. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
let logStream: ReturnType<typeof createWriteStream> | null = null;

function serveLogPath(): string {
  return path.join(configDir(), "serve.log");
}

function pidFilePath(): string {
  return path.join(configDir(), "serve.pid");
}

/**
 * Write a debug line straight to the live terminal, bypassing the serve.log
 * file tee installed by setupFileLogging. Used for raw upstream error bodies:
 * a misbehaving upstream can echo the consumer's prompt back inside a 4xx/5xx
 * body, and that plaintext must never persist to disk — it would defeat the
 * "prompts vanish once processed" property. An operator actively debugging
 * still sees the full body live (ephemeral terminal scrollback); nothing is
 * written to ~/.halo/serve.log. We go through process.stderr.write
 * directly because setupFileLogging patches console.error to also append to
 * the file, so console.* is no longer a disk-free channel.
 */
function debugToTerminal(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    /* a debug write must never crash serving */
  }
}

/**
 * Tee console.log / console.error to a persistent log file. The file
 * survives terminal close, sleep/wake, and process crashes — which makes
 * diagnosing "the WS silently dropped" possible after the fact instead of
 * needing live scrollback. Append-only with size-based rotation; opaque
 * binary log files were not an option because operators (and the agents
 * driving them) need to grep these.
 */
function setupFileLogging(): void {
  mkdirSync(configDir(), { recursive: true });
  // Rotate if the existing log is too big. We rotate ONCE at startup so the
  // running serve writes to a known-fresh file; subsequent rotation during
  // the lifetime of the process is rare enough not to warrant the extra
  // complexity (an operator generating > 5 MB of logs in a single session
  // already has something else to look at).
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

/**
 * Write a PID file so `halo doctor` can answer "is serve running?"
 * deterministically. Cleared on graceful exit (SIGINT/SIGTERM); a stale PID
 * file after a crash is detected by doctor via process.kill(pid, 0).
 */
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
