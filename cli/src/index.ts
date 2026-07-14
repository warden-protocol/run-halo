#!/usr/bin/env node
import { cmdSetup } from "./commands/setup";
import { cmdServe } from "./commands/serve";
import { cmdConsume } from "./commands/consume";
import { cmdLink } from "./commands/link";
import { cmdStatus } from "./commands/status";
import { cmdDoctor } from "./commands/doctor";
import { cmdService } from "./commands/service";
import { cmdVault } from "./commands/vault";
import { HALO_VERSION } from "./version";
import { checkAndApplyUpdate, restartIntoManagedInstall } from "./update";
import { shouldPreRunUpdate } from "./commandGating";

// Fail before dispatch because unsupported Node versions can corrupt setup state mid-command.
const NODE_MAJOR = parseInt(process.versions.node.split(".")[0], 10);
if (NODE_MAJOR < 20) {
  process.stderr.write(
    `halo requires Node 20+ (you have ${process.versions.node}).\n` +
      `Earlier versions crash mid-setup on scrypt memory limits.\n` +
      `Install Node 20 or later: https://nodejs.org\n` +
      `If you use nvm: nvm install 20 && nvm use 20\n`
  );
  process.exit(1);
}

const USAGE = `
halo — Halo operator + payer CLI

  halo setup [flags]                               configure wallet + provider
    --provider <slug>          openclaw|claude-code|hermes|ollama|lmstudio|openai|anthropic|openrouter|venice|near|together|fireworks|groq|custom
    --base-url <url>           override (or set, for "custom") provider base URL
    --api-key <key>            provider API key (paid providers only)
    --models <a,b,c>           comma-separated model ids to advertise
    --image-models <a,b,c>     subset of --models priced per returned image (requires --image-price)
    --margin <n>               margin pricing: n% over upstream (e.g. 20) — chat/completion models
    --flat <n>                 flat pricing: USD per 1K tokens (e.g. 0.0005) — chat/completion models
    --image-price <n>          per-image overlay: USD per returned image (e.g. 0.02); requires --image-models; composes with --margin/--flat
    --add-provider             ADD this provider to an existing operator (front several gateways at once, e.g. openrouter + near) instead of replacing it
    --fallback-cents <n>       fallback price per request in cents (default 1)
    --label <name>             label shown in the League
    --with-pairing             after setup, also print a dashboard pairing code
    --rotate-wallet            DESTRUCTIVE: replace existing wallet with a new one (default: keep existing)
    --encrypt-api-key          encrypt upstream API key with the keystore passphrase (default: yes for flag-driven setup)
    --no-encrypt-api-key       store upstream API key as plaintext in config.json (faster, less safe)
    --data-retention <policy>  prompt-log retention you commit to: none|24h|7d|unknown (default: unknown)
    --no-wallet-passphrase     UNATTENDED MODE: generate keystore with empty passphrase; serve starts without prompting. Keystore-on-disk becomes effectively plaintext — host must be trusted.
    --wallet-mode <m>          generate|import — skip the wallet prompt (driven/headless setup). Unattended mode defaults to generate.
    --key-backup <m>           file|skip — skip the private-key backup prompt. Unattended mode defaults to skip.
    --consume / --no-consume   opt in/out of a consumer profile non-interactively (defaults for halo consume)
    --consume-model <id>       default model when a consume request omits one
    --consume-allow <a,b,c>    models you'll pay for ("" or "any" = no limit)
    --consume-max-usdc <n>     per-request spend ceiling in USD (the consumer cost guard)
    --consume-port <n>         local consume endpoint port (default 8799)

  halo run                                         connect to relay, start earning
  halo consume [flags]                             run a vault-backed local OpenAI-compatible endpoint
    --port <n>                 port to listen on (default 8799)
    --host <addr>              bind address (default 127.0.0.1)
    --detach                   self-daemonize: start the server in its own session (survives the launching agent/gateway restarting) and return. Idempotent — no-ops if one's already serving. Needs an unattended keystore or HALO_PASSPHRASE.
    --api-key <secret>         require this bearer token on /v1/* requests
    --max-usdc <n>             per-request spend ceiling in USD (default 0.10)
    --keystore <path>          wallet keystore to pay from (default: operator keystore)
    --confidential             route only to TEE operators, encrypt to the reported TEE key, and require the response signer to match the attested signer
    --tee-base-url <url>       TEE provider attestation endpoint (default https://cloud-api.near.ai/v1)
    --no-attestation-verify    DEBUG: skip the DCAP hardware attestation check (signature-only); not recommended
    --no-e2e                   disable operator end-to-end encryption (sends the prompt to the relay in plaintext)
    --budget-usdc <n>          cumulative spend cap (USD) for this run — bounds an agent's total spend across many requests (0/unset = uncapped). Raise at runtime: POST /v1/budget {"limitUsd": N}
    --budget-warn-pct <0-1>    warn (X-Halo-Budget-Warning header) at this fraction of the budget (default 0.8)
    --vault-deposit <usd>      auto-managed: top the vault up to this from the wallet's USDC on startup (needs a little ETH for the deposit tx)
    --vault-reserve-multiple <n>  reserve this many requests' worth per operator (default 5); lower it when fanning out across many operators so reservations don't lock the whole deposit (#367)
    --session-key <wallet|browser>  vault session-key scheme (default wallet): "wallet" signs receipts with this wallet; "browser" derives the SAME session key the Halo web app uses, so one wallet works on both surfaces (#426)
    --force                    force unrelated supported behavior; cannot bypass vault identity checks
  halo vault [--session-key <wallet|browser>] <status|deposit <usd>|withdraw>   manage the HaloVault balance for consume (settle-actual billing)
  halo link                                        pair with a dashboard wallet
  halo status                                      show wallet + league stats
  halo doctor [--json]                             diagnose install state, local endpoints, config, reachability
  halo update                                      check for and apply the latest CLI release now
  halo service <install|uninstall|status|logs> [consume|serve] [-- daemon args…]
                                                   install consume/serve as an ALWAYS-ON OS service (launchd/systemd) that
                                                   survives agent/gateway restarts. e.g. halo service install consume -- --port 8799
                                                   (set HALO_PASSPHRASE first, or use a --no-wallet-passphrase keystore)

`;

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${HALO_VERSION}\n`);
    return;
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help" || cmd === undefined) {
    process.stdout.write(USAGE);
    return;
  }

  const flags = parseFlags(rest);

  if (cmd === "update") {
    const result = await checkAndApplyUpdate({ force: true });
    switch (result.kind) {
      case "applied":
        console.log(`✓ halo updated ${result.from} → ${result.to}`);
        return;
      case "current":
      case "cached":
        console.log(`✓ halo is current (${HALO_VERSION})`);
        return;
      case "disabled":
        console.log("halo auto-update is disabled by HALO_NO_AUTOUPDATE=1");
        return;
      case "unmanaged":
        console.log(
          `halo is running from an unmanaged checkout (${process.argv[1]}). ` +
            "The updater will not modify development installs."
        );
        return;
      case "locked":
        console.log("another halo update is already in progress");
        return;
      case "failed":
        throw new Error(`update failed: ${result.error}`);
    }
  }

  // Pre-run updates apply only to recognized short-lived commands; daemons self-update.
  if (shouldPreRunUpdate(cmd)) {
    const result = await checkAndApplyUpdate();
    if (result.kind === "applied") restartIntoManagedInstall(false);
  }

  switch (cmd) {
    case "setup":
      return cmdSetup({
        provider: typeof flags.provider === "string" ? flags.provider : undefined,
        baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
        apiKey: typeof flags["api-key"] === "string" ? flags["api-key"] : undefined,
        models: typeof flags.models === "string" ? flags.models : undefined,
        imageModels: typeof flags["image-models"] === "string" ? flags["image-models"] : undefined,
        margin: typeof flags.margin === "string" ? Number(flags.margin) : undefined,
        flat: typeof flags.flat === "string" ? Number(flags.flat) : undefined,
        imagePrice:
          typeof flags["image-price"] === "string"
            ? Number(flags["image-price"])
            : undefined,
        addProvider: flags["add-provider"] === true,
        fallbackCents:
          typeof flags["fallback-cents"] === "string"
            ? Number(flags["fallback-cents"])
            : undefined,
        label: typeof flags.label === "string" ? flags.label : undefined,
        withPairing: flags["with-pairing"] === true,
        rotateWallet: flags["rotate-wallet"] === true,
        encryptApiKey:
          flags["no-encrypt-api-key"] === true
            ? false
            : flags["encrypt-api-key"] === true
              ? true
              : undefined,
        dataRetention:
          flags["data-retention"] === "none" ||
          flags["data-retention"] === "24h" ||
          flags["data-retention"] === "7d" ||
          flags["data-retention"] === "unknown"
            ? (flags["data-retention"] as "none" | "24h" | "7d" | "unknown")
            : undefined,
        noWalletPassphrase: flags["no-wallet-passphrase"] === true,
        walletMode:
          flags["wallet-mode"] === "generate" || flags["wallet-mode"] === "import"
            ? flags["wallet-mode"]
            : undefined,
        keyBackup:
          flags["key-backup"] === "file" || flags["key-backup"] === "skip"
            ? flags["key-backup"]
            : undefined,
        consume:
          flags.consume === true ? true : flags["no-consume"] === true ? false : undefined,
        consumeModel:
          typeof flags["consume-model"] === "string" ? flags["consume-model"] : undefined,
        consumeAllow:
          typeof flags["consume-allow"] === "string" ? flags["consume-allow"] : undefined,
        consumeMaxUsdc:
          typeof flags["consume-max-usdc"] === "string"
            ? Number(flags["consume-max-usdc"])
            : undefined,
        consumePort:
          typeof flags["consume-port"] === "string" ? Number(flags["consume-port"]) : undefined,
        // --facilitator-url is intentionally NOT in --help. It's a dev/test
        // escape hatch (staging facilitator, migration window) — operators
        // never need it. Always functional, never documented.
        facilitatorUrl:
          typeof flags["facilitator-url"] === "string"
            ? flags["facilitator-url"]
            : undefined,
      });
    // `run` is the current verb; `serve` is kept as a silent back-compat alias
    // so existing operator scripts (`halo serve`) keep working.
    case "run":
    case "serve":
      return cmdServe();
    case "consume":
      return cmdConsume({
        port: typeof flags.port === "string" ? Number(flags.port) : undefined,
        host: typeof flags.host === "string" ? flags.host : undefined,
        apiKey: typeof flags["api-key"] === "string" ? flags["api-key"] : undefined,
        maxUsdc: typeof flags["max-usdc"] === "string" ? Number(flags["max-usdc"]) : undefined,
        keystore: typeof flags.keystore === "string" ? flags.keystore : undefined,
        confidential: flags.confidential === true,
        teeBaseUrl: typeof flags["tee-base-url"] === "string" ? flags["tee-base-url"] : undefined,
        noAttestationVerify: flags["no-attestation-verify"] === true,
        noE2e: flags["no-e2e"] === true,
        budgetUsdc: typeof flags["budget-usdc"] === "string" ? Number(flags["budget-usdc"]) : undefined,
        budgetWarnPct:
          typeof flags["budget-warn-pct"] === "string" ? Number(flags["budget-warn-pct"]) : undefined,
        vaultDeposit:
          typeof flags["vault-deposit"] === "string" ? Number(flags["vault-deposit"]) : undefined,
        vaultReserveMultiple:
          typeof flags["vault-reserve-multiple"] === "string"
            ? Number(flags["vault-reserve-multiple"])
            : undefined,
        sessionKey: typeof flags["session-key"] === "string" ? flags["session-key"] : undefined,
        detach: flags.detach === true,
        force: flags.force === true,
      });
    case "vault":
      return cmdVault(rest);
    case "link":
      return cmdLink();
    case "status":
      return cmdStatus();
    case "doctor":
      return cmdDoctor({ json: flags.json === true });
    case "service":
      // Pass the raw args through — `service` does its own sub/target/passthrough
      // parsing (e.g. `halo service install consume -- --port 8799 --budget-usdc 5`).
      return cmdService(rest);
    default:
      console.error(`unknown command: ${cmd}`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
