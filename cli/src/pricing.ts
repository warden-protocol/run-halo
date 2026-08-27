import {
  HaloConfig,
  configProviders,
  providerForModel,
} from "./config";
import {
  VAULT_SSE_REPLAY_PRICING_PROTOCOL,
  buildVaultSseReplayPricingQuote,
  canonicalVaultSseReplayPricingRate,
  type VaultSseReplayPricingQuoteV1,
} from "@halo/vault-core";

export interface UpstreamRate {
  /** USD per prompt token (e.g. 0.000003 for $3/M). */
  promptRateUsd: number;
  /** USD per completion token. */
  completionRateUsd: number;
  /** USD per request — some providers charge a flat surcharge on top. */
  requestRateUsd?: number;
  /** Optional USD cache-read rate; absent values use the ordinary prompt rate. */
  cacheReadRateUsd?: number;
  /** Model context window in tokens (provider `/models` `context_length`), when
   *  the provider reports it. Announced to the relay so agents can size context
   *  / decide when to compress. */
  contextLength?: number;
}

type Resolver = (model: string, baseUrl: string) => Promise<UpstreamRate | null>;

const CACHE_TTL_MS = 5 * 60 * 1000;
// Bound catalog fetches so callers terminate instead of sharing a permanently hung promise.
const FETCH_TIMEOUT_MS = 5_000;
export const VAULT_SSE_REPLAY_PRICING_QUOTE_TTL_MS = 10 * 60 * 1000;
export const VAULT_SSE_REPLAY_PRICING_QUOTE_REFRESH_MS = 5 * 60 * 1000;

/** Per-(provider+baseUrl) cache. Pricing tables don't change often. */
interface CacheEntry {
  rates: Map<string, UpstreamRate>;
  completionLimitFields: Map<string, CompletionLimitField>;
  expiresAt: number;
  inFlight?: Promise<void>;
}
const CACHES = new Map<string, CacheEntry>();

function cacheKey(slug: string, baseUrl: string): string {
  return `${slug}::${baseUrl.replace(/\/+$/, "")}`;
}


interface ModelsPricingEntry {
  id: string;
  /** Model context window in tokens (OpenRouter + NEAR both report it). */
  context_length?: number;
  // Per-token USD as decimal strings — the shape OpenRouter pioneered and NEAR
  // AI Cloud also reports. `input_cache_read` is the discounted rate for prompt
  // tokens served from the provider's prompt cache (both NEAR + OpenRouter ship it).
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    input_cache_read?: string;
  };
  supported_parameters?: unknown;
}

export type CompletionLimitField = "max_tokens" | "max_completion_tokens" | null;

function catalogCompletionLimitField(value: unknown): CompletionLimitField | undefined {
  if (!Array.isArray(value)) return undefined;
  const supported = new Set(value.filter((item): item is string => typeof item === "string"));
  if (supported.has("max_completion_tokens")) return "max_completion_tokens";
  if (supported.has("max_tokens")) return "max_tokens";
  return null;
}

function defaultCompletionLimitField(providerSlug: string): Exclude<CompletionLimitField, null> {
  return providerSlug === "openai" ? "max_completion_tokens" : "max_tokens";
}

