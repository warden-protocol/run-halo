import {
  Interface,
  JsonRpcProvider,
  MaxUint256,
  Transaction,
  ZeroHash,
  getAddress,
  getBytes,
  isAddress,
  solidityPackedKeccak256,
} from "ethers";
import { ERC20_ABI, VAULT_ABI } from "@halo/vault-core";
import { getChain } from "./chains";

export const DIRECT_FUNDING_APPROVAL_GAS_CAP = 150_000n;
export const DIRECT_FUNDING_DEPOSIT_GAS_CAP = 1_000_000n;
export const DIRECT_FUNDING_MAX_FEE_PER_GAS = 10_000_000_000n;
export const DIRECT_FUNDING_MAX_PRIORITY_FEE_PER_GAS = 5_000_000_000n;
export const DIRECT_FUNDING_MAX_TRANSACTION_BYTES = 2_048;
export const DIRECT_FUNDING_PREFLIGHT_TIMEOUT_MS = 15_000;

export type DirectVaultFundingFailureCode =
  | "insufficient_eth"
  | "insufficient_usdc"
  | "session_key_mismatch";

export class DirectVaultFundingError extends Error {
  readonly name = "DirectVaultFundingError";

  constructor(
    readonly code: DirectVaultFundingFailureCode,
    message: string
  ) {
    super(message);
  }
}

const BASE_CHAIN_ID = 8453;
const BASE_GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_RPC_BYTES = 64 * 1024;
const MAX_BLOCK_RESPONSE_BYTES = 512 * 1024;
const CANONICAL_UINT = /^(0|[1-9]\d{0,77})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const BUFFER_NUMERATOR = 130n;
const BUFFER_DENOMINATOR = 100n;

const vault = new Interface(VAULT_ABI);
const token = new Interface(ERC20_ABI);
const multicall = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
const oracle = new Interface([
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);

export interface DirectVaultFundingProvider {
  request(method: string, params?: readonly unknown[]): Promise<unknown>;
}

export interface DirectVaultFundingTransactionV1 {
  from: string;
  to: string;
  chainId: "8453";
  type: 2;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  value: "0";
  data: string;
}

export interface DirectVaultFundingActionV1 {
  version: 1;
  kind: "approval" | "deposit";
  chainId: "8453";
  vaultAddress: string;
  consumerAddress: string;
  sessionAddress: string;
  targetBalanceBase: string;
  amountBase: string;
  vaultBalanceBase: string;
  lockedTotalBase: string;
  keyEpoch: string;
  registeredSessionAddress: string;
  ethBalanceWei: string;
  usdcBalanceBase: string;
  allowanceBase: string;
  pendingNonce: string;
  observedBlockStart: number;
  observedBlockEnd: number;
  transaction: DirectVaultFundingTransactionV1;
  followingDepositTransaction?: DirectVaultFundingTransactionV1;
  requiredEthWei: string;
}

export type DirectVaultFundingReconciliation =
  | { status: "succeeded"; blockNumber: number | null }
  | { status: "reverted"; blockNumber: number }
  | { status: "pending" }
  | { status: "state-pending"; blockNumber: number }
  | { status: "ambiguous" };

export type VaultFundingPreparationV1 =
  | { mode: "satisfied"; action: null }
  | { mode: "direct"; action: DirectVaultFundingActionV1 }
  | { mode: "sponsored"; action: DirectVaultFundingActionV1 };

export interface SponsoredVaultDepositRequestV1 {
  version: 1;
  approveTransaction?: string;
  depositTransaction: string;
}

export interface SponsoredVaultDepositBundleV1 {
  version: 1;
  amountBase: string;
  approvalNonce: string | null;
  depositNonce: string;
  approvalHash: string | null;
  depositHash: string;
  initialOperationId: string;
  depositOnlyOperationId: string;
  initialRequestBody: string;
  depositOnlyRequestBody: string;
}

interface ChainSnapshot {
  blockStart: number;
  blockEnd: number;
  chainId: bigint;
  vaultBalance: bigint;
  lockedTotal: bigint;
  sessionKey: string;
  keyEpoch: bigint;
  ethBalance: bigint;
  usdcBalance: bigint;
  allowance: bigint;
  nonce: bigint;
}

interface Candidate {
  from: string;
  to: string;
  data: string;
}

interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface PreparedLeg {
  transaction: DirectVaultFundingTransactionV1;
  requiredEth: bigint;
}

function jsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry
  );
  if (serialized === undefined) throw new Error("value is not JSON serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function assertBounded(value: unknown, limit: number, label: string): void {
  if (jsonBytes(value) > limit) throw new Error(`${label} exceeds its byte limit`);
}

function uint(value: unknown, label: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (
    typeof value === "string" &&
    (/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) || CANONICAL_UINT.test(value))
  ) {
    parsed = BigInt(value);
  } else {
    throw new Error(`${label} is not a canonical unsigned integer`);
  }
  if (parsed < 0n || parsed > MaxUint256) {
    throw new Error(`${label} is outside uint256`);
  }
  return parsed;
}

