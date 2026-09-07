import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { configDir } from "../../config";
import {
  WalletAccessError,
  type PrivyWalletAccessSession,
} from "../domain/walletAccess";
import type { SavedWalletAccessSession } from "../application/session";
import type {
  PrivyReauthenticationRecord,
  PrivySessionRefreshStore,
  PrivyWalletAccessStoredState,
} from "../application/refresh";

const MAX_RECORD_BYTES = 32 * 1024;

interface RefreshLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function persistenceAmbiguous(message: string): WalletAccessError {
  return new WalletAccessError(
    "privy_session_persistence_ambiguous",
    message
  );
}

function invalidState(): WalletAccessError {
  return persistenceAmbiguous(
    "The local Privy session record is invalid. Run halo logout before trying again."
  );
}

function lockAmbiguous(): WalletAccessError {
  return new WalletAccessError(
    "privy_session_lock_ambiguous",
    "The Privy session lock state is ambiguous. Inspect local Wallet Access state before retrying."
  );
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parseIsoDate(value: unknown): string {
  if (typeof value !== "string") throw invalidState();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw invalidState();
  }
  return value;
}

function parseIdentity(value: unknown): { backend: "privy"; address: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState();
  }
  const identity = value as Record<string, unknown>;
  if (
    !hasExactKeys(identity, ["address", "backend"]) ||
    identity.backend !== "privy" ||
    typeof identity.address !== "string"
  ) {
    throw invalidState();
  }
  try {
    return { backend: "privy", address: getAddress(identity.address) };
  } catch {
    throw invalidState();
  }
}

function parseAppId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw invalidState();
  }
  return value;
}

function parseWalletId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw invalidState();
  }
  return value;
}

function parseToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) {
    throw invalidState();
  }
  return value;
}

function parseSession(value: unknown): PrivyWalletAccessSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState();
  }
  const session = value as Record<string, unknown>;
  const expected = [
    "accessToken",
    "appId",
    "expiresAt",
    "identity",
    "refreshToken",
    "version",
    "walletId",
  ];
  if (!hasExactKeys(session, expected) || session.version !== 1) {
    throw invalidState();
  }
  return {
    version: 1,
    identity: parseIdentity(session.identity),
    expiresAt: parseIsoDate(session.expiresAt),
    appId: parseAppId(session.appId),
    walletId: parseWalletId(session.walletId),
    accessToken: parseToken(session.accessToken),
    refreshToken: parseToken(session.refreshToken),
  };
}

function parseRecord(raw: string): PrivyWalletAccessStoredState {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw invalidState();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidState();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.state !== "string") {
    throw invalidState();
  }
  if (record.state === "active") {
    if (
      !hasExactKeys(record, [
        "refreshedAt",
        "session",
        "state",
        "verifiedAt",
        "version",
      ])
    ) {
      throw invalidState();
    }
    const session = parseSession(record.session);
    const verifiedAt = parseIsoDate(record.verifiedAt);
    const refreshedAt = parseIsoDate(record.refreshedAt);
    if (
      Date.parse(refreshedAt) < Date.parse(verifiedAt) ||
      Date.parse(session.expiresAt) <= Date.parse(refreshedAt)
    ) {
      throw invalidState();
    }
    return {
      kind: "active",
      record: {
        version: 1,
        state: "active",
        session,
        verifiedAt,
        refreshedAt,
      },
    };
  }
  if (
    record.state !== "reauthentication_required" ||
    !hasExactKeys(record, [
      "appId",
      "identity",
      "reason",
      "refreshedAt",
      "state",
      "updatedAt",
      "verifiedAt",
      "version",
      "walletId",
    ]) ||
    (record.reason !== "refresh_failed" &&
      record.reason !== "refresh_rejected" &&
      record.reason !== "refresh_invalid" &&
      record.reason !== "refresh_scope_mismatch")
  ) {
    throw invalidState();
  }
  const verifiedAt = parseIsoDate(record.verifiedAt);
  const refreshedAt = parseIsoDate(record.refreshedAt);
  const updatedAt = parseIsoDate(record.updatedAt);
  if (
    Date.parse(refreshedAt) < Date.parse(verifiedAt) ||
    Date.parse(updatedAt) < Date.parse(refreshedAt)
  ) {
    throw invalidState();
  }
  return {
    kind: "reauthentication_required",
    record: {
      version: 1,
      state: "reauthentication_required",
      identity: parseIdentity(record.identity),
      appId: parseAppId(record.appId),
      walletId: parseWalletId(record.walletId),
      reason: record.reason,
      verifiedAt,
      refreshedAt,
      updatedAt,
    },
  };
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function walletAccessSessionPath(): string {
  return path.join(configDir(), "wallet-access-session.json");
}

