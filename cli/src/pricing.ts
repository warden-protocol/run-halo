/**
 * Upstream pricing resolver — turns (provider, model, promptTokens,
 * completionTokens) into a USDC base-unit cost so margin mode can charge
 * fairly across cheap and expensive models.
 *
 * Without this, every margin-mode operator fell through to the
 * fallbackPerRequestUsdc — flat $0.01 regardless of model — losing money
 * on Claude Opus prompts and over-charging on tiny Qwen calls. See
 * docs/PRICING.md.
 *
 * Today: OpenRouter and NEAR AI Cloud (both via a public OpenAI-compatible
 * /models endpoint that reports per-token `prompt`/`completion` pricing
 * strings), Ollama (free, returns zero), and a fallback path that returns null
 * so the caller can use fallbackPerRequestUsdc.
 *
 * Adding a provider: if its /models endpoint reports OpenRouter-style pricing
 * strings, register `makeModelsPricingResolver(slug)`; otherwise implement a
 * bespoke `Resolver` and register it in RESOLVERS.
 */

export interface UpstreamRate {
  /** USD per prompt token (e.g. 0.000003 for $3/M). */
  promptRateUsd: number;
  /** USD per completion token. */
  completionRateUsd: number;
  /** USD per request — some providers charge a flat surcharge on top. */
  requestRateUsd?: number;
  /** USD per CACHE-READ prompt token (NEAR/OpenRouter `input_cache_read`).
   *  Typically ~5–10× cheaper than promptRateUsd. When the upstream reports
   *  cached prompt tokens, those are billed at this rate so the operator passes
   *  the provider's prompt-cache saving on to the consumer. Undefined ⇒ the
   *  provider doesn't discount cache reads (cached tokens bill at promptRateUsd). */
  cacheReadRateUsd?: number;
  /** Model context window in tokens (provider `/models` `context_length`), when
   *  the provider reports it. Announced to the relay so agents can size context
   *  / decide when to compress. */
  contextLength?: number;
}

type Resolver = (model: string, baseUrl: string) => Promise<UpstreamRate | null>;

const CACHE_TTL_MS = 5 * 60 * 1000;
// Hard ceiling on the /models fetch. Without it a hung OpenRouter endpoint never
// resolves the in-flight promise, stalling every caller awaiting it — including
// the operator announce (which prices each model) and per-request pricing on the
// serve hot path. On timeout we throw → fall back to stale cache / proxy rate.
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

// ── OpenAI-compatible /models pricing (OpenRouter, NEAR) ─────────────────────

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

/**
 * Build a resolver for any provider whose public `/models` endpoint reports
 * OpenRouter-style per-token `prompt`/`completion` pricing strings. One fetch
 * populates the whole catalog into the cache; subsequent lookups are O(1) for
 * 5 minutes. Returns null when the model isn't in the catalog (caller falls
 * back). `slug` keys the cache so providers sharing a base URL never collide.
 */
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

// ── Ollama (local, free) ────────────────────────────────────────────────────

const ollamaResolver: Resolver = async () => {
  // Local inference has no per-token upstream cost. Margin mode on
  // Ollama settles at 0 + margin = 0, which means the operator earns
  // nothing — they should use flat mode instead. We return zero rather
  // than null so this is explicit and shows up in logs.
  return { promptRateUsd: 0, completionRateUsd: 0 };
};

// ── Registry ────────────────────────────────────────────────────────────────

const RESOLVERS: Record<string, Resolver> = {
  openrouter: openrouterResolver,
  near: nearResolver,
  ollama: ollamaResolver,
};

/**
 * True when margin mode against this provider can produce a real upstream
 * cost. Used by setup.ts to warn operators selecting margin against a
 * provider we don't yet know how to price.
 */
export function providerSupportsMargin(slug: string): boolean {
  return slug in RESOLVERS && slug !== "ollama";
}

/**
 * Compute the upstream USDC base-unit cost for a given inference. Returns
 * null when the rate is unknown — caller must fall back (typically to
 * `fallbackPerRequestUsdc`).
 *
 * Token splits matter: most providers price prompt and completion at
 * different rates, sometimes by a factor of 5x or more.
 */
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

/**
 * Blend weight applied to the (more expensive) completion rate when
 * collapsing an upstream prompt/completion rate pair into the SINGLE
 * USD-per-1K-token number the operator announces to the relay. Upstream
 * completion tokens often cost 4–5× prompt tokens, so we lean toward
 * completion (rather than a flat 50/50 or a usage-weighted prompt-heavy
 * blend) to keep the advertised figure CONSERVATIVE — the relay/frontend
 * uses it to size per-prompt caps and gate model choice, and an
 * under-estimate there would let a prompt blow past its cap mid-run.
 */
const ANNOUNCE_COMPLETION_WEIGHT = 0.35; // 65% prompt-priced / 35% completion-priced

/**
 * Representative upstream rate in USD per 1,000 tokens for a model, for the
 * operator's pricing announce. Lets margin-mode operators advertise a REAL
 * per-model price (Opus high, small models low) instead of a flat proxy, so
 * the relay/frontend can show price and size budget caps per model.
 *
 * Returns:
 *   - a positive USD/1K number when the upstream rate is known,
 *   - 0 for free providers (e.g. Ollama),
 *   - null when the rate is unknown (caller falls back to its own proxy).
 *
 * The announce carries one number, so the prompt/completion split is blended
 * via ANNOUNCE_COMPLETION_WEIGHT. Actual per-prompt cost still varies with the
 * real split; this is a representative, intentionally conservative figure.
 */
/**
 * Model context window (tokens) for a model, from the provider's `/models`
 * `context_length`. Reuses the same cached fetch as pricing. Returns null when
 * the provider doesn't report it (or isn't a /models-pricing provider). The
 * operator announces this so the relay's /v1/models can expose it — agents use
 * it to size context and decide when to compress.
 */
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

/**
 * Cheap token estimator for the 402 pre-inference price quote. Real
 * settlement uses the operator's actual usage.prompt_tokens /
 * usage.completion_tokens, which is what the upstream returns.
 *
 * Heuristic: ~4 chars per token. Conservative for English, slightly
 * over-estimates for code/CJK; both bias toward over-quoting the user,
 * which is honest behavior for a ceiling-style 402.
 *
 * Counts array-form content (multimodal / tool parts) the same way as
 * @halo/vault-core `estimateTokens` (JSON.stringify each part). Previously this
 * counted only string `content`, so an array-content prompt was estimated as 0
 * prompt chars — the operator's vault ceiling then under-priced the request and
 * settled at a loss, AND diverged from the consumer's reserve sizing (which does
 * count array content), forcing an extra reserve-and-replay round trip. Keeping
 * the two estimators consistent restores `reserve >= gate` without the replay.
 */
export function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    if (m && typeof m === "object") {
      const content = (m as { content?: unknown }).content;
      if (typeof content === "string") chars += content.length;
      else if (Array.isArray(content)) {
        for (const part of content) chars += JSON.stringify(part).length;
      }
    }
  }
  // +4 tokens per message for role + delimiters, OpenAI's published overhead.
  return Math.ceil(chars / 4) + messages.length * 4;
}
