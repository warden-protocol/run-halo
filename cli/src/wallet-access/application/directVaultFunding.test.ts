import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Interface, MaxUint256 } from "ethers";
import { ERC20_ABI, VAULT_ABI } from "@halo/vault-core";
import type { DirectVaultFundingActionV1 } from "halo-sdk";
import type { WalletCatalogV1 } from "../domain/walletCatalog";
import type {
  PrivyWalletAccessSession,
  WalletAccessAuthorization,
} from "../domain/walletAccess";
import { WalletAccessError } from "../domain/walletAccess";
import {
  FileConsumeSessionKeyStore,
  type ConsumeSessionKeyStore,
} from "../infrastructure/fileConsumeSessionKeyStore";
import {
  FileDirectVaultFundingStore,
  directVaultFundingPath,
  type DirectVaultFundingRecordV1,
  type DirectVaultFundingStore,
} from "../infrastructure/fileDirectVaultFundingStore";
import type {
  PrivyReauthenticationRecord,
  PrivySessionRefreshStore,
  PrivyWalletAccessStoredState,
} from "./refresh";
import { fundPrivyVaultDirect } from "./directVaultFunding";

const CONSUMER = "0x0000000000000000000000000000000000000001";
const SESSION = "0x0000000000000000000000000000000000000002";
const VAULT = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;
const HASH_2 = `0x${"cd".repeat(32)}`;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const generation = "2026-09-04T00:00:00.000Z";
const vault = new Interface(VAULT_ABI);
const token = new Interface(ERC20_ABI);

function action(): DirectVaultFundingActionV1 {
  return {
    version: 1,
    kind: "deposit",
    chainId: "8453",
    vaultAddress: VAULT,
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: "2000000",
    amountBase: "2000000",
    vaultBalanceBase: "0",
    lockedTotalBase: "0",
    keyEpoch: "0",
    registeredSessionAddress: "0x0000000000000000000000000000000000000000",
    ethBalanceWei: "1000000000000000000",
    usdcBalanceBase: "2000000",
    allowanceBase: "2000000",
    pendingNonce: "7",
    observedBlockStart: 100,
    observedBlockEnd: 100,
    transaction: {
      from: CONSUMER,
      to: VAULT,
      chainId: "8453",
      type: 2,
      nonce: "7",
      gasLimit: "100000",
      maxFeePerGas: "1000000000",
      maxPriorityFeePerGas: "500000000",
      value: "0",
      data: vault.encodeFunctionData("deposit", ["2000000", SESSION]).toLowerCase(),
    },
    requiredEthWei: "100000000000000",
  };
}

function approvalAction(): DirectVaultFundingActionV1 {
  const deposit = action();
  return {
    ...deposit,
    kind: "approval",
    allowanceBase: "0",
    transaction: {
      ...deposit.transaction,
      to: USDC,
      gasLimit: "100000",
      data: token.encodeFunctionData("approve", [VAULT, MaxUint256]).toLowerCase(),
    },
    followingDepositTransaction: {
      ...deposit.transaction,
      nonce: "8",
      gasLimit: "1000000",
    },
    requiredEthWei: "1100000000000000",
  };
}

const catalog: WalletCatalogV1 = {
  version: 1,
  selector: "privy",
  generation: 4,
  keystoreIdentity: null,
  privyIdentity: { backend: "privy", address: CONSUMER, walletId: "wallet-1" },
  privyAppId: "app_test_123",
};

const session: PrivyWalletAccessSession = {
  version: 1,
  identity: { backend: "privy", address: CONSUMER },
  expiresAt: "2099-01-01T00:00:00.000Z",
  appId: "app_test_123",
  walletId: "wallet-1",
  accessToken: "not-persisted-here",
  refreshToken: "not-persisted-here",
};

const fundingScope = {
  chainId: 8453 as const,
  vaultAddress: VAULT,
  consumerAddress: CONSUMER,
  derivationVersion: 1 as const,
};

class MemoryKeyStore implements ConsumeSessionKeyStore {
  locked = false;
  read() { return null; }
  write(): void {}
  async withScopeLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    assert.equal(this.locked, false);
    this.locked = true;
    try {
      return await operation();
    } finally {
      this.locked = false;
    }
  }
}

class MemoryFundingStore implements DirectVaultFundingStore {
  value: DirectVaultFundingRecordV1 | null = null;
  read() { return this.value; }
  write(record: DirectVaultFundingRecordV1) { this.value = structuredClone(record); }
  clear() { this.value = null; }
}

