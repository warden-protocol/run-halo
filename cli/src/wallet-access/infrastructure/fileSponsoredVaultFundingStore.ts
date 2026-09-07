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
  parseSponsoredVaultDepositBundle,
  parseSponsoredVaultFundingAction,
  type DirectVaultFundingActionV1,
  type SponsoredVaultDepositBundleV1,
} from "halo-sdk";
import { configDir } from "../../config";
import { WalletAccessError } from "../domain/walletAccess";
import {
  consumeSessionKeyPath,
  type ConsumeSessionKeyScope,
} from "./fileConsumeSessionKeyStore";

const MAX_RECORD_BYTES = 128 * 1024;
const HASH = /^0x[0-9a-f]{64}$/;
const RESPONSE_PHASES = new Set([
  "validation",
  "approval-funding",
  "approval",
  "deposit-funding",
  "deposit",
  "complete",
]);

export type SponsoredVaultFundingState =
  | "ready"
  | "sending"
  | "pending"
  | "ambiguous"
  | "reverted";
export type SponsoredVaultFundingDisposition =
  | "ready"
  | "retryable"
  | "pending"
  | "ambiguous"
  | "terminal";

export interface SponsoredVaultFundingEvidenceV1 {
  approvalBlock: string | null;
  approvalStatus: "success" | "reverted" | null;
  depositBlock: string | null;
  depositStatus: "success" | "reverted" | null;
}

export interface SponsoredVaultFundingResponseV1 {
  status: "confirmed" | "pending" | "rejected" | "reverted";
  phase: string;
  operationId: string | null;
  errorCode: string | null;
  retryable: boolean;
}

export interface SponsoredVaultFundingRecordV1 {
  version: 1;
  catalogGeneration: number;
  sessionGeneration: string;
  sendGeneration: number;
  provenUnsentThroughGeneration: number;
  state: SponsoredVaultFundingState;
  disposition: SponsoredVaultFundingDisposition;
  activeRequest: "initial" | "deposit-only";
  createdAt: string;
  updatedAt: string;
  action: DirectVaultFundingActionV1;
  bundle: SponsoredVaultDepositBundleV1;
  evidence: SponsoredVaultFundingEvidenceV1;
  lastResponse: SponsoredVaultFundingResponseV1 | null;
}

export interface SponsoredVaultFundingStore {
  read(): SponsoredVaultFundingRecordV1 | null;
  write(record: SponsoredVaultFundingRecordV1): void;
  clear(): void;
}

function stateAmbiguous(): WalletAccessError {
  return new WalletAccessError(
    "privy_sponsored_funding_state_ambiguous",
    "The durable sponsored-deposit state is invalid or cannot be proven durable. Inspect the scoped consumer state before retrying."
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw stateAmbiguous();
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown): string {
  if (typeof value !== "string") throw stateAmbiguous();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw stateAmbiguous();
  }
  return value;
}

function nullableBlock(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw stateAmbiguous();
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw stateAmbiguous();
  return value;
}

