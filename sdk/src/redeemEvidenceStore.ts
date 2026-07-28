import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MaxUint256, getAddress, isAddress } from "ethers";

let temporarySequence = 0;
const OWNERSHIP_WAIT_MS = 2_000;
const OWNERSHIP_POLL_MS = 20;
const ownershipWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export type RedeemTerminalReason = "cli-outdated" | "invalid-request";

export interface PersistedDeadLetterRedeem {
  key: string;
  version: 1;
  vaultAddress: string;
  chainId: number;
  consumer: string;
  operator: string;
  cumulative: string;
  signature: string;
  cycle: string;
  reason: RedeemTerminalReason;
  recordedAt: string;
}

export interface PersistedDeadLetterStore {
  version: 1;
  entries: PersistedDeadLetterRedeem[];
}

export const MAX_DEAD_LETTER_ENTRIES = 10_000;
export const MAX_DEAD_LETTER_FILE_BYTES = 16 * 1024 * 1024;
const UINT_STRING = /^(0|[1-9]\d{0,77})$/;
const MAX_UINT64 = (1n << 64n) - 1n;

function isPositiveUint(value: unknown, maximum: bigint): value is string {
  return (
    typeof value === "string" &&
    UINT_STRING.test(value) &&
    BigInt(value) > 0n &&
    BigInt(value) <= maximum
  );
}

function deadLetterKey(entry: PersistedDeadLetterRedeem): string {
  return JSON.stringify([
    entry.chainId,
    entry.vaultAddress.toLowerCase(),
    entry.consumer.toLowerCase(),
    entry.operator.toLowerCase(),
    entry.cycle,
  ]);
}

/** Parse the complete versioned store or reject it as one fail-closed unit. */
export function parseDeadLetterStore(raw: string): PersistedDeadLetterStore {
  if (Buffer.byteLength(raw, "utf8") > MAX_DEAD_LETTER_FILE_BYTES) {
    throw new Error("file exceeds the 16 MiB recovery limit");
  }
  const value = JSON.parse(raw) as Partial<PersistedDeadLetterStore> | null;
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_DEAD_LETTER_ENTRIES
  ) {
    throw new Error("unsupported dead-letter store shape or version");
  }
  const entries: PersistedDeadLetterRedeem[] = [];
  const keys = new Set<string>();
  for (const candidate of value.entries) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("invalid dead-letter entry");
    }
    const entry = candidate as Partial<PersistedDeadLetterRedeem>;
    if (
      entry.version !== 1 ||
      typeof entry.key !== "string" ||
      entry.key.length > 512 ||
      typeof entry.vaultAddress !== "string" ||
      !isAddress(entry.vaultAddress) ||
      typeof entry.chainId !== "number" ||
      !Number.isSafeInteger(entry.chainId) ||
      entry.chainId <= 0 ||
      typeof entry.consumer !== "string" ||
      !isAddress(entry.consumer) ||
      typeof entry.operator !== "string" ||
      !isAddress(entry.operator) ||
      !isPositiveUint(entry.cumulative, MaxUint256) ||
      !isPositiveUint(entry.cycle, MAX_UINT64) ||
      typeof entry.signature !== "string" ||
      entry.signature.length === 0 ||
      entry.signature.length > 1024 ||
      (entry.reason !== "cli-outdated" && entry.reason !== "invalid-request") ||
      typeof entry.recordedAt !== "string" ||
      entry.recordedAt.length > 64 ||
      !Number.isFinite(Date.parse(entry.recordedAt))
    ) {
      throw new Error("invalid dead-letter entry");
    }
    const normalized: PersistedDeadLetterRedeem = {
      key: entry.key,
      version: 1,
      vaultAddress: getAddress(entry.vaultAddress),
      chainId: entry.chainId,
      consumer: getAddress(entry.consumer).toLowerCase(),
      operator: getAddress(entry.operator).toLowerCase(),
      cumulative: entry.cumulative,
      signature: entry.signature,
      cycle: entry.cycle,
      reason: entry.reason,
      recordedAt: entry.recordedAt,
    };
    if (normalized.key !== deadLetterKey(normalized)) {
      throw new Error("dead-letter entry key does not match its identity");
    }
    if (keys.has(normalized.key)) {
      throw new Error("duplicate dead-letter entry key");
    }
    keys.add(normalized.key);
    entries.push(normalized);
  }
  return { version: 1, entries };
}

export function serializeDeadLetterStore(
  store: PersistedDeadLetterStore
): string {
  const raw = JSON.stringify(store);
  if (Buffer.byteLength(raw, "utf8") > MAX_DEAD_LETTER_FILE_BYTES) {
    throw new Error("dead-letter store exceeds the 16 MiB recovery limit");
  }
  parseDeadLetterStore(raw);
  return raw;
}

