import prompts from "prompts";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { randomBytes, randomInt } from "crypto";
import path from "path";
import {
  configDir,
  configPath,
  DEFAULT_FACILITATOR_URL,
  DEFAULT_INDEXER_URL,
  DEFAULT_RELAY_URL,
  defaultKeystorePath,
  HaloConfig,
  ProviderConfig,
  configProviders,
  loadConfig,
  saveConfig,
} from "../config";
import { generateAndEncrypt, importAndEncrypt, loadWallet, writeKeystore } from "../wallet";
import { detectModels, PROVIDER_PRESETS } from "../providers";
import { providerSupportsMargin } from "../pricing";
import { encryptSecret, isEncryptedSecret } from "../secret";

export interface SetupFlags {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string; // "m1,m2,m3"
  margin?: number;
  flat?: number;
  fallbackCents?: number;
  /**
   * Append this provider to an existing operator instead of replacing it. Lets
   * one operator front several gateways at once (e.g. add NEAR confidential
   * models alongside an existing OpenRouter setup) — each request routes to the
   * provider that serves the requested model. Requires an existing config; the
   * wallet, network, and other providers are preserved untouched. The provider's
   * own pricing (margin/flat) is stored per-provider.
   */
  addProvider?: boolean;
  network?: "base" | "base-sepolia";
  label?: string;
  withPairing?: boolean;
  /**
   * Force wallet rotation. Without this flag, re-running setup with an existing
   * config preserves the operator wallet and only updates provider/pricing —
   * we never silently destroy an identity that already has accumulated league
   * points and dashboard pairings.
   */
  rotateWallet?: boolean;
  /**
   * Explicit choice for upstream API key encryption-at-rest.
   *   undefined → ask interactively (default behavior for human-driven setup)
   *   true      → encrypt with the keystore passphrase (recommended)
   *   false     → store plaintext (faster restart in trusted environments,
   *               but a stolen ~/.halo/ directory exposes the key)
   */
  encryptApiKey?: boolean;
  /**
   * Operator-declared prompt-log retention policy. Defaults to "unknown" if
   * omitted (most cautious value from the consumer's standpoint).
   */
  dataRetention?: "none" | "24h" | "7d" | "unknown";
  /**
   * Unattended mode: generate the wallet keystore with an empty passphrase,
   * skip every passphrase prompt, and force the upstream API key to be stored
   * plaintext. Intended for headless operator deploys (auto-restart, CI) where
   * no human is around to type. Comes with a clear security trade-off — see
   * the on-screen warning at setup time.
   */
  noWalletPassphrase?: boolean;
  /**
   * Non-interactive wallet choice for driven/headless setup. When set, the
   * "Generate / Import" select is skipped. Unattended mode (noWalletPassphrase)
   * defaults this to "generate" so the canonical agent command completes without
   * a human. NOTE: "import" still needs the key entered interactively (no pk
   * flag), so it can't fully run headless.
   */
  walletMode?: "generate" | "import";
  /**
   * Consumer profile (persisted for `halo consume`). `--consume` opts in
   * non-interactively (skips the yes/no prompt); the rest set its fields.
   * In unattended mode the consume step is only configured when `--consume` is
   * passed (it never prompts). Interactive setup asks if `--consume` is unset.
   */
  consume?: boolean;
  consumeModel?: string; // default model when a request omits one
  consumeAllow?: string; // CSV allowlist of payable models ("" / "any" ⇒ no limit)
  consumeMaxUsdc?: number; // per-request spend ceiling (the "fallback" cost guard)
  consumePort?: number;
  /**
   * Non-interactive private-key backup choice for the generate path. When set,
   * the backup prompt is skipped. Unattended mode defaults this to "skip" (the
   * encrypted keystore is the backup; don't write a plaintext copy unprompted).
   */
  keyBackup?: "file" | "skip";
  /**
   * DEV/TEST ESCAPE HATCH: override the x402 facilitator URL. Operators
   * should NEVER need this — the protocol-run facilitator is the single
   * authoritative settlement service in the current architecture, and
   * setup writes the protocol default URL automatically. This flag exists
   * only for development against a staging facilitator or for protocol
   * upgrades that need to point at a new instance during a migration
   * window. Intentionally omitted from `halo setup --help`.
   */
  facilitatorUrl?: string;
}

function passphraseStrength(p: string): { ok: boolean; label: string } {
  if (p.length < 12) return { ok: false, label: "too short — need 12+ characters" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 16 && classes < 3) return { ok: false, label: "weak — add uppercase, digits, or symbols" };
  return { ok: true, label: classes >= 3 && p.length >= 16 ? "strong" : "ok" };
}

const CONSUME_DEFAULT_MAX_USDC = 0.1;
// 8799, not the indexer's 8789 — avoids a common local port clash.
const CONSUME_DEFAULT_PORT = 8799;

/**
 * Resolve the optional consumer profile (`halo consume` defaults). Returns
 * undefined when the user doesn't consume. Precedence:
 *   --consume true/false       → honor without prompting
 *   unattended (no passphrase) → never prompt; configure only if --consume, else
 *                                preserve the existing profile
 *   interactive                → ask yes/no, then prompt the fields
 * `halo consume` flags still override these per run.
 */