class MemorySessionStore implements PrivySessionRefreshStore {
  locked = false;
  state: PrivyWalletAccessStoredState = {
    kind: "active",
    record: {
      version: 1,
      state: "active",
      session,
      verifiedAt: generation,
      refreshedAt: generation,
    },
  };
  readState() { return this.state; }
  read() { return this.state.kind === "active" ? this.state.record : null; }
  write(): void {}
  clear(): void {}
  writeReauthenticationRequired(_record: PrivyReauthenticationRecord): void {}
  async withRefreshLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    assert.equal(this.locked, false);
    this.locked = true;
    try {
      return await operation();
    } finally {
      this.locked = false;
    }
  }
}

test("direct-funding store persists and clears a strict mode-0600 action", () => {
  const root = mkdtempSync(path.join(tmpdir(), "halo-direct-funding-"));
  try {
    const store = new FileDirectVaultFundingStore(fundingScope, root);
    const record: DirectVaultFundingRecordV1 = {
      version: 1,
      catalogGeneration: 4,
      sessionGeneration: generation,
      referenceId: "halo_reference_1",
      sendState: "sending",
      transactionHash: null,
      providerTransactionId: null,
      createdAt: generation,
      updatedAt: generation,
      action: action(),
    };
    store.write(record);
    assert.deepEqual(store.read(), record);
    assert.equal(statSync(directVaultFundingPath(fundingScope, root)).mode & 0o777, 0o600);
    const submitted: DirectVaultFundingRecordV1 = {
      ...record,
      sendState: "submitted",
      transactionHash: HASH,
    };
    store.write(submitted);
    assert.deepEqual(store.read(), submitted);
    store.clear();
    assert.equal(store.read(), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent direct funding cannot pass the scoped preflight lock", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "halo-direct-funding-lock-"));
  let releasePrepare!: () => void;
  let markPrepareStarted!: () => void;
  const prepareHeld = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const prepareStarted = new Promise<void>((resolve) => {
    markPrepareStarted = resolve;
  });
  let prepares = 0;
  let authorizations = 0;
  const client = {
    prepare: async () => {
      prepares += 1;
      markPrepareStarted();
      await prepareHeld;
      return null;
    },
    revalidate: async () => true,
    reconcile: async () => ({ status: "pending" as const }),
  };
  const invoke = (keyStore: ConsumeSessionKeyStore) =>
    fundPrivyVaultDirect({
      initialCatalog: catalog,
      readCurrentCatalog: () => catalog,
      consumerAddress: CONSUMER,
      sessionAddress: SESSION,
      targetBalanceBase: 2_000_000n,
      keyStore,
      fundingStore: new MemoryFundingStore(),
      sessionStore: new MemorySessionStore(),
      client,
      authorize: async () => {
        authorizations += 1;
        throw new Error("must not authorize");
      },
    });
  let first: ReturnType<typeof invoke> | null = null;
  try {
    first = invoke(new FileConsumeSessionKeyStore(fundingScope, root));
    await prepareStarted;
    await assert.rejects(
      invoke(
        new FileConsumeSessionKeyStore(fundingScope, root, {
          timeoutMs: 0,
          retryMs: 1,
        })
      ),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_consume_key_lock_unavailable"
    );
    assert.equal(prepares, 1);
    releasePrepare();
    assert.deepEqual(await first, { funded: false, transactionHashes: [] });
    assert.equal(authorizations, 0);
  } finally {
    releasePrepare();
    await first?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct funding persists before send and clears only after observed success", async () => {
  const fundingStore = new MemoryFundingStore();
  const keyStore = new MemoryKeyStore();
  const sessionStore = new MemorySessionStore();
  const observedStates: string[] = [];
  const authorization: WalletAccessAuthorization<PrivyWalletAccessSession> = {
    identity: session.identity,
    session,
    signPersonalMessage: async () => "unused",
    sendEvmTransaction: async (_transaction, referenceId) => {
      assert.equal(keyStore.locked, true);
      assert.equal(sessionStore.locked, true);
      observedStates.push(fundingStore.read()?.sendState ?? "absent");
      return {
        transactionHash: HASH,
        providerTransactionId: "provider-1",
        referenceId,
      };
    },
    dispose: () => {},
  };
  const result = await fundPrivyVaultDirect({
    initialCatalog: catalog,
    readCurrentCatalog: () => catalog,
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
    keyStore,
    fundingStore,
    sessionStore,
    client: {
      prepare: async () => action(),
      revalidate: async () => true,
      reconcile: async () => ({ status: "succeeded", blockNumber: 101 }),
    },
    authorize: async () => ({ authorization, sessionGeneration: generation }),
    referenceId: () => "halo_reference_1",
  });
  assert.deepEqual(observedStates, ["sending"]);
  assert.deepEqual(result, { funded: true, transactionHashes: [HASH] });
  assert.equal(fundingStore.read(), null);
  assert.equal(keyStore.locked, false);
  assert.equal(sessionStore.locked, false);
});

test("ambiguous submission remains fenced and is never sent twice", async () => {
  const fundingStore = new MemoryFundingStore();
  let sends = 0;
  const authorization: WalletAccessAuthorization<PrivyWalletAccessSession> = {
    identity: session.identity,
    session,
    signPersonalMessage: async () => "unused",
    sendEvmTransaction: async () => {
      sends += 1;
      throw new WalletAccessError("privy_rpc_ambiguous", "response lost");
    },
    dispose: () => {},
  };
  const invoke = () =>
    fundPrivyVaultDirect({
      initialCatalog: catalog,
      readCurrentCatalog: () => catalog,
      consumerAddress: CONSUMER,
      sessionAddress: SESSION,
      targetBalanceBase: 2_000_000n,
      keyStore: new MemoryKeyStore(),
      fundingStore,
      sessionStore: new MemorySessionStore(),
      client: {
        prepare: async () => action(),
        revalidate: async () => true,
        reconcile: async (_action, hash) =>
          hash === null ? { status: "ambiguous" } : { status: "pending" },
      },
      authorize: async () => ({ authorization, sessionGeneration: generation }),
      referenceId: () => "halo_reference_1",
    });
  await assert.rejects(invoke(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_direct_funding_ambiguous"
  );
  assert.equal(fundingStore.read()?.sendState, "ambiguous");
  await assert.rejects(invoke(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_direct_funding_ambiguous"
  );
  assert.equal(sends, 1);
});

test("a definite pre-send rejection clears the journal for a later explicit retry", async () => {
  const fundingStore = new MemoryFundingStore();
  const authorization: WalletAccessAuthorization<PrivyWalletAccessSession> = {
    identity: session.identity,
    session,
    signPersonalMessage: async () => "unused",
    sendEvmTransaction: async () => {
      throw new WalletAccessError("privy_rpc_error", "definitely rejected");
    },
    dispose: () => {},
  };
  await assert.rejects(
    fundPrivyVaultDirect({
      initialCatalog: catalog,
      readCurrentCatalog: () => catalog,
      consumerAddress: CONSUMER,
      sessionAddress: SESSION,
      targetBalanceBase: 2_000_000n,
      keyStore: new MemoryKeyStore(),
      fundingStore,
      sessionStore: new MemorySessionStore(),
      client: {
        prepare: async () => action(),
        revalidate: async () => true,
        reconcile: async () => ({ status: "pending" }),
      },
      authorize: async () => ({ authorization, sessionGeneration: generation }),
      referenceId: () => "halo_reference_1",
    }),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_rpc_error"
  );
  assert.equal(fundingStore.read(), null);
});

test("restart reconciles a known hash without another provider submission", async () => {
  const fundingStore = new MemoryFundingStore();
  fundingStore.value = {
    version: 1,
    catalogGeneration: 4,
    sessionGeneration: generation,
    referenceId: "halo_reference_1",
    sendState: "submitted",
    transactionHash: HASH,
    providerTransactionId: "provider-1",
    createdAt: generation,
    updatedAt: generation,
    action: action(),
  };
  let authorizations = 0;
  const result = await fundPrivyVaultDirect({
    initialCatalog: catalog,
    readCurrentCatalog: () => catalog,
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
    keyStore: new MemoryKeyStore(),
    fundingStore,
    sessionStore: new MemorySessionStore(),
    client: {
      prepare: async () => null,
      revalidate: async () => true,
      reconcile: async (_action, hash) => {
        assert.equal(hash, HASH);
        return { status: "succeeded", blockNumber: 101 };
      },
    },
    authorize: async () => {
      authorizations += 1;
      throw new Error("must not authorize");
    },
  });
  assert.deepEqual(result, { funded: true, transactionHashes: [HASH] });
  assert.equal(authorizations, 0);
  assert.equal(fundingStore.read(), null);
});

test("a mined revert clears the journal without resubmitting in the same run", async () => {
  const fundingStore = new MemoryFundingStore();
  fundingStore.value = {
    version: 1,
    catalogGeneration: 4,
    sessionGeneration: generation,
    referenceId: "halo_reference_1",
    sendState: "submitted",
    transactionHash: HASH,
    providerTransactionId: "provider-1",
    createdAt: generation,
    updatedAt: generation,
    action: action(),
  };
  let prepared = 0;
  let authorizations = 0;
  await assert.rejects(
    fundPrivyVaultDirect({
      initialCatalog: catalog,
      readCurrentCatalog: () => catalog,
      consumerAddress: CONSUMER,
      sessionAddress: SESSION,
      targetBalanceBase: 2_000_000n,
      keyStore: new MemoryKeyStore(),
      fundingStore,
      sessionStore: new MemorySessionStore(),
      client: {
        prepare: async () => {
          prepared += 1;
          return action();
        },
        revalidate: async () => true,
        reconcile: async () => ({ status: "reverted", blockNumber: 101 }),
      },
      authorize: async () => {
        authorizations += 1;
        throw new Error("must not authorize");
      },
    }),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_direct_funding_reverted"
  );
  assert.equal(fundingStore.read(), null);
  assert.equal(prepared, 0);
  assert.equal(authorizations, 0);
});

test("approval confirmation forces a fresh deposit action and second nonce", async () => {
  const fundingStore = new MemoryFundingStore();
  const deposit = action();
  const prepared = [
    approvalAction(),
    { ...deposit, pendingNonce: "8", transaction: { ...deposit.transaction, nonce: "8" } },
  ];
  const sentNonces: string[] = [];
  const hashes = [HASH, HASH_2];
  const authorization: WalletAccessAuthorization<PrivyWalletAccessSession> = {
    identity: session.identity,
    session,
    signPersonalMessage: async () => "unused",
    sendEvmTransaction: async (transaction, referenceId) => ({
      transactionHash: hashes[sentNonces.push(transaction.nonce) - 1],
      providerTransactionId: `provider-${sentNonces.length}`,
      referenceId,
    }),
    dispose: () => {},
  };
  const result = await fundPrivyVaultDirect({
    initialCatalog: catalog,
    readCurrentCatalog: () => catalog,
    consumerAddress: CONSUMER,
    sessionAddress: SESSION,
    targetBalanceBase: 2_000_000n,
    keyStore: new MemoryKeyStore(),
    fundingStore,
    sessionStore: new MemorySessionStore(),
    client: {
      prepare: async () => prepared.shift() ?? null,
      revalidate: async () => true,
      reconcile: async () => ({ status: "succeeded", blockNumber: 101 }),
    },
    authorize: async () => ({ authorization, sessionGeneration: generation }),
    referenceId: () => `halo_reference_${3 - prepared.length}`,
  });
  assert.deepEqual(sentNonces, ["7", "8"]);
  assert.deepEqual(result.transactionHashes, [HASH, HASH_2]);
});

test("catalog replacement invalidates every action before transaction authorization", async () => {
  let sends = 0;
  const authorization: WalletAccessAuthorization<PrivyWalletAccessSession> = {
    identity: session.identity,
    session,
    signPersonalMessage: async () => "unused",
    sendEvmTransaction: async () => {
      sends += 1;
      throw new Error("must not send");
    },
    dispose: () => {},
  };
  await assert.rejects(
    fundPrivyVaultDirect({
      initialCatalog: catalog,
      readCurrentCatalog: () => ({ ...catalog, generation: catalog.generation + 1 }),
      consumerAddress: CONSUMER,
      sessionAddress: SESSION,
      targetBalanceBase: 2_000_000n,
      keyStore: new MemoryKeyStore(),
      fundingStore: new MemoryFundingStore(),
      sessionStore: new MemorySessionStore(),
      client: {
        prepare: async () => action(),
        revalidate: async () => true,
        reconcile: async () => ({ status: "pending" }),
      },
      authorize: async () => ({ authorization, sessionGeneration: generation }),
      sleep: async () => {},
    }),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_direct_funding_preflight_unavailable"
  );
  assert.equal(sends, 0);
});
