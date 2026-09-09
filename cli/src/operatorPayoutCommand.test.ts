import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import prompts from "prompts";
import { Interface, Transaction, Wallet, type JsonRpcProvider } from "ethers";
import { configDir, saveConfig, type HaloConfigV1 } from "./config";
import { selectPrivyWallet, forgetPrivyWallet } from "./wallet-access/application/catalog";
import { cmdWithdraw, parseWithdrawArgs } from "./commands/withdraw";
import { PAYOUT_ABI, PAYOUT_USDC, type SignedPayout } from "./operatorPayout";
import { shouldPreRunUpdate } from "./commandGating";

const wallet = new Wallet(`0x${"44".repeat(32)}`);
const destination = new Wallet(`0x${"55".repeat(32)}`).address;
const hash = `0x${"aa".repeat(32)}`;
const blockHash = `0x${"bb".repeat(32)}`;
const oracle = new Interface(["function getL1FeeUpperBound(uint256) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"]);

class Rpc {
  balance = 100_000_000n;
  eth = 0n;
  chain = "0x2105";
  nonce = 0;
  timeout = false;
  failRead = false;
  onBalance?: () => void;
  raws: string[] = [];
  payout: SignedPayout | null = null;
  async send(method: string, params: string[]): Promise<unknown> {
    if (method === "eth_chainId") return this.chain;
    if (method === "eth_sendRawTransaction") {
      this.raws.push(params[0]);
      const tx = Transaction.from(params[0]);
      const args = PAYOUT_ABI.decodeFunctionData("transfer", tx.data);
      this.payout = { source: tx.from!, destination: args[0], amount: args[1].toString(), generation: 1,
        submission: { mode: "direct", rawTransaction: params[0] } };
      return tx.hash;
    }
    throw new Error(`unexpected RPC ${method}`);
  }
  async call(tx: { to: string; data: string }): Promise<string> {
    if (this.failRead) throw new Error("RPC secret fixture must be suppressed");
    if (tx.to.toLowerCase() !== PAYOUT_USDC.toLowerCase()) {
      const parsed = oracle.parseTransaction(tx)!;
      return oracle.encodeFunctionResult(parsed.name, [100n]);
    }
    this.onBalance?.();
    return PAYOUT_ABI.encodeFunctionResult("balanceOf", [this.balance]);
  }
  async getBalance() { return this.eth; }
  async getTransactionCount() { return this.nonce; }
  async getFeeData() { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; }
  async estimateGas() { return 50000n; }
  async getBlock() { return { number: 100, timestamp: 1800000000, hash: blockHash }; }
  async waitForTransaction(txHash: string) {
    if (this.timeout) throw new Error("private timeout payload");
    const r = this.payout!;
    const logs = [{ address: PAYOUT_USDC, ...PAYOUT_ABI.encodeEventLog(PAYOUT_ABI.getEvent("Transfer")!, [r.source, r.destination, r.amount]) }];
    if (r.submission.mode === "sponsored") logs.push({ address: PAYOUT_USDC,
      ...PAYOUT_ABI.encodeEventLog(PAYOUT_ABI.getEvent("AuthorizationUsed")!, [r.source, r.submission.authorization.nonce]) });
    return { hash: txHash, blockNumber: 105, blockHash, status: 1, logs };
  }
  destroy() {}
}

test("withdraw accepts only an amount and uses normal short-command update policy", () => {
  for (const args of [[], ["1", "--force"], ["--status"], ["--retry"], ["--recipient", destination]]) assert.throws(() => parseWithdrawArgs(args));
  assert.equal(parseWithdrawArgs(["2"]), 2_000_000n);
  assert.equal(shouldPreRunUpdate("withdraw"), true);
});

