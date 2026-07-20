import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { EncryptedSecret } from "./secret";
import { matchesModel, priceImages } from "@halo/vault-core";
import { imageEditAdapterFor } from "./providers";

export type PricingMode = "margin" | "flat";

export interface PricingConfig {
  mode: PricingMode;
  marginPercent?: number;
  flatUsdcPer1KTokens?: number;
  usdcPerImage?: number;
}

/** One upstream provider; multi-provider routing uses model membership. */
export interface ProviderConfig {
  /** Provider slug: "openrouter" | "ollama" | "venice" | "near" | ... */
  slug: string;
  /** Base URL including /v1 */
  baseUrl: string;
  /** Stored provider key: legacy plaintext or a keystore-passphrase-encrypted envelope. */
  apiKey?: string | EncryptedSecret;
  /** Models this operator will advertise for this provider (subset of catalog). */
  models: string[];
  /** Subset of `models` priced per returned image; a non-image model here settles at $0 (invariant #2: never bill an unmeterable response). */
  imageModels?: string[];
  /** Explicit exact subset of `imageModels` accepted by this provider's tested edit adapter. */
  imageEditModels?: string[];
  /** Provider-specific pricing, falling back to top-level pricing. */
  pricing?: PricingConfig;
}

export interface HaloConfig {
  version: 1;
  relayUrl: string;
  indexerUrl: string;
  operator: {
    address: string;
    keystorePath: string;
    label?: string;
    /** Declared prompt-log retention policy; omission is exposed as `unknown`. */
    dataRetention?: "none" | "24h" | "7d" | "unknown";
    /** Empty-passphrase unattended mode relies entirely on file and host access controls. */
    noPassphrase?: boolean;
  };
  /** Primary provider retained for compatibility and mirrored as `providers[0]`. */
  provider: ProviderConfig;
  /** Ordered multi-provider configuration; the first entry is primary. */
  providers?: ProviderConfig[];
  pricing: PricingConfig & {
    /** "margin" = upstreamCostUsdc × (1 + marginPercent/100); "flat" = flatUsdcPer1KTokens */
    mode: PricingMode;
    /** Fallback fixed price per request in USDC base units (6 dp). Used when model token cost is unknown. */
    fallbackPerRequestUsdc: number;
  };
  facilitator: {
    url: string;
    /** Optional API key for facilitators that require auth (CDP). */
    apiKey?: string;
    /** Ordered RPC failovers; an empty list disables failover. */
    failoverUrls?: string[];
  };
  /** Config-only vault override; every facilitator and consumer must use the same address. */
  vaultAddress?: string;
  /** Persisted `halo consume` defaults; command flags override them. */
  consume?: {
    /** Per-request spend ceiling in USD: estimated vault cost above it is refused (402). */
    maxUsdc: number;
    /** Model used when a consume request omits `model`. */
    defaultModel?: string;
    /** Models the agent will pay for. A request for any model NOT in this list is
     *  refused before payment. Empty/omitted ⇒ allow any model on the network. */
    allowedModels?: string[];
    /** Default port for the local endpoint (overridden by --port). */
    port?: number;
  };
}

const DIR_NAME = ".halo";

