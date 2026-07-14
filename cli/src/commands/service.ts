import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configDir, loadConfig } from "../config";

type Target = "consume" | "serve";

const LABEL = (t: Target) => `com.halo-${t}`;
const UNIT = (t: Target) => `halo-${t}.service`;

export async function cmdService(rawArgs: string[]): Promise<void> {
  const dryRun = rawArgs.includes("--dry-run") || rawArgs.includes("--print");
  const args = rawArgs.filter((a) => a !== "--dry-run" && a !== "--print");

  const sub = args[0];
  let target: Target = "consume";
  let passthrough: string[];
  if (args[1] === "consume" || args[1] === "serve") {
    target = args[1];
    passthrough = args.slice(2);
  } else {
    passthrough = args.slice(1);
  }
  // Strip a leading `--` separator (e.g. `service install consume -- --port 8799`).
  if (passthrough[0] === "--") passthrough = passthrough.slice(1);

  switch (sub) {
    case "install":
      return install(target, passthrough, dryRun);
    case "uninstall":
    case "remove":
      return uninstall(target);
    case "status":
      return status(target);
    case "logs":
      return logs(target);
    default:
      console.error(
        "usage: halo service <install|uninstall|status|logs> [consume|serve] [--dry-run] [-- daemon args…]"
      );
      process.exit(1);
  }
}

/** Absolute invocation of this CLI, independent of PATH and the parent shell.
 *  Prefer an installed `halo` on PATH (clean ExecStart); else node + entry. */
function invocation(): string[] {
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "command", ["-v", "halo"], {
      encoding: "utf-8",
      shell: process.platform !== "win32",
    }).trim().split("\n")[0];
    if (found) return [found];
  } catch {
    /* not on PATH — fall back to the running interpreter + entry script */
  }
  return [process.execPath, process.argv[1]];
}

function passphrasePreflight(): void {
  if (process.env.HALO_PASSPHRASE != null) return;
  try {
    const cfg = loadConfig();
    if (!cfg.operator.noPassphrase) {
      console.warn(
        "  ⚠ This keystore has a passphrase, but a background service can't be prompted.\n" +
          "    Either export HALO_PASSPHRASE before `install` (it'll be baked into the unit),\n" +
          "    or re-create an unattended keystore with `halo setup --no-wallet-passphrase`.\n"
      );
    }
  } catch {
    /* no config yet — `setup` first; install can still proceed for inspection */
  }
}

export function buildServiceEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  home = homedir()
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    PATH: source.PATH || "/usr/local/bin:/usr/bin:/bin",
    HALO_SERVICE: "1",
  };
  if (source.HALO_PASSPHRASE != null) env.HALO_PASSPHRASE = source.HALO_PASSPHRASE;
  if (source.HALO_NO_AUTOUPDATE != null) {
    env.HALO_NO_AUTOUPDATE = source.HALO_NO_AUTOUPDATE;
  }
  for (const k of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    if (source[k] != null) env[k] = source[k] as string;
  }
  return env;
}

function install(target: Target, passthrough: string[], dryRun: boolean): void {
  const argv = [...invocation(), target, ...passthrough];
  const outLog = path.join(configDir(), `${target}.log`);
  const errLog = path.join(configDir(), `${target}.err`);
  const env = buildServiceEnvironment();
  // Carry proxy config into the unit — a background service inherits none of the
  // shell's env, so without this it can't reach the relay / Intel PCS on a
  // proxied network (consume/serve call installProxyFromEnv() to honor these).
  if (process.platform === "darwin") return installLaunchd(target, argv, env, outLog, errLog, dryRun);
  if (process.platform === "linux") return installSystemd(target, argv, env, outLog, errLog, dryRun);
  console.error(
    `  ✗ Persistent-service install is supported on macOS (launchd) and Linux (systemd --user).\n` +
      `    On ${process.platform}, run \`halo ${target}\` under your own supervisor (e.g. pm2, nssm).`
  );
  process.exit(1);
}

