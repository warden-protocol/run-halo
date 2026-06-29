/**
 * halo consume — run Halo as a local OpenAI-compatible inference endpoint.
 *
 * Starts a small HTTP server on localhost that any OpenAI-compatible client or
 * agent (Hermes, OpenClaw, the OpenAI SDK, LangChain, …) can point its
 * `baseURL` at. Each request is paid for from the CLI's own wallet via x402
 * ("exact" mode): the server probes the relay, signs an EIP-3009 authorization
 * when challenged with a 402, retries, and relays the operator's response back.
 *
 * This is the consumer-side mirror of `serve`: same keystore, same config, same
 * wallet — one direction earns, the other spends. No browser, no wallet popup.
 *
 *   halo consume [--port 8799] [--api-key SECRET] [--max-usdc 0.10]
 *
 * The wallet is the only credential — fund its address with USDC on Base. The
 * server binds to 127.0.0.1 by default and (optionally) requires a bearer token,
 * because anything that can reach it can spend the wallet.
 */
import http from "node:http";
import prompts from "prompts";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { loadConfig, configDir } from "../config";
import { loadWallet } from "../wallet";
import { payAndFetch, X402Error } from "../x402-consume";
import {
  generateEphemeralKeypair,
  encryptRequest,
  decryptResponse,
  hexToPubkey,
  isEncryptedEnvelope,
  EncryptedEnvelope,
} from "../encryption";
import {
  encryptToTee,
  decryptFromTee,
  newClientKey,
  fetchModelAttestation,
  verifyTeeSignature,
  verifiedSignerForModel,
} from "../confidential";
import { installProxyFromEnv } from "../proxy";
import {
  VaultConsumeClient,
  priceTokens,
  estimateTokens,
  fmtUsd as fmtVaultUsd,
  type OpsState,
} from "../vault-consume";

