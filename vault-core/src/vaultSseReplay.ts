import {
  concat,
  decodeBase64,
  getAddress,
  getBytes,
  isAddress,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

export const VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL =
  "vault-sse-replay-ephemeral-v1" as const;
export const VAULT_SSE_REPLAY_MAX_RESULT_TTL_MS = 300_000;

export function isVaultSseReplayResultExpiry(
  value: unknown,
  receivedAtMs: number
): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(receivedAtMs) &&
    (value as number) > receivedAtMs &&
    (value as number) <= receivedAtMs + VAULT_SSE_REPLAY_MAX_RESULT_TTL_MS
  );
}

export const VAULT_SSE_REPLAY_COMMAND_TYPES: Record<string, TypedDataField[]> = {
  VaultSseReplayCommand: [
    { name: "protocol", type: "string" },
    { name: "command", type: "string" },
    { name: "requestId", type: "string" },
    { name: "tokenHash", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "cycle", type: "uint64" },
    { name: "keyEpoch", type: "uint256" },
    { name: "expiresAtMs", type: "uint64" },
  ],
};

export const VAULT_SSE_REPLAY_MANIFEST_TYPES: Record<string, TypedDataField[]> = {
  VaultSseReplayManifest: [
    { name: "protocol", type: "string" },
    { name: "requestId", type: "string" },
    { name: "requestDigest", type: "bytes32" },
    { name: "responseDigest", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "cycle", type: "uint64" },
    { name: "keyEpoch", type: "uint256" },
    { name: "amountUsdc", type: "uint256" },
    { name: "frameCount", type: "uint32" },
    { name: "outcome", type: "string" },
  ],
};

export const VAULT_SSE_REPLAY_RECEIPT_TYPES: Record<string, TypedDataField[]> = {
  VaultSseReplayReceiptDelivery: [
    { name: "protocol", type: "string" },
    { name: "requestId", type: "string" },
    { name: "responseDigest", type: "bytes32" },
    { name: "vault", type: "address" },
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "cycle", type: "uint64" },
    { name: "keyEpoch", type: "uint256" },
    { name: "priorCumulative", type: "uint256" },
    { name: "targetCumulative", type: "uint256" },
    { name: "receiptSignatureHash", type: "bytes32" },
    { name: "expiresAtMs", type: "uint64" },
  ],
};

export type VaultSseReplayCommandName = "attach" | "resume" | "cancel";
export type VaultSseReplayOutcome = "success" | "failed-unserved";

export interface VaultSseReplayPair {
  chainId: string;
  vault: string;
  consumer: string;
  operator: string;
  cycle: string;
  keyEpoch: string;
}

export interface VaultSseReplayPrepareRequest {
  protocol: typeof VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL;
  path: "/v1/chat/completions";
  requestBody: string;
  pair: VaultSseReplayPair;
}

export interface VaultSseReplayPrepareResponse {
  protocol: typeof VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL;
  requestId: string;
  resumeToken: string;
  prepareExpiresAtMs: number;
}

export interface VaultSseReplayCommand {
  protocol: typeof VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL;
  command: VaultSseReplayCommandName;
  requestId: string;
  resumeToken: string;
  pair: VaultSseReplayPair;
  expiresAtMs: number;
  signature: string;
}

export interface VaultSseReplayUnsignedManifest {
  protocol: typeof VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL;
  requestId: string;
  requestDigest: string;
  responseDigest: string;
  vault: string;
  consumer: string;
  operator: string;
  cycle: string;
  keyEpoch: string;
  amountUsdc: string;
  frameCount: number;
  outcome: VaultSseReplayOutcome;
}

export interface VaultSseReplayManifest extends VaultSseReplayUnsignedManifest {
  signature: string;
}

export interface VaultSseReplayReceiptDelivery {
  protocol: typeof VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL;
  requestId: string;
  responseDigest: string;
  pair: VaultSseReplayPair;
  priorCumulative: string;
  targetCumulative: string;
  receiptSignature: string;
  expiresAtMs: number;
  signature: string;
}

export const EMPTY_VAULT_SSE_REPLAY_DIGEST = keccak256(new Uint8Array());

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isCanonicalVaultSseReplayRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function isVaultSseReplayToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN.test(value)) return false;
  try {
    return decodeBase64(
      value.replace(/-/g, "+").replace(/_/g, "/") + "="
    ).length === 32;
  } catch {
    return false;
  }
}

