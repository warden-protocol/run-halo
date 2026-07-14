import { execFile, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { configDir } from "./config";
import { HALO_VERSION } from "./version";

export const CANONICAL_REMOTE = "https://github.com/warden-protocol/halo.git";
// Cache successful checks and failed-target backoff for the same short interval.
export const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000;
// Grace window after a detached relaunch spawns, to catch a child that launches
// but then crashes on module load (missing/corrupt entry) before we exit 0.
const RELAUNCH_HEALTH_GRACE_MS = 750;
const execFileAsync = promisify(execFile);

interface UpdateCache {
  lastCheckedAt: string;
  latestTag: string | null;
}

export type UpdateStatus = "ok" | "failed" | "locked" | "skipped-unmanaged";
interface UpdateLogEntry {
  at: string;
  status: "ok" | "failed" | "locked";
  action?: "checked" | "applied";
  from?: string;
  to?: string;
  error?: string;
}

export type UpdateResult =
  | { kind: "disabled" | "unmanaged" | "locked" | "current" | "cached" }
  | { kind: "applied"; from: string; to: string }
  | { kind: "failed"; error: string };

export function managedSourceDir(): string {
  return path.join(configDir(), "src");
}

export function isManagedInstall(
  entry = process.argv[1],
  managedRoot = managedSourceDir()
): boolean {
  if (!entry || !existsSync(path.join(managedRoot, ".halo-managed"))) return false;
  try {
    const realEntry = realpathSync(entry);
    const realRoot = realpathSync(managedRoot);
    const rel = path.relative(realRoot, realEntry);
    return (
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(rel)
    );
  } catch {
    return false;
  }
}

function cachePath(): string {
  return path.join(configDir(), "update-check.json");
}

function logPath(): string {
  return path.join(configDir(), "update.log");
}

function lockPath(): string {
  return path.join(configDir(), "update.lock");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function readCache(): UpdateCache | null {
  const cache = readJson<UpdateCache>(cachePath());
  if (
    !cache ||
    typeof cache.lastCheckedAt !== "string" ||
    (cache.latestTag !== null && typeof cache.latestTag !== "string")
  ) {
    return null;
  }
  return cache;
}

function writeCache(latestTag: string | null): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    cachePath(),
    JSON.stringify({ lastCheckedAt: new Date().toISOString(), latestTag }, null, 2),
    { mode: 0o600 }
  );
}

function appendUpdateLog(entry: UpdateLogEntry): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    appendFileSync(logPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Updating must not fail merely because its evidence trail cannot be written.
  }
}

// Keep tag parsing compatible with relay/src/version-gate.ts.
export function parseCliTag(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = version.match(/^cli-v(\d+)\.(\d+)\.(\d+)(?:$|-)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function isNewerCliVersion(candidate: string, current: string): boolean {
  const candidateVersion = parseCliTag(candidate);
  const currentVersion = parseCliTag(current);
  return !!candidateVersion && !!currentVersion && compareVersions(candidateVersion, currentVersion) > 0;
}

export function latestCliTagFromLsRemote(output: string): string | null {
  const tags = new Set<string>();
  for (const line of output.split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    const match = ref?.match(/^refs\/tags\/(cli-v\d+\.\d+\.\d+)$/);
    if (match) tags.add(match[1]);
  }
  return [...tags].sort((a, b) => {
    const av = parseCliTag(a)!;
    const bv = parseCliTag(b)!;
    return compareVersions(bv, av);
  })[0] ?? null;
}

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
    return stdout;
  } catch (err) {
    const failure = err as Error & { stderr?: string };
    const detail = failure.stderr?.trim();
    throw new Error(detail ? `${failure.message}: ${detail.slice(-4000)}` : failure.message);
  }
}

async function verifyOrigin(root: string): Promise<void> {
  const origin = (await run("git", ["config", "--get", "remote.origin.url"], root)).trim();
  if (origin !== CANONICAL_REMOTE) {
    throw new Error(`managed checkout origin is ${JSON.stringify(origin)}, expected ${CANONICAL_REMOTE}`);
  }
}