test("operator payout command submits and waits without creating payout state", async t => {
  const encrypted = await wallet.encrypt("");
  async function fixture(run: (rpc: Rpc, posts: string[], config: ReturnType<typeof selectPrivyWallet>, output: string[]) => Promise<void>) {
    const root = mkdtempSync(path.join(tmpdir(), "halo-payout-command-"));
    const oldHome = process.env.HOME;
    const oldFetch = globalThis.fetch;
    const oldExit = process.exitCode;
    const oldLog = console.log;
    const output: string[] = [];
    process.env.HOME = root;
    console.log = (...args) => { output.push(args.join(" ")); };
    const cfg: HaloConfigV1 = { version: 1, relayUrl: "https://relay.test", indexerUrl: "https://indexer.test",
      operator: { address: wallet.address, keystorePath: path.join(root, "keystore.json"), noPassphrase: true },
      provider: { slug: "test", baseUrl: "https://provider.test", models: ["test"] },
      pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, fallbackPerRequestUsdc: 0.01 },
      facilitator: { url: "https://facilitator.test" } };
    const selected = selectPrivyWallet(cfg, { address: destination, walletId: "test-wallet", appId: "test-app" });
    const rpc = new Rpc();
    const posts: string[] = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      posts.push(String(options!.body));
      rpc.payout = { source: body.authorization.from, destination: body.authorization.to, amount: body.authorization.value,
        generation: 1, submission: { mode: "sponsored", authorization: body.authorization, signature: body.signature } };
      return new Response(JSON.stringify({ network: "base", transaction: hash, success: false, pending: true }), { status: 202 });
    };
    try {
      saveConfig(selected);
      writeFileSync(cfg.operator.keystorePath, encrypted, { mode: 0o600 });
      await run(rpc, posts, selected, output);
      assert.equal(existsSync(path.join(configDir(), "operator-payout")), false);
      assert.ok(output.every(line => !line.includes("secret fixture")));
    } finally {
      prompts.override({});
      globalThis.fetch = oldFetch; console.log = oldLog; process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      rmSync(root, { recursive: true, force: true });
    }
  }
  const command = async (args: string[], rpc: Rpc) => {
    process.exitCode = 0;
    await cmdWithdraw(args, rpc as unknown as JsonRpcProvider);
  };
  await t.test("zero-ETH sponsorship waits for a receipt and reports the transfer", () => fixture(async (rpc, posts, _cfg, output) => {
    await command(["2"], rpc);
    assert.equal(posts.length, 1); assert.equal(process.exitCode, 0);
    assert.ok(output.some(line => line.includes("Transferred 2.0 USDC")));
    assert.ok(output.some(line => line.includes(hash)));
    assert.equal(rpc.payout!.source, wallet.address); assert.equal(rpc.payout!.destination, destination);
  }));
  await t.test("timeout reports uncertainty; another invocation creates a fresh payment", () => fixture(async (rpc, posts, _cfg, output) => {
    rpc.timeout = true;
    await command(["2"], rpc);
    assert.equal(process.exitCode, 2);
    assert.ok(output.some(line => line.includes("Outcome unknown")));
    assert.ok(!output.some(line => line.includes("Transferred")));
    await command(["2"], rpc);
    assert.equal(posts.length, 2);
    assert.notEqual(JSON.parse(posts[0]).authorization.nonce, JSON.parse(posts[1]).authorization.nonce);
  }));
  await t.test("direct payout includes Base data fees and confirms the keystore transfer", () => fixture(async (rpc, posts) => {
    rpc.eth = 600229n;
    await assert.rejects(command(["1"], rpc), /more Base ETH/);
    rpc.eth = 600230n;
    await command(["1"], rpc);
    assert.equal(process.exitCode, 0); assert.equal(rpc.raws.length, 1); assert.equal(posts.length, 0);
    const tx = Transaction.from(rpc.raws[0]);
    assert.equal(tx.from, wallet.address); assert.equal(tx.chainId, 8453n);
    assert.equal(tx.data, PAYOUT_ABI.encodeFunctionData("transfer", [destination, 1_000_000]));
  }));
  await t.test("wrong chain, insufficient funds and forgotten destination stop before sending", () => fixture(async (rpc, posts, selected) => {
    rpc.chain = "0x1"; await assert.rejects(command(["2"], rpc));
    rpc.chain = "0x2105"; rpc.balance = 1n; await assert.rejects(command(["2"], rpc), /Insufficient USDC/);
    rpc.balance = 100_000_000n;
    saveConfig(forgetPrivyWallet(selected, destination)); await assert.rejects(command(["2"], rpc), /halo login/);
    assert.equal(posts.length, 0); assert.equal(rpc.raws.length, 0);
  }));
  await t.test("a mismatched decrypted keystore cannot submit", () => fixture(async (rpc, posts, selected) => {
    const other = Wallet.createRandom();
    writeFileSync(selected.operator.keystorePath, await other.encrypt(""), { mode: 0o600 });
    await assert.rejects(command(["2"], rpc), /does not match/);
    assert.equal(posts.length, 0); assert.equal(rpc.raws.length, 0);
  }));
  await t.test("catalog changes during preparation stop submission", () => fixture(async (rpc, posts, selected) => {
    let reads = 0;
    rpc.onBalance = () => { if (++reads === 2) saveConfig(forgetPrivyWallet(selected, destination)); };
    await assert.rejects(command(["2"], rpc));
    assert.equal(posts.length, 0);
  }));
  await t.test("invocation authorizes payment without confirmation or Privy session tokens", () => fixture(async (rpc, posts) => {
    writeFileSync(path.join(configDir(), "wallet-access-session.json"), "expired-session-fixture", { mode: 0o600 });
    prompts.override({ confirmed: false });
    await command(["2"], rpc);
    assert.equal(posts.length, 1);
    assert.equal(process.exitCode, 0);
  }));
  await t.test("protected keystores still prompt only for their passphrase", () => fixture(async (rpc, posts, selected) => {
    const previous = process.env.HALO_PASSPHRASE;
    delete process.env.HALO_PASSPHRASE;
    try {
      saveConfig({ ...selected, operator: { ...selected.operator, noPassphrase: false } });
      prompts.inject([""]);
      await command(["2"], rpc);
      assert.equal(posts.length, 1);
    } finally {
      if (previous === undefined) delete process.env.HALO_PASSPHRASE;
      else process.env.HALO_PASSPHRASE = previous;
    }
  }));
  await t.test("RPC errors cannot expose provider payloads", () => fixture(async rpc => {
    rpc.failRead = true;
    await assert.rejects(command(["2"], rpc), error => !String(error).includes("secret fixture"));
  }));
});
