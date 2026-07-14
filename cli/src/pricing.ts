import {
  HaloConfig,
  configProviders,
  providerForModel,
} from "./config";

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
// Bound catalog fetches so callers can fall back instead of sharing a permanently hung promise.
const FETCH_TIMEOUT_MS = 5_000;

/** Per-(provider+baseUrl) cache. Pricing tables don't change often. */
interface CacheEntry {
  rates: Map<string, UpstreamRate>;
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
            for (const m of models) {
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
          // Don't poison the cache on a transient failure. If we have stale
          // data, keep it; if not, leave the entry empty so the next call
          // tries again.
          if (entry && entry.rates.size > 0) {
            // Keep stale entry alive for one more TTL.
            newEntry.rates = entry.rates;
            newEntry.expiresAt = Date.now() + CACHE_TTL_MS;
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


const ollamaResolver: Resolver = async () => {
  // Return explicit zero for free local inference; `null` would incorrectly select a fallback.
  return { promptRateUsd: 0, completionRateUsd: 0 };
};


const RESOLVERS: Record<string, Resolver> = {
  openrouter: openrouterResolver,
  near: nearResolver,
  ollama: ollamaResolver,
};

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

/** Estimate quote tokens at roughly four characters each; settlement uses reported usage. */
export function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (m && typeof m === "object") {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") chars += content.length;
    }
  }
  // +4 tokens per message for role + delimiters, OpenAI's published overhead.
  return Math.ceil(chars / 4) + messages.length * 4;
}