export function hashVaultSseReplayToken(token: string): string {
  if (!isVaultSseReplayToken(token)) {
    throw new Error("invalid vault SSE replay token");
  }
  const bytes = decodeBase64(
    token.replace(/-/g, "+").replace(/_/g, "/") + "="
  );
  return keccak256(bytes);
}

export function canonicalVaultSseReplayUint(
  value: unknown,
  bits: 64 | 256,
  allowZero = true
): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  if (!allowZero && value === "0") return null;
  const parsed = BigInt(value);
  const maximum = bits === 64 ? UINT64_MAX : UINT256_MAX;
  return parsed <= maximum ? value : null;
}

export function canonicalVaultSseReplayAddress(value: unknown): string | null {
  if (typeof value !== "string" || !isAddress(value)) return null;
  return getAddress(value).toLowerCase();
}

export function canonicalVaultSseReplayPair(
  value: unknown
): VaultSseReplayPair | null {
  if (!isRecord(value)) return null;
  if (
    !exactKeys(value, [
      "chainId",
      "vault",
      "consumer",
      "operator",
      "cycle",
      "keyEpoch",
    ])
  ) {
    return null;
  }
  const chainId = canonicalVaultSseReplayUint(value.chainId, 64, false);
  const vault = canonicalVaultSseReplayAddress(value.vault);
  const consumer = canonicalVaultSseReplayAddress(value.consumer);
  const operator = canonicalVaultSseReplayAddress(value.operator);
  const cycle = canonicalVaultSseReplayUint(value.cycle, 64, false);
  const keyEpoch = canonicalVaultSseReplayUint(value.keyEpoch, 256);
  if (!chainId || !vault || !consumer || !operator || !cycle || !keyEpoch) {
    return null;
  }
  return { chainId, vault, consumer, operator, cycle, keyEpoch };
}

export function vaultSseReplayPairKey(pair: VaultSseReplayPair): string {
  const canonical = canonicalVaultSseReplayPair(pair);
  if (!canonical) throw new Error("invalid vault SSE replay pair");
  return [
    canonical.chainId,
    canonical.vault,
    canonical.consumer,
    canonical.operator,
    canonical.cycle,
    canonical.keyEpoch,
  ].join(":");
}

export function digestVaultSseReplayRequest(requestBody: string): string {
  if (typeof requestBody !== "string") {
    throw new Error("vault SSE replay request body must be a string");
  }
  return keccak256(toUtf8Bytes(requestBody));
}

export function advanceVaultSseReplayDigest(
  previousDigest: string,
  frameData: string
): string {
  if (!BYTES32.test(previousDigest)) {
    throw new Error("invalid vault SSE replay digest");
  }
  if (typeof frameData !== "string") {
    throw new Error("vault SSE replay frame data must be a string");
  }
  return keccak256(concat([getBytes(previousDigest), toUtf8Bytes(frameData)]));
}

export function vaultSseReplayDomain(
  chainId: string | number | bigint,
  vault: string
): TypedDataDomain {
  const chain = canonicalVaultSseReplayUint(String(chainId), 64, false);
  const verifyingContract = canonicalVaultSseReplayAddress(vault);
  if (!chain || !verifyingContract) {
    throw new Error("invalid vault SSE replay domain");
  }
  return {
    name: "Halo Vault SSE Replay",
    version: "1",
    chainId: BigInt(chain),
    verifyingContract,
  };
}

export function vaultSseReplayCommandValue(
  command: Omit<VaultSseReplayCommand, "signature">
): Record<string, unknown> {
  const pair = canonicalVaultSseReplayPair(command.pair);
  if (
    command.protocol !== VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL ||
    !["attach", "resume", "cancel"].includes(command.command) ||
    !isCanonicalVaultSseReplayRequestId(command.requestId) ||
    !isVaultSseReplayToken(command.resumeToken) ||
    !pair ||
    !Number.isSafeInteger(command.expiresAtMs) ||
    command.expiresAtMs <= 0
  ) {
    throw new Error("invalid vault SSE replay command");
  }
  return {
    protocol: command.protocol,
    command: command.command,
    requestId: command.requestId,
    tokenHash: hashVaultSseReplayToken(command.resumeToken),
    vault: pair.vault,
    consumer: pair.consumer,
    operator: pair.operator,
    cycle: BigInt(pair.cycle),
    keyEpoch: BigInt(pair.keyEpoch),
    expiresAtMs: BigInt(command.expiresAtMs),
  };
}