interface Args {
  port?: number;
  /** Optional bearer token required on /v1/* requests. */
  apiKey?: string;
  /** Per-request spend ceiling in USD. Defaults to $0.10. */
  maxUsdc?: number;
  /** Override the keystore path (defaults to config.operator.keystorePath). */
  keystore?: string;
  /** Bind host. Defaults to 127.0.0.1 — do not expose publicly without auth. */
  host?: string;
  /** Route only to TEE operators and end-to-end-encrypt the prompt to the
   *  enclave (the operator can't read it), then verify the response signature. */
  confidential?: boolean;
  /** Base URL of the TEE provider's attestation/key endpoint (default NEAR). */
  teeBaseUrl?: string;
  /** Skip the full DCAP hardware attestation verification (Intel TDX + NVIDIA)
   *  on confidential requests — falls back to signature-only verification.
   *  Default false (hardware verification ON). For debugging only. */
  noAttestationVerify?: boolean;
  /** Disable operator end-to-end encryption on non-confidential requests (sends
   *  the prompt in plaintext through the relay). Default false — E2E is ON when
   *  the chosen operator advertises an encryption key. */
  noE2e?: boolean;
  /** Cumulative spend ceiling (USD) for this process — the budget an autonomous
   *  agent can't blow past in a loop. 0 / unset = no cap. Distinct from
   *  --max-usdc (per request); this bounds total volume. Updatable at runtime via
   *  POST /v1/budget. */
  budgetUsdc?: number;
  /** Warn (response header) once cumulative spend reaches this fraction of the
   *  budget, so the agent can tell the user and offer to raise it. Default 0.8. */
  budgetWarnPct?: number;
  /** Use the HaloVault rail (RFC v2): deposit once, then pay the ACTUAL tokens
   *  each request used (settle-actual) instead of the prompt-blind flat per-request
   *  quote of exact mode. Requires a vault deposit (auto-managed via --vault-deposit). */
  vault?: boolean;
  /** Auto-managed vault top-up target (USD). On startup (and when the vault runs
   *  low) consume tops the vault up to this from the wallet's USDC. Needs a little
   *  ETH on Base for the deposit tx. 0/unset = never auto-deposit (manage with
   *  `halo vault deposit`). */
  vaultDeposit?: number;
  /** Batch size for vault reservations: reserve this many requests' worth at once
   *  to amortize the reserve tx. Default 5. Lower it when fanning out across many
   *  operators so reservations don't lock the whole deposit (#367); a single
   *  reservation is also auto-capped at a slice of the free balance regardless. */
  vaultReserveMultiple?: number;
  /** Self-daemonize: re-spawn the server detached (own session, reparented to
   *  init) and return immediately, so an agent/gateway that launches consume
   *  can't kill it on restart. Idempotent — no-ops if one's already serving. */
  detach?: boolean;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB — generous for large-context prompts

/**
 * Pick an operator that serves `model` AND advertises an X25519 encryption key,
 * so we can E2E-encrypt the prompt to it (relay sees only ciphertext). Returns
 * the operator address + pubkey, or null when none is E2E-capable (caller falls
 * back to plaintext). Cheapest priced first, mirroring the relay's default.
 */
async function selectE2EOperator(
  relayBase: string,
  model: string
): Promise<{ address: string; encryptionPubkey: string } | null> {
  try {
    const res = await fetch(`${relayBase}/v1/operators`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const { operators } = (await res.json()) as {
      operators: Array<{
        address: string;
        models: string[];
        encryptionPubkey?: string | null;
        pricing?: Record<string, number>;
      }>;
    };
    const candidates = operators
      .filter((o) => o.encryptionPubkey && o.models.some((m) => m === model || m.includes(model) || model.includes(m)))
      .sort((a, b) => {
        const pa = a.pricing?.[model] ?? Number.POSITIVE_INFINITY;
        const pb = b.pricing?.[model] ?? Number.POSITIVE_INFINITY;
        return pa - pb;
      });
    const op = candidates[0];
    return op ? { address: op.address, encryptionPubkey: op.encryptionPubkey! } : null;
  } catch {
    return null;
  }
}

interface VaultOperatorPin {
  address: string;
  priceUsdPerMtok: number;
  encryptionPubkey: string | null;
}

/**
 * Pick the cheapest priced operator for `model` to RESERVE against in vault mode.
 * Vault needs a price (to size the reservation + meter) and pins ONE operator so
 * the reservation, the request, and the receipt all line up. Filters to TEE
 * operators when `teeOnly` (confidential). Returns null when none qualify.
 */
async function selectVaultOperator(
  relayBase: string,
  model: string,
  teeOnly: boolean,
  maxPriceUsdPerMtok?: number,
  requireAddress?: string
): Promise<VaultOperatorPin | null> {
  try {
    const url = `${relayBase}/v1/operators` + (teeOnly ? "?tee=1" : "");
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const { operators } = (await res.json()) as {
      operators: Array<{
        address: string;
        models: string[];
        encryptionPubkey?: string | null;
        pricing?: Record<string, number>;
        tee?: boolean;
        teeModels?: string[];
      }>;
    };
    const servesTee = (o: { teeModels?: string[]; tee?: boolean }): boolean =>
      o.teeModels && o.teeModels.length > 0
        ? o.teeModels.some((m) => m === model || m.includes(model) || model.includes(m))
        : o.tee === true;
    const priced = operators
      .filter((o) => !teeOnly || servesTee(o))
      .map((o) => {
        const key =
          o.models.find((m) => m === model) || o.models.find((m) => m.includes(model) || model.includes(m));
        const per1k = key && o.pricing ? o.pricing[key] : undefined;
        return per1k != null
          ? { address: o.address, priceUsdPerMtok: per1k * 1000, encryptionPubkey: o.encryptionPubkey ?? null }
          : null;
      })
      .filter((x): x is VaultOperatorPin => x !== null)
      .filter((x) => maxPriceUsdPerMtok === undefined || x.priceUsdPerMtok <= maxPriceUsdPerMtok);
    if (priced.length === 0) return null;
    // Honor an explicit operator pin (X-Halo-Operator) when the caller forced
    // one: return THAT operator's pin if it serves+prices the model, so a caller
    // can deliberately target any operator (e.g. a settlement sweep funding every
    // operator, not just the cheapest). null when the pinned operator doesn't
    // qualify, so the caller surfaces a clear 503 instead of silently rerouting.
    if (requireAddress) {
      const want = requireAddress.toLowerCase();
      return priced.find((x) => x.address.toLowerCase() === want) ?? null;
    }
    // Spread across operators TIED at the cheapest price instead of always
    // pinning the first. Vault mode pins ONE operator (so the reservation,
    // request, and receipt line up) and bypasses the relay's balanced routing —
    // so without this, several equally-priced operators serving one model (e.g.
    // a confidential model on multiple TEE operators) all starve but one, and
    // only that one ever redeems. (#364)
    const best = Math.min(...priced.map((x) => x.priceUsdPerMtok));
    const PRICE_EPS = 1e-9;
    const cheapest = priced.filter((x) => x.priceUsdPerMtok <= best + PRICE_EPS);
    return cheapest[Math.floor(Math.random() * cheapest.length)];
  } catch {
    return null;
  }
}

/**
 * Send one inference over the HaloVault rail and return a payAndFetch-shaped
 * result so the caller's response post-processing (confidential/E2E decrypt, SSE,
 * budget headers) is unchanged. Ensures a reservation covers the request, sends
 * with vault headers (operator gates + serves, reporting ACTUAL cost), then
 * advances + redeems the cumulative receipt in the background.
 */
async function vaultSend(
  client: VaultConsumeClient,
  url: string,
  body: unknown,
  opts: {
    forwardHeaders: Record<string, string>;
    signal: AbortSignal;
    operator: string;
    priceUsdPerMtok: number;
    estTokens: number;
  }
): Promise<{ status: number; headers: Headers; body: string; paid: boolean; chargedBase?: string }> {
  const estCost = priceTokens(opts.priceUsdPerMtok, opts.estTokens);
  let ops: OpsState;
  let keyEpoch: bigint;
  ({ ops, keyEpoch } = await client.ensureReservation(opts.operator, estCost));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.forwardHeaders,
    // Vault-critical headers win over any forwarded ones.
    "x-halo-payment-mode": "vault",
    "x-halo-operator": opts.operator,
    "x-halo-vault-consumer": client.consumer,
  };
  if (!("x-halo-max-price" in headers) && !("X-Halo-Max-Price" in headers)) {
    headers["x-halo-max-price"] = String(opts.priceUsdPerMtok);
  }

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
  const text = await res.text();

  // The operator reports the ACTUAL metered cost in PAYMENT-RESPONSE (base64 JSON).
  let cost = 0n;
  const pr = res.headers.get("PAYMENT-RESPONSE");
  if (pr) {
    try {
      const d = JSON.parse(Buffer.from(pr, "base64").toString("utf-8")) as { amountUsdc?: string };
      if (d.amountUsdc && /^\d+$/.test(d.amountUsdc)) cost = BigInt(d.amountUsdc);
    } catch {
      /* no parseable settlement — treat as unpaid */
    }
  }
  if (res.ok && cost > 0n) client.recordAndRedeem(opts.operator, ops, keyEpoch, cost);

  return {
    status: res.status,
    headers: res.headers,
    body: text,
    paid: res.ok && cost > 0n,
    chargedBase: cost > 0n ? cost.toString() : undefined,
  };
}

/** Probe a local consume /health. Returns the health info if a halo consume is
 *  serving there, "other" if something else holds the port, or null if nothing. */
async function probeConsumeHealth(
  host: string,
  port: number
): Promise<{ wallet: string } | "other" | null> {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return "other";
    const j = (await r.json()) as { status?: string; wallet?: string };
    return j && j.status === "ok" && typeof j.wallet === "string" ? { wallet: j.wallet } : "other";
  } catch {
    return null; // nothing listening
  }
}

/**
 * Self-daemonize: re-exec this CLI WITHOUT --detach in its own session
 * (`detached: true` + `unref()` reparents it to init), stdio → a log file, then
 * return. A gateway that SIGTERMs its child process group on restart can't reach
 * it. Idempotent: no-ops if a halo consume already serves the port, so an agent
 * can safely call it every session.
 */
async function runDetached(
  cfg: { operator: { noPassphrase?: boolean } },
  port: number,
  host: string
): Promise<void> {
  const existing = await probeConsumeHealth(host, port);
  if (existing && existing !== "other") {
    console.log(
      `  ✓ halo consume already running on http://${host}:${port}/v1 (wallet ${existing.wallet}) — nothing to start.`
    );
    return;
  }
  if (existing === "other") {
    console.error(`  ✗ port ${port} is held by a non-halo service. Free it, or use --port <other>.`);
    process.exit(1);
  }
  // A detached server can't be prompted for a passphrase.
  if (!cfg.operator.noPassphrase && process.env.HALO_PASSPHRASE == null) {
    console.error(
      `  ✗ --detach needs an unattended keystore: create one with \`halo setup --no-wallet-passphrase\`,\n` +
        `    or export HALO_PASSPHRASE before launching (a background process can't be prompted).`
    );
    process.exit(1);
  }
  const logPath = path.join(configDir(), "consume.log");
  let fd: number;
  try {
    fd = openSync(logPath, "a");
  } catch {
    fd = openSync("/dev/null", "a");
  }
  // Re-exec the same interpreter + entry, dropping --detach so the child is the
  // real server. (Requires the built/installed CLI — `node dist/index.js`.)
  const childArgs = process.argv.slice(1).filter((a) => a !== "--detach");
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  const pid = child.pid;
  // Confirm it bound before reporting success.
  const deadline = Date.now() + 12_000;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    const h = await probeConsumeHealth(host, port);
    if (h && h !== "other") {
      up = true;
      break;
    }
  }
  if (up) {
    console.log(`  ✓ halo consume started detached (pid ${pid}) on http://${host}:${port}/v1`);
    console.log(`    it survives gateway restarts; logs → ${logPath}`);
    console.log(`    point your agent at the endpoint and don't relaunch per session (calling this again no-ops).`);
  } else {
    console.error(`  ⚠ launched detached (pid ${pid}) but it didn't report healthy within 12s — check ${logPath}`);
    process.exit(1);
  }
}

