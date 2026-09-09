import { getAddress, Interface, MaxUint256, parseUnits, ZeroAddress } from "ethers";

export class PayoutError extends Error {}

export const PAYOUT_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const PAYOUT_DOMAIN = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: PAYOUT_USDC };
export const PAYOUT_TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" },
  { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
] };
export const PAYOUT_ABI = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
export type PayoutMode = "sponsored" | "direct";
export interface PayoutIntent {
  source: string;
  destination: string;
  amount: string;
  generation: number;
}
export interface Authorization {
  from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string;
}
export interface SignedPayout extends PayoutIntent {
  submission: { mode: "sponsored"; authorization: Authorization; signature: string } |
    { mode: "direct"; rawTransaction: string };
}

export function payoutAmount(input: string): bigint {
  if (input.length > 85 || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input)) throw new PayoutError("Enter a positive USDC amount with at most six decimal places.");
  const amount = parseUnits(input, 6);
  if (amount <= 0n || amount > MaxUint256) throw new PayoutError("USDC amount is out of range.");
  return amount;
}
export function payoutMode(amount: bigint): PayoutMode {
  return amount > 1_000_000n && amount <= 50_000_000n ? "sponsored" : "direct";
}
export function validatePayoutIntent(intent: PayoutIntent): void {
  if (getAddress(intent.source) !== intent.source || getAddress(intent.destination) !== intent.destination ||
      intent.destination === ZeroAddress || intent.source === ZeroAddress || intent.source === intent.destination ||
      !Number.isSafeInteger(intent.generation) || intent.generation < 0 ||
      !/^[1-9]\d*$/.test(intent.amount) || BigInt(intent.amount) > MaxUint256) {
    throw new PayoutError("Invalid payout identity or amount.");
  }
}

export interface PayoutReceipt {
  hash: string; blockNumber: number; blockHash: string; status: number | null;
  logs: ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>;
}
export function receiptHasPayout(record: SignedPayout, receipt: PayoutReceipt): boolean {
  let transfer = false;
  let authorization = record.submission.mode === "direct";
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PAYOUT_USDC.toLowerCase()) continue;
    const event = PAYOUT_ABI.parseLog({ topics: [...log.topics], data: log.data });
    if (event?.name === "Transfer" && event.args.from === record.source &&
        event.args.to === record.destination && event.args.value === BigInt(record.amount)) transfer = true;
    if (event?.name === "AuthorizationUsed" && record.submission.mode === "sponsored" &&
        event.args.authorizer === record.source && event.args.nonce === record.submission.authorization.nonce) authorization = true;
  }
  return transfer && authorization;
}
