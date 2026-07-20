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
import { detectModels, imageEditAdapterFor, PROVIDER_PRESETS } from "../providers";
import { providerSupportsMargin } from "../pricing";
import { encryptSecret, isEncryptedSecret } from "../secret";

export interface SetupFlags {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
  imageModels?: string; // subset of models priced per image
  imageEditModels?: string; // explicit subset accepted for image+prompt edits
  margin?: number;
  flat?: number;
  imagePrice?: number;
  fallbackCents?: number;
  /** Add a provider to an existing multi-provider config while preserving its wallet and providers. */
  addProvider?: boolean;
  label?: string;
  withPairing?: boolean;
  /** Rotate the wallet explicitly; setup otherwise preserves an existing identity. */
  rotateWallet?: boolean;
  /** API-key storage choice: `undefined` prompts, true encrypts, false stores plaintext. */
  encryptApiKey?: boolean;
  /** Declared prompt-log retention policy; omission becomes `unknown`. */
  dataRetention?: "none" | "24h" | "7d" | "unknown";
  /** Headless mode uses an empty keystore passphrase and plaintext API key. */
  noWalletPassphrase?: boolean;
  /** Non-interactive choice; import still requires interactive key entry. */
  walletMode?: "generate" | "import";
  /** Persisted consumer defaults; unattended setup configures them only with explicit `--consume`. */
  consume?: boolean;
  consumeModel?: string; // default model when a request omits one
  consumeAllow?: string; // CSV allowlist of payable models ("" / "any" ⇒ no limit)
  consumeMaxUsdc?: number; // per-request vault spend ceiling
  consumePort?: number;
  /** Generated-key backup choice; unattended mode defaults to no plaintext backup. */
  keyBackup?: "file" | "skip";
  /** Development-only facilitator override, intentionally omitted from setup help. */
  facilitatorUrl?: string;
}

function passphraseStrength(p: string): { ok: boolean; label: string } {
  if (p.length < 12) return { ok: false, label: "too short — need 12+ characters" };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 16 && classes < 3) return { ok: false, label: "weak — add uppercase, digits, or symbols" };
  return { ok: true, label: classes >= 3 && p.length >= 16 ? "strong" : "ok" };
}

const CONSUME_DEFAULT_MAX_USDC = 0.1;
const CONSUME_DEFAULT_PORT = 8799;