export async function cmdConsume(args: Args): Promise<void> {
  // Route outbound through a proxy if the env asks for it (relay + Intel PCS
  // attestation collateral). No-op when no proxy var is set.
  installProxyFromEnv();
  const cfg = loadConfig();
  // Flags override the persisted consume profile (set by `halo setup`), which
  // overrides the built-in defaults.
  // Default 8799 — deliberately NOT the indexer's 8789 (a frequent local clash).
  const port = args.port ?? cfg.consume?.port ?? 8799;
  const host = args.host ?? "127.0.0.1";

  // ── Detached mode ─────────────────────────────────────────────────────────
  // For agents that launch consume themselves (Hermes, OpenClaw, …): re-spawn
  // the server in its OWN session (reparented to init) and return immediately,
  // so a gateway restart — which SIGTERMs its child process group — can't kill
  // it. Idempotent: if a halo consume is already serving on the port, this is a
  // no-op, so the agent can safely call it on every session start.
  if (args.detach) {
    await runDetached(cfg, port, host);
    return;
  }
  const keystorePath = args.keystore ?? cfg.operator.keystorePath;
  // USD → USDC base units (6 decimals). Default $0.10.
  const maxAmountBase = BigInt(
    Math.round((args.maxUsdc ?? cfg.consume?.maxUsdc ?? 0.1) * 1_000_000)
  );

  // ── Cumulative spend budget (the agent-volume guard) ──────────────────────
  // An agent generates far more requests than a human — loops, retries, tool
  // fan-out — each individually under the per-request cap, so a per-request cap
  // alone can't bound total spend. This session budget does, and warns the agent
  // as it approaches so it can ask the user to raise the limit instead of just
  // failing. Mutable: spentBase accrues; budgetBase can be raised at runtime via
  // POST /v1/budget. 0 budget = uncapped (default).
  const budget = {
    spentBase: 0n,
    // In-flight reservations. An autonomous agent fans requests out in parallel;
    // a plain check-then-accrue lets N concurrent requests all pass the gate near
    // the cap and overspend. Each request reserves its per-request ceiling up
    // front (released + reconciled to the actual charge when it settles), so the
    // budget can never be blown past even under heavy concurrency.
    reservedBase: 0n,
    budgetBase: BigInt(Math.round((args.budgetUsdc ?? 0) * 1_000_000)),
    warnPct: typeof args.budgetWarnPct === "number" ? args.budgetWarnPct : 0.8,
  };
  const usd = (b: bigint) => (Number(b) / 1_000_000).toFixed(4);
  /** Budget headers for every response so the agent always knows where it stands. */
  const budgetHeaders = (): Record<string, string> => {
    if (budget.budgetBase <= 0n) return {}; // uncapped → no budget headers
    const remaining = budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n;
    const h: Record<string, string> = {
      "X-Halo-Budget-Limit": usd(budget.budgetBase),
      "X-Halo-Budget-Spent": usd(budget.spentBase),
      "X-Halo-Budget-Remaining": usd(remaining),
    };
    // Warn band: spent ≥ warnPct × budget (and not yet over). The agent reads
    // this and can tell the user + offer to raise the limit (POST /v1/budget).
    const warnAt = (budget.budgetBase * BigInt(Math.round(budget.warnPct * 1000))) / 1000n;
    if (budget.spentBase >= warnAt && budget.spentBase < budget.budgetBase) {
      h["X-Halo-Budget-Warning"] = "true";
      h["X-Halo-Budget-Message"] = `Spending budget ${Math.round(
        (Number(budget.spentBase) / Number(budget.budgetBase)) * 100
      )}% used ($${usd(budget.spentBase)} of $${usd(budget.budgetBase)}). Ask the user to raise it (POST /v1/budget {"limitUsd": N}) before it's exhausted.`;
    }
    return h;
  };
  // Consume profile guards: a default model for requests that omit one, and an
  // allowlist of models the agent will pay for (refuse anything else pre-payment).
  const defaultModel = cfg.consume?.defaultModel;
  const allowedModels = cfg.consume?.allowedModels;
  // Confidential (TEE) mode: route only to TEE operators and E2E-encrypt the
  // prompt to the enclave. The base URL is the TEE provider's public
  // attestation/key endpoint (NEAR by default).
  const confidential = args.confidential === true;
  const teeBaseUrl = (args.teeBaseUrl ?? "https://cloud-api.near.ai/v1").replace(/\/+$/, "");

  // Passphrase resolution, mirroring `serve`: unattended (empty) when the
  // keystore was created with --no-wallet-passphrase, else HALO_PASSPHRASE env
  // (for headless/daemon launch), else an interactive prompt.
  let passphrase: string;
  if (cfg.operator.noPassphrase) {
    passphrase = "";
  } else if (typeof process.env.HALO_PASSPHRASE === "string") {
    passphrase = process.env.HALO_PASSPHRASE;
  } else {
    const r = await prompts({ type: "password", name: "passphrase", message: "Keystore passphrase" });
    if (!r.passphrase) process.exit(130);
    passphrase = r.passphrase;
  }

  const wallet = await loadWallet(keystorePath, passphrase);
  const relayBase = cfg.relayUrl.replace(/\/+$/, "");
  const completionsUrl = `${relayBase}/v1/chat/completions`;
  const modelsUrl = `${relayBase}/v1/models`;
  const ctx = { wallet, network: cfg.network } as const;

  // ── HaloVault rail (RFC v2): settle ACTUAL tokens, not the prompt-blind flat
  // exact-mode quote. Opt-in via --vault. Deposit once; reserve per operator;
  // pay the metered cost via background receipts. ──────────────────────────────
  const vaultMode = args.vault === true;
  const vault = vaultMode
    ? new VaultConsumeClient(wallet, {
        facilitatorUrl: cfg.facilitator?.url ?? "https://facilitator.runhalo.xyz",
        rpcUrl: (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim(),
        chainId: cfg.network === "base-sepolia" ? 84532 : 8453,
        // Push signed receipts to the serving operator through the relay
        // (operator-driven redeem, issue #369); self-redeem is the fallback.
        relayUrl: relayBase,
        // Optional override for the reservation batch size (#367). Omitted (not
        // undefined) when unset so the client's default (5) isn't clobbered.
        ...(args.vaultReserveMultiple && args.vaultReserveMultiple > 0
          ? { reserveMultiple: BigInt(Math.floor(args.vaultReserveMultiple)) }
          : {}),
        // Same target drives startup deposit AND mid-run auto-refill, so the
        // vault doesn't drain to a 402 (which would bounce the agent to a fallback).
        autoTopUpUsd: args.vaultDeposit,
      })
    : null;
  if (vault && args.vaultDeposit && args.vaultDeposit > 0) {
    // Auto-managed: top the vault up to the target from the wallet's USDC on
    // startup so the first request has reservable funds. Fails loud (and the
    // sidecar still starts in case the agent only hits read endpoints).
    try {
      const target = BigInt(Math.round(args.vaultDeposit * 1_000_000));
      const tx = await vault.ensureDeposit(target);
      console.log(
        tx
          ? `  ✓ vault topped up to $${args.vaultDeposit.toFixed(2)} (deposit ${tx.slice(0, 10)}…)`
          : `  ✓ vault already funded ≥ $${args.vaultDeposit.toFixed(2)}`
      );
    } catch (e) {
      console.error(`  ⚠ vault auto-deposit failed: ${errMsg(e)}`);
      console.error(`    Fund ${wallet.address} with USDC + a little ETH on Base, or run: halo vault deposit <usd>`);
    }
  }

  // Last-resort crash nets: a long-running inference sidecar an agent depends on
  // must NEVER exit because one request threw. Without these, an uncaught
  // exception or unhandled rejection from any code path (a malformed upstream
  // body, a socket reset mid-write, a confidential-decrypt edge case) takes the
  // whole daemon down and the agent sees connection-refused thereafter. Log and
  // keep serving.
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error(`  ⚠ uncaught exception (kept alive): ${errMsg(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error(`  ⚠ unhandled rejection (kept alive): ${errMsg(reason)}`);
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { error: { message: errMsg(err), type: "halo_internal_error" } });
    });
  });
  // A malformed/oversized request line or a client that resets mid-handshake
  // emits 'clientError'; without a handler Node can surface it as an uncaught
  // error. Respond 400 if the socket is still writable, else just close.
  server.on("clientError", (_err, socket) => {
    try {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      else socket.destroy();
    } catch {
      /* socket already gone */
    }
  });
  // A bind failure (most often EADDRINUSE) must be FATAL and LOUD. Without this
  // handler the listen 'error' propagates to the uncaughtException net above,
  // which logs "kept alive" and leaves the process running while the socket
  // never bound — so the agent gets connection-refused on EVERY request with no
  // clear cause. Fail fast with the fix instead.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `\n  ✗ port ${port} is already in use on ${host}.\n` +
          `    Another process (another consume, or anything else) is holding it.\n` +
          `    Start consume on a free port, e.g.  halo consume --port 8800\n` +
          `    then point your agent at  http://${host}:8800/v1\n`
      );
    } else {
      console.error(`\n  ✗ server error (${err.code || "unknown"}): ${errMsg(err)}\n`);
    }
    process.exit(1);
  });
  // Long-lived-daemon socket hardening. requestTimeout bounds a slow/stuck body
  // upload but must exceed our upstream inference ceiling (~300s) so a slow model
  // isn't severed; headersTimeout guards slow-loris header dribbling;
  // keepAliveTimeout outlives a typical agent's idle keep-alive so the server
  // doesn't close a socket the client is about to reuse.
  server.requestTimeout = 360_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 75_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url || "").split("?")[0];

    // Unauthenticated health/capability check — never spends, never needs the
    // bearer. `confidential` tells a consuming agent whether THIS endpoint
    // enforces confidential (TEE) inference by default; per-model availability is
    // on /v1/models (`confidential: true`), and a request can require it ad-hoc
    // with the `X-Halo-Confidential: true` header.
    if (req.method === "GET" && (url === "/health" || url === "/healthz")) {
      return sendJson(res, 200, {
        status: "ok",
        wallet: wallet.address,
        network: cfg.network,
        confidential,
      });
    }

    // Bearer gate (if configured) on everything that can spend or query upstream.
    if (args.apiKey && !bearerOk(req, args.apiKey)) {
      return sendJson(res, 401, { error: { message: "missing or invalid bearer token", type: "halo_auth_error" } });
    }

    // Model list — proxied from the relay, no payment.
    if (req.method === "GET" && url === "/v1/models") {
      try {
        const upstream = await fetch(modelsUrl, { signal: AbortSignal.timeout(15_000) });
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
      } catch (err) {
        sendJson(res, 502, {
          error: { message: `relay unreachable for model list (${errMsg(err)}). Check ${relayBase}/health.`, type: "halo_upstream_error" },
        });
      }
      return;
    }

    // Account — this consume wallet's League standing (consume points, tier,
    // streak, requests, total USDC spent) from the indexer, plus this session's
    // budget. Lets an agent "check its points/stats" over the API without knowing
    // the indexer URL. Link the wallet to a dashboard with `halo link` to see it
    // there too. No payment.
    if (req.method === "GET" && url === "/v1/account") {
      let stats: Record<string, unknown> = { error: "indexer unreachable" };
      try {
        const r = await fetch(`${cfg.indexerUrl.replace(/\/+$/, "")}/points/${wallet.address}`, {
          signal: AbortSignal.timeout(15_000),
        });
        if (r.ok) {
          const p = (await r.json()) as Record<string, unknown>;
          stats = {
            consumePoints: p.consumePoints ?? 0,
            consumeTier: p.consumeTier ?? null,
            consumeStreakDays: p.consumeStreakDays ?? 0,
            consumeStreakMultiplier: p.consumeStreakMultiplier ?? 1,
            requestsConsumed: p.requestsConsumed ?? 0,
            tokensConsumed: p.tokensConsumed ?? 0,
            usdcSpentTotal: Number((Number(p.usdcSpentBase ?? 0) / 1_000_000).toFixed(4)),
            season: p.season ?? null,
          };
        }
      } catch {
        /* indexer down — return the wallet + budget anyway */
      }
      return sendJson(res, 200, {
        address: wallet.address,
        network: cfg.network,
        league: stats,
        sessionBudget: {
          capped: budget.budgetBase > 0n,
          limitUsd: Number(usd(budget.budgetBase)),
          spentUsd: Number(usd(budget.spentBase)),
          remainingUsd: Number(usd(budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n)),
        },
        // Pair this wallet with a dashboard to view it in the UI: run `halo link`.
        dashboardHint: "run `halo link` to pair this wallet with a dashboard",
      });
    }

    if (req.method === "POST" && url === "/v1/chat/completions") {
      return handleCompletion(req, res);
    }

    // Budget read/update. GET reports current limit/spent/remaining; POST
    // {"limitUsd": N} raises (or sets) the cumulative cap WITHOUT a restart — the
    // path for "agent told the user the budget's nearly out, user approved more".
    // Gated by the same bearer as everything else (above); loopback-only by
    // default. Spent is never reset by an update — only the ceiling moves.
    if (url === "/v1/budget") {
      if (req.method === "GET") {
        return sendJson(res, 200, {
          limitUsd: Number(usd(budget.budgetBase)),
          spentUsd: Number(usd(budget.spentBase)),
          remainingUsd: Number(usd(budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n)),
          capped: budget.budgetBase > 0n,
        });
      }
      if (req.method === "POST") {
        let body: { limitUsd?: number };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: { message: "body must be JSON {\"limitUsd\": N}", type: "halo_request_error" } });
        }
        if (typeof body.limitUsd !== "number" || body.limitUsd < 0) {
          return sendJson(res, 400, { error: { message: "limitUsd must be a non-negative number (0 = uncapped)", type: "halo_request_error" } });
        }
        budget.budgetBase = BigInt(Math.round(body.limitUsd * 1_000_000));
        console.log(`  ℹ budget updated → $${usd(budget.budgetBase)} (spent so far $${usd(budget.spentBase)})`);
        return sendJson(res, 200, {
          limitUsd: Number(usd(budget.budgetBase)),
          spentUsd: Number(usd(budget.spentBase)),
          remainingUsd: Number(usd(budget.budgetBase > budget.spentBase ? budget.budgetBase - budget.spentBase : 0n)),
          capped: budget.budgetBase > 0n,
        });
      }
    }

    return sendJson(res, 404, { error: { message: `no route for ${req.method} ${url}`, type: "halo_not_found" } });
  }

  async function handleCompletion(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const t0 = Date.now();
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      return sendJson(res, 413, { error: { message: errMsg(err), type: "halo_request_error" } });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: { message: "request body is not valid JSON", type: "halo_request_error" } });
    }

    // Cancel signal: if the client (agent) gives up and disconnects — a common
    // case, agents have their own timeouts — abort the upstream call so we stop
    // paying for a response nobody is waiting for.
    const ac = new AbortController();

    // Cumulative budget gate with a race-safe RESERVATION. An autonomous agent
    // fans requests out in parallel; a plain check-then-accrue lets several
    // requests pass the gate near the cap and overspend. Each request reserves
    // its per-request ceiling here (the most it could cost), so spent+reserved
    // can never exceed the budget. The reservation is released — and reconciled
    // to the actual charge — when the response closes, on every path.
    let reserved = false;
    const release = (): void => {
      if (!reserved) return;
      reserved = false;
      budget.reservedBase -= maxAmountBase;
      if (budget.reservedBase < 0n) budget.reservedBase = 0n;
    };
    if (budget.budgetBase > 0n) {
      if (budget.spentBase + budget.reservedBase + maxAmountBase > budget.budgetBase) {
        res.writeHead(402, { "Content-Type": "application/json", ...budgetHeaders() });
        res.end(
          JSON.stringify({
            error: {
              message: `Spending budget would be exceeded: $${usd(budget.spentBase)} spent${
                budget.reservedBase > 0n ? ` (+$${usd(budget.reservedBase)} in flight)` : ""
              } of the $${usd(budget.budgetBase)} cap, and this request reserves up to $${usd(
                maxAmountBase
              )}. Ask the user to approve more, then raise it without restarting: POST ${`http://${host}:${port}`}/v1/budget {"limitUsd": <new total>}.`,
              type: "halo_over_budget",
              code: "over_budget",
              spentUsd: Number(usd(budget.spentBase)),
              limitUsd: Number(usd(budget.budgetBase)),
            },
          })
        );
        return;
      }
      budget.reservedBase += maxAmountBase;
      reserved = true;
    }
    // One handler covers both outcomes: release the reservation always, and if
    // the response closed before we finished writing it (client disconnected),
    // abort the in-flight upstream call.
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
      release();
    });

    // Streaming: the x402 pay flow is buffered (we pay for, then receive, the
    // full response), so we can't proxy a live token stream from the operator.
    // But many agents (Hermes, etc.) ALWAYS send stream:true and treat a non-SSE
    // reply as a hard failure. So we BUFFER under the hood, then re-emit the
    // finished answer to the client as a tiny SSE stream (chat.completion.chunk
    // events + [DONE]). The client gets a valid stream; payment is unchanged. We
    // force stream:false upstream so the operator returns a buffered completion.
    const wantStream = parsed.stream === true;
    if (wantStream) delete parsed.stream;

    // Apply the consume profile's default model when the client omits one.
    if ((parsed.model === undefined || parsed.model === "") && defaultModel) {
      parsed.model = defaultModel;
    }
    // Allowlist guard: refuse to pay for a model outside the configured set,
    // BEFORE any payment is signed.
    if (allowedModels && allowedModels.length) {
      const m = typeof parsed.model === "string" ? parsed.model : "";
      if (!allowedModels.includes(m)) {
        return sendJson(res, 403, {
          error: {
            message: `model ${m || "(none)"} is not in this consumer's allowlist (${allowedModels.join(", ")})`,
            type: "halo_model_not_allowed",
          },
        });
      }
    }

    // Forward x-halo-* routing hints (model/operator/price/privacy) transparently.
    const forwardHeaders = collectHaloHeaders(req);

    // Confidential is required either globally (`--confidential`) or per-request
    // via the `X-Halo-Confidential` header — so an agent can demand confidential
    // for a specific call without running a confidential-only endpoint.
    const wantConfidential =
      confidential ||
      /^(1|true|required|yes)$/i.test(String(req.headers["x-halo-confidential"] || ""));

    // Confidential (TEE) mode: fetch the model's PUBLIC attestation, encrypt each
    // message content to the enclave key, and route only to TEE operators. The
    // operator relays ciphertext and can't read the prompt; we decrypt + verify
    // the response below. Fails the request (not silently downgrades) so the
    // caller never thinks a plaintext request was confidential.
    const errCtx = {
      wallet: wallet.address,
      network: cfg.network,
      maxUsd: Number(maxAmountBase) / 1_000_000,
      relay: relayBase,
      confidential: wantConfidential,
    };

    // Vault rail: capture the prompt-size estimate (to size the reservation)
    // BEFORE confidential/E2E mutate `parsed`, and pin ONE operator to reserve
    // against, encrypt to, and meter (TEE-only when confidential).
    const vaultEstTokens = vault
      ? estimateTokens(
          (parsed as { messages?: unknown }).messages,
          typeof parsed.max_tokens === "number" ? parsed.max_tokens : 1024
        )
      : 0;
    let vaultPin: VaultOperatorPin | null = null;
    if (vault) {
      const m = typeof parsed.model === "string" ? parsed.model : "";
      // If the caller explicitly pinned an operator (X-Halo-Operator, e.g. a
      // settlement sweep targeting every operator), honor it; otherwise fall back
      // to the default cheapest-tier selection.
      const pinned = (forwardHeaders["x-halo-operator"] || "").trim() || undefined;
      vaultPin = m ? await selectVaultOperator(relayBase, m, wantConfidential, undefined, pinned) : null;
      if (!vaultPin) {
        return sendJson(
          res,
          503,
          actionableError(
            503,
            JSON.stringify({
              error: {
                message: pinned
                  ? `pinned operator ${pinned} is not advertising a price for "${m}"${wantConfidential ? " (confidential)" : ""} right now — it can't be reserved against. Drop X-Halo-Operator to use the cheapest available operator.`
                  : `no priced${wantConfidential ? " confidential" : ""} operator is online for "${m}". Vault mode needs an operator advertising a price for this model.`,
              },
            }),
            errCtx
          )
        );
      }
      forwardHeaders["x-halo-operator"] = vaultPin.address;
    }

    let teeClientKey: string | null = null;
    let teeSigner: string | null = null;
    if (wantConfidential) {
      const model = typeof parsed.model === "string" ? parsed.model : "";
      try {
        const att = await fetchModelAttestation(teeBaseUrl, model);
        // TRUSTLESS hardware verification (parity with the frontend): prove the
        // attestation is a genuine Intel TDX + NVIDIA enclave running NEAR's
        // image and that its signing key is bound into the quote — BEFORE we
        // encrypt the prompt to that key. Then confirm THIS request's attested
        // signer matches the hardware-verified one (a rogue relay/provider can't
        // substitute a key that lacks a valid Intel-signed quote). Cached per
        // model (~2s only on a cache miss / enclave rotation). Fails closed.
        if (!args.noAttestationVerify) {
          const verifiedSigner = await verifiedSignerForModel(teeBaseUrl, model);
          if (att.signingAddress.toLowerCase() !== verifiedSigner) {
            throw new Error(
              `attested signer ${att.signingAddress} does not match the hardware-verified enclave signer ${verifiedSigner}`
            );
          }
        }
        teeSigner = att.signingAddress;
        const ck = newClientKey();
        teeClientKey = ck.privateKey;
        if (Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map((m) => {
            const mm = m as { content?: unknown };
            return mm && typeof mm.content === "string"
              ? { ...mm, content: encryptToTee(mm.content, att.signingPublicKey) }
              : m;
          });
        }
        forwardHeaders["x-halo-tee"] = "true";
        forwardHeaders["x-signing-algo"] = "ecdsa";
        forwardHeaders["x-client-pub-key"] = ck.pubHex;
      } catch (e) {
        // Fails closed — never silently downgrade a confidential request to plaintext.
        const detail = errMsg(e);
        // "Failed to get collateral" is the DCAP verifier unable to fetch the
        // Intel quote's collateral — almost always egress to Intel's PCS, not a
        // bad model. Say so, since the generic "TEE unavailable" misleads.
        const hint = /collateral/i.test(detail)
          ? `This is the hardware-attestation collateral fetch from Intel's PCS (api.trustedservices.intel.com) failing — ensure THIS process can reach it (firewall/VPN, and set HTTPS_PROXY if you use a proxy). It auto-retries transient blips. To bypass the hardware check (less private — trusts the attestation source), restart consume with --no-attestation-verify.`
          : `The model may not support confidential inference, or the TEE provider is briefly unavailable. Retry, pick a model with confidential available (${relayBase}/v1/models), or drop the X-Halo-Confidential header to run non-confidential.`;
        return sendJson(res, 502, {
          error: {
            message: `Confidential setup failed for "${model}": ${detail}. ${hint}`,
            type: "halo_confidential_error",
            code: "confidential_setup_failed",
          },
        });
      }
    }

    // Operator end-to-end encryption (non-confidential path): encrypt the prompt
    // to the chosen operator's announced X25519 key so the RELAY only ever sees
    // ciphertext (parity with the frontend). Confidential already encrypts to the
    // enclave, so this only applies when NOT confidential. Pins the operator we
    // encrypted to. Falls back to plaintext when no operator advertises a key
    // (unless that ever becomes a hard requirement).
    let e2eEphemeralPriv: Uint8Array | null = null;
    let e2eOperatorPub: Uint8Array | null = null;
    if (!wantConfidential && !args.noE2e) {
      const model = typeof parsed.model === "string" ? parsed.model : "";
      // Vault mode pins ONE operator (for the reservation) — E2E-encrypt to that
      // SAME operator rather than re-selecting, so the request lands where the
      // funds are reserved.
      const op = vault
        ? vaultPin && vaultPin.encryptionPubkey
          ? { address: vaultPin.address, encryptionPubkey: vaultPin.encryptionPubkey }
          : null
        : model
          ? await selectE2EOperator(relayBase, model)
          : null;
      if (op) {
        try {
          const operatorPub = hexToPubkey(op.encryptionPubkey);
          const eph = generateEphemeralKeypair();
          // `model` (and `stream`, already stripped) stay cleartext for routing;
          // everything else is sealed in `_enc`. The operator decrypts before it
          // quotes/serves (serve.ts Phase 0), so pricing is still accurate.
          const { model: routeModel, ...rest } = parsed as { model?: unknown } & Record<string, unknown>;
          const envelope = encryptRequest(rest, operatorPub, eph);
          parsed = { model: routeModel, _enc: envelope } as Record<string, unknown>;
          forwardHeaders["x-halo-operator"] = op.address;
          e2eEphemeralPriv = eph.privateKey;
          e2eOperatorPub = operatorPub;
        } catch {
          // Encryption setup failed — fall through to plaintext rather than block.
          e2eEphemeralPriv = null;
          e2eOperatorPub = null;
        }
      }
    }

    try {
      const result =
        vault && vaultPin
          ? await vaultSend(vault, completionsUrl, parsed, {
              forwardHeaders,
              signal: ac.signal,
              operator: vaultPin.address,
              priceUsdPerMtok: vaultPin.priceUsdPerMtok,
              estTokens: vaultEstTokens,
            })
          : await payAndFetch(completionsUrl, parsed, ctx, { maxAmountBase, forwardHeaders, signal: ac.signal });
      // Accrue what was actually charged into the session budget, then attach the
      // live budget headers (limit/spent/remaining + warning band) so the agent
      // always knows where it stands and can warn the user before it runs out.
      if (result.paid && result.chargedBase && /^\d+$/.test(result.chargedBase)) {
        budget.spentBase += BigInt(result.chargedBase);
      }
      const headers: Record<string, string> = { "Content-Type": "application/json", ...budgetHeaders() };
      const operator = result.headers.get("X-Halo-Operator");
      if (operator) headers["X-Halo-Operator"] = operator;
      headers["X-Halo-Paid"] = result.paid ? "true" : "false";
      logReq({
        model: typeof parsed.model === "string" ? parsed.model : "(none)",
        status: result.status,
        paid: result.paid,
        chargedBase: result.chargedBase,
        operator,
        confidential: wantConfidential,
        ms: Date.now() - t0,
      });
      // Echo whether this call was confidential so the agent can assert it.
      headers["X-Halo-Confidential"] = wantConfidential ? "true" : "false";
      let outBody = result.body;
      if (wantConfidential && teeClientKey && result.status >= 200 && result.status < 300) {
        // Decrypt the enclave's response + verify the operator-forwarded signature
        // recovers to the ATTESTED signer (operator can't forge; only withhold).
        try {
          const j = JSON.parse(result.body) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          for (const ch of j.choices ?? []) {
            if (ch.message && typeof ch.message.content === "string") {
              ch.message.content = decryptFromTee(ch.message.content, teeClientKey);
            }
          }
          outBody = JSON.stringify(j);
        } catch (e) {
          return sendJson(res, 502, {
            error: { message: `confidential response decrypt failed: ${errMsg(e)}`, type: "halo_confidential_error" },
          });
        }
        const sigB64 = result.headers.get("X-Halo-TEE-Signature") || "";
        headers["X-Halo-TEE-Verified"] =
          sigB64 && teeSigner && verifyTeeSignature(sigB64, teeSigner) ? "true" : "false";
      }
      // Operator-E2E: decrypt the operator's `_enc` reply (relay never saw it in
      // the clear). Marks the response so the agent knows it was relay-blind.
      if (e2eEphemeralPriv && e2eOperatorPub && result.status >= 200 && result.status < 300) {
        try {
          const j = JSON.parse(result.body) as { _enc?: unknown };
          if (isEncryptedEnvelope(j._enc)) {
            outBody = JSON.stringify(
              decryptResponse(j._enc as EncryptedEnvelope, e2eOperatorPub, e2eEphemeralPriv)
            );
          }
          headers["X-Halo-E2E-Encrypted"] = "true";
        } catch (e) {
          return sendJson(res, 502, {
            error: { message: `E2E response decrypt failed: ${errMsg(e)}`, type: "halo_e2e_error" },
          });
        }
      }
      // The operator/relay served a non-2xx (no operator, payment rejected, …).
      // Replace the raw body with an actionable, OpenAI-shaped error so the
      // agent surfaces the fix, not a cryptic "payment required". (Errors stay
      // JSON even for stream requests — OpenAI clients read the error body off a
      // non-200 response directly.)
      if (result.status >= 400) {
        return sendJson(res, result.status, actionableError(result.status, result.body, errCtx));
      }
      if (wantStream) {
        return sendBufferedAsSse(res, outBody, headers);
      }
      res.writeHead(result.status, headers);
      res.end(outBody);
    } catch (err) {
      // Client gave up and disconnected — the response socket is already gone.
      // Nothing to send; don't log it as an upstream fault.
      if (err instanceof X402Error && err.code === "client_aborted") {
        logReq({ model: typeof parsed.model === "string" ? parsed.model : "(none)", status: 0, paid: false, confidential: wantConfidential, ms: Date.now() - t0, note: "client disconnected" });
        return;
      }
      if (err instanceof X402Error) {
        // over_cap is a budget refusal (402); other guard failures are upstream
        // protocol faults (502).
        const status = err.code === "over_cap" ? 402 : 502;
        logReq({ model: typeof parsed.model === "string" ? parsed.model : "(none)", status, paid: false, confidential: wantConfidential, ms: Date.now() - t0, note: err.code });
        return sendJson(res, status, actionableError(status, JSON.stringify({ error: { message: err.message } }), errCtx));
      }
      logReq({ model: typeof parsed.model === "string" ? parsed.model : "(none)", status: 502, paid: false, confidential: wantConfidential, ms: Date.now() - t0, note: errMsg(err) });
      return sendJson(res, 502, actionableError(502, JSON.stringify({ error: { message: errMsg(err) } }), errCtx));
    }
  }

  server.listen(port, host, () => {
    console.log(`halo consume`);
    console.log(`  endpoint : http://${host}:${port}/v1`);
    console.log(`  wallet   : ${wallet.address}  (${cfg.network})`);
    console.log(`  relay    : ${relayBase}`);
    console.log(
      `  rail     : ${vault ? "vault (settle ACTUAL tokens; deposit-backed)" : `exact (sign-per-request, up to $${(Number(maxAmountBase) / 1_000_000).toFixed(2)}/req)`}`
    );
    console.log(
      `  budget   : ${budget.budgetBase > 0n ? `$${usd(budget.budgetBase)} cumulative (warn at ${Math.round(budget.warnPct * 100)}%)` : "uncapped (set --budget-usdc to bound an agent)"}`
    );
    console.log(`  auth     : ${args.apiKey ? "bearer token required" : "none (localhost only)"}`);
    console.log(`\n  point an OpenAI-compatible client at the endpoint above. Fund the wallet with USDC on Base.\n`);
  });

  // Keep the process alive until interrupted.
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return; // second Ctrl-C shouldn't double-run
      shuttingDown = true;
      console.log("\n  shutting down…");
      // Flush any in-flight vault receipt redeems so the operator is paid for
      // work already served before we exit.
      if (vault) void vault.flushRedeems();
      server.close(() => resolve());
      // Drop idle keep-alive sockets so close() doesn't wait on them, and
      // force-resolve if an in-flight request refuses to drain.
      server.closeIdleConnections?.();
      setTimeout(() => resolve(), 5000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

function bearerOk(req: http.IncomingMessage, expected: string): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth !== "string") return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] === expected : false;
}