export function parseSponsoredVaultFundingRecord(
  raw: string,
  scope: ConsumeSessionKeyScope
): SponsoredVaultFundingRecordV1 {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw stateAmbiguous();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw stateAmbiguous();
  }
  const value = object(parsed);
  if (!exactKeys(value, [
    "action",
    "activeRequest",
    "bundle",
    "catalogGeneration",
    "createdAt",
    "disposition",
    "evidence",
    "lastResponse",
    "provenUnsentThroughGeneration",
    "sendGeneration",
    "sessionGeneration",
    "state",
    "updatedAt",
    "version",
  ])) throw stateAmbiguous();
  const states = new Set<SponsoredVaultFundingState>([
    "ready", "sending", "pending", "ambiguous", "reverted",
  ]);
  const dispositions = new Set<SponsoredVaultFundingDisposition>([
    "ready", "retryable", "pending", "ambiguous", "terminal",
  ]);
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.catalogGeneration) || Number(value.catalogGeneration) < 0 ||
    !Number.isSafeInteger(value.sendGeneration) || Number(value.sendGeneration) < 0 ||
    !Number.isSafeInteger(value.provenUnsentThroughGeneration) ||
    Number(value.provenUnsentThroughGeneration) < 0 ||
    Number(value.provenUnsentThroughGeneration) > Number(value.sendGeneration) ||
    !states.has(value.state as SponsoredVaultFundingState) ||
    !dispositions.has(value.disposition as SponsoredVaultFundingDisposition) ||
    (value.activeRequest !== "initial" && value.activeRequest !== "deposit-only")
  ) throw stateAmbiguous();
  if (
    value.state === "ready" &&
    Number(value.provenUnsentThroughGeneration) !== Number(value.sendGeneration)
  ) throw stateAmbiguous();
  const createdAt = iso(value.createdAt);
  const updatedAt = iso(value.updatedAt);
  const sessionGeneration = iso(value.sessionGeneration);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw stateAmbiguous();
  let action: DirectVaultFundingActionV1;
  let bundle: SponsoredVaultDepositBundleV1;
  try {
    action = parseSponsoredVaultFundingAction(value.action);
    bundle = parseSponsoredVaultDepositBundle(value.bundle, action);
  } catch {
    throw stateAmbiguous();
  }
  if (
    action.chainId !== String(scope.chainId) ||
    action.vaultAddress !== getAddress(scope.vaultAddress) ||
    action.consumerAddress !== getAddress(scope.consumerAddress)
  ) throw stateAmbiguous();
  const evidenceValue = object(value.evidence);
  if (!exactKeys(evidenceValue, [
    "approvalBlock", "approvalStatus", "depositBlock", "depositStatus",
  ])) throw stateAmbiguous();
  const approvalStatus = evidenceValue.approvalStatus;
  const depositStatus = evidenceValue.depositStatus;
  if (
    approvalStatus !== null && approvalStatus !== "success" && approvalStatus !== "reverted"
  ) throw stateAmbiguous();
  if (
    depositStatus !== null && depositStatus !== "success" && depositStatus !== "reverted"
  ) throw stateAmbiguous();
  const evidence: SponsoredVaultFundingEvidenceV1 = {
    approvalBlock: nullableBlock(evidenceValue.approvalBlock),
    approvalStatus,
    depositBlock: nullableBlock(evidenceValue.depositBlock),
    depositStatus,
  };
  if (
    (evidence.approvalStatus === null) !== (evidence.approvalBlock === null) ||
    (evidence.depositStatus === null) !== (evidence.depositBlock === null) ||
    (bundle.approvalHash === null && evidence.approvalStatus !== null)
  ) throw stateAmbiguous();
  let lastResponse: SponsoredVaultFundingResponseV1 | null = null;
  if (value.lastResponse !== null) {
    const response = object(value.lastResponse);
    if (!exactKeys(response, ["errorCode", "operationId", "phase", "retryable", "status"])) {
      throw stateAmbiguous();
    }
    if (
      !["confirmed", "pending", "rejected", "reverted"].includes(String(response.status)) ||
      !RESPONSE_PHASES.has(String(response.phase)) ||
      (response.operationId !== null &&
        (typeof response.operationId !== "string" || !HASH.test(response.operationId))) ||
      (response.errorCode !== null &&
        (typeof response.errorCode !== "string" || response.errorCode.length > 128)) ||
      typeof response.retryable !== "boolean"
    ) throw stateAmbiguous();
    lastResponse = response as unknown as SponsoredVaultFundingResponseV1;
  }
  return {
    version: 1,
    catalogGeneration: Number(value.catalogGeneration),
    sessionGeneration,
    sendGeneration: Number(value.sendGeneration),
    provenUnsentThroughGeneration: Number(value.provenUnsentThroughGeneration),
    state: value.state as SponsoredVaultFundingState,
    disposition: value.disposition as SponsoredVaultFundingDisposition,
    activeRequest: value.activeRequest,
    createdAt,
    updatedAt,
    action,
    bundle,
    evidence,
    lastResponse,
  };
}

export function sponsoredVaultFundingPath(
  scope: ConsumeSessionKeyScope,
  root = configDir()
): string {
  return path.join(path.dirname(consumeSessionKeyPath(scope, root)), "sponsored-deposit.json");
}

export class FileSponsoredVaultFundingStore implements SponsoredVaultFundingStore {
  private readonly filePath: string;

  constructor(private readonly scope: ConsumeSessionKeyScope, root = configDir()) {
    this.filePath = sponsoredVaultFundingPath(scope, path.resolve(root));
  }