async function resolveLatestTag(
  force: boolean
): Promise<{ tag: string | null; fromCache: boolean }> {
  const cache = readCache();
  const checkedAt = cache ? Date.parse(cache.lastCheckedAt) : NaN;
  if (!force && cache && Number.isFinite(checkedAt) && Date.now() - checkedAt < UPDATE_CHECK_TTL_MS) {
    return { tag: cache.latestTag, fromCache: true };
  }
  // A failed network check is still a check attempt. Persist its timestamp
  // before I/O so an offline daemon retries after the check TTL (5 min), not
  // every 30 seconds.
  writeCache(cache?.latestTag ?? null);
  const output = await run("git", [
    "ls-remote",
    "--tags",
    "--sort=-v:refname",
    CANONICAL_REMOTE,
    "refs/tags/cli-v*",
  ]);
  const tag = latestCliTagFromLsRemote(output);
  if (!tag) throw new Error("no cli-vX.Y.Z release tag found");
  writeCache(tag);
  return { tag, fromCache: false };
}

function lastUpdateLogEntry(): UpdateLogEntry | null {
  try {
    let last: UpdateLogEntry | null = null;
    for (const line of readFileSync(logPath(), "utf8").split("\n")) {
      if (line.trim()) last = JSON.parse(line) as UpdateLogEntry;
    }
    return last;
  } catch {
    return null;
  }
}

function logLockedAttempt(): void {
  const last = lastUpdateLogEntry();
  const lastAt = last ? Date.parse(last.at) : NaN;
  if (
    last?.status === "locked" &&
    Number.isFinite(lastAt) &&
    Date.now() - lastAt < 60_000
  ) {
    return;
  }
  appendUpdateLog({
    at: new Date().toISOString(),
    status: "locked",
    from: HALO_VERSION,
    to: readCache()?.latestTag ?? undefined,
    error: "another update process holds the lock",
  });
}

interface LockHolder {
  pid: number;
  startedAt: string;
  token: string;
}

function readLegacyLockHolder(dir: string): Pick<LockHolder, "pid" | "startedAt"> | null {
  const holder = readJson<{ pid?: unknown; startedAt?: unknown }>(path.join(dir, "holder.json"));
  if (
    typeof holder?.pid !== "number" ||
    !Number.isInteger(holder.pid) ||
    holder.pid <= 0 ||
    typeof holder.startedAt !== "string"
  ) {
    return null;
  }
  return { pid: holder.pid, startedAt: holder.startedAt };
}

export interface UpdateLockHandle {
  holder: LockHolder;
  release(): void;
}

export interface UpdateLockState {
  held: boolean;
  pid: number | null;
  startedAt: string | null;
  stale: boolean;
}

interface LockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else. Anything
    // except definitive ESRCH fails safe as alive.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockHolder(file: string): LockHolder | null {
  const holder = readJson<Partial<LockHolder>>(file);
  if (
    typeof holder?.pid !== "number" ||
    !Number.isInteger(holder.pid) ||
    holder.pid <= 0 ||
    typeof holder.startedAt !== "string" ||
    typeof holder.token !== "string"
  ) {
    return null;
  }
  return holder as LockHolder;
}

function holderFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^holder-\d+-[0-9a-f-]+\.json$/.test(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Atomically publish a complete contender and acquire only when no other live contender exists. */
export function tryAcquireUpdateLock(
  dir = lockPath(),
  opts: LockOptions = {}
): UpdateLockHandle | null {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const token = randomUUID();
  const holder: LockHolder = { pid, startedAt: new Date().toISOString(), token };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Interoperate with the pre-contender implementation during rollout. A live
  // legacy holder wins; a definitively dead one is safe to remove. An empty
  // directory from its mkdir/write crash window is intentionally not a lock.
  const legacy = readLegacyLockHolder(dir);
  if (legacy) {
    if (isAlive(legacy.pid)) return null;
    rmSync(path.join(dir, "holder.json"), { force: true });
  }
  const temp = path.join(dir, `.candidate-${pid}-${token}.tmp`);
  const published = path.join(dir, `holder-${pid}-${token}.json`);
  try {
    writeFileSync(temp, JSON.stringify(holder), { mode: 0o600, flag: "wx" });
    renameSync(temp, published);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }

  let blocked = false;
  for (const file of holderFiles(dir)) {
    if (file === published) continue;
    const other = readLockHolder(file);
    if (other && isAlive(other.pid)) {
      blocked = true;
      break;
    }
    // Final holder paths are atomically published and unique. Invalid or dead
    // contenders can be removed without ever touching a replacement owner.
    rmSync(file, { force: true });
  }
  if (blocked) {
    rmSync(published, { force: true });
    return null;
  }

  return {
    holder,
    release: () => rmSync(published, { force: true }),
  };
}

export function readUpdateLockState(
  dir = lockPath(),
  isAlive: (pid: number) => boolean = defaultIsAlive
): UpdateLockState {
  let staleState: UpdateLockState | null = null;
  const legacy = readLegacyLockHolder(dir);
  if (legacy) {
    const alive = isAlive(legacy.pid);
    const state = {
      held: alive,
      pid: legacy.pid,
      startedAt: legacy.startedAt,
      stale: !alive,
    };
    if (alive) return state;
    staleState = state;
  }
  for (const file of holderFiles(dir)) {
    const holder = readLockHolder(file);
    if (!holder) continue;
    const alive = isAlive(holder.pid);
    const state = {
      held: alive,
      pid: holder.pid,
      startedAt: holder.startedAt,
      stale: !alive,
    };
    if (alive) return state;
    staleState ??= state;
  }
  return staleState ?? { held: false, pid: null, startedAt: null, stale: false };
}

export function cleanupOrphanedStagingDirs(
  installHome = configDir(),
  isAlive: (pid: number) => boolean = defaultIsAlive
): void {
  let names: string[];
  try {
    names = readdirSync(installHome);
  } catch {
    return;
  }
  for (const name of names) {
    const match = name.match(/^src-staging-(\d+)$/);
    if (!match || isAlive(Number(match[1]))) continue;
    rmSync(path.join(installHome, name), { recursive: true, force: true });
  }
}

function safeSnapshotName(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, "-");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isOwnedManagedTree(dir: string): boolean {
  const sentinel = readJson<{ remote?: unknown }>(path.join(dir, ".halo-managed"));
  return sentinel?.remote === CANONICAL_REMOTE && existsSync(path.join(dir, ".git"));
}

/** Restore executable bits after rename-based promotion because `tsc` emits the linked CLI entry as 0644. */
export function ensureEntryExecutable(entry: string): void {
  const mode = statSync(entry).mode;
  // Mirror read → execute: 0o444 (r for u/g/o) >> 2 == 0o111 (x for u/g/o).
  chmodSync(entry, mode | ((mode & 0o444) >> 2));
}

async function buildStaging(staging: string, tag: string): Promise<void> {
  await run("git", ["clone", "--depth", "1", "--branch", tag, CANONICAL_REMOTE, staging]);
  for (const packageName of ["vault-core", "sdk", "cli"]) {
    const cwd = path.join(staging, packageName);
    await run("npm", ["ci", "--ignore-scripts"], cwd);
    await run("npm", ["run", "build"], cwd);
  }

  const entry = path.join(staging, "cli", "dist", "index.js");
  ensureEntryExecutable(entry);
  const reported = (await run(process.execPath, [entry, "--version"])).trim();
  if (reported !== tag) throw new Error(`staged CLI reported ${JSON.stringify(reported)}, expected ${tag}`);
  const help = await run(process.execPath, [entry, "--help"]);
  if (!help.includes("halo — Halo operator + payer CLI")) {
    throw new Error("staged CLI --help smoke test failed");
  }
}

export function promoteStagedInstall(staging: string, root: string, oldVersion: string): void {
  const installHome = path.dirname(root);
  const previous = path.join(installHome, `src-prev-${safeSnapshotName(oldVersion)}`);
  if (existsSync(previous)) {
    if (!isOwnedManagedTree(previous)) {
      throw new Error(`refusing to delete unowned rollback path: ${previous}`);
    }
    rmSync(previous, { recursive: true, force: true });
  }
  renameSync(root, previous);
  try {
    renameSync(staging, root);
  } catch (err) {
    try {
      renameSync(previous, root);
    } catch (rollbackErr) {
      // Preserve both the promotion and rollback errors when the live root could not be restored.
      throw new Error(
        `halo update failed and automatic rollback also failed; the managed ` +
          `install at ${root} is now broken (its previous copy is at ${previous}). ` +
          `Reinstall with install.sh. original error: ${errorMessage(err)}; ` +
          `rollback error: ${errorMessage(rollbackErr)}`
      );
    }
    throw err;
  }
  // Snapshot pruning is best-effort and cannot invalidate a completed promotion.
  try {
    for (const name of readdirSync(installHome)) {
      if (name.startsWith("src-prev-") && path.join(installHome, name) !== previous) {
        const candidate = path.join(installHome, name);
        if (!isOwnedManagedTree(candidate)) continue;
        try {
          rmSync(candidate, { recursive: true, force: true });
        } catch {
          // Skip a snapshot we couldn't remove; keep pruning the rest.
        }
      }
    }
  } catch {
    // Leave stale snapshots for the next run rather than failing an update
    // that has already fully succeeded.
  }
}

export async function checkAndApplyUpdate(opts: { force?: boolean } = {}): Promise<UpdateResult> {
  if (process.env.HALO_NO_AUTOUPDATE === "1") return { kind: "disabled" };
  if (!isManagedInstall()) return { kind: "unmanaged" };

  const root = managedSourceDir();
  let lock: UpdateLockHandle | null = null;
  let staging = "";
  let target: string | undefined;
  try {
    // Provenance is re-read from git on every path, before trusting cached or
    // remote tag data. The sentinel is necessary but never authoritative.
    await verifyOrigin(root);
    cleanupOrphanedStagingDirs();
    lock = tryAcquireUpdateLock();
    if (!lock) {
      logLockedAttempt();
      return { kind: "locked" };
    }

    const latest = await resolveLatestTag(opts.force === true);
    if (!latest.tag) return { kind: "cached" };
    target = latest.tag;
    const targetVersion = parseCliTag(target);
    const currentVersion = parseCliTag(HALO_VERSION);
    if (!targetVersion || !currentVersion) {
      throw new Error(
        `cannot safely compare CLI versions (current=${HALO_VERSION}, target=${target})`
      );
    }
    if (!isNewerCliVersion(target, HALO_VERSION)) {
      if (!latest.fromCache || lastUpdateLogEntry()?.status === "locked") {
        appendUpdateLog({
          at: new Date().toISOString(),
          status: "ok",
          action: "checked",
          from: HALO_VERSION,
          to: target,
        });
      }
      return { kind: "current" };
    }

    const lastAttempt = lastUpdateLogEntry();
    const lastAttemptAt = lastAttempt ? Date.parse(lastAttempt.at) : NaN;
    if (
      opts.force !== true &&
      lastAttempt?.status === "failed" &&
      lastAttempt.to === target &&
      Number.isFinite(lastAttemptAt) &&
      Date.now() - lastAttemptAt < UPDATE_CHECK_TTL_MS
    ) {
      return { kind: "cached" };
    }

    staging = path.join(configDir(), `src-staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    await buildStaging(staging, target);

    const sentinel = readJson<Record<string, unknown>>(path.join(root, ".halo-managed")) ?? {
      remote: CANONICAL_REMOTE,
      installedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(staging, ".halo-managed"), JSON.stringify(sentinel, null, 2), {
      mode: 0o600,
    });
    promoteStagedInstall(staging, root, HALO_VERSION);
    staging = "";
    appendUpdateLog({
      at: new Date().toISOString(),
      status: "ok",
      action: "applied",
      from: HALO_VERSION,
      to: target,
    });
    return { kind: "applied", from: HALO_VERSION, to: target };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendUpdateLog({
      at: new Date().toISOString(),
      status: "failed",
      from: HALO_VERSION,
      to: target,
      error: message,
    });
    return { kind: "failed", error: message };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    lock?.release();
  }
}

export interface UpdateDiagnostics {
  currentVersion: string;
  latestKnownVersion: string | null;
  lastCheckedAt: string | null;
  lastUpdateAppliedAt: string | null;
  lastUpdateStatus: UpdateStatus | null;
  lastUpdateTarget: string | null;
  lastUpdateError: string | null;
  lock: UpdateLockState;
  managed: boolean;
}

export function readUpdateDiagnostics(): UpdateDiagnostics {
  const managed = isManagedInstall();
  const cache = readCache();
  let last: UpdateLogEntry | null = null;
  let lastAppliedAt: string | null = null;
  // Ignore inherited update logs for unmanaged checkouts; they do not prove this checkout was promoted.
  if (managed) {
    try {
      for (const line of readFileSync(logPath(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as UpdateLogEntry;
        if (
          entry.status === "ok" &&
          (entry.action === "applied" || (!entry.action && entry.from !== entry.to))
        ) {
          lastAppliedAt = entry.at;
        }
        last = entry;
      }
    } catch {
      // Missing or partially-written logs are reported as no history.
    }
  }
  return {
    currentVersion: HALO_VERSION,
    latestKnownVersion: cache?.latestTag ?? null,
    lastCheckedAt: cache?.lastCheckedAt ?? null,
    lastUpdateAppliedAt: lastAppliedAt,
    lastUpdateStatus: managed ? last?.status ?? null : "skipped-unmanaged",
    lastUpdateTarget: last?.to ?? null,
    lastUpdateError: last?.error ?? null,
    lock: readUpdateLockState(),
    managed,
  };
}

export function startAutoUpdateMonitor(onApplied: () => Promise<void> | void): () => void {
  if (process.env.HALO_NO_AUTOUPDATE === "1" || !isManagedInstall()) return () => {};
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void checkAndApplyUpdate()
      .then((result) => (result.kind === "applied" ? onApplied() : undefined))
      .finally(() => {
        checking = false;
      });
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

export function shouldExitForServiceRestart(
  detached: boolean,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return detached && env.HALO_SERVICE === "1";
}

export function restartIntoManagedInstall(detached = true): void {
  if (shouldExitForServiceRestart(detached)) process.exit(0);
  const entry = path.join(managedSourceDir(), "cli", "dist", "index.js");
  if (!detached) {
    const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
    process.exit(result.status ?? 1);
  }
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    detached: true,
    stdio: "inherit",
    env: process.env,
  });
  let settled = false;
  const finish = (code: number): void => {
    if (settled) return;
    settled = true;
    process.exit(code);
  };
  // Observe both spawn errors and early child exits before reporting a successful relaunch.
  // Detach only after the crash-grace interval.
  child.once("error", (err: Error) => {
    console.error(
      `Fatal: could not relaunch managed halo (${err.message}). ` +
        `Reinstall with install.sh if this persists.`
    );
    finish(1);
  });
  child.once("exit", (code) => {
    console.error(
      `Fatal: relaunched halo exited immediately (code ${code ?? "unknown"}). ` +
        `Reinstall with install.sh if this persists.`
    );
    finish(code ?? 1);
  });
  child.once("spawn", () => {
    setTimeout(() => {
      child.unref();
      finish(0);
    }, RELAUNCH_HEALTH_GRACE_MS).unref();
  });
}