function collectHaloHeaders(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase().startsWith("x-halo-") && typeof v === "string") out[k] = v;
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  // Never throw from here. If the response was already (partly) sent — e.g. an
  // error surfaced after writeHead — a second writeHead throws
  // ERR_HTTP_HEADERS_SENT, and when this runs inside the top-level `.catch` that
  // throw is uncaught and KILLS the whole `consume` daemon (the agent then sees
  // connection-refused on every later request). Guard on headersSent and swallow
  // any residual error so one bad request can never take the server down.
  try {
    if (res.headersSent || res.writableEnded) {
      res.end();
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  } catch (e) {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ failed to send response: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Truncate an address for logs (0xabcd…ef01), mirroring the relay/indexer. */
function shortAddr(a?: string | null): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "-";
}

/** One concise line per completion so an operator can see what the agent is
 *  doing and debug "issues on the consumer api" without turning on a profiler. */
function logReq(info: {
  model: string;
  status: number;
  paid: boolean;
  chargedBase?: string;
  operator?: string | null;
  confidential: boolean;
  ms: number;
  note?: string;
}): void {
  const charged =
    info.chargedBase && /^\d+$/.test(info.chargedBase) ? `$${(Number(info.chargedBase) / 1_000_000).toFixed(4)}` : "$0";
  const statusStr = info.status === 0 ? "---" : String(info.status);
  // eslint-disable-next-line no-console
  console.log(
    `  ▸ ${statusStr} ${info.model} paid=${info.paid} ${charged} op=${shortAddr(info.operator)}${
      info.confidential ? " conf" : ""
    } ${info.ms}ms${info.note ? ` (${info.note})` : ""}`
  );
}

/**
 * Re-emit a BUFFERED chat.completion as a minimal OpenAI SSE stream so a client
 * that requested stream:true gets a valid `text/event-stream` (we paid for and
 * received the whole answer first — there's no live token stream to proxy).
 * Forwards BOTH content AND tool_calls — a tool-using agent (Hermes, etc.) gets
 * finish_reason "tool_calls" with no tool calls in the deltas otherwise, and
 * hangs waiting for a tool it was never handed. Halo metadata rides as headers.
 */
interface BufferedToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
function sendBufferedAsSse(
  res: http.ServerResponse,
  bufferedBody: string,
  haloHeaders: Record<string, string>
): void {
  let parsed: {
    id?: string;
    model?: string;
    created?: number;
    choices?: Array<{
      message?: { role?: string; content?: string | null; tool_calls?: BufferedToolCall[] };
      finish_reason?: string;
    }>;
    usage?: unknown;
  };
  try {
    parsed = JSON.parse(bufferedBody);
  } catch {
    // Not JSON we recognize — fall back to a plain non-stream JSON reply.
    sendJson(res, 200, { error: { message: "upstream returned a non-JSON body", type: "halo_upstream_error" } });
    return;
  }
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content ?? "";
  const toolCalls = choice?.message?.tool_calls;
  const id = parsed.id || "chatcmpl-halo";
  const model = parsed.model || "";
  const created = parsed.created || Math.floor(Date.now() / 1000);
  // Honour the real finish_reason: "tool_calls" when the model asked for a tool,
  // else "stop". Mislabeling it "stop" when tool_calls exist makes the agent
  // ignore the tools.
  const finish = choice?.finish_reason || (toolCalls && toolCalls.length ? "tool_calls" : "stop");
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  try {
    // haloHeaders carries the X-Halo-* metadata (and a JSON content-type we
    // override). SSE content-type must win.
    const sseHeaders: Record<string, string> = {
      ...haloHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    res.writeHead(200, sseHeaders);
    const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    write(chunk({ role: "assistant" }, null));
    if (content) write(chunk({ content }, null));
    // Tool calls: stream each with the `index` the OpenAI delta format requires.
    if (toolCalls && toolCalls.length) {
      write(
        chunk(
          {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: tc.id,
              type: tc.type ?? "function",
              function: {
                name: tc.function?.name,
                arguments: tc.function?.arguments ?? "",
              },
            })),
          },
          null
        )
      );
    }
    write(chunk({}, finish));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    try {
      res.destroy();
    } catch {
      /* gone */
    }
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ SSE write failed: ${errMsg(e)}`);
  }
}

/**
 * Turn a raw relay/operator/facilitator failure into an OpenAI-shaped error whose
 * `message` tells the user (or their agent) HOW to fix it — funding, caps, model
 * availability, confidential. Folds the remedy into `message` because most
 * OpenAI clients/gateways only surface `error.message`.
 */
function actionableError(
  status: number,
  rawBody: string,
  ctx: { wallet: string; network: string; maxUsd: number; relay: string; confidential: boolean }
): { error: { message: string; type: string; code?: string } } {
  let inner = "";
  try {
    const j = JSON.parse(rawBody) as { error?: { message?: string } | string };
    inner = typeof j.error === "string" ? j.error : j.error?.message || "";
  } catch {
    inner = rawBody.slice(0, 200);
  }
  const low = inner.toLowerCase();
  const fundLine = `Fund your consumer wallet with USDC on Base ${ctx.network === "base-sepolia" ? "Sepolia" : "mainnet"}: ${ctx.wallet}`;

  // No operator online for the model.
  if (status === 503 || low.includes("no operators")) {
    const teeHint = ctx.confidential
      ? " For confidential, the model also needs a TEE operator online — check the `confidential` flag per model."
      : "";
    return {
      error: {
        message: `${inner || "No operator is currently serving this model."} → See available models at ${ctx.relay}/v1/models and pick one with operators > 0, or try again shortly.${teeHint}`,
        type: "halo_no_operator",
        code: "no_operator",
      },
    };
  }
  // Per-request cap (operator price exceeds the consumer's ceiling).
  if (low.includes("over_cap") || low.includes("exceeds") || low.includes("cap")) {
    return {
      error: {
        message: `${inner} → The operator's price is above your per-request cap of $${ctx.maxUsd.toFixed(2)}. Raise it with --max-usdc (or the X-Halo-Max-Price header), or route to a cheaper operator.`,
        type: "halo_over_cap",
        code: "over_cap",
      },
    };
  }
  // Payment failed — almost always an unfunded / underfunded wallet.
  if (status === 402 || low.includes("insufficient") || low.includes("balance") || low.includes("payment required")) {
    return {
      error: {
        message: `Payment was rejected${inner ? ` (${inner})` : ""}. This usually means the wallet has no USDC. ${fundLine}`,
        type: "halo_payment_required",
        code: "insufficient_funds",
      },
    };
  }
  // Generic upstream/relay fault.
  return {
    error: {
      message: `${inner || "Upstream request failed."} → Check the relay/operator status (${ctx.relay}/health) and retry; if it persists, the operator serving this model may be down.`,
      type: "halo_upstream_error",
    },
  };
}