export function recoverVaultSseReplayCommandSigner(
  command: VaultSseReplayCommand
): string | null {
  if (!SIGNATURE.test(command.signature)) return null;
  const pair = canonicalVaultSseReplayPair(command.pair);
  if (!pair) return null;
  try {
    return verifyTypedData(
      vaultSseReplayDomain(pair.chainId, pair.vault),
      VAULT_SSE_REPLAY_COMMAND_TYPES,
      vaultSseReplayCommandValue(command),
      command.signature
    ).toLowerCase();
  } catch {
    return null;
  }
}

function canonicalManifest(
  manifest: VaultSseReplayUnsignedManifest
): VaultSseReplayUnsignedManifest | null {
  const vault = canonicalVaultSseReplayAddress(manifest.vault);
  const consumer = canonicalVaultSseReplayAddress(manifest.consumer);
  const operator = canonicalVaultSseReplayAddress(manifest.operator);
  const cycle = canonicalVaultSseReplayUint(manifest.cycle, 64, false);
  const keyEpoch = canonicalVaultSseReplayUint(manifest.keyEpoch, 256);
  const amountUsdc = canonicalVaultSseReplayUint(
    manifest.amountUsdc,
    256,
    manifest.outcome !== "success"
  );
  if (
    manifest.protocol !== VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL ||
    !isCanonicalVaultSseReplayRequestId(manifest.requestId) ||
    !BYTES32.test(manifest.requestDigest) ||
    !BYTES32.test(manifest.responseDigest) ||
    !vault ||
    !consumer ||
    !operator ||
    !cycle ||
    !keyEpoch ||
    !amountUsdc ||
    !Number.isSafeInteger(manifest.frameCount) ||
    manifest.frameCount < 0 ||
    manifest.frameCount > 65_536 ||
    !["success", "failed-unserved"].includes(manifest.outcome) ||
    (manifest.outcome === "success" &&
      (manifest.frameCount === 0 || manifest.amountUsdc === "0")) ||
    (manifest.outcome === "failed-unserved" && manifest.amountUsdc !== "0")
  ) {
    return null;
  }
  return {
    ...manifest,
    vault,
    consumer,
    operator,
    cycle,
    keyEpoch,
    amountUsdc,
  };
}

export function vaultSseReplayManifestValue(
  manifest: VaultSseReplayUnsignedManifest
): Record<string, unknown> {
  const canonical = canonicalManifest(manifest);
  if (!canonical) throw new Error("invalid vault SSE replay manifest");
  return {
    protocol: canonical.protocol,
    requestId: canonical.requestId,
    requestDigest: canonical.requestDigest,
    responseDigest: canonical.responseDigest,
    vault: canonical.vault,
    consumer: canonical.consumer,
    operator: canonical.operator,
    cycle: BigInt(canonical.cycle),
    keyEpoch: BigInt(canonical.keyEpoch),
    amountUsdc: BigInt(canonical.amountUsdc),
    frameCount: canonical.frameCount,
    outcome: canonical.outcome,
  };
}

export function recoverVaultSseReplayManifestSigner(
  manifest: VaultSseReplayManifest,
  chainId: string | number | bigint
): string | null {
  if (!SIGNATURE.test(manifest.signature)) return null;
  try {
    return verifyTypedData(
      vaultSseReplayDomain(chainId, manifest.vault),
      VAULT_SSE_REPLAY_MANIFEST_TYPES,
      vaultSseReplayManifestValue(manifest),
      manifest.signature
    ).toLowerCase();
  } catch {
    return null;
  }
}

export function vaultSseReplayReceiptValue(
  delivery: Omit<VaultSseReplayReceiptDelivery, "signature">
): Record<string, unknown> {
  const pair = canonicalVaultSseReplayPair(delivery.pair);
  const prior = canonicalVaultSseReplayUint(delivery.priorCumulative, 256);
  const target = canonicalVaultSseReplayUint(
    delivery.targetCumulative,
    256,
    false
  );
  if (
    delivery.protocol !== VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL ||
    !isCanonicalVaultSseReplayRequestId(delivery.requestId) ||
    !BYTES32.test(delivery.responseDigest) ||
    !pair ||
    !prior ||
    !target ||
    BigInt(target) <= BigInt(prior) ||
    !SIGNATURE.test(delivery.receiptSignature) ||
    !Number.isSafeInteger(delivery.expiresAtMs) ||
    delivery.expiresAtMs <= 0
  ) {
    throw new Error("invalid vault SSE replay receipt delivery");
  }
  return {
    protocol: delivery.protocol,
    requestId: delivery.requestId,
    responseDigest: delivery.responseDigest,
    vault: pair.vault,
    consumer: pair.consumer,
    operator: pair.operator,
    cycle: BigInt(pair.cycle),
    keyEpoch: BigInt(pair.keyEpoch),
    priorCumulative: BigInt(prior),
    targetCumulative: BigInt(target),
    receiptSignatureHash: keccak256(getBytes(delivery.receiptSignature)),
    expiresAtMs: BigInt(delivery.expiresAtMs),
  };
}

