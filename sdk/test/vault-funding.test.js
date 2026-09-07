const test = require("node:test");
const assert = require("node:assert/strict");
const { Interface, MaxUint256, Wallet } = require("ethers");
const { ERC20_ABI, VAULT_ABI } = require("@halo/vault-core");
const {
  DirectVaultFundingClient,
  DIRECT_FUNDING_APPROVAL_GAS_CAP,
  DIRECT_FUNDING_DEPOSIT_GAS_CAP,
  buildSponsoredVaultDepositBundle,
  parseDirectVaultFundingAction,
  parseSponsoredVaultDepositBundle,
} = require("../dist/vaultFunding");

const CONSUMER = "0x0000000000000000000000000000000000000001";
const SESSION = "0x0000000000000000000000000000000000000002";
const VAULT = "0x0000000000000000000000000000000000000003";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
const ORACLE = "0x420000000000000000000000000000000000000f";
const vault = new Interface(VAULT_ABI);
const token = new Interface(ERC20_ABI);
const multicall = new Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)",
]);
const oracle = new Interface([
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);

function fakeProvider(options = {}) {
  const state = {
    vaultBalance: options.vaultBalance ?? 0n,
    sessionKey: options.sessionKey ?? "0x0000000000000000000000000000000000000000",
    allowance: options.allowance ?? 0n,
    ethBalance: options.ethBalance ?? 10n ** 18n,
    receipt: null,
    transaction: null,
  };
  return {
    state,
    async request(method, params = []) {
      if (method === "eth_blockNumber") return "0x64";
      if (method === "eth_chainId") return "0x2105";
      if (method === "eth_getBalance") return `0x${state.ethBalance.toString(16)}`;
      if (method === "eth_getTransactionCount") return "0x7";
      if (method === "eth_gasPrice") return "0x3b9aca00";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x1dcd6500" };
      if (method === "eth_estimateGas") return "0x186a0";
      if (method === "eth_getTransactionReceipt") return state.receipt;
      if (method === "eth_getTransactionByHash") return state.transaction;
      if (method === "eth_call") {
        const call = params[0];
        const to = call.to.toLowerCase();
        if (to === MULTICALL) {
          const results = [
            vault.encodeFunctionResult("balance", [state.vaultBalance]),
            vault.encodeFunctionResult("lockedTotal", [0n]),
            vault.encodeFunctionResult("sessionKey", [state.sessionKey]),
            vault.encodeFunctionResult("keyEpoch", [0n]),
            token.encodeFunctionResult("balanceOf", [10_000_000n]),
            token.encodeFunctionResult("allowance", [state.allowance]),
          ].map((returnData) => ({ success: true, returnData }));
          return multicall.encodeFunctionResult("aggregate3", [results]);
        }
        if (to === ORACLE) {
          const methodName = call.data.startsWith(oracle.getFunction("getL1FeeUpperBound").selector)
            ? "getL1FeeUpperBound"
            : "getOperatorFee";
          return oracle.encodeFunctionResult(methodName, [1000n]);
        }
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  };
}

function client(provider) {
  return new DirectVaultFundingClient({
    provider,
    chainId: 8453,
    vaultAddress: VAULT,
  });
}

test("prepares a deposit-only action with exact snapshot and capped fee evidence", async () => {
  const provider = fakeProvider({ allowance: MaxUint256, sessionKey: SESSION });
  const action = await client(provider).prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(action.kind, "deposit");
  assert.equal(action.amountBase, "2000000");
  assert.equal(action.transaction.to, VAULT);
  assert.equal(action.transaction.nonce, "7");
  assert.ok(BigInt(action.transaction.gasLimit) <= DIRECT_FUNDING_DEPOSIT_GAS_CAP);
  assert.equal(action.followingDepositTransaction, undefined);
  assert.ok(BigInt(action.requiredEthWei) > 0n);
});

test("prepares approval then deposit and permits exact ETH liability", async () => {
  const firstProvider = fakeProvider();
  const first = await client(firstProvider).prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(first.kind, "approval");
  assert.equal(first.transaction.to, USDC);
  assert.equal(first.followingDepositTransaction.nonce, "8");
  assert.ok(BigInt(first.transaction.gasLimit) <= DIRECT_FUNDING_APPROVAL_GAS_CAP);
  assert.ok(BigInt(first.followingDepositTransaction.gasLimit) <= DIRECT_FUNDING_DEPOSIT_GAS_CAP);

  const exactProvider = fakeProvider({ ethBalance: BigInt(first.requiredEthWei) });
  const exact = await client(exactProvider).prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(exact.requiredEthWei, first.requiredEthWei);
});

test("rejects a journal action whose transaction target or nonce sequence changed", async () => {
  const action = await client(fakeProvider()).prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.throws(() =>
    parseDirectVaultFundingAction({
      ...action,
      followingDepositTransaction: {
        ...action.followingDepositTransaction,
        nonce: "9",
      },
    })
  );
  assert.throws(() =>
    parseDirectVaultFundingAction({
      ...action,
      transaction: { ...action.transaction, to: VAULT },
    })
  );
});

test("revalidates the full action and detects chain-state changes", async () => {
  const provider = fakeProvider({ allowance: MaxUint256, sessionKey: SESSION });
  const funding = client(provider);
  const action = await funding.prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(await funding.revalidate(action), true);
  provider.state.vaultBalance = 1n;
  assert.equal(await funding.revalidate(action), false);
});

test("rejects a different registered session key during preflight", async () => {
  const provider = fakeProvider({
    allowance: MaxUint256,
    sessionKey: "0x0000000000000000000000000000000000000004",
  });
  await assert.rejects(
    client(provider).prepare({
      consumerAddress: CONSUMER,
      sessionAddress: SESSION,
      targetBalanceBase: 2_000_000n,
    }),
    (error) => error?.code === "session_key_mismatch"
  );
});

test("known hashes bind the exact transaction before receipt reconciliation", async () => {
  const provider = fakeProvider({ allowance: MaxUint256, sessionKey: SESSION });
  const funding = client(provider);
  const action = await funding.prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  const hash = `0x${"ab".repeat(32)}`;
  provider.state.receipt = {
    transactionHash: hash,
    status: "0x1",
    blockNumber: "0x65",
  };
  provider.state.transaction = {
    from: action.transaction.from,
    to: action.transaction.to,
    input: action.transaction.data,
    nonce: "0x7",
    value: "0x0",
    chainId: "0x2105",
    gas: `0x${BigInt(action.transaction.gasLimit).toString(16)}`,
    maxFeePerGas: `0x${BigInt(action.transaction.maxFeePerGas).toString(16)}`,
    maxPriorityFeePerGas: `0x${BigInt(action.transaction.maxPriorityFeePerGas).toString(16)}`,
  };
  provider.state.vaultBalance = 2_000_000n;
  assert.deepEqual(await funding.reconcile(action, hash), {
    status: "succeeded",
    blockNumber: 101,
  });
  provider.state.transaction.to = USDC;
  await assert.rejects(funding.reconcile(action, hash), /does not match/);
});

test("reverted and unknown submissions remain distinct", async () => {
  const provider = fakeProvider({ allowance: MaxUint256, sessionKey: SESSION });
  const funding = client(provider);
  const action = await funding.prepare({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.deepEqual(await funding.reconcile(action, null), { status: "ambiguous" });
  const hash = `0x${"cd".repeat(32)}`;
  provider.state.receipt = {
    transactionHash: hash,
    status: "0x0",
    blockNumber: "0x66",
  };
  provider.state.transaction = {
    from: action.transaction.from,
    to: action.transaction.to,
    input: action.transaction.data,
    nonce: "0x7",
    value: "0x0",
    chainId: "0x2105",
    gas: `0x${BigInt(action.transaction.gasLimit).toString(16)}`,
    maxFeePerGas: `0x${BigInt(action.transaction.maxFeePerGas).toString(16)}`,
    maxPriorityFeePerGas: `0x${BigInt(action.transaction.maxPriorityFeePerGas).toString(16)}`,
  };
  assert.deepEqual(await funding.reconcile(action, hash), {
    status: "reverted",
    blockNumber: 102,
  });
});

test("selects sponsored only below the exact direct ETH liability", async () => {
  const fundedProvider = fakeProvider({ allowance: MaxUint256, sessionKey: SESSION });
  const fundedClient = client(fundedProvider);
  const direct = await fundedClient.prepareRoute({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(direct.mode, "direct");
  fundedProvider.state.ethBalance = BigInt(direct.action.requiredEthWei);
  assert.equal((await fundedClient.prepareRoute({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  })).mode, "direct");
  fundedProvider.state.ethBalance -= 1n;
  assert.equal((await fundedClient.prepareRoute({
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  })).mode, "sponsored");
});

test("builds and strictly re-parses approval plus deposit sponsored bodies", async () => {
  const wallet = new Wallet(`0x${"11".repeat(32)}`);
  const provider = fakeProvider({ ethBalance: 0n });
  const route = await client(provider).prepareRoute({
    consumerAddress: wallet.address,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(route.mode, "sponsored");
  assert.equal(route.action.kind, "approval");
  const approval = await wallet.signTransaction(route.action.transaction);
  const deposit = await wallet.signTransaction(route.action.followingDepositTransaction);
  const bundle = buildSponsoredVaultDepositBundle({
    action: route.action,
    signedApprovalTransaction: approval,
    signedDepositTransaction: deposit,
  });
  assert.equal(JSON.parse(bundle.initialRequestBody).approveTransaction, approval);
  assert.equal(JSON.parse(bundle.depositOnlyRequestBody).depositTransaction, deposit);
  assert.match(bundle.initialOperationId, /^0x[0-9a-f]{64}$/);
  assert.notEqual(bundle.initialOperationId, bundle.depositOnlyOperationId);
  assert.deepEqual(parseSponsoredVaultDepositBundle(bundle, route.action), bundle);
  assert.throws(() => parseSponsoredVaultDepositBundle({
    ...bundle,
    depositHash: `0x${"00".repeat(32)}`,
  }, route.action), /inconsistent/);
});

test("builds a deposit-only sponsored body and rejects an extra approval", async () => {
  const wallet = new Wallet(`0x${"22".repeat(32)}`);
  const provider = fakeProvider({
    allowance: MaxUint256,
    ethBalance: 0n,
    sessionKey: SESSION,
  });
  const route = await client(provider).prepareRoute({
    consumerAddress: wallet.address,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
  });
  assert.equal(route.mode, "sponsored");
  assert.equal(route.action.kind, "deposit");
  const deposit = await wallet.signTransaction(route.action.transaction);
  const bundle = buildSponsoredVaultDepositBundle({
    action: route.action,
    signedDepositTransaction: deposit,
  });
  assert.equal(bundle.approvalHash, null);
  assert.equal(bundle.initialRequestBody, bundle.depositOnlyRequestBody);
  await assert.rejects(
    async () => buildSponsoredVaultDepositBundle({
      action: route.action,
      signedApprovalTransaction: deposit,
      signedDepositTransaction: deposit,
    }),
    /cannot include an approval/
  );
});
