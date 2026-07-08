import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ensureEntryExecutable,
  isManagedInstall,
  isNewerCliVersion,
  latestCliTagFromLsRemote,
  parseCliTag,
  promoteStagedInstall,
  cleanupOrphanedStagingDirs,
  readUpdateDiagnostics,
  readUpdateLockState,
  shouldExitForServiceRestart,
  tryAcquireUpdateLock,
} from "./update";
import { statSync } from "node:fs";
import { configDir } from "./config";

const CANONICAL_REMOTE = "https://github.com/warden-protocol/run-halo.git";

function markManaged(dir: string): void {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(
    path.join(dir, ".halo-managed"),
    JSON.stringify({ remote: CANONICAL_REMOTE })
  );
}

test("latestCliTagFromLsRemote ignores peeled/non-semver refs and compares numerically", () => {
  const output = [
    "a\trefs/tags/cli-v2.9.0",
    "b\trefs/tags/cli-v10.0.0",
    "c\trefs/tags/cli-v10.0.0^{}",
    "d\trefs/tags/v99.0.0",
    "e\trefs/tags/cli-vnext",
  ].join("\n");
  assert.equal(latestCliTagFromLsRemote(output), "cli-v10.0.0");
  assert.deepEqual(parseCliTag("cli-v1.2.3-4-gabc-dirty"), [1, 2, 3]);
  assert.equal(parseCliTag("1.2.3"), null);
  assert.equal(isNewerCliVersion("cli-v1.2.4", "cli-v1.2.3"), true);
  assert.equal(isNewerCliVersion("cli-v1.2.3", "cli-v1.2.3"), false);
  assert.equal(isNewerCliVersion("cli-v1.2.2", "cli-v1.2.3"), false);
});

