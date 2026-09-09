import prompts from "prompts";
import { Contract, formatUnits, getAddress, hexlify, randomBytes, type JsonRpcProvider, type TransactionRequest } from "ethers";
import { DEFAULT_FACILITATOR_URL, loadConfig } from "../config";
import { loadWallet } from "../wallet";
import { resolveWalletCatalog } from "../wallet-access/application/catalog";
import { PayoutError, PAYOUT_ABI, PAYOUT_DOMAIN, PAYOUT_TYPES, PAYOUT_USDC, payoutAmount, payoutMode,
  validatePayoutIntent, type PayoutIntent, type SignedPayout } from "../operatorPayout";
import { assertPayoutChain, executePayout, payoutFeeLiability, payoutProvider } from "../operatorPayoutRpc";

class PayoutInputError extends PayoutError {}
export function payoutIdentity(amount: bigint): PayoutIntent {
  const cfg = loadConfig();
  const catalog = resolveWalletCatalog(cfg).catalog;
  if (!catalog.privyIdentity) throw new PayoutInputError("Run halo login once to pin the Privy payout destination.");
  const intent = { source: getAddress(cfg.operator.address), destination: getAddress(catalog.privyIdentity.address),
    generation: catalog.generation, amount: amount.toString() };
  validatePayoutIntent(intent);
  return intent;
}
export function parseWithdrawArgs(args: string[]): bigint {
  if (args.length !== 1) throw new PayoutInputError("Usage: halo withdraw <usdc>");
  return payoutAmount(args[0]);
}
function printPayout(record: PayoutIntent, mode: string): void {
  console.log(`Source:      ${record.source}\nDestination: ${record.destination}\nAmount:      ${formatUnits(record.amount, 6)} USDC\nNetwork:     Base mainnet (8453)\nGas paid by: ${mode === "sponsored" ? "Halo facilitator" : "operator keystore (Base ETH)"}`);
}

export async function cmdWithdraw(args: string[], rpc?: JsonRpcProvider): Promise<void> {
  try { await withdraw(args, rpc); }
  catch (error) {
    // RPC errors can contain raw signed transactions and reusable authorization material.
    throw new Error(error instanceof PayoutError ? error.message :
      "Withdrawal stopped: identity, balance, keystore, or RPC validation failed.");
  }
}
async function withdraw(args: string[], rpc?: JsonRpcProvider): Promise<void> {
  const amount = parseWithdrawArgs(args);
  const cfg = loadConfig();
  const source = getAddress(cfg.operator.address);
  const provider = rpc ?? payoutProvider((process.env.BASE_RPC_URL || "https://mainnet.base.org").trim());
  const facilitator = cfg.facilitator?.url ?? DEFAULT_FACILITATOR_URL;
  try {
    await assertPayoutChain(provider);
    const intent = payoutIdentity(amount);
    if (intent.source !== source) throw new PayoutInputError("Operator identity changed. Run the command again.");
    const mode = payoutMode(amount);
    const usdc = new Contract(PAYOUT_USDC, PAYOUT_ABI, provider);
    const balance = BigInt(await usdc.balanceOf(source));
    if (balance < amount) throw new PayoutInputError("Insufficient USDC in the operator keystore wallet.");
    let tx: TransactionRequest | undefined;
    let gasBalance: bigint | undefined;
    let feeLiability: bigint | undefined;
    if (mode === "direct") {
      const nonce = await provider.getTransactionCount(source, "pending");
      if (nonce !== await provider.getTransactionCount(source, "latest")) throw new PayoutInputError("Operator has a pending transaction. Wait for it before a direct payout.");
      const fees = await provider.getFeeData();
      if (fees.maxFeePerGas === null || fees.maxPriorityFeePerGas === null) throw new PayoutInputError("Base fee quote unavailable.");
      const data = PAYOUT_ABI.encodeFunctionData("transfer", [intent.destination, intent.amount]);
      const gasLimit = (await provider.estimateGas({ from: source, to: PAYOUT_USDC, data })) * 120n / 100n;
      gasBalance = await provider.getBalance(source);

      tx = { type: 2, chainId: 8453, nonce, to: PAYOUT_USDC, value: 0n, data, gasLimit,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
      feeLiability = await payoutFeeLiability(provider, tx);
      if (gasBalance < feeLiability) throw new PayoutInputError("Direct payout requires more Base ETH for gas. Sponsorship covers only amounts above 1 and at most 50 USDC.");
      console.log(`Buffered gas budget (execution, L1 data, operator fee): ${formatUnits(feeLiability, 18)} ETH`);
    }
    printPayout(intent, mode);
    let passphrase = process.env.HALO_PASSPHRASE ?? "";
    if (!cfg.operator.noPassphrase && process.env.HALO_PASSPHRASE === undefined) {
      const answer = await prompts({ type: "password", name: "passphrase", message: "Operator keystore passphrase" });
      if (typeof answer.passphrase !== "string") return;
      passphrase = answer.passphrase;
    }
    if (cfg.operator.noPassphrase) passphrase = "";
    const wallet = await loadWallet(cfg.operator.keystorePath, passphrase);
    if (getAddress(wallet.address) !== source) throw new PayoutInputError("Decrypted keystore does not match the configured operator.");
    const recheck = async () => {
      await assertPayoutChain(provider);
      if (BigInt(await usdc.balanceOf(source)) !== balance) throw new PayoutInputError("USDC balance changed; run the command again.");
      if (tx && (await payoutFeeLiability(provider, tx) !== feeLiability || await provider.getBalance(source) !== gasBalance ||
          await provider.getTransactionCount(source, "pending") !== tx.nonce ||
          await provider.getTransactionCount(source, "latest") !== tx.nonce)) throw new PayoutInputError("Gas balance or nonce changed; run the command again.");
      const current = loadConfig();
      if (JSON.stringify(payoutIdentity(amount)) !== JSON.stringify(intent) || current.operator.keystorePath !== cfg.operator.keystorePath ||
          current.facilitator?.url !== cfg.facilitator?.url) throw new PayoutInputError("Payout identity or configuration changed; run the command again.");
    };
    const block = await provider.getBlock("latest");
    if (!block) throw new PayoutInputError("Base block unavailable.");
    let record: SignedPayout;
    await recheck();
    if (tx) {
      record = { ...intent, submission: { mode: "direct", rawTransaction: await wallet.signTransaction(tx) } };
    } else {
      const authorization = { from: source, to: intent.destination, value: intent.amount,
        validAfter: "0", validBefore: String(block.timestamp + 3600), nonce: hexlify(randomBytes(32)) };
      record = { ...intent, submission: { mode: "sponsored", authorization,
        signature: await wallet.signTypedData(PAYOUT_DOMAIN, PAYOUT_TYPES, authorization) } };
    }
    await recheck();
    const result = await executePayout(record, provider, facilitator, hash => console.log(`Transaction: ${hash}`));
    if (result.status === "confirmed") {
      console.log(`Transferred ${formatUnits(intent.amount, 6)} USDC to ${intent.destination}.`);
    } else if (result.status === "reverted") {
      console.log("Transaction reverted; no payout completed.");
      process.exitCode = 1;
    } else {
      console.log("Outcome unknown—check wallet activity before running again. A new invocation creates a new payment.");
      process.exitCode = 2;
    }
  } finally { provider.destroy(); }
}
