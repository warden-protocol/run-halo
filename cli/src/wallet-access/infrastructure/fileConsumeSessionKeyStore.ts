import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Wallet, getAddress } from "ethers";
import { configDir } from "../../config";
import { WalletAccessError } from "../domain/walletAccess";

const MAX_RECORD_BYTES = 4 * 1024;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;
const BASE_CHAIN_ID = "8453";

export interface ConsumeSessionKeyScope {
  chainId: 8453;
  vaultAddress: string;
  consumerAddress: string;
  derivationVersion: 1;
}

export interface ConsumeSessionKeyRecordV1 {
  version: 1;
  chainId: "8453";
  vaultAddress: string;
  consumerAddress: string;
  derivationVersion: 1;
  privateKey: string;
  sessionAddress: string;
}

export interface ConsumeSessionKeyStore {
  read(): ConsumeSessionKeyRecordV1 | null;
  write(record: ConsumeSessionKeyRecordV1): void;
  withScopeLock<Result>(operation: () => Promise<Result>): Promise<Result>;
}

interface NormalizedConsumeSessionKeyScope {
  chainId: "8453";
  vaultAddress: string;
  consumerAddress: string;
  derivationVersion: 1;
}

interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function stateAmbiguous(): WalletAccessError {
  return new WalletAccessError(
    "privy_consume_key_state_ambiguous",
    "The scoped Privy consume-key state is invalid or cannot be proven durable. Inspect local consumer state before retrying."
  );
}

function lockAmbiguous(): WalletAccessError {
  return new WalletAccessError(
    "privy_consume_key_lock_ambiguous",
    "The scoped Privy consume-key lock is ambiguous. Inspect local consumer state before retrying."
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") throw stateAmbiguous();
  try {
    const normalized = getAddress(value).toLowerCase();
    if (normalized === "0x0000000000000000000000000000000000000000") {
      throw stateAmbiguous();
    }
    return normalized;
  } catch (error) {
    if (error instanceof WalletAccessError) throw error;
    throw stateAmbiguous();
  }
}

function normalizeConsumeSessionKeyScope(
  scope: ConsumeSessionKeyScope
): NormalizedConsumeSessionKeyScope {
  if (scope.chainId !== 8453 || scope.derivationVersion !== 1) throw stateAmbiguous();
  return {
    chainId: BASE_CHAIN_ID,
    vaultAddress: normalizeAddress(scope.vaultAddress),
    consumerAddress: normalizeAddress(scope.consumerAddress),
    derivationVersion: 1,
  };
}

export function parseConsumeSessionKeyRecord(
  raw: string,
  scope: ConsumeSessionKeyScope
): ConsumeSessionKeyRecordV1 {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw stateAmbiguous();
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw stateAmbiguous();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw stateAmbiguous();
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, [
      "chainId",
      "consumerAddress",
      "derivationVersion",
      "privateKey",
      "sessionAddress",
      "vaultAddress",
      "version",
    ]) ||
    record.version !== 1 ||
    record.chainId !== BASE_CHAIN_ID ||
    record.derivationVersion !== 1 ||
    typeof record.privateKey !== "string" ||
    !PRIVATE_KEY.test(record.privateKey) ||
    /^0x0{64}$/.test(record.privateKey)
  ) {
    throw stateAmbiguous();
  }

  const expected = normalizeConsumeSessionKeyScope(scope);
  const vaultAddress = normalizeAddress(record.vaultAddress);
  const consumerAddress = normalizeAddress(record.consumerAddress);
  const sessionAddress = normalizeAddress(record.sessionAddress);
  let derivedAddress: string;
  try {
    derivedAddress = new Wallet(record.privateKey).address.toLowerCase();
  } catch {
    throw stateAmbiguous();
  }
  if (
    vaultAddress !== expected.vaultAddress ||
    consumerAddress !== expected.consumerAddress ||
    sessionAddress !== derivedAddress
  ) {
    throw stateAmbiguous();
  }
  return {
    version: 1,
    chainId: BASE_CHAIN_ID,
    vaultAddress,
    consumerAddress,
    derivationVersion: 1,
    privateKey: record.privateKey,
    sessionAddress,
  };
}