test("managed install requires both the sentinel and an entry inside the managed checkout", () => {
  const base = mkdtempSync(path.join(tmpdir(), "halo-update-test-"));
  try {
    const root = path.join(base, "src");
    const entry = path.join(root, "cli", "dist", "index.js");
    const outside = path.join(base, "dev", "index.js");
    mkdirSync(path.dirname(entry), { recursive: true });
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(entry, "");
    writeFileSync(outside, "");
    assert.equal(isManagedInstall(entry, root), false);
    writeFileSync(path.join(root, ".halo-managed"), "{}");
    assert.equal(isManagedInstall(entry, root), true);
    assert.equal(isManagedInstall(outside, root), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ensureEntryExecutable restores the exec bit tsc drops on the bin entry", () => {
  const base = mkdtempSync(path.join(tmpdir(), "halo-chmod-test-"));
  try {
    const entry = path.join(base, "index.js");
    writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o644 });
    assert.equal(statSync(entry).mode & 0o111, 0, "precondition: not executable");

    ensureEntryExecutable(entry);

    // Executable for every class that could already read it, so the global
    // `halo` bin symlink can invoke it instead of failing with EACCES.
    assert.equal(statSync(entry).mode & 0o111, 0o111);
    assert.equal(statSync(entry).mode & 0o444, 0o444, "read bits preserved");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("staged promotion keeps one rollback snapshot and installs the independent tree", () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-promote-test-"));
  try {
    const root = path.join(home, "src");
    const staging = path.join(home, "src-staging-1");
    mkdirSync(root);
    mkdirSync(staging);
    markManaged(root);
    markManaged(staging);
    writeFileSync(path.join(root, "marker"), "old");
    writeFileSync(path.join(staging, "marker"), "new");
    mkdirSync(path.join(home, "src-prev-older"));
    markManaged(path.join(home, "src-prev-older"));

    promoteStagedInstall(staging, root, "cli-v1.0.0");

    assert.equal(readFileSync(path.join(root, "marker"), "utf8"), "new");
    assert.equal(
      readFileSync(path.join(home, "src-prev-cli-v1.0.0", "marker"), "utf8"),
      "old"
    );
    assert.equal(existsSync(path.join(home, "src-prev-older")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed staged promotion restores the live checkout", () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-promote-rollback-test-"));
  try {
    const root = path.join(home, "src");
    mkdirSync(root);
    markManaged(root);
    writeFileSync(path.join(root, "marker"), "old");
    assert.throws(() =>
      promoteStagedInstall(path.join(home, "missing-staging"), root, "cli-v1.0.0")
    );
    assert.equal(readFileSync(path.join(root, "marker"), "utf8"), "old");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("promotion surfaces both errors and the recovery path when rollback also fails", () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-promote-double-fail-test-"));
  // Patch the shared node:fs singleton the module calls through, so the rollback
  // renameSync itself fails — the only deterministic way to exercise the double
  // failure. Restored in finally.
  const fs = require("node:fs");
  const realRename = fs.renameSync;
  try {
    const root = path.join(home, "src");
    mkdirSync(root);
    markManaged(root);
    writeFileSync(path.join(root, "marker"), "old");

    let calls = 0;
    fs.renameSync = (from: string, to: string) => {
      calls += 1;
      if (calls === 1) return realRename(from, to); // root -> previous (real)
      throw new Error(`boom-${calls}`); // staging->root (2) then rollback previous->root (3)
    };

    assert.throws(
      () => promoteStagedInstall(path.join(home, "missing-staging"), root, "cli-v1.0.0"),
      (err: unknown) => {
        const m = (err as Error).message;
        // Original error preserved (not masked by the rollback's own error),
        // rollback error included, and the manual-recovery pointer present.
        return (
          /rollback also failed/.test(m) &&
          /install\.sh/.test(m) &&
          /boom-2/.test(m) &&
          /boom-3/.test(m)
        );
      }
    );
  } finally {
    fs.renameSync = realRename;
    rmSync(home, { recursive: true, force: true });
  }
});

test("readUpdateDiagnostics ignores a stale update.log on an unmanaged checkout", () => {
  // Override HOME so configDir() points at a throwaway dir with a stale log but
  // no managed checkout (no ~/.halo/src/.halo-managed) => unmanaged.
  const home = mkdtempSync(path.join(tmpdir(), "halo-diag-test-"));
  const realHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const cfgDir = configDir();
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      path.join(cfgDir, "update.log"),
      JSON.stringify({
        at: "2020-01-01T00:00:00Z",
        status: "ok",
        action: "applied",
        from: "cli-v0.0.1",
        to: "cli-v0.9.9",
      }) + "\n"
    );

    const diag = readUpdateDiagnostics();
    assert.equal(diag.managed, false);
    assert.equal(diag.lastUpdateStatus, "skipped-unmanaged");
    // The stale log must NOT leak a target/appliedAt that implies this checkout auto-updated.
    assert.equal(diag.lastUpdateTarget, null);
    assert.equal(diag.lastUpdateAppliedAt, null);
    assert.equal(diag.lastUpdateError, null);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("promotion refuses to delete an unowned rollback path", () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-promote-owner-test-"));
  try {
    const root = path.join(home, "src");
    const staging = path.join(home, "src-staging-1");
    const previous = path.join(home, "src-prev-cli-v1.0.0");
    mkdirSync(root);
    mkdirSync(staging);
    mkdirSync(previous);
    markManaged(root);
    markManaged(staging);
    writeFileSync(path.join(root, "marker"), "live");
    writeFileSync(path.join(previous, "marker"), "user-owned");

    assert.throws(() => promoteStagedInstall(staging, root, "cli-v1.0.0"), /unowned/);
    assert.equal(readFileSync(path.join(root, "marker"), "utf8"), "live");
    assert.equal(readFileSync(path.join(previous, "marker"), "utf8"), "user-owned");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("atomic contender lock tolerates empty dirs, blocks peers, and reclaims dead holders", () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-lock-test-"));
  const lockDir = path.join(home, "update.lock");
  const isAlive = (pid: number) => pid === process.pid;
  try {
    // A crash after creating the directory but before publishing a contender is harmless.
    mkdirSync(lockDir);
    const first = tryAcquireUpdateLock(lockDir, { isAlive });
    assert.ok(first);
    assert.equal(readUpdateLockState(lockDir, isAlive).held, true);

    const second = tryAcquireUpdateLock(lockDir, { isAlive });
    assert.equal(second, null);
    assert.equal(existsSync(path.join(lockDir, `holder-${first.holder.pid}-${first.holder.token}.json`)), true);

    first.release();
    writeFileSync(
      path.join(lockDir, "holder.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    assert.equal(tryAcquireUpdateLock(lockDir, { isAlive }), null);
    rmSync(path.join(lockDir, "holder.json"));

    const staleToken = "00000000-0000-4000-8000-000000000000";
    writeFileSync(
      path.join(lockDir, `holder-999999-${staleToken}.json`),
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), token: staleToken })
    );
    const replacement = tryAcquireUpdateLock(lockDir, { isAlive });
    assert.ok(replacement);
    assert.equal(existsSync(path.join(lockDir, `holder-999999-${staleToken}.json`)), false);
    replacement.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("three simultaneous processes never double-acquire the update lock", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-lock-race-test-"));
  const lockDir = path.join(home, "update.lock");
  const barrier = path.join(home, "start");
  const worker = `
    const fs = require("node:fs");
    const { tryAcquireUpdateLock } = require("./src/update");
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    (async () => {
      fs.writeFileSync(process.env.READY, "ready");
      while (!fs.existsSync(process.env.BARRIER)) await wait(2);
      const lock = tryAcquireUpdateLock(process.env.LOCK_DIR);
      process.stdout.write(lock ? "acquired" : "blocked");
      if (lock) { await wait(150); lock.release(); }
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  try {
    const children = [0, 1, 2].map((id) => {
      const ready = path.join(home, `ready-${id}`);
      const child = spawn(
        process.execPath,
        ["--require", "ts-node/register", "-e", worker],
        {
          cwd: path.resolve(__dirname, ".."),
          env: { ...process.env, READY: ready, BARRIER: barrier, LOCK_DIR: lockDir },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const done = new Promise<string>((resolve, reject) => {
        child.on("exit", (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(stderr || `worker exited ${code}`))
        );
      });
      return { ready, done };
    });

    while (!children.every((child) => existsSync(child.ready))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(barrier, "go");
    const outcomes = await Promise.all(children.map((child) => child.done));
    assert.ok(outcomes.filter((outcome) => outcome === "acquired").length <= 1, outcomes.join(","));

    const final = tryAcquireUpdateLock(lockDir);
    assert.ok(final, "lock remains acquirable after all contenders exit");
    final.release();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("orphan staging cleanup removes only definitively dead owners", () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-staging-cleanup-test-"));
  try {
    mkdirSync(path.join(home, "src-staging-101"));
    mkdirSync(path.join(home, "src-staging-202"));
    cleanupOrphanedStagingDirs(home, (pid) => pid === 202);
    assert.equal(existsSync(path.join(home, "src-staging-101")), false);
    assert.equal(existsSync(path.join(home, "src-staging-202")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("HALO_SERVICE only delegates detached daemon restarts to the supervisor", () => {
  assert.equal(shouldExitForServiceRestart(true, { HALO_SERVICE: "1" }), true);
  assert.equal(shouldExitForServiceRestart(false, { HALO_SERVICE: "1" }), false);
});