function temporaryPath(target: string): string {
  temporarySequence += 1;
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${Date.now()}.${temporarySequence}.tmp`
  );
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

interface OwnedLock {
  descriptor: number;
  path: string;
}

export interface RedeemEvidenceOwnership {
  readonly paths: readonly string[];
  release(): void;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function waitForOwnership(): void {
  Atomics.wait(ownershipWaitBuffer, 0, 0, OWNERSHIP_POLL_MS);
}

function createLock(path: string): OwnedLock {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, flags, 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
    fsyncSync(descriptor);
    const owned = { descriptor, path };
    descriptor = undefined;
    return owned;
  } catch (error) {
    if (descriptor !== undefined) {
      const owned = fstatSync(descriptor);
      try {
        const current = lstatSync(path);
        if (owned.dev === current.dev && owned.ino === current.ino) {
          unlinkSync(path);
        }
      } catch {}
      closeSync(descriptor);
    }
    throw error;
  }
}

function readLockOwner(path: string): number {
  const stat = lstatSync(path);
  const owner = Number(readFileSync(path, "utf8").trim());
  if (!stat.isFile() || !Number.isSafeInteger(owner) || owner <= 0) {
    throw new Error(`vault redeem evidence lock is invalid: ${path}`);
  }
  return owner;
}

function recoverStaleLock(path: string): boolean {
  const recoveryPath = `${path}.recovery`;
  let recoveryLinked = false;
  try {
    try {
      linkSync(path, recoveryPath);
      recoveryLinked = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") return false;
      throw error;
    }

    const recoveryStat = lstatSync(recoveryPath);
    const owner = readLockOwner(recoveryPath);
    if (isLivePid(owner)) return false;

    let currentStat;
    try {
      currentStat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      currentStat &&
      (currentStat.dev !== recoveryStat.dev || currentStat.ino !== recoveryStat.ino)
    ) {
      return false;
    }
    if (currentStat) unlinkSync(path);
    return true;
  } finally {
    if (recoveryLinked) {
      try {
        unlinkSync(recoveryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function acquireLock(path: string): OwnedLock {
  const deadline = Date.now() + OWNERSHIP_WAIT_MS;
  while (true) {
    try {
      return createLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let owner: number;
    try {
      owner = readLockOwner(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (owner === process.pid) {
      throw new Error(`vault redeem evidence is already owned by this process: ${path}`);
    }
    if (!isLivePid(owner)) {
      if (recoverStaleLock(path)) continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`vault redeem evidence is already owned by process ${owner}: ${path}`);
    }
    waitForOwnership();
  }
}

function releaseLock(lock: OwnedLock): void {
  try {
    const owned = fstatSync(lock.descriptor);
    const current = lstatSync(lock.path);
    if (owned.dev !== current.dev || owned.ino !== current.ino) {
      throw new Error(`vault redeem evidence lock ownership changed: ${lock.path}`);
    }
    unlinkSync(lock.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`vault redeem evidence lock ownership disappeared: ${lock.path}`);
    }
    throw error;
  } finally {
    closeSync(lock.descriptor);
  }
}

export function resolveRedeemEvidencePath(target: string): string {
  const absolute = resolve(target);
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const normalized = join(realpathSync(parent), basename(absolute));
  try {
    if (lstatSync(normalized).isSymbolicLink()) {
      throw new Error(`vault redeem evidence path must not be a symbolic link: ${normalized}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return normalized;
}

/**
 * Hold exclusive ownership across the active and terminal stores. Paths are
 * locked separately so even a partially overlapping configuration fails closed.
 */
export function acquireRedeemEvidenceOwnership(
  targets: readonly string[]
): RedeemEvidenceOwnership {
  const requested = targets
    .filter((target) => target.length > 0)
    .map(resolveRedeemEvidencePath);
  const paths = [...new Set(requested)].sort();
  if (paths.length !== requested.length) {
    throw new Error("pending and dead-letter redeem stores must use distinct paths");
  }
  if (
    paths.some((target) => {
      const lowerTarget = target.toLowerCase();
      return lowerTarget.endsWith(".lock") || lowerTarget.endsWith(".lock.recovery");
    })
  ) {
    throw new Error(
      "pending and dead-letter redeem stores must not overlap redeem evidence lock metadata"
    );
  }
  const reservedPaths = paths.flatMap((target) => {
    const lockPath = `${target}.lock`;
    return [target, lockPath, `${lockPath}.recovery`];
  });
  if (new Set(reservedPaths).size !== reservedPaths.length) {
    throw new Error(
      "pending and dead-letter redeem stores must not overlap redeem evidence lock metadata"
    );
  }
  const locks: OwnedLock[] = [];
  try {
    for (const target of paths) {
      locks.push(acquireLock(`${target}.lock`));
    }
  } catch (error) {
    const releaseErrors: unknown[] = [];
    for (const lock of locks.reverse()) {
      try {
        releaseLock(lock);
      } catch (releaseError) {
        releaseErrors.push(releaseError);
      }
    }
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [error, ...releaseErrors],
        "redeem evidence ownership acquisition and rollback both failed"
      );
    }
    throw error;
  }

  let released = false;
  return {
    paths,
    release(): void {
      if (released) return;
      const releaseErrors: unknown[] = [];
      for (const lock of [...locks].reverse()) {
        try {
          releaseLock(lock);
        } catch (error) {
          releaseErrors.push(error);
        }
      }
      released = true;
      if (releaseErrors.length === 1) throw releaseErrors[0];
      if (releaseErrors.length > 1) {
        throw new AggregateError(releaseErrors, "redeem evidence ownership release failed");
      }
    },
  };
}

/** Replace one local state file through a synced same-directory temporary. */
export function writeDurableFile(target: string, contents: string): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(target);
  let descriptor: number | undefined;
  let replaced = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    replaced = true;
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!replaced) {
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }
}

export function writeDurableJson(target: string, value: unknown): void {
  writeDurableFile(target, JSON.stringify(value));
}