export function configDir(): string {
  return path.join(homedir(), DIR_NAME);
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function defaultKeystorePath(): string {
  return path.join(configDir(), "keystore.json");
}

export function loadConfig(): HaloConfig {
  const p = configPath();
  if (!existsSync(p)) {
    throw new Error(`No config at ${p}. Run: halo setup`);
  }
  const raw = readFileSync(p, "utf-8");
  return validateConfig(JSON.parse(raw) as HaloConfig);
}

export function saveConfig(cfg: HaloConfig): void {
  validateConfig(cfg);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function providerServesConfiguredImageModel(
  provider: ProviderConfig,
  model: string
): boolean {
  return (provider.imageModels ?? []).includes(model);
}

export function providerServesConfiguredImageEditModel(
  provider: ProviderConfig,
  model: string
): boolean {
  return (provider.imageEditModels ?? []).includes(model);
}

/** Per-image rate for `model`, or null if it isn't a configured image model; the provider's `usdcPerImage` overrides the operator-wide default. */
export function imagePriceForModel(cfg: HaloConfig, model: string): number | null {
  const provider = providerForModel(configProviders(cfg), model);
  if (!providerServesConfiguredImageModel(provider, model)) return null;
  const price = provider.pricing?.usdcPerImage ?? cfg.pricing.usdcPerImage;
  return typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null;
}

export function isPositiveImagePriceRepresentable(price: unknown): price is number {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return false;
  try {
    return priceImages(price, 1) > 0n;
  } catch {
    return false;
  }
}

const VALID_PRICING_MODES: PricingMode[] = ["margin", "flat"];

export function validateConfig(cfg: HaloConfig): HaloConfig {
  const providers = cfg.providers && cfg.providers.length > 0 ? cfg.providers : [cfg.provider];
  if (!VALID_PRICING_MODES.includes(cfg.pricing.mode)) {
    throw new Error(`unrecognized pricing.mode "${cfg.pricing.mode}"`);
  }
  for (const provider of providers) {
    if (provider.pricing && !VALID_PRICING_MODES.includes(provider.pricing.mode)) {
      throw new Error(
        `unrecognized pricing.mode "${provider.pricing.mode}" for provider "${provider.slug}"`
      );
    }
    const imageModels = provider.imageModels ?? [];
    const imageEditModels = provider.imageEditModels ?? [];
    const price = provider.pricing?.usdcPerImage ?? cfg.pricing.usdcPerImage;
    if (imageModels.length > 0) {
      if (!Number.isFinite(price) || (price ?? -1) < 0) {
        throw new Error(
          `imageModels for provider "${provider.slug}" requires a finite non-negative usdcPerImage`
        );
      }
      for (const imageModel of imageModels) {
        if (!provider.models.includes(imageModel)) {
          throw new Error(
            `imageModels entry "${imageModel}" must also be listed in provider "${provider.slug}" models`
          );
        }
      }
    }
    if (imageEditModels.length > 0) {
      if (imageEditAdapterFor(provider.slug) === null) {
        throw new Error(
          `imageEditModels for provider "${provider.slug}" requires a supported inline image-edit adapter`
        );
      }
      if (!isPositiveImagePriceRepresentable(price)) {
        throw new Error(
          `imageEditModels for provider "${provider.slug}" requires a finite positive usdcPerImage that remains non-zero at vault pricing precision`
        );
      }
      for (const editModel of imageEditModels) {
        if (!provider.models.includes(editModel)) {
          throw new Error(
            `imageEditModels entry "${editModel}" must also be listed in provider "${provider.slug}" models`
          );
        }
        if (!imageModels.includes(editModel)) {
          throw new Error(
            `imageEditModels entry "${editModel}" must also be listed in provider "${provider.slug}" imageModels`
          );
        }
      }
    }
  }
  return cfg;
}

/** Return `providers[]` or the primary provider as a non-empty list. */
export function configProviders(cfg: HaloConfig): ProviderConfig[] {
  if (cfg.providers && cfg.providers.length > 0) return cfg.providers;
  return [cfg.provider];
}

/** Resolve a model by exact then loose membership, falling back to the primary provider. */
export function providerForModel(providers: ProviderConfig[], model: string): ProviderConfig {
  return (
    providers.find((p) => p.models.includes(model)) ||
    providers.find((p) => p.models.some((advertised) => matchesModel(advertised, model))) ||
    providers[0]
  );
}

/** Union of every provider's advertised models, de-duplicated, order-preserving. */
export function allConfiguredModels(cfg: HaloConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of configProviders(cfg)) {
    for (const m of p.models) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

export const DEFAULT_RELAY_URL = "https://relay.runhalo.xyz";
export const DEFAULT_INDEXER_URL = "https://indexer.runhalo.xyz";
// The protocol facilitator is credentialless for operators and covers gas.
export const DEFAULT_FACILITATOR_URL = "https://facilitator.runhalo.xyz";

/** Fixed Base-mainnet identifiers shared by signing, USDC selection, and settlement. */
export const BASE_CHAIN_ID = 8453;
export const BASE_NETWORK = "base";
