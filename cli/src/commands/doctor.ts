import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { configDir, configPath, defaultKeystorePath, loadConfig } from "../config";
import { readUpdateDiagnostics, UpdateDiagnostics } from "../update";

export interface DoctorOptions {
  json?: boolean;
}

interface EndpointProbe {
  /** Slug used for `--provider`. */
  slug: string;
  label: string;
  url: string;
  /** True if we got a 2xx within the timeout. */
  reachable: boolean;
  modelCount: number | null;
  error: string | null;
}

interface DoctorReport {
  /** ISO timestamp of when the report was generated. */
  generatedAt: string;
  install: {
    nodeVersion: string;
    entry: string;
  };
  update: UpdateDiagnostics;
  configDir: {
    path: string;
    exists: boolean;
    keystorePresent: boolean;
    configPresent: boolean;
    /** True when keystore.json exists but config.json doesn't — fingerprint of a crashed setup. */
    orphanedKeystore: boolean;
  };
  wallet: {
    address: string | null;
    /** "config" | "keystore" | null — where we read the address from. */
    source: "config" | "keystore" | null;
    noPassphrase: boolean;
  };
  provider: {
    slug: string | null;
    baseUrl: string | null;
    modelCount: number | null;
  };
  serve: {
    pidFilePresent: boolean;
    pidFileStale: boolean;
    pid: number | null;
    /** True when the process named in serve.pid is alive. */
    running: boolean;
    logPath: string | null;
    recentLogLines: string[];
  };
  endpoints: EndpointProbe[];
  network: {
    relayUrl: string | null;
    relayReachable: boolean;
    indexerUrl: string | null;
    indexerReachable: boolean;
  };
}

const LOCAL_PROBES: Array<{ slug: string; label: string; modelsUrl: string }> = [
  {
    slug: "openclaw",
    label: "OpenClaw gateway",
    modelsUrl: "http://127.0.0.1:18789/v1/models",
  },
  {
    slug: "ollama",
    label: "Local Ollama",
    modelsUrl: "http://127.0.0.1:11434/api/tags",
  },
  {
    slug: "lmstudio",
    label: "Local LM Studio",
    modelsUrl: "http://127.0.0.1:1234/v1/models",
  },
];

const PROBE_TIMEOUT_MS = 1500;