/** Build a slug-isolated cached resolver for OpenRouter-style `/models` pricing. */
function makeModelsPricingResolver(slug: string): Resolver {
  return async (model, baseUrl) => {
    const key = cacheKey(slug, baseUrl);
    let entry = CACHES.get(key);
    const now = Date.now();
    const isFresh = entry && entry.expiresAt > now;

    if (!isFresh) {
      // Single-flight: if a refresh is already running, await it instead of
      // racing N parallel HTTP calls to /models when N requests arrive at
      // the same moment.
      if (entry?.inFlight) {
        await entry.inFlight;
        entry = CACHES.get(key);
      } else {
        const newEntry: CacheEntry = entry ?? {
          rates: new Map(),
          completionLimitFields: new Map(),
          expiresAt: 0,
        };
        const fetchPromise = (async () => {
          try {
            const url = `${baseUrl.replace(/\/+$/, "")}/models`;
            const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`/models ${res.status}`);
            const body = (await res.json()) as { data?: ModelsPricingEntry[] };
            const models = body.data ?? [];
            const fresh = new Map<string, UpstreamRate>();
            const freshCompletionLimitFields = new Map<string, CompletionLimitField>();
            for (const m of models) {
              const completionLimitField = catalogCompletionLimitField(m.supported_parameters);
              if (completionLimitField !== undefined) {
                freshCompletionLimitFields.set(m.id, completionLimitField);
              }
              const p = m.pricing;
              if (!p?.prompt || !p?.completion) continue;
              const promptRateUsd = parseFloat(p.prompt);
              const completionRateUsd = parseFloat(p.completion);
              if (!Number.isFinite(promptRateUsd) || !Number.isFinite(completionRateUsd)) continue;
              const requestRateUsd = p.request ? parseFloat(p.request) : 0;
              const cacheRead = p.input_cache_read ? parseFloat(p.input_cache_read) : NaN;
              const ctx = typeof m.context_length === "number" ? m.context_length : NaN;
              fresh.set(m.id, {
                promptRateUsd,
                completionRateUsd,
                requestRateUsd: Number.isFinite(requestRateUsd) ? requestRateUsd : 0,
                cacheReadRateUsd:
                  Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : undefined,
                contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : undefined,
              });
            }
            newEntry.rates = fresh;
            newEntry.completionLimitFields = freshCompletionLimitFields;
            newEntry.expiresAt = Date.now() + CACHE_TTL_MS;
          } finally {
            delete newEntry.inFlight;
          }
        })();
        newEntry.inFlight = fetchPromise;
        CACHES.set(key, newEntry);
        try {
          await fetchPromise;
        } catch (err) {
          const staleRates = entry?.rates;
          newEntry.completionLimitFields = new Map();
          if (staleRates && staleRates.size > 0) {
            newEntry.rates = staleRates;
            newEntry.expiresAt = Date.now() + CACHE_TTL_MS;
          } else {
            newEntry.rates = new Map();
            newEntry.expiresAt = 0;
          }
          console.warn(
            `[pricing] ${slug} rate fetch failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        entry = newEntry;
      }
    }

    return entry?.rates.get(model) ?? null;
  };
}

const openrouterResolver: Resolver = makeModelsPricingResolver("openrouter");
// NEAR AI Cloud: same public /models pricing shape (prompt/completion strings).
const nearResolver: Resolver = makeModelsPricingResolver("near");
const CATALOG_COMPLETION_LIMIT_SLUGS = new Set(["openrouter", "near"]);

const ollamaResolver: Resolver = async () => {
  // Return explicit zero for free local inference; `null` would incorrectly select a fallback.
  return { promptRateUsd: 0, completionRateUsd: 0 };
};


const RESOLVERS: Record<string, Resolver> = {
  openrouter: openrouterResolver,
  near: nearResolver,
  ollama: ollamaResolver,
};

/** Resolve the single completion-limit alias accepted by this model. */
export async function upstreamCompletionLimitField(params: {
  providerSlug: string;
  providerBaseUrl: string;
  model: string;
}): Promise<CompletionLimitField | undefined> {
  const resolver = RESOLVERS[params.providerSlug];
  if (resolver) {
    try {
      await resolver(params.model, params.providerBaseUrl);
      const entry = CACHES.get(cacheKey(params.providerSlug, params.providerBaseUrl));
      if (entry?.completionLimitFields.has(params.model)) {
        return entry.completionLimitFields.get(params.model) ?? null;
      }
    } catch {
      if (CATALOG_COMPLETION_LIMIT_SLUGS.has(params.providerSlug)) return undefined;
    }
  }
  if (CATALOG_COMPLETION_LIMIT_SLUGS.has(params.providerSlug)) return undefined;
  return defaultCompletionLimitField(params.providerSlug);
}

/** Whether this provider has a margin-pricing resolver. */
export function providerSupportsMargin(slug: string): boolean {
  return slug in RESOLVERS && slug !== "ollama";
}

/** Compute upstream cost in USDC base units, or `null` when no rate is available. */
export async function upstreamUsdcCost(params: {
  providerSlug: string;
  providerBaseUrl: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Of `promptTokens`, how many were served from the provider's prompt cache
   *  (usage.prompt_tokens_details.cached_tokens). Billed at the cheaper
   *  cacheReadRateUsd when the provider publishes one — passing the saving on. */
  cachedPromptTokens?: number;
}): Promise<bigint | null> {
  const resolver = RESOLVERS[params.providerSlug];
  if (!resolver) return null;
  let rate: UpstreamRate | null;
  try {
    rate = await resolver(params.model, params.providerBaseUrl);
  } catch (err) {
    console.warn(
      `[pricing] resolver(${params.providerSlug}) threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!rate) return null;
  const promptTokens = Math.max(0, params.promptTokens);
  // Cached tokens can't exceed the prompt; bill them at the cache-read rate when
  // the provider publishes one (else they fall through to the normal prompt rate).
  const cached = Math.min(promptTokens, Math.max(0, params.cachedPromptTokens ?? 0));
  const cacheRate = rate.cacheReadRateUsd;
  const uncached = promptTokens - (cacheRate !== undefined ? cached : 0);
  const cachedCost = cacheRate !== undefined ? cacheRate * cached : 0;
  const usd =
    rate.promptRateUsd * uncached +
    cachedCost +
    rate.completionRateUsd * Math.max(0, params.completionTokens) +
    (rate.requestRateUsd ?? 0);
  // Round UP so the operator never undercharges by sub-cent rounding.
  return BigInt(Math.ceil(usd * 1_000_000));
}

export interface RequestPricingInputs {
  cfg: HaloConfig;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
}

/** Price a request in six-decimal USDC base units using flat or upstream-margin pricing. */
export async function priceRequest(inputs: RequestPricingInputs): Promise<bigint> {
  const provider = providerForModel(configProviders(inputs.cfg), inputs.model);
  const pricing = provider.pricing ?? inputs.cfg.pricing;
  const fallbackPerRequestUsdc = inputs.cfg.pricing.fallbackPerRequestUsdc;
  const totalTokens = Math.max(1, inputs.promptTokens + inputs.completionTokens);

  if (
    pricing.mode === "flat" &&
    typeof pricing.flatUsdcPer1KTokens === "number"
  ) {
    const scaled = BigInt(Math.round(pricing.flatUsdcPer1KTokens * 1_000_000));
    return (scaled * BigInt(totalTokens)) / 1000n;
  }

  if (pricing.mode === "margin") {
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
      console.warn(
        `[pricing] margin mode on free provider ${provider.slug}: upstream cost is $0; using fallbackPerRequestUsdc — consider switching to mode=flat`
      );
      return BigInt(fallbackPerRequestUsdc);
    }
    const marginPct =
      typeof pricing.marginPercent === "number" ? pricing.marginPercent : 25;
    const multipliedNumerator =
      upstream * BigInt(100 + Math.round(marginPct));
    return (multipliedNumerator + 99n) / 100n;
  }

  return BigInt(fallbackPerRequestUsdc);
}

/** Completion-heavy weight for the single blended rate announced to the relay. */
const ANNOUNCE_COMPLETION_WEIGHT = 0.35; // 65% prompt-priced / 35% completion-priced

/** Blended announcement rate: positive, zero for free providers, or `null` for caller fallback. */
/** Return cached catalog `context_length`, or `null` when the provider omits it. */
export async function upstreamContextLength(params: {
  providerSlug: string;
  providerBaseUrl: string;
  model: string;
}): Promise<number | null> {
  const resolver = RESOLVERS[params.providerSlug];
  if (!resolver) return null;
  try {
    const rate = await resolver(params.model, params.providerBaseUrl);
    return rate?.contextLength ?? null;
  } catch {
    return null;
  }
}

export async function upstreamRatePer1KUsd(params: {
  providerSlug: string;
  providerBaseUrl: string;
  model: string;
}): Promise<number | null> {
  const resolver = RESOLVERS[params.providerSlug];
  if (!resolver) return null;
  let rate: UpstreamRate | null;
  try {
    rate = await resolver(params.model, params.providerBaseUrl);
  } catch (err) {
    console.warn(
      `[pricing] resolver(${params.providerSlug}) threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!rate) return null;
  const perToken =
    rate.promptRateUsd * (1 - ANNOUNCE_COMPLETION_WEIGHT) +
    rate.completionRateUsd * ANNOUNCE_COMPLETION_WEIGHT;
  // Per-request surcharges are deliberately excluded: they don't scale with
  // tokens, so folding them into a per-1K rate would distort it.
  return perToken * 1000;
}

export async function buildVaultSseReplayPricingAnnounce(
  cfg: HaloConfig,
  announcedModels: readonly string[],
  nowMs: number = Date.now()
): Promise<Record<string, VaultSseReplayPricingQuoteV1>> {
  const quotes: Record<string, VaultSseReplayPricingQuoteV1> = {};
  const issuedAtMs = Math.max(1, Math.floor(nowMs));
  const expiresAtMs = issuedAtMs + VAULT_SSE_REPLAY_PRICING_QUOTE_TTL_MS;

  for (const model of new Set(announcedModels)) {
    const provider = providerForModel(configProviders(cfg), model);
    const pricing = provider.pricing ?? cfg.pricing;
    if (pricing.mode !== "margin") continue;
    const roundedMarginPercent =
      typeof pricing.marginPercent === "number"
        ? Math.round(pricing.marginPercent)
        : 25;
    const marginBps = Math.max(0, roundedMarginPercent) * 100;
    const factor = (100 + Math.max(0, roundedMarginPercent)) / 100;
    const fallback = cfg.pricing.fallbackPerRequestUsdc;
    if (!Number.isSafeInteger(fallback) || fallback <= 0) continue;

    try {
      const resolver = RESOLVERS[provider.slug];
      let rate: UpstreamRate | null = null;
      if (resolver) {
        try {
          rate = await resolver(model, provider.baseUrl);
        } catch {
          rate = null;
        }
      }
      const positiveCatalogRate =
        rate !== null &&
        Number.isFinite(rate.promptRateUsd) &&
        rate.promptRateUsd >= 0 &&
        Number.isFinite(rate.completionRateUsd) &&
        rate.completionRateUsd >= 0 &&
        (rate.promptRateUsd > 0 ||
          rate.completionRateUsd > 0 ||
          (rate.requestRateUsd ?? 0) > 0);

      if (positiveCatalogRate && rate) {
        const requestRateUsd = Math.max(0, rate.requestRateUsd ?? 0);
        quotes[model] = buildVaultSseReplayPricingQuote({
          protocol: VAULT_SSE_REPLAY_PRICING_PROTOCOL,
          model,
          promptUsdPerMtok: canonicalVaultSseReplayPricingRate(
            rate.promptRateUsd * 1_000_000 * factor
          ),
          completionUsdPerMtok: canonicalVaultSseReplayPricingRate(
            rate.completionRateUsd * 1_000_000 * factor
          ),
          cacheReadUsdPerMtok:
            rate.cacheReadRateUsd !== undefined && rate.cacheReadRateUsd >= 0
              ? canonicalVaultSseReplayPricingRate(
                  rate.cacheReadRateUsd * 1_000_000 * factor
                )
              : null,
          requestUsdcBase: String(Math.ceil(requestRateUsd * 1_000_000 * factor)),
          fallbackUsdcBase: String(fallback),
          marginBps,
          issuedAtMs,
          expiresAtMs,
        });
        continue;
      }

      quotes[model] = buildVaultSseReplayPricingQuote({
        protocol: VAULT_SSE_REPLAY_PRICING_PROTOCOL,
        model,
        promptUsdPerMtok: "0",
        completionUsdPerMtok: "0",
        cacheReadUsdPerMtok: null,
        requestUsdcBase: String(fallback),
        fallbackUsdcBase: String(fallback),
        marginBps,
        issuedAtMs,
        expiresAtMs,
      });
    } catch (error) {
      console.warn(
        `[pricing] replay quote unavailable for ${provider.slug}/${model}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return quotes;
}

// Shared media-aware prompt estimator — keeps the operator's vault gate sized
// identically to the consumer's reservation (`estimateTokens` in `@halo/vault-core`).
export { estimatePromptTokens, estimateRequestPromptTokens } from "@halo/vault-core";