/** Resolve consumer defaults: explicit flag wins, unattended mode preserves state, interactive mode prompts. */
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
  if (
    flags.provider ||
    flags.models ||
    flags.imageEditModels !== undefined ||
    flags.margin !== undefined ||
    flags.flat !== undefined ||
    flags.imagePrice !== undefined
  ) {
    console.log("  using flags from caller — interactive prompts skipped where provided\n");
  }

  const cancel = { onCancel: () => process.exit(130) };

  // Preserve configured or orphaned keystores unless rotation is explicit.
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

  // Empty-passphrase mode cannot encrypt provider keys and suppresses the serve unlock prompt.
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

  // API-key precedence: explicit flag, existing stored value, then interactive prompt.
  // Preserved values keep their current plaintext/encrypted representation.
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

  // Strip common paste wrappers before persisting bytes used verbatim in Bearer auth.
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
    // Reject masked or truncated values before they reach runtime configuration.
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

  // Driven mode uses defaults instead of prompts; computed here because the pricing section below needs it.
  const drivenMode = !!(
    flags.provider ||
    flags.models ||
    flags.imageModels ||
    flags.imageEditModels !== undefined ||
    flags.margin !== undefined ||
    flags.flat !== undefined ||
    flags.imagePrice !== undefined
  );

  let pricingMode: "margin" | "flat";
  let marginPercent: number | undefined;
  let flatUsdcPer1KTokens: number | undefined;

  const explicitPricingFlags = [flags.margin, flags.flat].filter(
    (v) => v !== undefined
  ).length;
  if (explicitPricingFlags > 1) {
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
  } else if (drivenMode) {
    // Driven/headless with no --margin/--flat defaults silently instead of
    // blocking on a prompt; inert when all models are image-priced.
    if (slug === "ollama") {
      pricingMode = "flat";
      flatUsdcPer1KTokens = 0.0005;
    } else {
      pricingMode = "margin";
      marginPercent = preset.defaultMarginPercent;
    }
    console.log(
      `  pricing: ${pricingMode === "flat" ? `flat $${flatUsdcPer1KTokens}/1K tokens` : `margin ${marginPercent}%`} (default; pass --margin/--flat to override)`
    );
  } else {
    const r = await prompts(
      {
        type: "select",
        name: "pricingMode",
        message: "Pricing model (for chat/completion models)",
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
      // Margin without a resolver uses the fixed fallback, so warn that the percentage cannot apply.
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

  // Optional per-image overlay: a subset of --models priced per returned image
  // instead of by token count. --image-price and --image-models must be given
  // together (no default) so no chat model is silently reclassified as image-priced.
  let usdcPerImage: number | undefined;
  let pricedImageModels: string[] = [];
  let imageOverlayGivenThisRun =
    flags.imagePrice !== undefined || flags.imageModels !== undefined;
  let imageEditOverlayGivenThisRun = flags.imageEditModels !== undefined;
  if (flags.imagePrice !== undefined || flags.imageModels !== undefined) {
    if (flags.imagePrice === undefined) {
      throw new Error("--image-models requires --image-price");
    }
    pricedImageModels = (flags.imageModels ?? "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (pricedImageModels.length === 0) {
      throw new Error(
        "--image-price requires --image-models (comma-separated subset of --models priced per image)"
      );
    }
    usdcPerImage = flags.imagePrice;
    console.log(
      `  image pricing: $${usdcPerImage}/image for ${pricedImageModels.join(", ")} (from --image-price/--image-models)`
    );
  } else if (!drivenMode) {
    const { wantsImagePricing } = await prompts(
      {
        type: "confirm",
        name: "wantsImagePricing",
        message: "Price any models per returned image (e.g. image generation/editing)?",
        initial: false,
      },
      cancel
    );
    imageOverlayGivenThisRun = true;
    if (wantsImagePricing) {
      const { imgModels } = await prompts(
        {
          type: "text",
          name: "imgModels",
          message: "Image model id(s) to price per image (comma-separated, subset of the models above)",
          validate: (v: string) => (v.trim().length > 0 ? true : "required"),
        },
        cancel
      );
      pricedImageModels = String(imgModels)
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      const { usd } = await prompts(
        {
          type: "number",
          name: "usd",
          message: "Flat price per returned image (USD, e.g. 0.02)",
          initial: 0.02,
          float: true,
          increment: 0.005,
          validate: (v: number) => (v >= 0 ? true : "must be >= 0"),
        },
        cancel
      );
      usdcPerImage = usd;
    } else {
      imageEditOverlayGivenThisRun = true;
    }
  }
  for (const imageModel of pricedImageModels) {
    if (!models.includes(imageModel)) {
      throw new Error(`--image-models entry "${imageModel}" must also be listed in --models`);
    }
  }

  let configuredImageEditModels: string[] = [];
  if (flags.imageEditModels !== undefined) {
    configuredImageEditModels = flags.imageEditModels
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (configuredImageEditModels.length > 0 && imageEditAdapterFor(slug) === null) {
      throw new Error(
        `--image-edit-models is unsupported for provider "${slug}"; only providers with a tested inline edit adapter may opt in`
      );
    }
    console.log(
      configuredImageEditModels.length > 0
        ? `  image editing: ${configuredImageEditModels.join(", ")} (from --image-edit-models)`
        : "  image editing: disabled (from empty --image-edit-models)"
    );
  } else if (
    !drivenMode &&
    pricedImageModels.length > 0 &&
    imageEditAdapterFor(slug) !== null
  ) {
    const { wantsImageEditing } = await prompts(
      {
        type: "confirm",
        name: "wantsImageEditing",
        message: "Accept encrypted image+prompt edits for an exact subset of these image models?",
        initial: false,
      },
      cancel
    );
    imageEditOverlayGivenThisRun = true;
    if (wantsImageEditing) {
      const { editModels } = await prompts(
        {
          type: "multiselect",
          name: "editModels",
          message: "Image models to opt into editing",
          choices: pricedImageModels.map((model) => ({ title: model, value: model })),
          min: 1,
        },
        cancel
      );
      configuredImageEditModels = editModels;
    }
  }
  for (const editModel of configuredImageEditModels) {
    if (!models.includes(editModel)) {
      throw new Error(`--image-edit-models entry "${editModel}" must also be listed in --models`);
    }
  }

  // Fallback pricing is cents-based; driven mode defaults to one cent and guards large values.
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

  // Flag-driven setup accepts default infrastructure URLs instead of blocking on prompts.
  const driven = drivenMode;

  // When re-running setup with an existing config, default infra settings to
  // whatever the operator already had — never silently reset them.
  const relayDefault = existingConfig?.relayUrl ?? DEFAULT_RELAY_URL;
  const indexerDefault = existingConfig?.indexerUrl ?? DEFAULT_INDEXER_URL;
  // Facilitator URL + key are always reset to protocol defaults (see below).
  // No existingConfig-derived facilitator defaults — the protocol owns this.
  const labelDefault = existingConfig?.operator.label ?? "";
  const retentionDefault = existingConfig?.operator.dataRetention ?? "unknown";

  const dataRetention: "none" | "24h" | "7d" | "unknown" =
    flags.dataRetention ?? retentionDefault;

  let relayUrl = relayDefault;
  let indexerUrl = indexerDefault;
  // Setup writes the protocol facilitator without an operator API key.
  // The hidden URL override is reserved for development and migrations.
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

  // New API keys may reuse the wallet passphrase; preserved keys retain their stored representation.
  const finalApiKey =
    preservedApiKey !== undefined
      ? preservedApiKey
      : await resolveApiKeyStorage(apiKey, flags, passphrase, driven);

  // Upsert one provider and its pricing while preserving wallet and other provider entries.
  if (flags.addProvider) {
    if (!existingConfig) {
      throw new Error(
        "--add-provider needs an existing operator config. Run `halo setup` once to create the operator, then `halo setup --add-provider --provider <slug> --api-key <key>` to add another gateway."
      );
    }
    // Start from the existing provider list (normalizing a single-provider
    // config to a list), then replace-or-append this slug.
    const existingList = configProviders(existingConfig).map((p) => ({ ...p }));
    const at = existingList.findIndex((p) => p.slug === slug);
    const existingProvider = at >= 0 ? existingList[at] : undefined;
    // Re-running --add-provider without --image-* must not drop the
    // existing per-image overlay.
    const preserved = imageOverlayGivenThisRun ? undefined : existingProvider;
    const effectiveImageModels = imageOverlayGivenThisRun
      ? pricedImageModels
      : preserved?.imageModels ?? [];
    const effectiveUsdcPerImage = imageOverlayGivenThisRun
      ? usdcPerImage
      : preserved?.pricing?.usdcPerImage ?? usdcPerImage;
    const effectiveImageEditModels = imageEditOverlayGivenThisRun
      ? configuredImageEditModels
      : existingProvider?.imageEditModels ?? [];
    // Preserve existing token pricing only for an existing-slug re-run
    // without --margin/--flat; a brand-new slug uses the driven-mode default,
    // never the primary's cfg.pricing (which would misprice the gateway).
    const tokenPricingGivenThisRun = flags.margin !== undefined || flags.flat !== undefined;
    const effectiveTokenPricing =
      !tokenPricingGivenThisRun && existingProvider
        ? existingProvider.pricing ?? existingConfig.pricing
        : { mode: pricingMode, marginPercent, flatUsdcPer1KTokens };
    const newProvider: ProviderConfig = {
      slug,
      baseUrl,
      apiKey: finalApiKey,
      models,
      ...(effectiveImageModels.length > 0 ? { imageModels: effectiveImageModels } : {}),
      ...(effectiveImageEditModels.length > 0
        ? { imageEditModels: effectiveImageEditModels }
        : {}),
      pricing: {
        mode: effectiveTokenPricing.mode,
        marginPercent: effectiveTokenPricing.marginPercent,
        flatUsdcPer1KTokens: effectiveTokenPricing.flatUsdcPer1KTokens,
        usdcPerImage: effectiveUsdcPerImage,
      },
    };
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

  for (const editModel of configuredImageEditModels) {
    if (!pricedImageModels.includes(editModel)) {
      throw new Error(
        `--image-edit-models entry "${editModel}" must also be listed in --image-models`
      );
    }
  }

  const cfg: HaloConfig = {
    version: 1,
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
      ...(pricedImageModels.length > 0 ? { imageModels: pricedImageModels } : {}),
      ...(configuredImageEditModels.length > 0
        ? { imageEditModels: configuredImageEditModels }
        : {}),
    },
    pricing: {
      mode: pricingMode,
      marginPercent,
      flatUsdcPer1KTokens,
      usdcPerImage,
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
  console.log(`  Network:     Base mainnet`);
  console.log(`  Provider:    ${slug} (${models.length} models)`);
  if (apiKey) {
    console.log(
      `  API key:     ${isEncryptedSecret(finalApiKey) ? "encrypted (AES-256-GCM, keystore passphrase)" : "plaintext (file 0600)"}`
    );
  }
  // Show dollar equivalents so unit mistakes remain visible before serving.
  const pricingDetail =
    pricingMode === "flat"
      ? `flat $${(flatUsdcPer1KTokens ?? 0).toFixed(4)}/1K tokens`
      : `margin ${marginPercent ?? 0}% over upstream`;
  const fallbackDetail = `fallback $${(fallbackCents / 100).toFixed(2)}/request`;
  console.log(`  Pricing:     ${pricingDetail}; ${fallbackDetail}`);
  if (pricedImageModels.length > 0) {
    console.log(
      `  Image:       $${(usdcPerImage ?? 0).toFixed(4)}/image for ${pricedImageModels.join(", ")}`
    );
  }
  if (configuredImageEditModels.length > 0) {
    console.log(`  Edits:       ${configuredImageEditModels.join(", ")}`);
  }
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

  console.log(`  Next:`);
  console.log(`    halo serve        — connect to relay and start earning`);
  if (consume) {
    console.log(`    halo consume      — local OpenAI-compatible endpoint (fund this wallet with USDC)`);
  }
  console.log(`    halo link         — pair with a dashboard wallet\n`);

  // Reuse the available passphrase for optional pairing.
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

/** Read the public address from a keystore-only recovery state, or return `null`. */
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
  // Explicit wallet mode wins; unattended mode generates; only interactive setup prompts.
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
    // Empty-passphrase unattended keystores rely entirely on host access controls and mode 0600.
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

    // Never print private keys; optional plaintext backups use mode 0600 and default off unattended.
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
  // Empty is a known unattended passphrase; only undefined requires prompting.
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
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
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

/** Store a provider key as plaintext, encrypted envelope, or `undefined` according to resolved setup inputs. */
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
