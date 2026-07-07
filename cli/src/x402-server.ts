/**
 * Server-side x402 handling for Halo operators.
 *
 * Produces 402 challenges, decodes consumer PAYMENT-SIGNATURE headers, and
 * drives a facilitator (CDP or compatible) to verify + settle onchain.
 *
 * The flow is intentionally split into two phases so the operator can run
 * inference between them:
 *   1. x402Verify  — decode + verify the signed payment, NO money movement
 *   2. x402Settle  — settle after inference using actual token count (upto scheme)
 *
 * With the `upto` scheme the user signs a Permit2 authorization for up to
 * `maxAmountRequired`. After inference the operator calls settle with the
 * actual token cost (≤ max), so the user is charged only for tokens consumed.
 * If inference fails or the operator crashes before settle, no money moves.
 */
import { HaloConfig, configProviders, providerForModel, BASE_CHAIN_ID, BASE_NETWORK } from "./config";
import {
  Facilitator,
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
} from "./cdp-facilitator";
import { upstreamUsdcCost } from "./pricing";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function b64decode(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
  return atob(s);
}

function b64encode(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf-8").toString("base64");
  return btoa(s);
}

export function decodePaymentSignature(header: string): PaymentPayload {
  const trimmed = header.trim();
  const json = trimmed.startsWith("{") ? trimmed : b64decode(trimmed);
  return JSON.parse(json) as PaymentPayload;
}

/**
 * Inputs for any pricing call. `model` and the token split matter for
 * margin mode (different upstream rates per model + per token type).
 * For 402 quotes, completion = max_tokens (ceiling). For settle,
 * use the actual usage.prompt_tokens / usage.completion_tokens.
 */
export interface PricingInputs {
  cfg: HaloConfig;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's prompt cache (margin mode only) —
   *  billed at the provider's cheaper cache-read rate so the saving reaches the
   *  consumer. Only meaningful at SETTLE time (the prompt-blind 402 quote can't
   *  know cache hits). Ignored in flat mode. */
  cachedPromptTokens?: number;
}

/**
 * Price a request. Returns USDC base units (6 dp). Strategy by mode:
 *
 *   flat   — flatUsdcPer1KTokens × (prompt + completion). Same rate
 *            across models; size-sensitive.
 *   margin — query the upstream provider's per-model rate, compute the
 *            real upstream cost, multiply by (1 + marginPercent/100).
 *            Falls back to fallbackPerRequestUsdc when the upstream
 *            rate is unknown (provider not supported, model not in
 *            catalog, network error), with a warning log.
 *
 * Async because margin mode hits the provider's pricing API. The result
 * is cached for 5 min so the steady-state path is one map lookup.
 */
export async function priceRequest(inputs: PricingInputs): Promise<bigint> {
  // Multi-provider: the model picks the provider, and that provider's own
  // pricing block (if any) wins over the operator-wide cfg.pricing.
  const provider = providerForModel(configProviders(inputs.cfg), inputs.model);
  const p = provider.pricing ?? inputs.cfg.pricing;
  // The per-provider pricing override carries no fallback rate — that's an
  // operator-wide setting, so always source it from cfg.pricing.
  const fallbackPerRequestUsdc = inputs.cfg.pricing.fallbackPerRequestUsdc;
  const totalTokens = Math.max(1, inputs.promptTokens + inputs.completionTokens);

  if (p.mode === "flat" && typeof p.flatUsdcPer1KTokens === "number") {
    const scaled = BigInt(Math.round(p.flatUsdcPer1KTokens * 1_000_000));
    return (scaled * BigInt(totalTokens)) / 1000n;
  }

  if (p.mode === "margin") {
    const upstream = await upstreamUsdcCost({
      providerSlug: provider.slug,
      providerBaseUrl: provider.baseUrl,
      model: inputs.model,
      promptTokens: inputs.promptTokens,
      completionTokens: inputs.completionTokens,
      cachedPromptTokens: inputs.cachedPromptTokens,
    });
    if (upstream === null) {
      console.warn(
        `[pricing] margin mode: no upstream rate for ${provider.slug}/${inputs.model} — using fallbackPerRequestUsdc ($${(fallbackPerRequestUsdc / 1_000_000).toFixed(4)})`
      );
      return BigInt(fallbackPerRequestUsdc);
    }
    if (upstream === 0n) {
      // Free provider (Ollama). Margin on zero is still zero — operator
      // should be on flat mode. Charge the fallback so the operator
      // doesn't accidentally serve for free.
      console.warn(
        `[pricing] margin mode on free provider ${provider.slug}: upstream cost is $0; using fallbackPerRequestUsdc — consider switching to mode=flat`
      );
      return BigInt(fallbackPerRequestUsdc);
    }
    const marginPct = typeof p.marginPercent === "number" ? p.marginPercent : 25;
    const multipliedNumerator = upstream * BigInt(100 + Math.round(marginPct));
    // Ceiling division so we never undercharge by sub-cent rounding.
    return (multipliedNumerator + 99n) / 100n;
  }

  return BigInt(fallbackPerRequestUsdc);
}