export function consumeSessionKeyPath(
  scope: ConsumeSessionKeyScope,
  root = configDir()
): string {
  const normalized = normalizeConsumeSessionKeyScope(scope);
  return path.join(
    root,
    "consumer-state",
    "v1",
    BASE_CHAIN_ID,
    normalized.vaultAddress,
    normalized.consumerAddress,
    "privy-session-key.json"
  );
}

export class FileConsumeSessionKeyStore implements ConsumeSessionKeyStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly scope: ConsumeSessionKeyScope,
    root = configDir(),
    options: LockOptions = {}
  ) {
    this.filePath = consumeSessionKeyPath(scope, path.resolve(root));
    this.lockPath = `${this.filePath}.lock`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.retryMs = options.retryMs ?? 25;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 0 ||
      !Number.isSafeInteger(this.retryMs) ||
      this.retryMs <= 0
    ) {
      throw lockAmbiguous();
    }
  }

  read(): ConsumeSessionKeyRecordV1 | null {
    try {
      const stat = lstatSync(this.filePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_RECORD_BYTES ||
        (stat.mode & 0o077) !== 0
      ) {
        throw stateAmbiguous();
      }
      return parseConsumeSessionKeyRecord(readFileSync(this.filePath, "utf8"), this.scope);
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw stateAmbiguous();
    }
  }

  write(record: ConsumeSessionKeyRecordV1): void {
    const validated = parseConsumeSessionKeyRecord(JSON.stringify(record), this.scope);
    const existing = this.read();
    if (existing !== null) {
      if (JSON.stringify(existing) === JSON.stringify(validated)) return;
      throw stateAmbiguous();
    }
    const directory = path.dirname(this.filePath);
    let temporary: string | null = null;
    let descriptor: number | null = null;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const canonicalDirectory = realpathSync(directory);
      if (path.join(canonicalDirectory, path.basename(this.filePath)) !== this.filePath) {
        throw stateAmbiguous();
      }
      const serialized = `${JSON.stringify(validated, null, 2)}\n`;
      temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.filePath);
      temporary = null;
      chmodSync(this.filePath, 0o600);
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      const persisted = this.read();
      if (persisted === null || JSON.stringify(persisted) !== JSON.stringify(validated)) {
        throw stateAmbiguous();
      }
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {}
      }
      if (temporary !== null) {
        try {
          unlinkSync(temporary);
        } catch {}
      }
      if (error instanceof WalletAccessError) throw error;
      throw stateAmbiguous();
    }
  }

  async withScopeLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const directory = path.dirname(this.filePath);
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw lockAmbiguous();
    }
    const deadline = this.now() + this.timeoutMs;
    let descriptor: number;
    while (true) {
      let candidate: number | null = null;
      try {
        candidate = openSync(
          this.lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600
        );
        writeFileSync(candidate, `${process.pid}\n`, "utf8");
        fsyncSync(candidate);
        descriptor = candidate;
        candidate = null;
        break;
      } catch (error) {
        if (candidate !== null) closeSync(candidate);
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw lockAmbiguous();
        try {
          const lock = lstatSync(this.lockPath);
          if (!lock.isFile() || lock.isSymbolicLink() || (lock.mode & 0o077) !== 0) {
            throw lockAmbiguous();
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError instanceof WalletAccessError ? lockError : lockAmbiguous();
        }
        if (this.now() >= deadline) {
          throw new WalletAccessError(
            "privy_consume_key_lock_unavailable",
            "Another process owns this Privy consume-key scope. Try the command again."
          );
        }
        await this.sleep(this.retryMs);
      }
    }

    let result: Result;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }
    try {
      const owned = fstatSync(descriptor);
      const current = lstatSync(this.lockPath);
      if (owned.dev !== current.dev || owned.ino !== current.ino) throw lockAmbiguous();
      unlinkSync(this.lockPath);
      closeSync(descriptor);
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch {}
      throw error instanceof WalletAccessError ? error : lockAmbiguous();
    }
    if (operationError !== undefined) throw operationError;
    return result!;
  }
}
