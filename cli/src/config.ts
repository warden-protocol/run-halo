import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { EncryptedSecret } from "./secret";
import { matchesModel } from "@halo/vault-core";

/**
 * One upstream inference provider an operator fronts. A single operator may
 * carry several (multi-provider) — each request routes to the provider whose
 * `models` includes the requested model.
 */
export interface ProviderConfig {
  /** Provider slug: "openrouter" | "ollama" | "venice" | "near" | ... */
  slug: string;
  /** Base URL including /v1 */
  baseUrl: string;
  /**
   * Upstream provider API key. Two on-disk shapes are supported:
   *   - `string`           — legacy plaintext (still works; not recommended)
   *   - `EncryptedSecret`  — AES-256-GCM ciphertext keyed off the operator's
   *                          keystore passphrase. Decrypted at `serve` start
   *                          using the passphrase already entered to unlock
   *                          the wallet, so encryption adds zero new prompts.
   * At runtime `serve` mutates this back to a plaintext string before
   * `callUpstream` runs, so downstream code only ever sees `string | undefined`.
   */
  apiKey?: string | EncryptedSecret;
  /** Models this operator will advertise for this provider (subset of catalog). */
  models: string[];
  /**
   * Optional per-provider pricing override. Margins differ by gateway (a TEE
   * provider may warrant a different margin than a commodity one), so each
   * provider can carry its own; falls back to the top-level `cfg.pricing`.
   */
  pricing?: {
    mode: "margin" | "flat";
    marginPercent?: number;
    flatUsdcPer1KTokens?: number;
  };
}

export interface HaloConfig {
  version: 1;
  network: "base" | "base-sepolia";
  relayUrl: string;
  indexerUrl: string;
  operator: {
    address: string;
    keystorePath: string;
    /** Human-readable name shown in the League */
    label?: string;
    /**
     * Operator-declared prompt-log retention policy. Soft commitment —
     * surfaced in /v1/operators so privacy-aware consumers can filter.
     * Defaults to "unknown" when omitted (most cautious value for the consumer).
     */
    dataRetention?: "none" | "24h" | "7d" | "unknown";
    /**
     * Unattended mode: the keystore was created with an empty passphrase so
     * `halo serve` can start without a human at the keyboard. The
     * private key is recoverable from the keystore file in seconds by anyone
     * who can read it — file mode `0600` plus host-level access controls
     * become the only protection. API-key encryption is also forced off when
     * this is true (no passphrase to derive the encryption key from).
     */
    noPassphrase?: boolean;
  };
  /**
   * Primary upstream provider. Retained as the canonical single-provider field
   * for back-compat (existing configs, the relay's primary-slug classification,
   * and any code that reads one provider). When `providers` is also set, this is
   * mirrored as `providers[0]`.
   */
  provider: ProviderConfig;
  /**
   * Multi-provider operators: one `halo serve` can front several gateways at
   * once (e.g. OpenRouter for general models + NEAR for confidential ones).
   * Each request routes to the provider whose `models` list serves the
   * requested model (see `providerForModel`). When present this is the source
   * of truth and includes the primary as its first entry; when absent the
   * operator is single-provider (`[provider]`). Read via `configProviders`.
   */
  providers?: ProviderConfig[];
  pricing: {
    /** "margin" = upstreamCostUsdc × (1 + marginPercent/100); "flat" = flatUsdcPer1KTokens */
    mode: "margin" | "flat";
    marginPercent?: number;
    flatUsdcPer1KTokens?: number;
    /** Fallback fixed price per request in USDC base units (6 dp). Used when model token cost is unknown. */
    fallbackPerRequestUsdc: number;
  };
  facilitator: {
    url: string;
    /** Optional API key for facilitators that require auth (CDP). */
    apiKey?: string;
    /**
     * Failover URLs tried in order when the primary is down (I-03).
     * Empty array = no failover.
     */
    failoverUrls?: string[];
  };
  /**
   * Optional override for the HaloVault contract address this operator gates
   * against. Absent → the consensus-pinned VAULT_ADDRESS (production). Set this
   * ONLY to point at a non-prod deployment (e.g. a dev vault) whose facilitator
   * and consumers use the same address — it MUST match, or every vault request
   * is rejected. Deliberately config-only (never an env flag): see vault-address.ts.
   */
  vaultAddress?: string;
  /**
   * Optional consumer profile: persisted defaults for `halo consume` (the local
   * OpenAI-compatible endpoint that pays per request from this wallet). Set by
   * `halo setup` when the user opts to consume; absent when they only operate.
   * `halo consume` flags still override these at run time.
   */
  consume?: {
    /** Per-request spend ceiling in USD — the consumer's cost guard ("fallback"):
     *  a request is refused (402) if the operator asks for more. */
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

/** Current config dir name. */
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
  return JSON.parse(raw) as HaloConfig;
}

export function saveConfig(cfg: HaloConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * Normalized provider list. The multi-provider `providers[]` when set, else the
 * single legacy `provider` wrapped in a one-element list. Always ≥1 entry, so
 * callers never special-case the single-provider operator.
 */
export function configProviders(cfg: HaloConfig): ProviderConfig[] {
  if (cfg.providers && cfg.providers.length > 0) return cfg.providers;
  return [cfg.provider];
}

/**
 * Which provider serves `model`. Exact membership first, then a loose
 * substring match (mirrors the relay's tolerant model matching), else the
 * primary provider as a last resort. The provider's `models` list is the
 * routing key — a model announced by exactly one provider always resolves to it.
 */
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
// Default to the Halo protocol-run x402 facilitator. Operators don't
// need credentials or a personal wallet — the protocol covers gas. CDP and
// other facilitators remain valid via `--facilitator-url` if an operator
// wants their own settlement path.
export const DEFAULT_FACILITATOR_URL = "https://facilitator.runhalo.xyz";