async function resolveConsumeConfig(
  flags: SetupFlags,
  models: string[],
  existing: HaloConfig | null,
  cancel: { onCancel: () => never }
): Promise<HaloConfig["consume"] | undefined> {
  const csv = (s?: string) =>
    (s || "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && x.toLowerCase() !== "any");

  const fromFlags = (): NonNullable<HaloConfig["consume"]> => {
    const allow = csv(flags.consumeAllow);
    return {
      maxUsdc:
        flags.consumeMaxUsdc !== undefined && flags.consumeMaxUsdc > 0
          ? flags.consumeMaxUsdc
          : CONSUME_DEFAULT_MAX_USDC,
      defaultModel: flags.consumeModel || undefined,
      allowedModels: allow.length ? allow : undefined,
      port: flags.consumePort && flags.consumePort > 0 ? flags.consumePort : undefined,
    };
  };

  if (flags.consume === true) return fromFlags();
  if (flags.consume === false) return undefined;
  // Unattended + no explicit --consume: can't prompt; keep any existing profile.
  if (flags.noWalletPassphrase) return existing?.consume;

  const { yes } = await prompts(
    {
      type: "confirm",
      name: "yes",
      message: existing?.consume
        ? "Keep using this wallet to consume inference via the local API (halo consume)?"
        : "Also use this wallet to CONSUME inference via a local API (halo consume)?",
      initial: !!existing?.consume,
    },
    cancel
  );
  if (!yes) return undefined;

  const { dm } = await prompts(
    {
      type: "text",
      name: "dm",
      message: "Default model when a request omits one (blank = none; the client names it)",
      initial: existing?.consume?.defaultModel || models[0] || "",
    },
    cancel
  );
  const { allow } = await prompts(
    {
      type: "text",
      name: "allow",
      message: "Models you'll pay for, comma-separated (blank or 'any' = no limit)",
      initial: (existing?.consume?.allowedModels || models).join(","),
    },
    cancel
  );
  const { mx } = await prompts(
    {
      type: "number",
      name: "mx",
      message: "Per-request spend ceiling in USD (the consumer's cost guard)",
      initial: existing?.consume?.maxUsdc ?? CONSUME_DEFAULT_MAX_USDC,
      float: true,
      min: 0,
    },
    cancel
  );
  const { pt } = await prompts(
    {
      type: "number",
      name: "pt",
      message: "Local endpoint port",
      initial: existing?.consume?.port ?? CONSUME_DEFAULT_PORT,
      min: 1,
    },
    cancel
  );
  const allowed = csv(allow);
  return {
    maxUsdc: typeof mx === "number" && mx > 0 ? mx : CONSUME_DEFAULT_MAX_USDC,
    defaultModel: ((dm as string) || "").trim() || undefined,
    allowedModels: allowed.length ? allowed : undefined,
    port: typeof pt === "number" && pt > 0 ? pt : undefined,
  };
}

export async function cmdSetup(flags: SetupFlags = {}): Promise<void> {
  console.log("\nhalo setup\n");
  if (flags.provider || flags.models || flags.margin !== undefined || flags.flat !== undefined) {
    console.log("  using flags from caller — interactive prompts skipped where provided\n");
  }

  const cancel = { onCancel: () => process.exit(130) };

  // ── Wallet ─────────────────────────────────────────────────────────────
  // Identity preservation: if a config already exists at ~/.halo/, we
  // do NOT touch the keystore. Re-running setup is for adjusting provider,
  // pricing, or label — not for rotating identity. An accumulated league
  // history and dashboard pairings live on the address; silently overwriting
  // would orphan them. Pass --rotate-wallet to opt in to a new wallet.
  //
  // Orphaned-keystore recovery: if config.json is missing but a keystore.json
  // exists at the default path, that's the fingerprint of a setup that
  // crashed mid-way (most commonly: the scrypt-maxmem boundary on Node 18
  // during API-key encryption). Treat the keystore as a preserved wallet so
  // a retry of setup doesn't blow away the user's identity. The address is
  // recoverable from the keystore JSON without decryption.
  const existingConfig = existsSync(configPath()) ? safeLoadConfig() : null;
  const orphanedAddr = !existingConfig ? readOrphanedKeystoreAddress() : null;
  const preserveExisting =
    (existingConfig !== null || orphanedAddr !== null) && !flags.rotateWallet;

  let address: string;
  let keystorePath: string;
  // Passphrase is captured here only when we generate/import a wallet. When we
  // preserve an existing wallet and the caller asked for --with-pairing, we
  // prompt for the passphrase later (inside emitPairingCode).
  let passphrase: string | undefined;

  if (preserveExisting && existingConfig) {
    address = existingConfig.operator.address;
    keystorePath = existingConfig.operator.keystorePath;
    console.log(`  ✓ Keeping existing wallet: ${address}`);
    console.log(`    Keystore: ${keystorePath}`);
    console.log(`    (pass --rotate-wallet to generate a new wallet — destroys current identity)\n`);
  } else if (preserveExisting && orphanedAddr) {
    address = orphanedAddr;
    keystorePath = defaultKeystorePath();
    console.log(`  ℹ Found orphaned keystore from a prior crashed setup.`);
    console.log(`    Address: ${address}`);
    console.log(`    Keystore: ${keystorePath}`);
    console.log(`    Recovering by treating this as a preserved wallet — your existing`);
    console.log(`    identity and any league points stay with this address.`);
    console.log(`    (pass --rotate-wallet to discard it instead — destructive.)\n`);
  } else {
    if (existingConfig && flags.rotateWallet) {
      console.log(`  ⚠ --rotate-wallet set: existing wallet ${existingConfig.operator.address}`);
      console.log(`    will be replaced. Back up the keystore first if you want to recover it:`);
      console.log(`    ${existingConfig.operator.keystorePath}\n`);
    }
    const wallet = await runWalletWizard(cancel, !!flags.noWalletPassphrase, {
      walletMode: flags.walletMode,
      keyBackup: flags.keyBackup,
    });
    address = wallet.address;
    keystorePath = defaultKeystorePath();
    passphrase = wallet.passphrase;
    writeKeystore(keystorePath, wallet.encryptedJson);
    console.log(`  Keystore: ${keystorePath} (0600)\n`);
  }

  // Unattended-mode propagation: if the operator opted out of a wallet
  // passphrase, we cannot encrypt the API key (no key material to derive
  // the AES key from), and we'll mark the config so `serve` knows to skip
  // its passphrase prompt at startup.
  const noPassphrase = !!flags.noWalletPassphrase;
  if (noPassphrase && flags.encryptApiKey === true) {
    console.log(
      "  ⚠ --no-wallet-passphrase forces plaintext API key storage; --encrypt-api-key ignored\n"
    );
  }
  if (noPassphrase) {
    // Force the API key resolver into plaintext mode — no passphrase exists.
    flags = { ...flags, encryptApiKey: false };
  }

  // ── Provider ───────────────────────────────────────────────────────────
  let slug: string;
  if (flags.provider) {
    if (!PROVIDER_PRESETS[flags.provider]) {
      throw new Error(
        `unknown provider "${flags.provider}". Valid: ${Object.keys(PROVIDER_PRESETS).join(", ")}`
      );
    }
    slug = flags.provider;
    console.log(`  provider: ${slug} (from --provider)`);
  } else {
    const providerChoices = Object.values(PROVIDER_PRESETS).map((p) => ({
      title: p.label,
      value: p.slug,
    }));
    const r = await prompts(
      {
        type: "select",
        name: "slug",
        message: "Inference provider",
        choices: providerChoices,
      },
      cancel
    );
    slug = r.slug;
  }

  const preset = PROVIDER_PRESETS[slug];
  let baseUrl = flags.baseUrl || preset.baseUrl;
  if (!baseUrl) {
    const r = await prompts(
      {
        type: "text",
        name: "u",
        message: "Base URL (OpenAI-compatible, include /v1)",
        validate: (v: string) => (/^https?:\/\//.test(v) ? true : "must be http(s) URL"),
      },
      cancel
    );
    baseUrl = r.u;
  }

  // API key resolution. Precedence:
  //   1. Explicit --api-key flag → use it (operator wants to rotate)
  //   2. Existing config with same provider slug → preserve the value AS-IS
  //      (handles the footgun where re-running setup to change one thing —
  //      margin, label, facilitator URL — silently blanked the upstream API
  //      key when no --api-key flag was passed)
  //   3. Interactive prompt → ask (only fires when nothing else applies)
  //
  // When preserving, the existing key is kept in its on-disk form (plaintext
  // string or EncryptedSecret) and bypasses resolveApiKeyStorage so we don't
  // try to decrypt+re-encrypt when we don't have to.
  let apiKey: string | undefined = flags.apiKey;
  let preservedApiKey: string | import("../secret").EncryptedSecret | undefined;

  const canPreserveExistingKey =
    flags.apiKey === undefined &&
    existingConfig !== null &&
    existingConfig.provider.slug === slug &&
    existingConfig.provider.apiKey !== undefined &&
    existingConfig.provider.apiKey !== "";

  if (canPreserveExistingKey) {
    preservedApiKey = existingConfig!.provider.apiKey;
    const shape = isEncryptedSecret(preservedApiKey) ? "encrypted" : "plaintext";
    console.log(`  ✓ keeping existing ${preset.label} API key (${shape})`);
  } else if (preset.requiresApiKey && !apiKey) {
    const { k } = await prompts(
      {
        type: "password",
        name: "k",
        message: `${preset.label} API key`,
        validate: (v: string) => (v.length > 0 ? true : "required"),
      },
      cancel
    );
    apiKey = k;
  }

  // Normalize the key before storage: a key that "works when I curl it" but is
  // refused by Halo is almost always a paste artifact — a leading "Bearer ",
  // surrounding quotes, or stray whitespace/newline. Halo sends the stored bytes
  // verbatim as `Authorization: Bearer <key>`, so strip those here once.
  if (typeof apiKey === "string") {
    const cleaned = apiKey
      .trim()
      .replace(/^Bearer\s+/i, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (cleaned !== apiKey) {
      console.log("  ℹ normalized API key (stripped Bearer prefix / quotes / whitespace)");
      apiKey = cleaned;
    }
    // Reject an obviously MASKED/TRUNCATED key. The #1 way an AI agent driving
    // setup corrupts a key is by reading the terminal's masked display
    // (`sk-or-…1955`, `sk-…abcd`) instead of the real bytes — the stored value
    // then contains an ellipsis or is implausibly short, and every upstream call
    // 401s. Catch it here with a loud, specific error rather than letting a dead
    // key reach `serve`. Pass the FULL key from its original source (the user's
    // paste, an env var, the provider dashboard) — never a value copied from
    // masked terminal output.
    if (apiKey) {
      if (/[…⋯]|\.{3,}|\*{2,}|•{2,}/.test(apiKey)) {
        throw new Error(
          `the API key contains a masking marker (… / ... / ***) — it looks like a value copied from MASKED terminal output, not the real key. Pass the FULL key from its original source.`
        );
      }
      // Heuristic length floor: real provider keys are 30+ chars. A 13-char
      // "key" (the truncated case seen in the wild) is never valid.
      if (preset.requiresApiKey && apiKey.length < 20) {
        throw new Error(
          `the API key is only ${apiKey.length} characters — that's too short to be a real ${preset.label} key (likely truncated by masked terminal output). Pass the FULL key.`
        );
      }
    }
  }

  // ── Models ─────────────────────────────────────────────────────────────
  let models: string[] = [];
  if (flags.models) {
    models = flags.models
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (models.length === 0) throw new Error("--models was empty after parsing");
    console.log(`  models: ${models.length} from --models flag`);
  } else {
    console.log("\n  detecting models...");
    try {
      models = await detectModels(baseUrl, apiKey, slug);
      console.log(`  ✓ found ${models.length} model(s)`);
    } catch (err) {
      console.log(`  ✖ auto-detect failed: ${err instanceof Error ? err.message : err}`);
    }

    if (models.length > 0) {
      const top = models.slice(0, 50).map((m) => ({ title: m, value: m, selected: true }));
      const { selected } = await prompts(
        {
          type: "multiselect",
          name: "selected",
          message: "Models to advertise",
          choices: top,
          min: 1,
        },
        cancel
      );
      models = selected;
    } else {
      const { manual } = await prompts(
        {
          type: "text",
          name: "manual",
          message: "Model id(s) to advertise (comma-separated)",
          validate: (v: string) => (v.trim().length > 0 ? true : "required"),
        },
        cancel
      );
      models = String(manual)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  }

  // ── Pricing ────────────────────────────────────────────────────────────
  let pricingMode: "margin" | "flat";
  let marginPercent: number | undefined;
  let flatUsdcPer1KTokens: number | undefined;

  if (flags.margin !== undefined && flags.flat !== undefined) {
    throw new Error("--margin and --flat are mutually exclusive");
  }
  if (flags.margin !== undefined) {
    pricingMode = "margin";
    marginPercent = flags.margin;
    console.log(`  pricing: margin ${marginPercent}% (from --margin)`);
  } else if (flags.flat !== undefined) {
    pricingMode = "flat";
    flatUsdcPer1KTokens = flags.flat;
    console.log(`  pricing: flat $${flatUsdcPer1KTokens}/1K tokens (from --flat)`);
  } else {
    const r = await prompts(
      {
        type: "select",
        name: "pricingMode",
        message: "Pricing model",
        choices: [
          { title: "Margin on upstream cost (paid gateways)", value: "margin" },
          { title: "Flat per 1K tokens (local / free models)", value: "flat" },
        ],
        initial: slug === "ollama" ? 1 : 0,
      },
      cancel
    );
    pricingMode = r.pricingMode;
    if (pricingMode === "margin") {
      const { pct } = await prompts(
        {
          type: "number",
          name: "pct",
          message: "Margin % on top of upstream cost",
          initial: preset.defaultMarginPercent,
          validate: (v: number) => (v >= 0 && v <= 1000 ? true : "0–1000"),
        },
        cancel
      );
      marginPercent = pct;
      // Warn loudly if margin mode is paired with a provider we don't
      // have an upstream pricing resolver for. Without one, every
      // settle falls through to fallbackPerRequestUsdc and the
      // marginPercent value is effectively ignored.
      if (!providerSupportsMargin(slug)) {
        console.log(
          `\n  ⚠ margin mode against provider "${slug}" has no upstream pricing resolver yet.`
        );
        console.log(
          `    Every settle will fall back to fallbackPerRequestUsdc — your --margin value`
        );
        console.log(
          `    won't be respected. Use --flat instead, or accept the flat fallback.`
        );
        console.log(
          `    Supported margin providers today: openrouter, near.\n`
        );
      }
    } else {
      const { usd } = await prompts(
        {
          type: "number",
          name: "usd",
          message: "Flat price per 1K tokens (USD, e.g. 0.0005)",
          initial: 0.0005,
          float: true,
          increment: 0.0001,
        },
        cancel
      );
      flatUsdcPer1KTokens = usd;
    }
  }

  // "Driven mode" detection: the caller passed enough flags that interactive
  // prompts should be suppressed and reasonable defaults assumed. Computed
  // here (rather than near its only other use further down) because the
  // fallback-cents resolution below needs it to decide whether to prompt or
  // use the default.
  const drivenMode = !!(
    flags.provider ||
    flags.models ||
    flags.margin !== undefined ||
    flags.flat !== undefined
  );

  // Fallback price per request, in CENTS USD. Charged when token-count
  // pricing isn't available (margin mode, or flat mode when total_tokens is
  // missing). Default of 1 cent ($0.01) is sane for almost every operator.
  //
  // This prompt was historically a footgun: in driven-mode the agent shell
  // can't reliably answer an interactive number prompt, and the unit string
  // "cents USD" was easy to misread. A `10000` typo here produces a $100
  // fallback per inference and an operator advertising $100 per 1K tokens.
  // The mitigations below are layered defense:
  //
  //   1. In driven mode, skip the prompt and default to 1 cent silently.
  //      Operators with non-default needs pass --fallback-cents.
  //   2. Hard cap at 1000 cents ($10) without an explicit acknowledgement.
  //      Anything above that is almost certainly a unit-confusion typo.
  //   3. Print a confirmation summary showing the USD equivalent so the
  //      operator can catch a mistake visually before serve goes live.
  const FALLBACK_HARD_CAP_CENTS = 1000;
  let fallbackCents: number;
  if (flags.fallbackCents !== undefined) {
    if (flags.fallbackCents < 0) throw new Error("--fallback-cents must be >= 0");
    fallbackCents = flags.fallbackCents;
  } else if (drivenMode) {
    fallbackCents = 1;
    console.log(
      "  fallback price per request: $0.01 (default; pass --fallback-cents to override)"
    );
  } else {
    const r = await prompts(
      {
        type: "number",
        name: "fallbackCents",
        message: "Fallback price per request (cents USD; 1 = $0.01, 100 = $1.00)",
        initial: 1,
        validate: (v: number) => {
          if (v < 0) return "must be >= 0";
          if (v > FALLBACK_HARD_CAP_CENTS) {
            return `${v} cents = $${(v / 100).toFixed(2)} per request — that looks like a unit-confusion typo. Common values are 1–10 cents. Pass --fallback-cents ${v} explicitly if you really mean this.`;
          }
          return true;
        },
      },
      cancel
    );
    fallbackCents = r.fallbackCents;
  }
  if (fallbackCents > FALLBACK_HARD_CAP_CENTS && flags.fallbackCents === undefined) {
    // Defense-in-depth: this branch shouldn't reach here from any code path,
    // but if it does (e.g., agent-driven setup later evolves to pass weird
    // values), block at the boundary rather than save a $100 config.
    throw new Error(
      `fallback-cents ${fallbackCents} = $${(fallbackCents / 100).toFixed(2)} per request exceeds the safety cap of $${(FALLBACK_HARD_CAP_CENTS / 100).toFixed(2)}. Pass --fallback-cents explicitly to override.`
    );
  }
  const fallbackPerRequestUsdc = Math.round(fallbackCents * 10_000); // cents → base units

  // ── Network + infra URLs ───────────────────────────────────────────────
  // When the agent drove the provider/models/pricing decisions via flags, the
  // remaining infra URLs are almost always defaults — skip those prompts to
  // avoid an unattended setup hanging on them. Reuses the drivenMode flag
  // computed above for the fallback-cents resolution.
  const driven = drivenMode;

  // When re-running setup with an existing config, default infra settings to
  // whatever the operator already had — never silently reset them.
  const networkDefault = existingConfig?.network ?? "base";
  const relayDefault = existingConfig?.relayUrl ?? DEFAULT_RELAY_URL;
  const indexerDefault = existingConfig?.indexerUrl ?? DEFAULT_INDEXER_URL;
  // Facilitator URL + key are always reset to protocol defaults (see below).
  // No existingConfig-derived facilitator defaults — the protocol owns this.
  const labelDefault = existingConfig?.operator.label ?? "";
  const retentionDefault = existingConfig?.operator.dataRetention ?? "unknown";

  const dataRetention: "none" | "24h" | "7d" | "unknown" =
    flags.dataRetention ?? retentionDefault;

  let network: "base" | "base-sepolia";
  if (flags.network) {
    network = flags.network;
  } else if (driven) {
    network = networkDefault;
  } else {
    const r = await prompts(
      {
        type: "select",
        name: "network",
        message: "Network",
        choices: [
          { title: "Base mainnet", value: "base" },
          { title: "Base Sepolia (testnet)", value: "base-sepolia" },
        ],
        initial: networkDefault === "base-sepolia" ? 1 : 0,
      },
      cancel
    );
    network = r.network;
  }

  let relayUrl = relayDefault;
  let indexerUrl = indexerDefault;
  // Facilitator is protocol infrastructure, not an operator concern. Setup
  // always writes the protocol default URL and never a per-operator API key,
  // regardless of what the existing config has. Auto-migrates any operator
  // whose config predates the protocol facilitator (e.g., the CDP default
  // URL from earlier alpha builds) — silent except for a single-line notice.
  //
  // --facilitator-url is honored only as a dev/test escape hatch (staging
  // facilitator, protocol-upgrade migration windows). Not in --help.
  let facilitatorUrl = flags.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;
  const facilitatorKey = "";
  if (
    existingConfig &&
    existingConfig.facilitator.url !== facilitatorUrl &&
    flags.facilitatorUrl === undefined
  ) {
    console.log(
      `  ℹ migrating facilitator: ${existingConfig.facilitator.url} → ${facilitatorUrl}`
    );
  }
  if (!driven) {
    const r1 = await prompts(
      { type: "text", name: "relayUrl", message: "Relay URL", initial: relayDefault },
      cancel
    );
    relayUrl = r1.relayUrl;
    const r2 = await prompts(
      { type: "text", name: "indexerUrl", message: "Indexer URL", initial: indexerDefault },
      cancel
    );
    indexerUrl = r2.indexerUrl;
    // No prompt for facilitator URL/key — they're protocol infrastructure,
    // not operator config. The protocol default is always correct.
  }

  let label: string;
  if (flags.label !== undefined) {
    label = flags.label;
  } else if (driven) {
    label = labelDefault;
  } else {
    const r = await prompts(
      {
        type: "text",
        name: "label",
        message: "Label shown in the League (optional)",
        initial: labelDefault,
      },
      cancel
    );
    label = r.label;
  }

  // ── Upstream API key encryption-at-rest ────────────────────────────────
  // The wallet keystore on this host is already passphrase-protected. Offer
  // the operator the choice of binding the upstream API key (OpenRouter,
  // Anthropic, Hermes, …) to the same passphrase. Defaults to ON because
  // the passphrase is already entered on every `serve` start — turning it on
  // adds zero new prompts but defends against a stolen ~/.halo/.
  //
  // If we preserved an existing key (operator re-ran setup without changing
  // the upstream credential), keep it in its on-disk form and bypass the
  // encryption decision — we'd have to decrypt to re-encrypt, requiring the
  // passphrase. Idempotent for unattended-mode re-runs.
  const finalApiKey =
    preservedApiKey !== undefined
      ? preservedApiKey
      : await resolveApiKeyStorage(apiKey, flags, passphrase, driven);

  // ── Multi-provider: append this provider to an existing operator ──────────
  // Preserves the wallet, network, and every other provider; only adds (or
  // updates, if the same slug) one entry. The new provider keeps its own
  // pricing block so a confidential gateway can carry a different margin than
  // a commodity one. Each inference then routes to whichever provider serves
  // the requested model.
  if (flags.addProvider) {
    if (!existingConfig) {
      throw new Error(
        "--add-provider needs an existing operator config. Run `halo setup` once to create the operator, then `halo setup --add-provider --provider <slug> --api-key <key>` to add another gateway."
      );
    }
    const newProvider: ProviderConfig = {
      slug,
      baseUrl,
      apiKey: finalApiKey,
      models,
      pricing: { mode: pricingMode, marginPercent, flatUsdcPer1KTokens },
    };
    // Start from the existing provider list (normalizing a single-provider
    // config to a list), then replace-or-append this slug.
    const existingList = configProviders(existingConfig).map((p) => ({ ...p }));
    const at = existingList.findIndex((p) => p.slug === slug);
    if (at >= 0) existingList[at] = newProvider;
    else existingList.push(newProvider);

    const merged: HaloConfig = {
      ...existingConfig,
      providers: existingList,
      // Mirror primary as providers[0] for back-compat readers.
      provider: existingList[0],
    };
    saveConfig(merged);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Provider ${at >= 0 ? "updated" : "added"}: ${slug} (${models.length} models)`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Operator:    ${existingConfig.operator.address}`);
    console.log(`  Providers:   ${existingList.map((p) => `${p.slug} (${p.models.length})`).join(", ")}`);
    const totalModels = new Set(existingList.flatMap((p) => p.models)).size;
    console.log(`  Total models: ${totalModels}`);
    console.log(`  Config:      ${configPath()}\n`);
    console.log(`  Next: restart \`halo serve\` to announce the new provider's models.\n`);
    return;
  }

  const consume = await resolveConsumeConfig(flags, models, existingConfig, cancel);

  const cfg: HaloConfig = {
    version: 1,
    network,
    relayUrl,
    indexerUrl,
    consume,
    operator: {
      address,
      keystorePath,
      label: label || undefined,
      dataRetention,
      noPassphrase: noPassphrase ? true : undefined,
    },
    provider: {
      slug,
      baseUrl,
      apiKey: finalApiKey,
      models,
    },
    pricing: {
      mode: pricingMode,
      marginPercent,
      flatUsdcPer1KTokens,
      fallbackPerRequestUsdc,
    },
    facilitator: {
      url: facilitatorUrl,
      apiKey: facilitatorKey || undefined,
    },
  };

  saveConfig(cfg);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Halo operator configured`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Address:     ${address}`);
  console.log(`  Network:     ${network}`);
  console.log(`  Provider:    ${slug} (${models.length} models)`);
  if (apiKey) {
    console.log(
      `  API key:     ${isEncryptedSecret(finalApiKey) ? "encrypted (AES-256-GCM, keystore passphrase)" : "plaintext (file 0600)"}`
    );
  }
  // Show the pricing in human-readable USD. This is the visual sanity check
  // for the cents-vs-dollars unit confusion the prompt has historically been
  // vulnerable to. An operator scanning the summary line will notice a $100
  // fallback or a $5/1K-tokens flat rate immediately, before serve goes live.
  const pricingDetail =
    pricingMode === "flat"
      ? `flat $${(flatUsdcPer1KTokens ?? 0).toFixed(4)}/1K tokens`
      : `margin ${marginPercent ?? 0}% over upstream`;
  const fallbackDetail = `fallback $${(fallbackCents / 100).toFixed(2)}/request`;
  console.log(`  Pricing:     ${pricingDetail}; ${fallbackDetail}`);
  console.log(`  Relay:       ${relayUrl}`);
  console.log(`  Indexer:     ${indexerUrl}`);
  console.log(`  Facilitator: ${facilitatorUrl}`);
  if (consume) {
    const allow = consume.allowedModels?.length ? consume.allowedModels.join(", ") : "any";
    console.log(
      `  Consume:     up to $${consume.maxUsdc.toFixed(2)}/request · models: ${allow}` +
        (consume.defaultModel ? ` · default ${consume.defaultModel}` : "")
    );
  }
  console.log(`  Config:      ${configPath()}\n`);

  // Wallet funding hint: ETH is only needed if the operator wants to move
  // their earned USDC. x402 settlement gas is paid by the facilitator (CDP).
  console.log(`  Next:`);
  console.log(`    halo serve        — connect to relay and start earning`);
  if (consume) {
    console.log(`    halo consume      — local OpenAI-compatible endpoint (fund this wallet with USDC)`);
  }
  console.log(`    halo link         — pair with a dashboard wallet\n`);

  // ── Optional: chain into pairing-code generation. We already know the
  // passphrase here, so we don't need to re-prompt the operator (which would
  // be a poor experience inside an agent-driven flow).
  if (flags.withPairing) {
    await emitPairingCode(cfg, passphrase);
  }
}

function safeLoadConfig(): HaloConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/**
 * Read the wallet address from a keystore-only state (no config.json).
 *
 * Called when we detect ~/.halo/keystore.json exists but config.json
 * doesn't — almost always the fingerprint of a setup that crashed after the
 * wallet was generated but before saveConfig ran. v3 ethers keystores store
 * the address in cleartext under the top-level `address` field; we only need
 * that to identify which wallet the keystore belongs to, never to unlock it.
 *
 * Returns the 0x-prefixed checksum-case-insensitive address, or null if the
 * keystore is missing, malformed, or lacks a usable address field.
 */
function readOrphanedKeystoreAddress(): string | null {
  const ksPath = defaultKeystorePath();
  if (!existsSync(ksPath)) return null;
  try {
    const ks = JSON.parse(readFileSync(ksPath, "utf-8")) as { address?: unknown };
    if (typeof ks.address !== "string") return null;
    const addr = ks.address.startsWith("0x") ? ks.address : `0x${ks.address}`;
    return /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function runWalletWizard(
  cancel: { onCancel: () => never },
  noPassphrase: boolean = false,
  driven: { walletMode?: "generate" | "import"; keyBackup?: "file" | "skip" } = {}
): Promise<{ address: string; encryptedJson: string; passphrase: string }> {
  // Resolve the wallet mode without a prompt when driven/headless: an explicit
  // --wallet-mode wins; otherwise unattended mode (no passphrase, no human)
  // defaults to "generate" so the canonical agent command completes. Only fall
  // back to the interactive select when none of that applies.
  let walletMode = driven.walletMode;
  if (!walletMode && noPassphrase) walletMode = "generate";
  if (!walletMode) {
    const choice = await prompts(
      {
        type: "select",
        name: "mode",
        message: "Operator wallet",
        choices: [
          { title: "Generate a new wallet", value: "generate" },
          { title: "Import an existing private key", value: "import" },
        ],
      },
      cancel
    );
    walletMode = choice.mode as "generate" | "import";
  } else {
    console.log(`  wallet: ${walletMode} (non-interactive)`);
  }
  const walletChoice = { mode: walletMode };

  let passphrase: string;
  if (noPassphrase) {
    // Unattended mode — generate the keystore with an empty passphrase so
    // `halo serve` can start without a human at the keyboard. The key
    // in the file is then recoverable in seconds by anyone who can read it,
    // so the security model collapses to "trust the host's user account and
    // file mode 0600". Print the warning loudly so the operator is never in
    // any doubt about what they just signed up for.
    console.log("\n  ━━━ Unattended mode (--no-wallet-passphrase) ━━━");
    console.log("  The wallet keystore will be created with an EMPTY passphrase.");
    console.log("  Anyone with read access to the keystore file can extract the");
    console.log("  private key in seconds. Use this only on:");
    console.log("    • a host where you trust every other user on the machine, and");
    console.log("    • a filesystem that's covered by full-disk encryption.");
    console.log("  The API key will also be stored plaintext (no key to encrypt with).\n");
    passphrase = "";
  } else {
    while (true) {
      const p1 = await prompts(
        {
          type: "password",
          name: "p",
          message: "Keystore passphrase (12+ chars; use a passphrase manager)",
          validate: (v: string) => {
            const s = passphraseStrength(v);
            return s.ok ? true : s.label;
          },
        },
        cancel
      );
      const p2 = await prompts(
        { type: "password", name: "p", message: "Confirm passphrase" },
        cancel
      );
      if (p1.p === p2.p) {
        passphrase = p1.p;
        console.log(`  strength: ${passphraseStrength(p1.p).label}`);
        break;
      }
      console.log("✖ passphrases did not match — try again\n");
    }
  }

  if (walletChoice.mode === "generate") {
    const generated = await generateAndEncrypt(passphrase);
    console.log(`\n✓ Generated wallet: ${generated.address}`);

    // M-01: do NOT print private key to stdout. Write it to a 0600 file the
    // user can move/shred, or skip entirely — the encrypted keystore already
    // holds the key. Driven/headless: honor --key-backup, else default to "skip"
    // in unattended mode (don't write a plaintext copy with no human present).
    let backupMode = driven.keyBackup;
    if (!backupMode && noPassphrase) backupMode = "skip";
    if (!backupMode) {
      const backup = await prompts(
        {
          type: "select",
          name: "mode",
          message: "Private key backup",
          choices: [
            {
              title: "Write to a 0600 file (recommended — then move to a password manager)",
              value: "file",
            },
            { title: "Skip (the keystore is my only backup)", value: "skip" },
          ],
        },
        cancel
      );
      backupMode = backup.mode as "file" | "skip";
    }
    if (backupMode === "file") {
      const target = path.join(configDir(), "private-key-backup.txt");
      try {
        // On a fresh install the config dir doesn't exist yet (the keystore is
        // written later by the caller). Without this, writeFileSync throws ENOENT
        // and aborts setup — and "Write to a 0600 file" is the recommended option.
        mkdirSync(configDir(), { recursive: true });
        writeFileSync(
          target,
          `# Halo private key backup — delete after copying to a password manager.\n# Address: ${generated.address}\n${generated.privateKey}\n`,
          { mode: 0o600 }
        );
        chmodSync(target, 0o600);
        console.log(`  ✓ Wrote ${target} (0600). Move to your password manager and shred.\n`);
      } catch (err) {
        // The encrypted keystore is the real backup, so don't abort setup over a
        // failed convenience copy — warn and continue.
        console.log(
          `  ⚠ Couldn't write the key backup file (${(err as Error).message}). ` +
            `The encrypted keystore is still your backup; keep the passphrase safe.\n`
        );
      }
    } else {
      console.log(`  Keystore-only. If you lose the passphrase, the key is unrecoverable.\n`);
    }

    return {
      address: generated.address,
      encryptedJson: generated.encryptedJson,
      passphrase,
    };
  }

  const { pk } = await prompts(
    {
      type: "password",
      name: "pk",
      message: "Existing private key (0x…)",
      validate: (v: string) =>
        /^0x?[0-9a-fA-F]{64}$/.test(v) ? true : "must be a 32-byte hex key",
    },
    cancel
  );
  const imported = await importAndEncrypt(
    pk.startsWith("0x") ? pk : `0x${pk}`,
    passphrase
  );
  console.log(`\n✓ Imported wallet: ${imported.address}\n`);
  return {
    address: imported.address,
    encryptedJson: imported.encryptedJson,
    passphrase,
  };
}

async function emitPairingCode(
  cfg: HaloConfig,
  passphrase: string | undefined
): Promise<void> {
  // When setup preserved an existing wallet, we don't have the passphrase in
  // hand — prompt for it now. Skipped in the generate/import path because the
  // user just typed it 30 seconds ago. Note `passphrase === ""` is a *known*
  // empty passphrase (unattended mode) and must fall straight through to
  // loadWallet — only `undefined` means "we don't have it".
  if (passphrase === undefined) {
    const r = await prompts({
      type: "password",
      name: "p",
      message: "Keystore passphrase (to sign pairing code)",
    });
    if (!r.p) {
      console.log("  ✖ pairing skipped (no passphrase). Run `halo link` later.\n");
      return;
    }
    passphrase = r.p;
  }

  const wallet = await loadWallet(cfg.operator.keystorePath, passphrase!);
  const code = generatePairingCode();
  const nonce = "0x" + randomBytes(32).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 min
  const message = `halo-link-init:${wallet.address.toLowerCase()}:${code}:${nonce}:${expiresAt}`;
  const operatorSig = await wallet.signMessage(message);

  const url = `${cfg.indexerUrl.replace(/\/+$/, "")}/link/init`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        operatorAddress: wallet.address,
        operatorSig,
        nonce,
        expiresAt,
      }),
    });
    if (!res.ok) {
      console.log(
        `  ✖ pairing-code init failed: ${res.status} ${await res.text()} — run \`halo link\` to retry\n`
      );
      return;
    }
  } catch (err) {
    console.log(
      `  ✖ pairing-code init failed: ${err instanceof Error ? err.message : err} — run \`halo link\` to retry\n`
    );
    return;
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Pairing code (link your dashboard wallet)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\n                 ${code}\n`);
  console.log(`  Open the dashboard, paste this code, and sign with your wallet.`);
  console.log(`  Valid 5 minutes.\n`);
}

function generatePairingCode(): string {
  // CSPRNG (crypto.randomInt), not Math.random — this is a pairing secret.
  const groups = Array.from({ length: 3 }, () =>
    randomInt(0, 1000).toString().padStart(3, "0")
  );
  return groups.join("-");
}

/**
 * Decide how the upstream API key lands in config.json.
 *
 * Inputs the caller already resolved:
 *   - `apiKey`: the plaintext key the user just typed or passed via --api-key
 *               (undefined for ollama/lmstudio/openclaw).
 *   - `flags.encryptApiKey`: explicit yes/no from --encrypt-api-key / --no-...
 *   - `walletPassphrase`: the keystore passphrase if we have it in hand
 *                         (true for generate/import path; undefined when we
 *                          preserved an existing wallet — we prompt late).
 *   - `driven`: true when the agent passed enough flags that we shouldn't
 *               drop into an interactive question.
 *
 * Output: either a plaintext string (legacy / opted-out) or an EncryptedSecret
 * envelope. Returning undefined means "no key" (free providers).
 */
async function resolveApiKeyStorage(
  apiKey: string | undefined,
  flags: SetupFlags,
  walletPassphrase: string | undefined,
  driven: boolean
): Promise<string | import("../secret").EncryptedSecret | undefined> {
  if (!apiKey) return undefined;

  let shouldEncrypt: boolean;
  if (flags.encryptApiKey === true) {
    shouldEncrypt = true;
    console.log("  encrypt API key: yes (from --encrypt-api-key)");
  } else if (flags.encryptApiKey === false) {
    shouldEncrypt = false;
    console.log("  encrypt API key: no (from --no-encrypt-api-key)");
  } else if (driven) {
    // Default for flag-driven setup: encrypt. Agents driving setup
    // shouldn't be silently dumping plaintext API keys to disk.
    shouldEncrypt = true;
    console.log("  encrypt API key: yes (default for flag-driven setup)");
  } else {
    console.log("\n  ── Upstream API key storage ───────────────────────────────────");
    console.log("  This key is your access to the inference provider. If a stolen");
    console.log("  ~/.halo/ directory leaks it, the attacker can drain your");
    console.log("  provider quota until you rotate the key.\n");
    console.log("  Encrypted (recommended):");
    console.log("    Stored as AES-256-GCM ciphertext keyed off your keystore");
    console.log("    passphrase. `halo serve` decrypts it using the same");
    console.log("    passphrase you already enter to unlock the wallet — no extra");
    console.log("    prompt at startup. A stolen config file alone won't reveal it.\n");
    console.log("  Plaintext:");
    console.log("    Stored as-is in ~/.halo/config.json (file mode 0600).");
    console.log("    Any process or user that can read that file gets the key.");
    console.log("    Choose this only on trusted single-tenant hosts.\n");
    const r = await prompts({
      type: "confirm",
      name: "encrypt",
      message: "Encrypt the API key with your keystore passphrase?",
      initial: true,
    });
    if (r.encrypt === undefined) process.exit(130);
    shouldEncrypt = !!r.encrypt;
  }

  if (!shouldEncrypt) return apiKey;

  let passphrase = walletPassphrase;
  if (!passphrase) {
    // Existing wallet was preserved — we don't have the passphrase in hand.
    // Prompt now so we can encrypt the key with it. The operator will type
    // the same passphrase again on every `halo serve`.
    const r = await prompts({
      type: "password",
      name: "p",
      message: "Keystore passphrase (to encrypt the API key)",
    });
    if (!r.p) {
      console.log("  ⚠ no passphrase provided — storing API key plaintext\n");
      return apiKey;
    }
    passphrase = r.p as string;
  }

  return encryptSecret(apiKey, passphrase);
}