async function probeEndpoint(
  slug: string,
  label: string,
  url: string
): Promise<EndpointProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { slug, label, url, reachable: false, modelCount: null, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { data?: unknown[]; models?: unknown[] };
    const list = body.data || body.models || [];
    return {
      slug,
      label,
      url,
      reachable: true,
      modelCount: Array.isArray(list) ? list.length : null,
      error: null,
    };
  } catch (err) {
    clearTimeout(timer);
    const msg =
      err instanceof Error && err.name === "AbortError"
        ? `timeout after ${PROBE_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { slug, label, url, reachable: false, modelCount: null, error: msg };
  }
}

async function probeRelay(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * 2);
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

interface ServeStatus {
  pidFilePresent: boolean;
  pidFileStale: boolean;
  pid: number | null;
  running: boolean;
  logPath: string | null;
  recentLogLines: string[];
}

function readServeStatus(): ServeStatus {
  const pidPath = path.join(configDir(), "serve.pid");
  const logPath = path.join(configDir(), "serve.log");
  const out: ServeStatus = {
    pidFilePresent: existsSync(pidPath),
    pidFileStale: false,
    pid: null,
    running: false,
    logPath: existsSync(logPath) ? logPath : null,
    recentLogLines: [],
  };

  if (out.pidFilePresent) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        out.pid = pid;
        // process.kill(pid, 0) throws ESRCH when no such process exists;
        // throws EPERM when the process exists but is owned by someone else
        // (which still counts as "running" for our purposes — same machine).
        try {
          process.kill(pid, 0);
          out.running = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EPERM") {
            out.running = true;
          } else {
            out.pidFileStale = true;
          }
        }
      }
    } catch {
      out.pidFileStale = true;
    }
  }

  if (out.logPath) {
    try {
      // Tail ~last 10 KB of the log and return the final 8 non-empty lines.
      // Bounded so doctor stays cheap even when serve.log grows.
      const sz = statSync(out.logPath).size;
      const TAIL_BYTES = 10 * 1024;
      const start = Math.max(0, sz - TAIL_BYTES);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs");
      const fd = fs.openSync(out.logPath, "r");
      const buf = Buffer.alloc(sz - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      const text = buf.toString("utf-8");
      out.recentLogLines = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(-8);
    } catch {
      /* unreadable log — leave recentLogLines empty */
    }
  }

  return out;
}

function readKeystoreAddress(path: string): string | null {
  try {
    const ks = JSON.parse(readFileSync(path, "utf-8")) as { address?: unknown };
    if (typeof ks.address !== "string") return null;
    const addr = ks.address.startsWith("0x") ? ks.address : `0x${ks.address}`;
    return /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function buildReport(): Promise<DoctorReport> {
  const cfgPath = configPath();
  const ksPath = defaultKeystorePath();
  const configPresent = existsSync(cfgPath);
  const keystorePresent = existsSync(ksPath);
  const configDirPath = cfgPath.replace(/\/[^/]+$/, "");
  const configDirExists = (() => {
    try {
      return statSync(configDirPath).isDirectory();
    } catch {
      return false;
    }
  })();

  let cfg: ReturnType<typeof loadConfig> | null = null;
  if (configPresent) {
    try {
      cfg = loadConfig();
    } catch {
      cfg = null;
    }
  }

  let walletAddress: string | null = null;
  let walletSource: "config" | "keystore" | null = null;
  if (cfg) {
    walletAddress = cfg.operator.address;
    walletSource = "config";
  } else if (keystorePresent) {
    walletAddress = readKeystoreAddress(ksPath);
    walletSource = walletAddress ? "keystore" : null;
  }

  const endpoints = await Promise.all(
    LOCAL_PROBES.map((p) => probeEndpoint(p.slug, p.label, p.modelsUrl))
  );

  const relayUrl = cfg?.relayUrl || "https://relay.runhalo.xyz";
  const indexerUrl = cfg?.indexerUrl || "https://indexer.runhalo.xyz";
  const [relayReachable, indexerReachable] = await Promise.all([
    probeRelay(relayUrl),
    probeRelay(indexerUrl),
  ]);

  const serve = readServeStatus();

  return {
    generatedAt: new Date().toISOString(),
    install: {
      nodeVersion: process.versions.node,
      entry: process.argv[1] || "(unknown)",
    },
    update: readUpdateDiagnostics(),
    configDir: {
      path: configDirPath,
      exists: configDirExists,
      keystorePresent,
      configPresent,
      orphanedKeystore: keystorePresent && !configPresent,
    },
    wallet: {
      address: walletAddress,
      source: walletSource,
      noPassphrase: cfg?.operator.noPassphrase === true,
    },
    provider: {
      slug: cfg?.provider.slug ?? null,
      baseUrl: cfg?.provider.baseUrl ?? null,
      modelCount: cfg?.provider.models.length ?? null,
    },
    serve,
    endpoints,
    network: {
      relayUrl,
      relayReachable,
      indexerUrl,
      indexerReachable,
    },
  };
}

function printText(r: DoctorReport): void {
  const mark = (ok: boolean): string => (ok ? "✓" : "✖");
  const warn = (s: string): string => `⚠ ${s}`;

  console.log(`\nhalo doctor — ${r.generatedAt}\n`);

  console.log(`Install`);
  console.log(`  ${mark(true)} Node ${r.install.nodeVersion}`);
  console.log(`  ${mark(true)} entry: ${r.install.entry}`);
  console.log(`  ${mark(true)} version: ${r.update.currentVersion}`);
  console.log(`  ${r.update.managed ? mark(true) : warn("unmanaged")} auto-update: ${r.update.managed ? "managed" : "disabled for this checkout"}`);
  if (r.update.latestKnownVersion) {
    console.log(`    latest known: ${r.update.latestKnownVersion} (checked ${r.update.lastCheckedAt})`);
  }
  if (r.update.lastUpdateStatus) {
    console.log(
      `    last check: ${r.update.lastUpdateStatus}` +
        `${r.update.lastUpdateTarget ? ` (target ${r.update.lastUpdateTarget})` : ""}`
    );
  }
  if (r.update.lastUpdateAppliedAt) {
    console.log(`    last applied: ${r.update.lastUpdateAppliedAt}`);
  }
  if (r.update.lastUpdateError) {
    console.log(`    last error: ${r.update.lastUpdateError}`);
  }
  if (r.update.lock.held || r.update.lock.stale) {
    console.log(
      `    update lock: ${r.update.lock.stale ? "stale" : "held"}` +
        `${r.update.lock.pid ? ` by pid ${r.update.lock.pid}` : ""}` +
        `${r.update.lock.startedAt ? ` since ${r.update.lock.startedAt}` : ""}`
    );
  }
  console.log();

  console.log(`Config (${r.configDir.path})`);
  console.log(`  ${mark(r.configDir.exists)} directory ${r.configDir.exists ? "exists" : "missing"}`);
  console.log(`  ${mark(r.configDir.keystorePresent)} keystore.json ${r.configDir.keystorePresent ? "present" : "missing"}`);
  console.log(`  ${mark(r.configDir.configPresent)} config.json ${r.configDir.configPresent ? "present" : "missing"}`);
  if (r.configDir.orphanedKeystore) {
    console.log(`  ${warn("ORPHANED KEYSTORE — setup likely crashed mid-way. Re-run `halo setup` to recover.")}`);
  }
  console.log();

  console.log(`Wallet`);
  if (r.wallet.address) {
    console.log(`  ${mark(true)} ${r.wallet.address} (from ${r.wallet.source})`);
    if (r.wallet.noPassphrase) {
      console.log(`  ${warn("unattended mode (no wallet passphrase)")}`);
    }
  } else {
    console.log(`  ${mark(false)} no wallet on this machine`);
  }
  console.log();

  console.log(`Provider`);
  if (r.provider.slug) {
    console.log(`  ${mark(true)} ${r.provider.slug} → ${r.provider.baseUrl}`);
    console.log(`    advertising ${r.provider.modelCount ?? 0} model(s)`);
  } else {
    console.log(`  ${mark(false)} not configured`);
  }
  console.log();

  console.log(`Serve process`);
  if (r.serve.running) {
    console.log(`  ${mark(true)} running (pid ${r.serve.pid})`);
  } else if (r.serve.pidFileStale) {
    console.log(`  ${mark(false)} not running (stale pid ${r.serve.pid} — last serve crashed or was killed)`);
  } else {
    console.log(`  ${mark(false)} not running`);
  }
  if (r.serve.logPath) {
    console.log(`  log: ${r.serve.logPath}`);
    if (r.serve.recentLogLines.length > 0) {
      console.log(`  recent log (last ${r.serve.recentLogLines.length} line(s)):`);
      for (const line of r.serve.recentLogLines) {
        console.log(`    │ ${line}`);
      }
    }
  } else {
    console.log(`  log: (no serve.log yet — serve has never been started, or pre-upgrade install)`);
  }
  console.log();

  console.log(`Local endpoint probes (1.5s timeout)`);
  for (const e of r.endpoints) {
    const left = `  ${mark(e.reachable)} ${e.label.padEnd(22)}`;
    if (e.reachable) {
      console.log(`${left}  ${e.modelCount ?? "?"} model(s) at ${e.url}`);
    } else {
      console.log(`${left}  unreachable (${e.error}) at ${e.url}`);
    }
  }
  console.log();

  console.log(`Halo network`);
  console.log(`  ${mark(r.network.relayReachable)} relay     ${r.network.relayUrl}`);
  console.log(`  ${mark(r.network.indexerReachable)} indexer   ${r.network.indexerUrl}`);
  console.log();

  // Next-step hint at the end so the agent has a clear callout.
  const hints: string[] = [];
  if (r.configDir.orphanedKeystore) {
    hints.push("Re-run `halo setup` — orphaned-keystore recovery will preserve the existing address.");
  } else if (!r.configDir.configPresent && !r.configDir.keystorePresent) {
    const localReady = r.endpoints.find((e) => e.reachable);
    if (localReady) {
      hints.push(
        `Local inference available via ${localReady.slug}. Run: \`halo setup --provider ${localReady.slug} --margin 0 --no-wallet-passphrase\` for an unattended install.`
      );
    } else {
      hints.push("No local inference detected. Run `halo setup` and pick OpenRouter, OpenAI, or another hosted provider.");
    }
  } else if (!r.network.relayReachable) {
    hints.push("Relay unreachable — operator can't serve until it's back.");
  } else if (r.serve.pidFileStale) {
    hints.push(
      "Previous serve process crashed (stale pid file). Check `serve.log` recent lines above for the cause, then restart with `halo serve`."
    );
  } else if (r.provider.slug && r.wallet.address && !r.serve.running) {
    hints.push("Looks healthy. Run `halo serve` to start earning.");
  } else if (r.serve.running) {
    hints.push(`Serve is running (pid ${r.serve.pid}). \`tail -f ${r.serve.logPath ?? "~/.halo/serve.log"}\` to follow it live.`);
  }
  for (const h of hints) console.log(`→ ${h}`);
  if (hints.length > 0) console.log();
}

export async function cmdDoctor(opts: DoctorOptions = {}): Promise<void> {
  const report = await buildReport();
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
}