function positiveUint(value: unknown, label: string): bigint {
  const parsed = uint(value, label);
  if (parsed === 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function safeNumber(value: unknown, label: string): number {
  const parsed = uint(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is too large to narrow safely`);
  }
  return Number(parsed);
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  const value = left + right;
  if (left < 0n || right < 0n || value > MaxUint256) {
    throw new Error(`${label} overflows uint256`);
  }
  return value;
}

function checkedMultiply(left: bigint, right: bigint, label: string): bigint {
  const value = left * right;
  if (left < 0n || right < 0n || value > MaxUint256) {
    throw new Error(`${label} overflows uint256`);
  }
  return value;
}

function buffered(value: bigint, label: string): bigint {
  const product = checkedMultiply(value, BUFFER_NUMERATOR, label);
  return checkedAdd(product, BUFFER_DENOMINATOR - 1n, label) / BUFFER_DENOMINATOR;
}

function decimal(value: bigint): string {
  return value.toString();
}

function address(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} is not an address`);
  }
  const normalized = getAddress(value);
  if (normalized === ZERO_ADDRESS) throw new Error(`${label} is zero`);
  return normalized;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

export function parseDirectVaultFundingTransaction(
  value: unknown
): DirectVaultFundingTransactionV1 {
  const input = record(value, "direct funding transaction");
  if (
    !exactKeys(input, [
      "chainId",
      "data",
      "from",
      "gasLimit",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "nonce",
      "to",
      "type",
      "value",
    ]) ||
    input.chainId !== "8453" ||
    input.type !== 2 ||
    input.value !== "0" ||
    typeof input.data !== "string" ||
    !DATA.test(input.data)
  ) {
    throw new Error("direct funding transaction is invalid");
  }
  const from = address(input.from, "transaction sender");
  const to = address(input.to, "transaction target");
  const nonce = uint(input.nonce, "transaction nonce");
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("transaction nonce is too large to sign safely");
  }
  const gasLimit = positiveUint(input.gasLimit, "transaction gas limit");
  const maxFeePerGas = positiveUint(input.maxFeePerGas, "transaction max fee");
  const maxPriorityFeePerGas = uint(
    input.maxPriorityFeePerGas,
    "transaction priority fee"
  );
  if (
    maxFeePerGas > DIRECT_FUNDING_MAX_FEE_PER_GAS ||
    maxPriorityFeePerGas > DIRECT_FUNDING_MAX_PRIORITY_FEE_PER_GAS ||
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new Error("direct funding transaction fees exceed the safety cap");
  }
  const parsed = {
    from,
    to,
    chainId: "8453" as const,
    type: 2 as const,
    nonce: decimal(nonce),
    gasLimit: decimal(gasLimit),
    maxFeePerGas: decimal(maxFeePerGas),
    maxPriorityFeePerGas: decimal(maxPriorityFeePerGas),
    value: "0" as const,
    data: input.data.toLowerCase(),
  };
  const unsigned = Transaction.from({
    type: 2,
    chainId: BASE_CHAIN_ID,
    nonce: Number(nonce),
    to,
    value: 0n,
    data: parsed.data,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    accessList: [],
  }).unsignedSerialized;
  if (getBytes(unsigned).length + 67 > DIRECT_FUNDING_MAX_TRANSACTION_BYTES) {
    throw new Error("direct funding transaction exceeds 2048 bytes");
  }
  return parsed;
}

type FundingEthRequirement = "sufficient" | "insufficient" | "any";

function parseVaultFundingAction(
  value: unknown,
  ethRequirement: FundingEthRequirement
): DirectVaultFundingActionV1 {
  const input = record(value, "direct funding action");
  const expected = [
    "allowanceBase",
    "amountBase",
    "chainId",
    "consumerAddress",
    "ethBalanceWei",
    "keyEpoch",
    "kind",
    "lockedTotalBase",
    "observedBlockEnd",
    "observedBlockStart",
    "pendingNonce",
    "registeredSessionAddress",
    "requiredEthWei",
    "sessionAddress",
    "targetBalanceBase",
    "transaction",
    "usdcBalanceBase",
    "vaultAddress",
    "vaultBalanceBase",
    "version",
  ];
  if (input.followingDepositTransaction !== undefined) {
    expected.push("followingDepositTransaction");
  }
  if (
    !exactKeys(input, expected) ||
    input.version !== 1 ||
    input.chainId !== "8453" ||
    (input.kind !== "approval" && input.kind !== "deposit") ||
    !Number.isSafeInteger(input.observedBlockStart) ||
    Number(input.observedBlockStart) < 0 ||
    !Number.isSafeInteger(input.observedBlockEnd) ||
    Number(input.observedBlockEnd) < Number(input.observedBlockStart) ||
    Number(input.observedBlockEnd) - Number(input.observedBlockStart) > 2
  ) {
    throw new Error("direct funding action is invalid");
  }
  const action: DirectVaultFundingActionV1 = {
    version: 1,
    kind: input.kind,
    chainId: "8453",
    vaultAddress: address(input.vaultAddress, "funding vault"),
    consumerAddress: address(input.consumerAddress, "funding consumer"),
    sessionAddress: address(input.sessionAddress, "funding session"),
    targetBalanceBase: decimal(positiveUint(input.targetBalanceBase, "funding target")),
    amountBase: decimal(positiveUint(input.amountBase, "funding amount")),
    vaultBalanceBase: decimal(uint(input.vaultBalanceBase, "vault balance")),
    lockedTotalBase: decimal(uint(input.lockedTotalBase, "locked total")),
    keyEpoch: decimal(uint(input.keyEpoch, "key epoch")),
    registeredSessionAddress:
      typeof input.registeredSessionAddress === "string" && isAddress(input.registeredSessionAddress)
        ? getAddress(input.registeredSessionAddress)
        : (() => {
            throw new Error("registered session address is invalid");
          })(),
    ethBalanceWei: decimal(uint(input.ethBalanceWei, "ETH balance")),
    usdcBalanceBase: decimal(uint(input.usdcBalanceBase, "USDC balance")),
    allowanceBase: decimal(uint(input.allowanceBase, "USDC allowance")),
    pendingNonce: decimal(uint(input.pendingNonce, "pending nonce")),
    observedBlockStart: Number(input.observedBlockStart),
    observedBlockEnd: Number(input.observedBlockEnd),
    transaction: parseDirectVaultFundingTransaction(input.transaction),
    requiredEthWei: decimal(positiveUint(input.requiredEthWei, "required ETH")),
    ...(input.followingDepositTransaction === undefined
      ? {}
      : {
          followingDepositTransaction: parseDirectVaultFundingTransaction(
            input.followingDepositTransaction
          ),
        }),
  };
  const target = BigInt(action.targetBalanceBase);
  const balance = BigInt(action.vaultBalanceBase);
  if (target <= balance) throw new Error("direct funding target is already satisfied");
  const expectedDepositData = vault
    .encodeFunctionData("deposit", [action.amountBase, action.sessionAddress])
    .toLowerCase();
  const expectedApprovalData = token
    .encodeFunctionData("approve", [action.vaultAddress, MaxUint256])
    .toLowerCase();
  const following = action.followingDepositTransaction;
  const transactionExecutionLiability =
    BigInt(action.transaction.gasLimit) * BigInt(action.transaction.maxFeePerGas);
  const followingExecutionLiability = following
    ? BigInt(following.gasLimit) * BigInt(following.maxFeePerGas)
    : 0n;
  if (
    action.consumerAddress !== action.transaction.from ||
    BigInt(action.amountBase) !== target - balance ||
    BigInt(action.usdcBalanceBase) < BigInt(action.amountBase) ||
    BigInt(action.requiredEthWei) <
      transactionExecutionLiability + followingExecutionLiability ||
    BigInt(action.pendingNonce) !== BigInt(action.transaction.nonce) ||
    (action.kind === "approval") !== (following !== undefined) ||
    (action.registeredSessionAddress !== ZERO_ADDRESS &&
      action.registeredSessionAddress !== action.sessionAddress)
  ) {
    throw new Error("direct funding action evidence is inconsistent");
  }
  const ethBalance = BigInt(action.ethBalanceWei);
  const requiredEth = BigInt(action.requiredEthWei);
  if (
    (ethRequirement === "sufficient" && ethBalance < requiredEth) ||
    (ethRequirement === "insufficient" && ethBalance >= requiredEth)
  ) {
    throw new Error("direct funding ETH route evidence is inconsistent");
  }
  if (action.kind === "approval") {
    if (
      action.transaction.to !== getAddress(getChain(BASE_CHAIN_ID).usdcToken) ||
      action.transaction.data !== expectedApprovalData ||
      BigInt(action.transaction.gasLimit) > DIRECT_FUNDING_APPROVAL_GAS_CAP ||
      following === undefined ||
      following.from !== action.consumerAddress ||
      following.to !== action.vaultAddress ||
      following.data !== expectedDepositData ||
      BigInt(following.nonce) !== BigInt(action.pendingNonce) + 1n ||
      BigInt(following.gasLimit) > DIRECT_FUNDING_DEPOSIT_GAS_CAP
    ) {
      throw new Error("direct funding approval evidence is inconsistent");
    }
  } else if (
    action.transaction.to !== action.vaultAddress ||
    action.transaction.data !== expectedDepositData ||
    BigInt(action.transaction.gasLimit) > DIRECT_FUNDING_DEPOSIT_GAS_CAP
  ) {
    throw new Error("direct funding deposit evidence is inconsistent");
  }
  return action;
}

export function parseDirectVaultFundingAction(value: unknown): DirectVaultFundingActionV1 {
  return parseVaultFundingAction(value, "sufficient");
}

export function parseSponsoredVaultFundingAction(value: unknown): DirectVaultFundingActionV1 {
  return parseVaultFundingAction(value, "insufficient");
}

function withoutObservationBlocks(action: DirectVaultFundingActionV1): unknown {
  const { observedBlockStart: _start, observedBlockEnd: _end, ...rest } = action;
  return rest;
}

export function sameDirectVaultFundingAction(
  left: DirectVaultFundingActionV1,
  right: DirectVaultFundingActionV1
): boolean {
  return JSON.stringify(withoutObservationBlocks(parseDirectVaultFundingAction(left))) ===
    JSON.stringify(withoutObservationBlocks(parseDirectVaultFundingAction(right)));
}

export function sameSponsoredVaultFundingAction(
  left: DirectVaultFundingActionV1,
  right: DirectVaultFundingActionV1
): boolean {
  return JSON.stringify(withoutObservationBlocks(parseSponsoredVaultFundingAction(left))) ===
    JSON.stringify(withoutObservationBlocks(parseSponsoredVaultFundingAction(right)));
}

function parseSignedSponsoredTransaction(
  raw: string,
  expected: DirectVaultFundingTransactionV1
): Transaction {
  if (!DATA.test(raw) || raw === "0x" || getBytes(raw).length > DIRECT_FUNDING_MAX_TRANSACTION_BYTES) {
    throw new Error("signed sponsored transaction is malformed or oversized");
  }
  let parsed: Transaction;
  try {
    parsed = Transaction.from(raw);
  } catch {
    throw new Error("signed sponsored transaction cannot be decoded");
  }
  if (
    parsed.type !== 2 ||
    parsed.chainId !== BigInt(BASE_CHAIN_ID) ||
    parsed.nonce !== Number(BigInt(expected.nonce)) ||
    parsed.gasLimit !== BigInt(expected.gasLimit) ||
    parsed.maxFeePerGas !== BigInt(expected.maxFeePerGas) ||
    parsed.maxPriorityFeePerGas !== BigInt(expected.maxPriorityFeePerGas) ||
    parsed.value !== 0n ||
    parsed.from === null ||
    getAddress(parsed.from) !== expected.from ||
    parsed.to === null ||
    getAddress(parsed.to) !== expected.to ||
    parsed.data.toLowerCase() !== expected.data ||
    (parsed.accessList?.length ?? 0) !== 0 ||
    parsed.serialized.toLowerCase() !== raw.toLowerCase() ||
    parsed.hash === null
  ) {
    throw new Error("signed sponsored transaction does not match the funding action");
  }
  return parsed;
}

function sponsoredOperationId(approvalHash: string | null, depositHash: string): string {
  return solidityPackedKeccak256(
    ["uint8", "bytes32", "bytes32"],
    [1, approvalHash ?? ZeroHash, depositHash]
  ).toLowerCase();
}

export function buildSponsoredVaultDepositBundle(input: {
  action: DirectVaultFundingActionV1;
  signedApprovalTransaction?: string;
  signedDepositTransaction: string;
}): SponsoredVaultDepositBundleV1 {
  const action = parseSponsoredVaultFundingAction(input.action);
  const depositExpected = action.kind === "approval"
    ? action.followingDepositTransaction
    : action.transaction;
  if (depositExpected === undefined) {
    throw new Error("sponsored deposit action is missing its deposit transaction");
  }
  const deposit = parseSignedSponsoredTransaction(
    input.signedDepositTransaction,
    depositExpected
  );
  let approval: Transaction | null = null;
  if (action.kind === "approval") {
    if (input.signedApprovalTransaction === undefined) {
      throw new Error("sponsored approval action is missing its signed approval");
    }
    approval = parseSignedSponsoredTransaction(
      input.signedApprovalTransaction,
      action.transaction
    );
  } else if (input.signedApprovalTransaction !== undefined) {
    throw new Error("sponsored deposit-only action cannot include an approval");
  }
  const approvalRaw = approval?.serialized;
  const depositRaw = deposit.serialized;
  const approvalHash = approval?.hash?.toLowerCase() ?? null;
  const depositHash = deposit.hash!.toLowerCase();
  const initialRequest: SponsoredVaultDepositRequestV1 = {
    version: 1,
    ...(approvalRaw ? { approveTransaction: approvalRaw } : {}),
    depositTransaction: depositRaw,
  };
  const depositOnlyRequest: SponsoredVaultDepositRequestV1 = {
    version: 1,
    depositTransaction: depositRaw,
  };
  return {
    version: 1,
    amountBase: action.amountBase,
    approvalNonce: approval ? String(approval.nonce) : null,
    depositNonce: String(deposit.nonce),
    approvalHash,
    depositHash,
    initialOperationId: sponsoredOperationId(approvalHash, depositHash),
    depositOnlyOperationId: sponsoredOperationId(null, depositHash),
    initialRequestBody: JSON.stringify(initialRequest),
    depositOnlyRequestBody: JSON.stringify(depositOnlyRequest),
  };
}

export function parseSponsoredVaultDepositBundle(
  value: unknown,
  actionValue: DirectVaultFundingActionV1
): SponsoredVaultDepositBundleV1 {
  const input = record(value, "sponsored deposit bundle");
  if (!exactKeys(input, [
    "amountBase",
    "approvalHash",
    "approvalNonce",
    "depositHash",
    "depositNonce",
    "depositOnlyOperationId",
    "depositOnlyRequestBody",
    "initialOperationId",
    "initialRequestBody",
    "version",
  ]) || input.version !== 1) {
    throw new Error("sponsored deposit bundle is invalid");
  }
  let initial: unknown;
  let depositOnly: unknown;
  try {
    initial = JSON.parse(String(input.initialRequestBody));
    depositOnly = JSON.parse(String(input.depositOnlyRequestBody));
  } catch {
    throw new Error("sponsored deposit request body is invalid");
  }
  const initialRecord = record(initial, "initial sponsored deposit request");
  const depositOnlyRecord = record(depositOnly, "deposit-only sponsored deposit request");
  if (
    !exactKeys(initialRecord, initialRecord.approveTransaction === undefined
      ? ["depositTransaction", "version"]
      : ["approveTransaction", "depositTransaction", "version"]) ||
    !exactKeys(depositOnlyRecord, ["depositTransaction", "version"]) ||
    initialRecord.version !== 1 ||
    depositOnlyRecord.version !== 1 ||
    typeof initialRecord.depositTransaction !== "string" ||
    typeof depositOnlyRecord.depositTransaction !== "string" ||
    initialRecord.depositTransaction !== depositOnlyRecord.depositTransaction ||
    (initialRecord.approveTransaction !== undefined &&
      typeof initialRecord.approveTransaction !== "string")
  ) {
    throw new Error("sponsored deposit request body is invalid");
  }
  const rebuilt = buildSponsoredVaultDepositBundle({
    action: actionValue,
    ...(initialRecord.approveTransaction === undefined
      ? {}
      : { signedApprovalTransaction: initialRecord.approveTransaction }),
    signedDepositTransaction: initialRecord.depositTransaction,
  });
  for (const key of Object.keys(rebuilt) as Array<keyof SponsoredVaultDepositBundleV1>) {
    if (input[key] !== rebuilt[key]) {
      throw new Error("sponsored deposit bundle evidence is inconsistent");
    }
  }
  return rebuilt;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class DirectVaultFundingClient {
  private readonly provider: DirectVaultFundingProvider;
  private readonly vaultAddress: string;
  private readonly usdcAddress: string;

  constructor(options: {
    rpcUrl?: string;
    provider?: DirectVaultFundingProvider;
    chainId: 8453;
    vaultAddress: string;
  }) {
    if (options.chainId !== BASE_CHAIN_ID || !isAddress(options.vaultAddress)) {
      throw new Error("direct funding supports only the selected Base HaloVault");
    }
    this.vaultAddress = getAddress(options.vaultAddress);
    this.usdcAddress = getAddress(getChain(BASE_CHAIN_ID).usdcToken);
    if (options.provider) {
      this.provider = options.provider;
    } else {
      if (!options.rpcUrl) throw new Error("direct funding RPC URL is required");
      const provider = new JsonRpcProvider(options.rpcUrl, BASE_CHAIN_ID, {
        staticNetwork: true,
      });
      this.provider = {
        request: (method, params = []) => provider.send(method, [...params]),
      };
    }
  }

  private async rpc(
    method: string,
    params: readonly unknown[] = [],
    responseLimit = MAX_RPC_BYTES
  ): Promise<unknown> {
    const request = { method, params };
    assertBounded(request, MAX_RPC_BYTES, `Base ${method} request`);
    const result = await this.provider.request(method, params);
    assertBounded(result, responseLimit, `Base ${method} response`);
    return result;
  }

  private async readChainSnapshot(consumerAddress: string): Promise<ChainSnapshot> {
    const consumer = address(consumerAddress, "funding consumer");
    const blockStart = safeNumber(await this.rpc("eth_blockNumber"), "starting block");
    const calls = [
      [this.vaultAddress, vault, "balance", [consumer]],
      [this.vaultAddress, vault, "lockedTotal", [consumer]],
      [this.vaultAddress, vault, "sessionKey", [consumer]],
      [this.vaultAddress, vault, "keyEpoch", [consumer]],
      [this.usdcAddress, token, "balanceOf", [consumer]],
      [this.usdcAddress, token, "allowance", [consumer, this.vaultAddress]],
    ] as const;
    const multicallData = multicall.encodeFunctionData("aggregate3", [
      calls.map(([target, contractInterface, functionName, args]) => ({
        target,
        allowFailure: false,
        callData: contractInterface.encodeFunctionData(functionName, args),
      })),
    ]);
    const [chainIdValue, stateValue, ethValue, nonceValue] = await Promise.all([
      this.rpc("eth_chainId"),
      this.rpc("eth_call", [{ to: MULTICALL3_ADDRESS, data: multicallData }, "pending"]),
      this.rpc("eth_getBalance", [consumer, "pending"]),
      this.rpc("eth_getTransactionCount", [consumer, "pending"]),
    ]);
    if (typeof stateValue !== "string" || !DATA.test(stateValue)) {
      throw new Error("Base returned malformed funding state");
    }
    const decoded = multicall.decodeFunctionResult("aggregate3", stateValue)[0] as
      unknown as readonly (readonly [boolean, string])[];
    if (decoded.length !== calls.length || decoded.some((entry) => !entry[0])) {
      throw new Error("Base returned incomplete funding state");
    }
    const value = (index: number): unknown => {
      const [, contractInterface, functionName] = calls[index];
      return contractInterface.decodeFunctionResult(functionName, decoded[index][1])[0];
    };
    const sessionKeyValue = value(2);
    if (typeof sessionKeyValue !== "string" || !isAddress(sessionKeyValue)) {
      throw new Error("Base returned an invalid session key");
    }
    const blockEnd = safeNumber(await this.rpc("eth_blockNumber"), "ending block");
    if (blockEnd < blockStart || blockEnd - blockStart > 2) {
      throw new Error("direct funding snapshot became stale");
    }
    const nonce = uint(nonceValue, "pending nonce");
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER - 1)) {
      throw new Error("pending nonce is too large to sign safely");
    }
    return {
      blockStart,
      blockEnd,
      chainId: uint(chainIdValue, "chain ID"),
      vaultBalance: uint(value(0), "vault balance"),
      lockedTotal: uint(value(1), "locked total"),
      sessionKey: getAddress(sessionKeyValue),
      keyEpoch: uint(value(3), "key epoch"),
      usdcBalance: uint(value(4), "USDC balance"),
      allowance: uint(value(5), "USDC allowance"),
      ethBalance: uint(ethValue, "ETH balance"),
      nonce,
    };
  }

  private async readFees(): Promise<Fees> {
    const [gasPriceValue, blockValue] = await Promise.all([
      this.rpc("eth_gasPrice"),
      this.rpc("eth_getBlockByNumber", ["pending", false], MAX_BLOCK_RESPONSE_BYTES),
    ]);
    const gasPrice = uint(gasPriceValue, "gas price");
    const block = record(blockValue, "pending block");
    const baseFee = uint(block.baseFeePerGas, "pending base fee");
    const rawPriority = gasPrice > baseFee ? gasPrice - baseFee : 0n;
    const maxPriorityFeePerGas =
      rawPriority > DIRECT_FUNDING_MAX_PRIORITY_FEE_PER_GAS
        ? DIRECT_FUNDING_MAX_PRIORITY_FEE_PER_GAS
        : rawPriority;
    const maxFeePerGas = checkedAdd(
      checkedMultiply(baseFee, 2n, "maximum fee"),
      maxPriorityFeePerGas,
      "maximum fee"
    );
    if (maxFeePerGas === 0n || maxFeePerGas > DIRECT_FUNDING_MAX_FEE_PER_GAS) {
      throw new Error("Base fees exceed the direct-funding safety cap");
    }
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private transaction(
    candidate: Candidate,
    nonce: bigint,
    gasLimit: bigint,
    fees: Fees
  ): DirectVaultFundingTransactionV1 {
    return parseDirectVaultFundingTransaction({
      from: candidate.from,
      to: candidate.to,
      chainId: "8453",
      type: 2,
      nonce: decimal(nonce),
      gasLimit: decimal(gasLimit),
      maxFeePerGas: decimal(fees.maxFeePerGas),
      maxPriorityFeePerGas: decimal(fees.maxPriorityFeePerGas),
      value: "0",
      data: candidate.data,
    });
  }

  private async feeFor(
    candidate: Candidate,
    nonce: bigint,
    fees: Fees,
    gasCap: bigint,
    useCeiling: boolean
  ): Promise<PreparedLeg> {
    let gasLimit = gasCap;
    if (!useCeiling) {
      const estimate = positiveUint(
        await this.rpc("eth_estimateGas", [
          { from: candidate.from, to: candidate.to, data: candidate.data, value: "0x0" },
        ]),
        "gas estimate"
      );
      gasLimit = buffered(estimate, "gas buffer");
      if (gasLimit > gasCap) throw new Error("gas estimate exceeds the direct-funding cap");
    }
    const transaction = this.transaction(candidate, nonce, gasLimit, fees);
    const unsignedBytes = getBytes(
      Transaction.from({
        type: 2,
        chainId: BASE_CHAIN_ID,
        nonce: Number(nonce),
        to: transaction.to,
        value: 0n,
        data: transaction.data,
        gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        accessList: [],
      }).unsignedSerialized
    ).length;
    const [l1Raw, operatorRaw] = await Promise.all([
      this.rpc("eth_call", [
        {
          to: BASE_GAS_PRICE_ORACLE,
          data: oracle.encodeFunctionData("getL1FeeUpperBound", [unsignedBytes]),
        },
        "pending",
      ]),
      this.rpc("eth_call", [
        {
          to: BASE_GAS_PRICE_ORACLE,
          data: oracle.encodeFunctionData("getOperatorFee", [gasLimit]),
        },
        "pending",
      ]),
    ]);
    const decodeOracle = (name: string, raw: unknown): bigint => {
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
        throw new Error(`Base Gas Price Oracle returned invalid ${name}`);
      }
      return uint(oracle.decodeFunctionResult(name, raw)[0], name);
    };
    const l1Fee = decodeOracle("getL1FeeUpperBound", l1Raw);
    const operatorFee = decodeOracle("getOperatorFee", operatorRaw);
    const execution = checkedMultiply(gasLimit, fees.maxFeePerGas, "execution fee");
    const requiredEth = checkedAdd(
      checkedAdd(execution, buffered(l1Fee, "L1 fee buffer"), "transaction fee"),
      operatorFee,
      "transaction fee"
    );
    return { transaction, requiredEth };
  }

  async prepare(input: {
    consumerAddress: string;
    sessionAddress: string;
    targetBalanceBase: bigint;
  }): Promise<DirectVaultFundingActionV1 | null> {
    const prepared = await this.prepareRoute(input);
    if (prepared.mode === "satisfied") return null;
    if (prepared.mode === "sponsored") {
      throw new DirectVaultFundingError(
        "insufficient_eth",
        "The Privy wallet has insufficient Base ETH for direct Vault funding."
      );
    }
    return prepared.action;
  }

  async prepareRoute(input: {
    consumerAddress: string;
    sessionAddress: string;
    targetBalanceBase: bigint;
  }): Promise<VaultFundingPreparationV1> {
    return withTimeout(
      this.prepareRouteWithinDeadline(input),
      DIRECT_FUNDING_PREFLIGHT_TIMEOUT_MS,
      "direct funding preflight"
    );
  }

  private async prepareRouteWithinDeadline(input: {
    consumerAddress: string;
    sessionAddress: string;
    targetBalanceBase: bigint;
  }): Promise<VaultFundingPreparationV1> {
    const consumer = address(input.consumerAddress, "funding consumer");
    const session = address(input.sessionAddress, "funding session");
    const target = positiveUint(input.targetBalanceBase, "funding target");
    const snapshot = await this.readChainSnapshot(consumer);
    if (snapshot.chainId !== BigInt(BASE_CHAIN_ID)) {
      throw new Error("direct funding RPC is not Base mainnet");
    }
    const registered = getAddress(snapshot.sessionKey);
    if (registered !== ZERO_ADDRESS && registered !== session) {
      throw new DirectVaultFundingError(
        "session_key_mismatch",
        "The registered HaloVault session key does not match the funding session."
      );
    }
    if (snapshot.vaultBalance >= target) {
      if (registered !== session) {
        throw new Error("HaloVault session key is not registered");
      }
      return { mode: "satisfied", action: null };
    }
    const amount = target - snapshot.vaultBalance;
    if (snapshot.usdcBalance < amount) {
      throw new DirectVaultFundingError(
        "insufficient_usdc",
        "The Privy wallet has insufficient Base USDC for the requested Vault target."
      );
    }
    const fees = await this.readFees();
    const approvalNeeded = snapshot.allowance < amount;
    const depositCandidate: Candidate = {
      from: consumer,
      to: this.vaultAddress,
      data: vault.encodeFunctionData("deposit", [amount, session]),
    };
    let kind: "approval" | "deposit";
    let transaction: DirectVaultFundingTransactionV1;
    let followingDepositTransaction: DirectVaultFundingTransactionV1 | undefined;
    let requiredEth: bigint;
    if (approvalNeeded) {
      kind = "approval";
      const approval = await this.feeFor(
        {
          from: consumer,
          to: this.usdcAddress,
          data: token.encodeFunctionData("approve", [this.vaultAddress, MaxUint256]),
        },
        snapshot.nonce,
        fees,
        DIRECT_FUNDING_APPROVAL_GAS_CAP,
        false
      );
      const deposit = await this.feeFor(
        depositCandidate,
        snapshot.nonce + 1n,
        fees,
        DIRECT_FUNDING_DEPOSIT_GAS_CAP,
        true
      );
      transaction = approval.transaction;
      followingDepositTransaction = deposit.transaction;
      requiredEth = checkedAdd(approval.requiredEth, deposit.requiredEth, "funding liability");
    } else {
      kind = "deposit";
      const deposit = await this.feeFor(
        depositCandidate,
        snapshot.nonce,
        fees,
        DIRECT_FUNDING_DEPOSIT_GAS_CAP,
        false
      );
      transaction = deposit.transaction;
      requiredEth = deposit.requiredEth;
    }
    const action = parseVaultFundingAction({
      version: 1,
      kind,
      chainId: "8453",
      vaultAddress: this.vaultAddress,
      consumerAddress: consumer,
      sessionAddress: session,
      targetBalanceBase: decimal(target),
      amountBase: decimal(amount),
      vaultBalanceBase: decimal(snapshot.vaultBalance),
      lockedTotalBase: decimal(snapshot.lockedTotal),
      keyEpoch: decimal(snapshot.keyEpoch),
      registeredSessionAddress: registered,
      ethBalanceWei: decimal(snapshot.ethBalance),
      usdcBalanceBase: decimal(snapshot.usdcBalance),
      allowanceBase: decimal(snapshot.allowance),
      pendingNonce: decimal(snapshot.nonce),
      observedBlockStart: snapshot.blockStart,
      observedBlockEnd: snapshot.blockEnd,
      transaction,
      ...(followingDepositTransaction ? { followingDepositTransaction } : {}),
      requiredEthWei: decimal(requiredEth),
    }, "any");
    return snapshot.ethBalance >= requiredEth
      ? { mode: "direct", action: parseDirectVaultFundingAction(action) }
      : { mode: "sponsored", action: parseSponsoredVaultFundingAction(action) };
  }

  async revalidate(action: DirectVaultFundingActionV1): Promise<boolean> {
    const expected = parseDirectVaultFundingAction(action);
    const current = await this.prepare({
      consumerAddress: expected.consumerAddress,
      sessionAddress: expected.sessionAddress,
      targetBalanceBase: BigInt(expected.targetBalanceBase),
    });
    return current !== null && sameDirectVaultFundingAction(expected, current);
  }

  async revalidateSponsored(action: DirectVaultFundingActionV1): Promise<boolean> {
    const expected = parseSponsoredVaultFundingAction(action);
    const current = await this.prepareRoute({
      consumerAddress: expected.consumerAddress,
      sessionAddress: expected.sessionAddress,
      targetBalanceBase: BigInt(expected.targetBalanceBase),
    });
    return current.mode === "sponsored" &&
      sameSponsoredVaultFundingAction(expected, current.action);
  }

  private async effectObserved(
    action: DirectVaultFundingActionV1,
    kind: "approval" | "deposit"
  ): Promise<boolean> {
    const snapshot = await this.readChainSnapshot(action.consumerAddress);
    if (kind === "approval") {
      return snapshot.allowance >= BigInt(action.amountBase);
    }
    return (
      snapshot.vaultBalance >= BigInt(action.targetBalanceBase) &&
      getAddress(snapshot.sessionKey) === action.sessionAddress
    );
  }

  async reconcile(
    actionValue: DirectVaultFundingActionV1,
    transactionHash: string | null
  ): Promise<DirectVaultFundingReconciliation> {
    const action = parseDirectVaultFundingAction(actionValue);
    return this.reconcileTransaction(
      action,
      action.transaction,
      action.kind,
      transactionHash
    );
  }

  async reconcileSponsored(
    actionValue: DirectVaultFundingActionV1,
    transactionHashes: { approval: string | null; deposit: string }
  ): Promise<{
    approval: DirectVaultFundingReconciliation | null;
    deposit: DirectVaultFundingReconciliation;
  }> {
    const action = parseSponsoredVaultFundingAction(actionValue);
    const depositTransaction = action.kind === "approval"
      ? action.followingDepositTransaction
      : action.transaction;
    if (depositTransaction === undefined) {
      throw new Error("sponsored deposit action is missing its deposit transaction");
    }
    const approval = action.kind === "approval"
      ? await this.reconcileTransaction(
          action,
          action.transaction,
          "approval",
          transactionHashes.approval
        )
      : null;
    const deposit = await this.reconcileTransaction(
      action,
      depositTransaction,
      "deposit",
      transactionHashes.deposit
    );
    return { approval, deposit };
  }

  private async reconcileTransaction(
    action: DirectVaultFundingActionV1,
    transaction: DirectVaultFundingTransactionV1,
    kind: "approval" | "deposit",
    transactionHash: string | null
  ): Promise<DirectVaultFundingReconciliation> {
    if (transactionHash === null) {
      return (await this.effectObserved(action, kind))
        ? { status: "succeeded", blockNumber: null }
        : { status: "ambiguous" };
    }
    if (!HASH.test(transactionHash)) throw new Error("funding transaction hash is invalid");
    const hash = transactionHash.toLowerCase();
    const receiptValue = await this.rpc("eth_getTransactionReceipt", [hash]);
    if (receiptValue === null) return { status: "pending" };
    const receipt = record(receiptValue, "funding receipt");
    if (
      typeof receipt.transactionHash !== "string" ||
      receipt.transactionHash.toLowerCase() !== hash
    ) {
      throw new Error("funding receipt hash does not match");
    }
    const status = uint(receipt.status, "funding receipt status");
    if (status !== 0n && status !== 1n) throw new Error("funding receipt status is invalid");
    const blockNumber = safeNumber(receipt.blockNumber, "funding receipt block");
    const transactionValue = await this.rpc("eth_getTransactionByHash", [hash]);
    const observed = record(transactionValue, "funding transaction");
    const inputData = observed.input ?? observed.data;
    if (
      typeof observed.from !== "string" ||
      getAddress(observed.from) !== transaction.from ||
      typeof observed.to !== "string" ||
      getAddress(observed.to) !== transaction.to ||
      typeof inputData !== "string" ||
      inputData.toLowerCase() !== transaction.data ||
      uint(observed.nonce, "funding transaction nonce") !== BigInt(transaction.nonce) ||
      uint(observed.value, "funding transaction value") !== 0n ||
      uint(observed.chainId, "funding transaction chain") !== BigInt(BASE_CHAIN_ID) ||
      uint(observed.gas ?? observed.gasLimit, "funding transaction gas") !==
        BigInt(transaction.gasLimit) ||
      uint(observed.maxFeePerGas, "funding transaction max fee") !==
        BigInt(transaction.maxFeePerGas) ||
      uint(observed.maxPriorityFeePerGas, "funding transaction priority fee") !==
        BigInt(transaction.maxPriorityFeePerGas)
    ) {
      throw new Error("funding transaction does not match the persisted action");
    }
    if (status === 0n) return { status: "reverted", blockNumber };
    return (await this.effectObserved(action, kind))
      ? { status: "succeeded", blockNumber }
      : { status: "state-pending", blockNumber };
  }
}
