import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
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
import { getAddress } from "ethers";
import {
  parseDirectVaultFundingAction,
  type DirectVaultFundingActionV1,
} from "halo-sdk";
import { configDir } from "../../config";
import { WalletAccessError } from "../domain/walletAccess";
import {
  consumeSessionKeyPath,
  type ConsumeSessionKeyScope,
} from "./fileConsumeSessionKeyStore";

const MAX_RECORD_BYTES = 64 * 1024;
const HASH = /^0x[0-9a-f]{64}$/;
const REFERENCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type DirectVaultFundingSendState = "sending" | "submitted" | "ambiguous";

export interface DirectVaultFundingRecordV1 {
  version: 1;
  catalogGeneration: number;
  sessionGeneration: string;
  referenceId: string;
  sendState: DirectVaultFundingSendState;
  transactionHash: string | null;
  providerTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
  action: DirectVaultFundingActionV1;
}

export interface DirectVaultFundingStore {
  read(): DirectVaultFundingRecordV1 | null;
  write(record: DirectVaultFundingRecordV1): void;
  clear(): void;
}

function stateAmbiguous(): WalletAccessError {
  return new WalletAccessError(
    "privy_direct_funding_state_ambiguous",
    "The durable Privy funding action is invalid or cannot be proven durable. Inspect the scoped consumer state before retrying."
  );
}

function iso(value: unknown): string {
  if (typeof value !== "string") throw stateAmbiguous();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw stateAmbiguous();
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function parseDirectVaultFundingRecord(
  raw: string,
  scope: ConsumeSessionKeyScope
): DirectVaultFundingRecordV1 {
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
      "action",
      "catalogGeneration",
      "createdAt",
      "providerTransactionId",
      "referenceId",
      "sendState",
      "sessionGeneration",
      "transactionHash",
      "updatedAt",
      "version",
    ]) ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.catalogGeneration) ||
    Number(record.catalogGeneration) < 0 ||
    typeof record.referenceId !== "string" ||
    !REFERENCE_ID.test(record.referenceId) ||
    (record.sendState !== "sending" &&
      record.sendState !== "submitted" &&
      record.sendState !== "ambiguous")
  ) {
    throw stateAmbiguous();
  }
  const createdAt = iso(record.createdAt);
  const updatedAt = iso(record.updatedAt);
  const sessionGeneration = iso(record.sessionGeneration);
  const transactionHash =
    record.transactionHash === null ||
    (typeof record.transactionHash === "string" && HASH.test(record.transactionHash))
      ? record.transactionHash
      : (() => {
          throw stateAmbiguous();
        })();
  const providerTransactionId =
    record.providerTransactionId === null ||
    (typeof record.providerTransactionId === "string" &&
      record.providerTransactionId.length > 0 &&
      record.providerTransactionId.length <= 256)
      ? record.providerTransactionId
      : (() => {
          throw stateAmbiguous();
        })();
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    (record.sendState === "submitted") !== (transactionHash !== null) ||
    (record.sendState !== "submitted" &&
      (transactionHash !== null || providerTransactionId !== null))
  ) {
    throw stateAmbiguous();
  }
  try {
    const action = parseDirectVaultFundingAction(record.action);
    if (
      action.chainId !== String(scope.chainId) ||
      action.vaultAddress !== getAddress(scope.vaultAddress) ||
      action.consumerAddress !== getAddress(scope.consumerAddress)
    ) {
      throw stateAmbiguous();
    }
    return {
      version: 1,
      catalogGeneration: Number(record.catalogGeneration),
      sessionGeneration,
      referenceId: record.referenceId,
      sendState: record.sendState,
      transactionHash,
      providerTransactionId,
      createdAt,
      updatedAt,
      action,
    };
  } catch (error) {
    if (error instanceof WalletAccessError) throw error;
    throw stateAmbiguous();
  }
}

export function directVaultFundingPath(
  scope: ConsumeSessionKeyScope,
  root = configDir()
): string {
  return path.join(path.dirname(consumeSessionKeyPath(scope, root)), "direct-vault-funding.json");
}

export class FileDirectVaultFundingStore implements DirectVaultFundingStore {
  private readonly filePath: string;

  constructor(private readonly scope: ConsumeSessionKeyScope, root = configDir()) {
    this.filePath = directVaultFundingPath(scope, path.resolve(root));
  }

  read(): DirectVaultFundingRecordV1 | null {
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
      return parseDirectVaultFundingRecord(
        readFileSync(this.filePath, "utf8"),
        this.scope
      );
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw stateAmbiguous();
    }
  }

  write(record: DirectVaultFundingRecordV1): void {
    const validated = parseDirectVaultFundingRecord(JSON.stringify(record), this.scope);
    const existing = this.read();
    if (existing === null) {
      if (validated.sendState !== "sending") throw stateAmbiguous();
    } else {
      const immutable = (value: DirectVaultFundingRecordV1) => ({
        version: value.version,
        catalogGeneration: value.catalogGeneration,
        sessionGeneration: value.sessionGeneration,
        referenceId: value.referenceId,
        createdAt: value.createdAt,
        action: value.action,
      });
      const sameRecord = JSON.stringify(existing) === JSON.stringify(validated);
      const validTransition =
        existing.sendState === "sending" &&
        (validated.sendState === "submitted" || validated.sendState === "ambiguous") &&
        JSON.stringify(immutable(existing)) === JSON.stringify(immutable(validated));
      if (!sameRecord && !validTransition) throw stateAmbiguous();
      if (sameRecord) return;
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
      temporary = `${this.filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, this.filePath);
      temporary = null;
      chmodSync(this.filePath, 0o600);
      this.syncDirectory(directory);
      if (JSON.stringify(this.read()) !== JSON.stringify(validated)) throw stateAmbiguous();
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch {}
      }
      if (temporary !== null) {
        try { unlinkSync(temporary); } catch {}
      }
      if (error instanceof WalletAccessError) throw error;
      throw stateAmbiguous();
    }
  }

  clear(): void {
    const directory = path.dirname(this.filePath);
    try {
      const current = this.read();
      if (current === null) return;
      unlinkSync(this.filePath);
      this.syncDirectory(directory);
      if (this.read() !== null) throw stateAmbiguous();
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      throw stateAmbiguous();
    }
  }

  private syncDirectory(directory: string): void {
    const descriptor = openSync(directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
