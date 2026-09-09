import { Contract, FetchRequest, JsonRpcProvider, Transaction, getBytes, type TransactionRequest } from "ethers";
import { PayoutError, PAYOUT_ABI, PAYOUT_USDC, receiptHasPayout, type SignedPayout } from "./operatorPayout";

export function payoutProvider(url: string): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = 15_000;
  return new JsonRpcProvider(request, undefined, { batchMaxCount: 1, cacheTimeout: -1 });
}
export async function assertPayoutChain(provider: JsonRpcProvider): Promise<void> {
  if (BigInt(await provider.send("eth_chainId", [])) !== 8453n) throw new PayoutError("Payout requires Base mainnet (8453).");
}
async function submitPayout(record: SignedPayout, provider: JsonRpcProvider, facilitatorUrl: string): Promise<string | null> {
  await assertPayoutChain(provider);
  if (record.submission.mode === "direct") {
    // A locally derived hash remains available even if the RPC loses its response.
    const expected = Transaction.from(record.submission.rawTransaction).hash;
    const hash: unknown = await provider.send("eth_sendRawTransaction", [record.submission.rawTransaction]);
    if (hash !== expected) throw new PayoutError("Unexpected payout transaction hash.");
    return String(hash);
  }
  const response = await fetch(`${facilitatorUrl.replace(/\/$/, "")}/transfer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ network: "base", authorization: record.submission.authorization, signature: record.submission.signature }),
    signal: AbortSignal.timeout(135_000), redirect: "error",
  });
  // A facilitator response alone does not prove a successful transfer.
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 16_384) return null;
      chunks.push(chunk.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body !== "object" || body === null) return null;
    const result = body as { network?: unknown; transaction?: unknown };
    return result.network === "base" && typeof result.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(result.transaction)
      ? result.transaction.toLowerCase() : null;
  } finally { await reader.cancel(); }
}

export async function payoutFeeLiability(provider: JsonRpcProvider, tx: TransactionRequest): Promise<bigint> {
  const oracle = new Contract("0x420000000000000000000000000000000000000F", [
    "function getL1FeeUpperBound(uint256) view returns (uint256)",
    "function getOperatorFee(uint256) view returns (uint256)",
  ], provider);
  const bytes = getBytes(Transaction.from({ type: 2, chainId: 8453, to: PAYOUT_USDC, value: 0, data: tx.data,
    nonce: Number(tx.nonce), gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }).unsignedSerialized).length;
  const [l1, operator] = await Promise.all([
    oracle.getL1FeeUpperBound(bytes, { blockTag: "pending" }),
    oracle.getOperatorFee(tx.gasLimit, { blockTag: "pending" }),
  ]);
  return BigInt(tx.gasLimit!) * BigInt(tx.maxFeePerGas!) + (BigInt(l1) * 130n + 99n) / 100n + BigInt(operator);
}

export type PayoutResult = { status: "confirmed" | "reverted" | "unknown"; hash?: string };

export async function executePayout(
  payout: SignedPayout,
  provider: JsonRpcProvider,
  facilitatorUrl: string,
  reportHash: (hash: string) => void,
): Promise<PayoutResult> {
  await assertPayoutChain(provider);
  let hash = payout.submission.mode === "direct"
    ? Transaction.from(payout.submission.rawTransaction).hash ?? undefined : undefined;
  if (hash) reportHash(hash);
  try {
    const submittedHash = await submitPayout(payout, provider, facilitatorUrl);
    if (submittedHash && submittedHash !== hash) reportHash(submittedHash);
    hash = submittedHash ?? hash;
  } catch {
    // A lost response may follow broadcast. A direct transaction's local hash can still be checked.
  }
  if (!hash) return { status: "unknown" };
  try {
    const receipt = await provider.waitForTransaction(hash, 1, 120_000);
    await assertPayoutChain(provider);
    if (!receipt || receipt.hash.toLowerCase() !== hash.toLowerCase() ||
        (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) return { status: "unknown", hash };
    if (receipt.status === 0) return { status: "reverted", hash };
    return { status: receipt.status === 1 && receiptHasPayout(payout, receipt) ? "confirmed" : "unknown", hash };
  } catch {
    return { status: "unknown", hash };
  }
}