export function recoverVaultSseReplayReceiptSigner(
  delivery: VaultSseReplayReceiptDelivery
): string | null {
  if (!SIGNATURE.test(delivery.signature)) return null;
  const pair = canonicalVaultSseReplayPair(delivery.pair);
  if (!pair) return null;
  try {
    return verifyTypedData(
      vaultSseReplayDomain(pair.chainId, pair.vault),
      VAULT_SSE_REPLAY_RECEIPT_TYPES,
      vaultSseReplayReceiptValue(delivery),
      delivery.signature
    ).toLowerCase();
  } catch {
    return null;
  }
}

export function parseVaultSseReplayPrepareRequest(
  value: unknown
): VaultSseReplayPrepareRequest | null {
  if (!isRecord(value)) return null;
  if (!exactKeys(value, ["protocol", "path", "requestBody", "pair"])) {
    return null;
  }
  const pair = canonicalVaultSseReplayPair(value.pair);
  if (
    value.protocol !== VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL ||
    value.path !== "/v1/chat/completions" ||
    typeof value.requestBody !== "string" ||
    !pair
  ) {
    return null;
  }
  if (!vaultSseReplayRequestChargeCeiling(value.requestBody)) {
    return null;
  }
  return {
    protocol: value.protocol,
    path: value.path,
    requestBody: value.requestBody,
    pair,
  };
}

export function vaultSseReplayRequestChargeCeiling(
  requestBody: string
): string | null {
  try {
    const body = JSON.parse(requestBody);
    if (!isRecord(body) || body.stream !== true || !isRecord(body._enc)) {
      return null;
    }
    return canonicalVaultSseReplayUint(body.maxAmountUsdc, 256, false);
  } catch {
    return null;
  }
}

export function parseVaultSseReplayCommand(
  value: unknown
): VaultSseReplayCommand | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocol",
      "command",
      "requestId",
      "resumeToken",
      "pair",
      "expiresAtMs",
      "signature",
    ])
  ) return null;
  const pair = canonicalVaultSseReplayPair(value.pair);
  if (
    !pair ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)
  ) return null;
  const candidate = { ...value, pair } as unknown as VaultSseReplayCommand;
  try {
    vaultSseReplayCommandValue(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function parseVaultSseReplayPrepareResponse(
  value: unknown
): VaultSseReplayPrepareResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocol",
      "requestId",
      "resumeToken",
      "prepareExpiresAtMs",
    ]) ||
    value.protocol !== VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL ||
    !isCanonicalVaultSseReplayRequestId(value.requestId) ||
    !isVaultSseReplayToken(value.resumeToken) ||
    !Number.isSafeInteger(value.prepareExpiresAtMs) ||
    (value.prepareExpiresAtMs as number) <= 0
  ) return null;
  return value as unknown as VaultSseReplayPrepareResponse;
}

export function parseVaultSseReplayManifest(
  value: unknown
): VaultSseReplayManifest | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocol",
      "requestId",
      "requestDigest",
      "responseDigest",
      "vault",
      "consumer",
      "operator",
      "cycle",
      "keyEpoch",
      "amountUsdc",
      "frameCount",
      "outcome",
      "signature",
    ]) ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)
  ) return null;
  const canonical = canonicalManifest(
    value as unknown as VaultSseReplayUnsignedManifest
  );
  return canonical ? { ...canonical, signature: value.signature } : null;
}

export function parseVaultSseReplayReceiptDelivery(
  value: unknown
): VaultSseReplayReceiptDelivery | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocol",
      "requestId",
      "responseDigest",
      "pair",
      "priorCumulative",
      "targetCumulative",
      "receiptSignature",
      "expiresAtMs",
      "signature",
    ])
  ) return null;
  const pair = canonicalVaultSseReplayPair(value.pair);
  if (
    !pair ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)
  ) return null;
  const candidate = {
    ...value,
    pair,
  } as unknown as VaultSseReplayReceiptDelivery;
  try {
    vaultSseReplayReceiptValue(candidate);
    return candidate;
  } catch {
    return null;
  }
}