/**
 * Floor (USDC base units, 6 dp) on a settled amount. The facilitator refuses to
 * settle below its own MIN_SETTLEMENT_BASE (default $0.001) — it pays Base gas on
 * every settle, so dust transfers lose money — and rejects the verify/settle with
 * "amount N below minimum settlement". A short prompt (e.g. an agent's one-line
 * question) token-prices WAY below that (we've seen 4 base units = $0.000004), so
 * without a floor here the operator quotes 4, the consumer signs 4, and settlement
 * fails → the consumer's request errors out ("provider failed"). We floor the
 * EXACT-scheme quote so the consumer signs ≥ the floor and settlement clears.
 * Must be ≥ the facilitator's MIN_SETTLEMENT_BASE; env-tunable to track it.
 */
export const MIN_SETTLEMENT_FLOOR_BASE = BigInt(
  process.env.HALO_MIN_SETTLEMENT_BASE ?? "1000"
);

/**
 * Compute the actual amount to charge after inference.
 * Prices the inputs, then caps at maxAmount to honour the `upto`
 * invariant (actual settlement ≤ signed ceiling).
 */
export async function computeActualAmount(
  inputs: PricingInputs,
  maxAmount: bigint
): Promise<bigint> {
  const actual = await priceRequest(inputs);
  // Floor to the settlement minimum (the facilitator can't settle dust), then
  // cap at the signed ceiling. The signed ceiling was itself floored at quote
  // time, so floored-actual ≤ ceiling always holds.
  const floored = actual < MIN_SETTLEMENT_FLOOR_BASE ? MIN_SETTLEMENT_FLOOR_BASE : actual;
  return floored < maxAmount ? floored : maxAmount;
}

/**
 * Build the x402 PaymentRequirements.
 *
 * Uses `upto` when a facilitatorAddress is supplied (CDP supports it),
 * falling back to `exact` for older facilitators.
 */
export function buildPaymentRequirements(
  cfg: HaloConfig,
  requestPath: string,
  amountUsdcBase: bigint,
  facilitatorAddress: string | null = null
): PaymentRequirements {
  const chainId = BASE_CHAIN_ID;
  const scheme = facilitatorAddress ? "upto" : "exact";
  const extra: Record<string, unknown> = {
    chainId,
    operator: cfg.operator.address,
  };
  if (facilitatorAddress) {
    extra.facilitatorAddress = facilitatorAddress;
  }
  return {
    scheme,
    network: BASE_NETWORK,
    maxAmountRequired: amountUsdcBase.toString(),
    resource: requestPath,
    payTo: cfg.operator.address,
    // Settlement happens AFTER inference in both schemes, so the authorization
    // must stay valid for the whole sign→inference→settle→mine window. Slow
    // (large-output) models can take 60-120s — the relay caps a request at 120s
    // (INFERENCE_TIMEOUT_MS) — so a 60s window expired mid-inference and the
    // settle failed with "authorization expired". 300s covers the full window
    // (matching upto) with margin.
    maxTimeoutSeconds: 300,
    asset: USDC_BASE,
    description: `Halo inference · ${cfg.provider.slug}`,
    mimeType: "application/json",
    extra,
  };
}

export function encodePaymentRequiredHeader(req: PaymentRequirements): string {
  return b64encode(JSON.stringify(req));
}

export function encodePaymentResponseHeader(settlement: SettleResult): string {
  return b64encode(JSON.stringify(settlement));
}

// ── Dual-format helpers (EIP-3009 exact / Permit2 upto) ──────────────────────

/** Address of the user who authorised the payment. */
export function getConsumerAddress(payload: PaymentPayload): string {
  if (payload.permit2Authorization) return payload.permit2Authorization.from;
  if (payload.payload) return payload.payload.from;
  throw new Error("payload has neither `payload` nor `permit2Authorization`");
}