  read(): SponsoredVaultFundingRecordV1 | null {
    try {
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES ||
        (stat.mode & 0o077) !== 0) throw stateAmbiguous();
      return parseSponsoredVaultFundingRecord(readFileSync(this.filePath, "utf8"), this.scope);
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw stateAmbiguous();
    }
  }

  write(record: SponsoredVaultFundingRecordV1): void {
    let next: SponsoredVaultFundingRecordV1;
    try {
      next = parseSponsoredVaultFundingRecord(JSON.stringify(record), this.scope);
    } catch {
      throw stateAmbiguous();
    }
    const current = this.read();
    if (current !== null) this.assertTransition(current, next);
    else if (next.state !== "ready" || next.sendGeneration !== 0) throw stateAmbiguous();
    const directory = path.dirname(this.filePath);
    let descriptor: number | undefined;
    let temporary: string | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (path.join(realpathSync(directory), path.basename(this.filePath)) !== this.filePath) {
        throw stateAmbiguous();
      }
      temporary = `${this.filePath}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.filePath);
      temporary = undefined;
      chmodSync(this.filePath, 0o600);
      this.syncDirectory(directory);
      if (JSON.stringify(this.read()) !== JSON.stringify(next)) throw stateAmbiguous();
    } catch (error) {
      if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
      if (temporary !== undefined) try { unlinkSync(temporary); } catch {}
      if (error instanceof WalletAccessError) throw error;
      throw stateAmbiguous();
    }
  }

  clear(): void {
    const directory = path.dirname(this.filePath);
    try {
      if (this.read() === null) return;
      unlinkSync(this.filePath);
      this.syncDirectory(directory);
      if (this.read() !== null) throw stateAmbiguous();
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      throw stateAmbiguous();
    }
  }

  private assertTransition(
    current: SponsoredVaultFundingRecordV1,
    next: SponsoredVaultFundingRecordV1
  ): void {
    const immutable = (value: SponsoredVaultFundingRecordV1) => ({
      version: value.version,
      catalogGeneration: value.catalogGeneration,
      sessionGeneration: value.sessionGeneration,
      createdAt: value.createdAt,
      action: value.action,
      bundle: value.bundle,
    });
    const sameEvidenceOrAdded = (
      previous: SponsoredVaultFundingEvidenceV1,
      candidate: SponsoredVaultFundingEvidenceV1
    ): boolean => (
      (previous.approvalStatus === null ||
        (previous.approvalStatus === candidate.approvalStatus &&
          previous.approvalBlock === candidate.approvalBlock)) &&
      (previous.depositStatus === null ||
        (previous.depositStatus === candidate.depositStatus &&
          previous.depositBlock === candidate.depositBlock))
    );
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    if (JSON.stringify(immutable(current)) !== JSON.stringify(immutable(next)) ||
      next.sendGeneration < current.sendGeneration ||
      next.provenUnsentThroughGeneration < current.provenUnsentThroughGeneration ||
      Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
      !sameEvidenceOrAdded(current.evidence, next.evidence)) {
      throw stateAmbiguous();
    }
    const startingSend = (current.state === "ready" || current.state === "sending") &&
      current.disposition !== "terminal" &&
      next.activeRequest === current.activeRequest &&
      next.sendGeneration === current.sendGeneration + 1 &&
      next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration &&
      next.state === "sending" && next.disposition === "ambiguous" &&
      next.lastResponse === null &&
      JSON.stringify(next.evidence) === JSON.stringify(current.evidence);
    const recordingOutcome = current.state === "sending" &&
      next.sendGeneration === current.sendGeneration &&
      next.activeRequest === current.activeRequest &&
      ((next.state === "pending" && next.disposition === "pending" &&
          next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration) ||
        (next.state === "ambiguous" && next.disposition === "ambiguous" &&
          next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration) ||
        (next.state === "reverted" && next.disposition === "terminal" &&
          next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration) ||
        (next.state === "ready" &&
          next.provenUnsentThroughGeneration === next.sendGeneration &&
          (next.disposition === "retryable" || next.disposition === "terminal") &&
          next.lastResponse?.status === "rejected"));
    const recordingEvidence = next.sendGeneration === current.sendGeneration &&
      next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration &&
      next.activeRequest === current.activeRequest &&
      next.state === current.state && next.disposition === current.disposition &&
      JSON.stringify(next.lastResponse) === JSON.stringify(current.lastResponse);
    const advancingToDeposit = current.state === "ready" &&
      next.state === "ready" &&
      current.provenUnsentThroughGeneration === current.sendGeneration &&
      next.sendGeneration === current.sendGeneration &&
      next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration &&
      current.activeRequest === "initial" &&
      next.activeRequest === "deposit-only" &&
      current.bundle.approvalHash !== null &&
      next.evidence.approvalStatus === "success" &&
      next.lastResponse?.status === "rejected";
    const terminalizingWithEvidence = current.state === "ambiguous" &&
      next.state === "reverted" && next.disposition === "terminal" &&
      next.sendGeneration === current.sendGeneration &&
      next.provenUnsentThroughGeneration === current.provenUnsentThroughGeneration &&
      next.activeRequest === current.activeRequest &&
      JSON.stringify(next.lastResponse) === JSON.stringify(current.lastResponse);
    if (!startingSend && !recordingOutcome && !recordingEvidence &&
      !advancingToDeposit && !terminalizingWithEvidence) {
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
