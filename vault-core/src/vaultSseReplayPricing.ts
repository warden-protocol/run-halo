import { keccak256, parseUnits, toUtf8Bytes } from "ethers";

export const VAULT_SSE_REPLAY_PRICING_PROTOCOL =
  "vault-sse-replay-pricing-v1" as const;
export const VAULT_SSE_REPLAY_PRICING_QUOTE_MAX_LIFETIME_MS = 3_600_000;

const PRICE_DP = 12;
const MAX_RATE_USD_PER_MTOK = 1_000_000_000;
const MAX_QUOTED_USDC_BASE = 1_000_000_000_000n;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;
const UINT = /^(?:0|[1-9]\d*)$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;

export interface VaultSseReplayPricingQuoteV1 {
  protocol: typeof VAULT_SSE_REPLAY_PRICING_PROTOCOL;
  quoteId: string;
  model: string;
  promptUsdPerMtok: string;
  completionUsdPerMtok: string;
  cacheReadUsdPerMtok: string | null;
  requestUsdcBase: string;
  fallbackUsdcBase: string;
  marginBps: number;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type UnsignedVaultSseReplayPricingQuoteV1 = Omit<
  VaultSseReplayPricingQuoteV1,
  "quoteId"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validRate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return false;
  if (!DECIMAL.test(value)) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_RATE_USD_PER_MTOK;
}

function validQuotedUsdcBase(value: unknown): value is string {
  if (typeof value !== "string" || !UINT.test(value)) return false;
  try {
    return BigInt(value) <= MAX_QUOTED_USDC_BASE;
  } catch {
    return false;
  }
}

function canonicalUnsignedQuote(
  value: UnsignedVaultSseReplayPricingQuoteV1
): UnsignedVaultSseReplayPricingQuoteV1 | null {
  if (
    value.protocol !== VAULT_SSE_REPLAY_PRICING_PROTOCOL ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    value.model.length > 512 ||
    !validRate(value.promptUsdPerMtok) ||
    !validRate(value.completionUsdPerMtok) ||
    (value.cacheReadUsdPerMtok !== null && !validRate(value.cacheReadUsdPerMtok)) ||
    !validQuotedUsdcBase(value.requestUsdcBase) ||
    !validQuotedUsdcBase(value.fallbackUsdcBase) ||
    BigInt(value.fallbackUsdcBase) === 0n ||
    !Number.isSafeInteger(value.marginBps) ||
    value.marginBps < 0 ||
    value.marginBps > 100_000 ||
    !Number.isSafeInteger(value.issuedAtMs) ||
    value.issuedAtMs <= 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.issuedAtMs ||
    value.expiresAtMs - value.issuedAtMs >
      VAULT_SSE_REPLAY_PRICING_QUOTE_MAX_LIFETIME_MS
  ) {
    return null;
  }
  if (
    Number(value.promptUsdPerMtok) === 0 &&
    Number(value.completionUsdPerMtok) === 0 &&
    BigInt(value.requestUsdcBase) === 0n
  ) {
    return null;
  }
  return {
    protocol: value.protocol,
    model: value.model,
    promptUsdPerMtok: value.promptUsdPerMtok,
    completionUsdPerMtok: value.completionUsdPerMtok,
    cacheReadUsdPerMtok: value.cacheReadUsdPerMtok,
    requestUsdcBase: value.requestUsdcBase,
    fallbackUsdcBase: value.fallbackUsdcBase,
    marginBps: value.marginBps,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
  };
}

export function vaultSseReplayPricingQuoteId(
  value: UnsignedVaultSseReplayPricingQuoteV1
): string {
  const canonical = canonicalUnsignedQuote(value);
  if (!canonical) throw new Error("invalid vault SSE replay pricing quote");
  return keccak256(toUtf8Bytes(JSON.stringify(canonical)));
}

export function buildVaultSseReplayPricingQuote(
  value: UnsignedVaultSseReplayPricingQuoteV1
): VaultSseReplayPricingQuoteV1 {
  const canonical = canonicalUnsignedQuote(value);
  if (!canonical) throw new Error("invalid vault SSE replay pricing quote");
  return { ...canonical, quoteId: vaultSseReplayPricingQuoteId(canonical) };
}

export function parseVaultSseReplayPricingQuote(
  value: unknown
): VaultSseReplayPricingQuoteV1 | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocol",
      "quoteId",
      "model",
      "promptUsdPerMtok",
      "completionUsdPerMtok",
      "cacheReadUsdPerMtok",
      "requestUsdcBase",
      "fallbackUsdcBase",
      "marginBps",
      "issuedAtMs",
      "expiresAtMs",
    ]) ||
    typeof value.quoteId !== "string" ||
    !BYTES32.test(value.quoteId)
  ) {
    return null;
  }
  const unsigned = canonicalUnsignedQuote(
    value as unknown as UnsignedVaultSseReplayPricingQuoteV1
  );
  if (!unsigned || vaultSseReplayPricingQuoteId(unsigned) !== value.quoteId) return null;
  return { ...unsigned, quoteId: value.quoteId };
}

export function canonicalVaultSseReplayPricingRate(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > MAX_RATE_USD_PER_MTOK) {
    throw new Error("vault SSE replay pricing rate is outside the supported domain");
  }
  const canonical = value.toFixed(PRICE_DP).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, "$1");
  if (!validRate(canonical) || (value > 0 && Number(canonical) === 0)) {
    throw new Error("vault SSE replay pricing rate cannot be represented canonically");
  }
  return canonical;
}

function rateCost(rate: string, tokens: number): bigint {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error("vault SSE replay pricing tokens must be finite and non-negative");
  }
  const priceBase = parseUnits(rate, PRICE_DP);
  const scaled = BigInt(Math.ceil(tokens)) * priceBase;
  const denominator = 10n ** BigInt(PRICE_DP);
  return (scaled + denominator - 1n) / denominator;
}

export function priceVaultSseReplayPricingQuote(
  quote: VaultSseReplayPricingQuoteV1,
  inputs: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  }
): bigint {
  const parsed = parseVaultSseReplayPricingQuote(quote);
  if (!parsed) throw new Error("invalid vault SSE replay pricing quote");
  const promptTokens = Math.max(0, Math.ceil(inputs.promptTokens));
  const completionTokens = Math.max(0, Math.ceil(inputs.completionTokens));
  const cached = Math.min(
    promptTokens,
    Math.max(0, Math.ceil(inputs.cachedPromptTokens ?? 0))
  );
  const cacheRate = parsed.cacheReadUsdPerMtok;
  const uncached = promptTokens - (cacheRate === null ? 0 : cached);
  const amount =
    rateCost(parsed.promptUsdPerMtok, uncached) +
    (cacheRate === null ? 0n : rateCost(cacheRate, cached)) +
    rateCost(parsed.completionUsdPerMtok, completionTokens) +
    BigInt(parsed.requestUsdcBase);
  return amount === 0n ? BigInt(parsed.fallbackUsdcBase) : amount;
}

export function isVaultSseReplayPricingQuoteUsable(
  quote: VaultSseReplayPricingQuoteV1,
  model: string,
  nowMs: number = Date.now()
): boolean {
  const parsed = parseVaultSseReplayPricingQuote(quote);
  return (
    parsed !== null &&
    parsed.model === model &&
    Number.isSafeInteger(nowMs) &&
    nowMs >= parsed.issuedAtMs &&
    nowMs < parsed.expiresAtMs
  );
}