function installLaunchd(
  target: Target,
  argv: string[],
  env: Record<string, string>,
  outLog: string,
  errLog: string,
  dryRun: boolean
): void {
  const label = LABEL(target);
  const plistPath = path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const x = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const argEls = argv.map((a) => `      <string>${x(a)}</string>`).join("\n");
  const envEls = Object.entries(env)
    .map(([k, v]) => `    <key>${x(k)}</key>\n    <string>${x(v)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argEls}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${x(outLog)}</string>
  <key>StandardErrorPath</key><string>${x(errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEls}
  </dict>
</dict>
</plist>
`;
  if (dryRun) {
    console.log(`# ${plistPath}\n${plist}`);
    return;
  }
  passphrasePreflight();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(plistPath, plist);
  try {
    execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  console.log(`  ✓ installed launchd service ${label}`);
  console.log(`    plist : ${plistPath}`);
  console.log(`    logs  : ${outLog}`);
  console.log(`    It now starts on login, restarts on crash, and survives gateway restarts.`);
  console.log(`    Manage: halo service status ${target} | halo service uninstall ${target}`);
}

function installSystemd(
  target: Target,
  argv: string[],
  env: Record<string, string>,
  outLog: string,
  errLog: string,
  dryRun: boolean
): void {
  const unit = UNIT(target);
  const unitPath = path.join(homedir(), ".config", "systemd", "user", unit);
  // systemd splits ExecStart on whitespace; quote each arg to keep them intact.
  const execStart = argv.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  const unitText = `[Unit]
Description=Halo ${target} (always-on)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
${envLines}
Restart=always
RestartSec=2
StandardOutput=append:${outLog}
StandardError=append:${errLog}

[Install]
WantedBy=default.target
`;
  if (dryRun) {
    console.log(`# ${unitPath}\n${unitText}`);
    return;
  }
  passphrasePreflight();
  mkdirSync(path.dirname(unitPath), { recursive: true });
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(unitPath, unitText);
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", unit], { stdio: "inherit" });
  // Survive logout/headless: keep the user manager running without an active session.
  try {
    execFileSync("loginctl", ["enable-linger", process.env.USER || ""], { stdio: "ignore" });
  } catch {
    console.warn(`    (couldn't enable-linger — run \`loginctl enable-linger $USER\` to survive logout)`);
  }
  console.log(`  ✓ installed systemd --user service ${unit}`);
  console.log(`    unit : ${unitPath}`);
  console.log(`    logs : ${outLog}`);
  console.log(`    It now starts on login, restarts on crash, and survives gateway restarts.`);
  console.log(`    Manage: halo service status ${target} | halo service uninstall ${target}`);
}

function uninstall(target: Target): void {
  if (process.platform === "darwin") {
    const plistPath = path.join(homedir(), "Library", "LaunchAgents", `${LABEL(target)}.plist`);
    if (!existsSync(plistPath)) return void console.log(`  (no launchd service for ${target})`);
    try {
      execFileSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    unlinkSync(plistPath);
    return void console.log(`  ✓ removed launchd service ${LABEL(target)}`);
  }
  if (process.platform === "linux") {
    const unit = UNIT(target);
    const unitPath = path.join(homedir(), ".config", "systemd", "user", unit);
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", unit], { stdio: "ignore" });
    } catch {
      /* not enabled */
    }
    if (existsSync(unitPath)) unlinkSync(unitPath);
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    return void console.log(`  ✓ removed systemd service ${unit}`);
  }
  console.error(`  ✗ unsupported platform ${process.platform}`);
  process.exit(1);
}

function status(target: Target): void {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf-8" });
      const line = out.split("\n").find((l) => l.includes(LABEL(target)));
      console.log(line ? `  ${line.trim()}` : `  ${LABEL(target)}: not loaded`);
      console.log(`  (columns: PID  ExitStatus  Label — a numeric PID means running)`);
    } else if (process.platform === "linux") {
      execFileSync("systemctl", ["--user", "status", UNIT(target), "--no-pager"], { stdio: "inherit" });
    } else {
      console.error(`  ✗ unsupported platform ${process.platform}`);
    }
  } catch (e) {
    console.log(`  ${target}: not running / not installed`);
  }
}

function logs(target: Target): void {
  const outLog = path.join(configDir(), `${target}.log`);
  const errLog = path.join(configDir(), `${target}.err`);
  console.log(`  stdout: ${outLog}`);
  console.log(`  stderr: ${errLog}`);
  for (const f of [outLog, errLog]) {
    if (existsSync(f)) {
      const tail = readFileSync(f, "utf-8").split("\n").slice(-15).join("\n");
      if (tail.trim()) console.log(`\n--- ${path.basename(f)} (last 15 lines) ---\n${tail}`);
    }
  }
}