export class FileWalletAccessSessionStore implements PrivySessionRefreshStore {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly filePath = walletAccessSessionPath(),
    lockOptions: RefreshLockOptions = {}
  ) {
    this.lockPath = `${filePath}.refresh.lock`;
    this.lockTimeoutMs = lockOptions.timeoutMs ?? 10_000;
    this.lockRetryMs = lockOptions.retryMs ?? 25;
    this.now = lockOptions.now ?? Date.now;
    this.sleep =
      lockOptions.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      !Number.isSafeInteger(this.lockTimeoutMs) ||
      this.lockTimeoutMs < 0 ||
      !Number.isSafeInteger(this.lockRetryMs) ||
      this.lockRetryMs <= 0
    ) {
      throw new Error("invalid Wallet Access refresh lock timing");
    }
  }

  readState(): PrivyWalletAccessStoredState {
    try {
      const stat = lstatSync(this.filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_RECORD_BYTES ||
        (stat.mode & 0o077) !== 0
      ) {
        throw invalidState();
      }
      const raw = readFileSync(this.filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw invalidState();
      return parseRecord(raw);
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "absent" };
      }
      throw invalidState();
    }
  }

  read(): SavedWalletAccessSession<PrivyWalletAccessSession> | null {
    const state = this.readState();
    if (state.kind === "absent") return null;
    if (state.kind === "reauthentication_required") {
      throw new WalletAccessError(
        "privy_login_required",
        "The Privy session requires authentication. Run halo login."
      );
    }
    return state.record;
  }

  write(record: SavedWalletAccessSession<PrivyWalletAccessSession>): void {
    this.writeState({ kind: "active", record });
  }

  writeReauthenticationRequired(record: PrivyReauthenticationRecord): void {
    this.writeState({ kind: "reauthentication_required", record });
  }

  clear(): void {
    try {
      unlinkSync(this.filePath);
      syncDirectory(path.dirname(this.filePath));
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw persistenceAmbiguous(
        "Could not prove removal of the local Privy session record. Inspect Wallet Access state before retrying."
      );
    }
  }

  async withRefreshLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const directory = path.dirname(this.filePath);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw lockAmbiguous();
    }
    const deadline = this.now() + this.lockTimeoutMs;
    let fd: number;
    while (true) {
      let candidateFd: number | null = null;
      try {
        candidateFd = openSync(this.lockPath, "wx", 0o600);
        writeFileSync(candidateFd, `${process.pid}\n`, "utf8");
        fsyncSync(candidateFd);
        fd = candidateFd;
        candidateFd = null;
        break;
      } catch (error) {
        if (candidateFd !== null) {
          try {
            closeSync(candidateFd);
          } catch {}
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw lockAmbiguous();
        }
        if (this.now() >= deadline) {
          throw new WalletAccessError(
            "privy_session_lock_unavailable",
            "Another process owns the Privy session refresh lock. Try the command again."
          );
        }
        await this.sleep(this.lockRetryMs);
      }
    }

    try {
      return await operation();
    } finally {
      let cleanupFailure: WalletAccessError | null = null;
      try {
        const owned = fstatSync(fd);
        const current = lstatSync(this.lockPath);
        if (owned.dev !== current.dev || owned.ino !== current.ino) {
          throw lockAmbiguous();
        }
        unlinkSync(this.lockPath);
      } catch (error) {
        cleanupFailure =
          error instanceof WalletAccessError ? error : lockAmbiguous();
      }
      try {
        closeSync(fd);
      } catch {
        cleanupFailure = lockAmbiguous();
      }
      if (cleanupFailure !== null) throw cleanupFailure;
    }
  }

  private writeState(
    state: Exclude<PrivyWalletAccessStoredState, { kind: "absent" }>
  ): void {
    const directory = path.dirname(this.filePath);
    let temporary: string | null = null;
    let fd: number | null = null;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const serialized = `${JSON.stringify(state.record, null, 2)}\n`;
      const parsed = parseRecord(serialized);
      if (parsed.kind !== state.kind) throw invalidState();
      if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
        throw invalidState();
      }
      temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, serialized, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
      syncDirectory(directory);
      if (readFileSync(this.filePath, "utf8") !== serialized) throw invalidState();
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
      }
      if (temporary !== null) {
        try {
          unlinkSync(temporary);
        } catch {}
      }
      if (error instanceof WalletAccessError) throw error;
      throw persistenceAmbiguous(
        "Could not prove persistence of the local Privy session record. Inspect Wallet Access state before retrying."
      );
    }
  }
}
