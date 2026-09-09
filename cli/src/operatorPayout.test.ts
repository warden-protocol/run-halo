import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, Transaction, verifyTypedData, type JsonRpcProvider } from "ethers";
import { PAYOUT_ABI, PAYOUT_DOMAIN, PAYOUT_TYPES, PAYOUT_USDC,
  payoutAmount, payoutMode, receiptHasPayout, type SignedPayout, type PayoutReceipt } from "./operatorPayout";
import { executePayout } from "./operatorPayoutRpc";

const signer = new Wallet(`0x${"11".repeat(32)}`);
const destination = new Wallet(`0x${"22".repeat(32)}`).address;
const hash = `0x${"ab".repeat(32)}`;
const blockHash = `0x${"cd".repeat(32)}`;
async function payout(direct = false): Promise<SignedPayout> {
  const base = { source: signer.address, destination, generation: 1, amount: direct ? "1000000" : "2000000" };
  if (direct) return { ...base, submission: { mode: "direct", rawTransaction: await signer.signTransaction({
    type: 2, chainId: 8453, nonce: 0, to: PAYOUT_USDC, value: 0,
    data: PAYOUT_ABI.encodeFunctionData("transfer", [destination, base.amount]), gasLimit: 60000,
    maxFeePerGas: 100, maxPriorityFeePerGas: 1,
  }) } };
  const authorization = { from: signer.address, to: destination, value: base.amount,
    validAfter: "0", validBefore: "2000000000", nonce: `0x${"33".repeat(32)}` };
  return { ...base, submission: { mode: "sponsored", authorization,
    signature: await signer.signTypedData(PAYOUT_DOMAIN, PAYOUT_TYPES, authorization) } };
}
function receipt(r: SignedPayout): PayoutReceipt {
  const logs = [{ address: PAYOUT_USDC,
    ...PAYOUT_ABI.encodeEventLog(PAYOUT_ABI.getEvent("Transfer")!, [r.source, r.destination, r.amount]) }];
  if (r.submission.mode === "sponsored") logs.push({ address: PAYOUT_USDC,
    ...PAYOUT_ABI.encodeEventLog(PAYOUT_ABI.getEvent("AuthorizationUsed")!, [r.source, r.submission.authorization.nonce]) });
  return { hash: r.submission.mode === "direct" ? Transaction.from(r.submission.rawTransaction).hash! : hash,
    blockNumber: 12, blockHash, status: 1, logs };
}

test("payout amount and sponsorship enforce exact decimal boundaries", () => {
  for (const input of ["0", "-1", "1e2", "NaN", "1.0000001", " 2", "02", "9".repeat(80)]) assert.throws(() => payoutAmount(input));
  for (const [amount, mode] of [["1", "direct"], ["1.000001", "sponsored"], ["50", "sponsored"], ["50.000001", "direct"]]) {
    assert.equal(payoutMode(payoutAmount(amount)), mode);
  }
});
test("success evidence binds the exact USDC transfer and sponsored authorization", async () => {
  for (const direct of [false, true]) {
    const r = await payout(direct);
    assert.equal(receiptHasPayout(r, receipt(r)), true);
    assert.equal(receiptHasPayout({ ...r, amount: "3" }, receipt(r)), false);
    assert.equal(receiptHasPayout(r, { ...receipt(r), logs: [] }), false);
    if (r.submission.mode === "sponsored") {
      assert.equal(verifyTypedData(PAYOUT_DOMAIN, PAYOUT_TYPES, r.submission.authorization, r.submission.signature), signer.address);
      assert.equal(receiptHasPayout(r, { ...receipt(r), logs: receipt(r).logs.slice(0, 1) }), false);
    }
  }
});
test("submit once and wait: confirmed, reverted and unknown outcomes never auto-retry", async t => {
  const original = globalThis.fetch;
  try {
    for (const direct of [true, false]) {
      for (const outcome of ["confirmed", "reverted", "timeout", "wrong-effect", "noncanonical", "lost-response"]) {
        await t.test(`${direct ? "direct" : "sponsored"}: ${outcome}`, async () => {
          const r = await payout(direct);
          let sends = 0;
          const reports: string[] = [];
          const provider = {
            send: async (method: string) => {
              if (method === "eth_chainId") return "0x2105";
              sends++;
              if (outcome === "lost-response") throw new Error("private provider payload");
              return receipt(r).hash;
            },
            getBlock: async () => ({ hash: outcome === "noncanonical" ? null : blockHash }),
            waitForTransaction: async (txHash: string, confirmations: number, timeout: number) => {
              assert.equal(txHash, receipt(r).hash); assert.equal(confirmations, 1); assert.equal(timeout, 120_000);
              if (outcome === "timeout") throw new Error("private provider payload");
              return { ...receipt(r), status: outcome === "reverted" ? 0 : 1,
                logs: outcome === "wrong-effect" ? [] : receipt(r).logs };
            },
          } as unknown as JsonRpcProvider;
          globalThis.fetch = async () => {
            sends++;
            if (outcome === "lost-response") throw new Error("private provider payload");
            return new Response(JSON.stringify({ network: "base", transaction: hash, success: false, pending: true }), { status: 202 });
          };
          const result = await executePayout(r, provider, "https://facilitator.test", value => reports.push(value));
          const expected = outcome === "confirmed" || (direct && outcome === "lost-response") ? "confirmed" :
            outcome === "reverted" ? "reverted" : "unknown";
          assert.equal(result.status, expected);
          assert.equal(sends, 1);
          assert.equal(reports.length, !direct && outcome === "lost-response" ? 0 : 1);
        });
      }
    }
  } finally { globalThis.fetch = original; }
});