/** Address the payment is directed to (operator wallet). */
export function getPayToAddress(payload: PaymentPayload): string {
  if (payload.permit2Authorization) return payload.permit2Authorization.witness.to;
  if (payload.payload) return payload.payload.to;
  throw new Error("payload has neither `payload` nor `permit2Authorization`");
}

/** Maximum amount the user signed — used for upto-invariant enforcement. */
export function getSignedAmount(payload: PaymentPayload): bigint {
  if (payload.permit2Authorization) {
    return BigInt(payload.permit2Authorization.permitted.amount);
  }
  if (payload.payload) {
    return BigInt(payload.payload.value);
  }
  throw new Error("payload has neither `payload` nor `permit2Authorization`");
}

// ── Phase 1: verify ───────────────────────────────────────────────────────────

export type VerifyResult =
  | { kind: "challenge"; paymentRequired: PaymentRequirements }
  | {
      kind: "verified";
      consumer: string;
      signedAmount: bigint;
      paymentRequired: PaymentRequirements;
      payload: PaymentPayload;
    }
  | { kind: "rejected"; reason: string; paymentRequired: PaymentRequirements };

/**
 * Decode and verify a consumer's PAYMENT-SIGNATURE. No money moves here.
 *
 * Returns `challenge` when no header is present, `verified` on success,
 * `rejected` for any validation failure.
 */
export async function x402Verify(params: {
  cfg: HaloConfig;
  facilitator: Facilitator;
  paymentSignatureHeader: string | undefined;
  requestPath: string;
  /**
   * Pricing inputs for the 402 quote. promptTokens is estimated from the
   * request body (see estimatePromptTokens); completionTokens is the
   * caller-supplied ceiling (typically req.body.max_tokens).
   */
  pricing: PricingInputs;
  facilitatorAddress?: string | null;
}): Promise<VerifyResult> {
  const {
    cfg,
    facilitator,
    paymentSignatureHeader,
    requestPath,
    pricing,
    facilitatorAddress = null,
  } = params;

  // Floor the quote to the settlement minimum: a sub-floor amount can't be
  // settled by the facilitator, so quoting it would guarantee a failed settle
  // (and a "provider failed" error to the consumer). The exact scheme charges
  // the signed amount, so flooring the quote makes the consumer sign ≥ the floor.
  const priced = await priceRequest(pricing);
  const amount = priced < MIN_SETTLEMENT_FLOOR_BASE ? MIN_SETTLEMENT_FLOOR_BASE : priced;
  const paymentRequired = buildPaymentRequirements(
    cfg,
    requestPath,
    amount,
    facilitatorAddress
  );

  if (!paymentSignatureHeader) {
    return { kind: "challenge", paymentRequired };
  }

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignature(paymentSignatureHeader);
  } catch {
    return { kind: "rejected", reason: "malformed PAYMENT-SIGNATURE", paymentRequired };
  }

  try {
    const signedAmount = getSignedAmount(payload);
    if (signedAmount < amount) {
      return {
        kind: "rejected",
        reason: `signed amount ${signedAmount} < required ${amount}`,
        paymentRequired,
      };
    }
    const payTo = getPayToAddress(payload);
    if (payTo.toLowerCase() !== cfg.operator.address.toLowerCase()) {
      return { kind: "rejected", reason: "payTo mismatch", paymentRequired };
    }
  } catch {
    return { kind: "rejected", reason: "invalid payload fields", paymentRequired };
  }

  const consumer = getConsumerAddress(payload);

  const verify = await facilitator.verify(payload, paymentRequired);
  if (!verify.isValid) {
    return {
      kind: "rejected",
      reason: verify.invalidReason || "verify failed",
      paymentRequired,
    };
  }

  return {
    kind: "verified",
    consumer,
    signedAmount: getSignedAmount(payload),
    paymentRequired,
    payload,
  };
}

// ── Phase 2: settle ───────────────────────────────────────────────────────────

/**
 * Settle a payment after inference.
 *
 * For `upto`: pass `actualAmount` (actual tokens consumed) — the user is
 * charged only this amount. For `exact`: omit `actualAmount`.
 */
export async function x402Settle(params: {
  facilitator: Facilitator;
  payload: PaymentPayload;
  paymentRequired: PaymentRequirements;
  actualAmount?: bigint;
}): Promise<SettleResult> {
  const { facilitator, payload, paymentRequired, actualAmount } = params;
  return facilitator.settle(payload, paymentRequired, actualAmount);
}
