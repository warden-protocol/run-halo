import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { Interface, MaxUint256, Wallet } from "ethers";
import { ERC20_ABI, VAULT_ABI } from "@halo/vault-core";
import {
  buildSponsoredVaultDepositBundle,
  type DirectVaultFundingActionV1,
  type DirectVaultFundingReconciliation,
} from "halo-sdk";
import type { WalletCatalogV1 } from "../domain/walletCatalog";
import { WalletAccessError, type PrivyWalletAccessSession } from "../domain/walletAccess";
import {
  FileSponsoredVaultFundingStore,
  sponsoredVaultFundingPath,
  type SponsoredVaultFundingRecordV1,
} from "../infrastructure/fileSponsoredVaultFundingStore";
import { routePrivyVaultFunding } from "./sponsoredVaultFunding";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const APP_ID = "halo-test";
const WALLET_ID = "wallet-1";
const VAULT = "0x0000000000000000000000000000000000000003";
const SESSION = "0x0000000000000000000000000000000000000002";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const wallet = new Wallet(`0x${"33".repeat(32)}`);
const vault = new Interface(VAULT_ABI);
const token = new Interface(ERC20_ABI);

function action(kind: "approval" | "deposit" = "deposit"): DirectVaultFundingActionV1 {
  const deposit = {
    from: wallet.address,
    to: VAULT,
    chainId: "8453" as const,
    type: 2 as const,
    nonce: kind === "approval" ? "8" : "7",
    gasLimit: "100000",
    maxFeePerGas: "1000000000",
    maxPriorityFeePerGas: "500000000",
    value: "0" as const,
    data: vault.encodeFunctionData("deposit", [2_000_000n, SESSION]).toLowerCase(),
  };
  return {
    version: 1,
    kind,
    chainId: "8453",
    vaultAddress: VAULT,
    consumerAddress: wallet.address,
    sessionAddress: SESSION,
    targetBalanceBase: "2000000",
    amountBase: "2000000",
    vaultBalanceBase: "0",
    lockedTotalBase: "0",
    keyEpoch: "0",
    registeredSessionAddress: SESSION,
    ethBalanceWei: "0",
    usdcBalanceBase: "10000000",
    allowanceBase: kind === "approval" ? "0" : "2000000",
    pendingNonce: "7",
    observedBlockStart: 100,
    observedBlockEnd: 100,
    transaction: kind === "approval" ? {
      from: wallet.address,
      to: USDC,
      chainId: "8453",
      type: 2,
      nonce: "7",
      gasLimit: "100000",
      maxFeePerGas: "1000000000",
      maxPriorityFeePerGas: "500000000",
      value: "0",
      data: token.encodeFunctionData("approve", [VAULT, MaxUint256]).toLowerCase(),
    } : deposit,
    ...(kind === "approval" ? { followingDepositTransaction: deposit } : {}),
    requiredEthWei: kind === "approval" ? "200000000000000" : "100000000000000",
  };
}

function catalog(): WalletCatalogV1 {
  return {
    version: 1,
    generation: 4,
    selector: "privy",
    keystoreIdentity: null,
    privyAppId: APP_ID,
    privyIdentity: { backend: "privy", walletId: WALLET_ID, address: wallet.address },
  };
}

function session(): PrivyWalletAccessSession {
  return {
    version: 1,
    appId: APP_ID,
    walletId: WALLET_ID,
    identity: { backend: "privy", address: wallet.address },
    accessToken: "secret",
    refreshToken: "secret",
    expiresAt: "2026-09-04T13:00:00.000Z",
  };
}

class MemoryStore {
  record: SponsoredVaultFundingRecordV1 | null = null;
  history: SponsoredVaultFundingRecordV1[] = [];
  read(): SponsoredVaultFundingRecordV1 | null { return this.record; }
  write(record: SponsoredVaultFundingRecordV1): void {
    this.record = structuredClone(record);
    this.history.push(structuredClone(record));
  }
  clear(): void { this.record = null; }
}

class Mutex {
  private tail = Promise.resolve();
  async run<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await work(); } finally { release(); }
  }
}

type Reconciliation = {
  approval: DirectVaultFundingReconciliation | null;
  deposit: DirectVaultFundingReconciliation;
};

function harness(options: {
  kind?: "approval" | "deposit";
  reconciliations?: Reconciliation[];
  directRecord?: boolean;
  fetch: typeof fetch;
}) {
  const prepared = action(options.kind);
  const store = new MemoryStore();
  const mutex = new Mutex();
  const calls: string[] = [];
  const activeSession = session();
  const currentCatalog = catalog();
  const reconciliations = [...(options.reconciliations ?? [])];
  const client = {
    async prepareRoute() { return { mode: "sponsored" as const, action: prepared }; },
    async revalidateSponsored() { return true; },
    async reconcileSponsored(): Promise<Reconciliation> {
      return reconciliations.shift() ?? { approval: null, deposit: { status: "pending" } };
    },
  };
  const run = (targetBalanceBase: bigint | null = 2_000_000n) =>
    routePrivyVaultFunding({
      initialCatalog: currentCatalog,
      readCurrentCatalog: () => currentCatalog,
      consumerAddress: wallet.address,
      sessionAddress: SESSION,
      targetBalanceBase,
      facilitatorUrl: "https://facilitator.test",
      keyStore: {
        withScopeLock: <T>(work: () => Promise<T>) => mutex.run(work),
      } as never,
      directFundingStore: {
        read: () => options.directRecord ? ({} as never) : null,
        write() {},
        clear() {},
      },
      fundingStore: store,
      sessionStore: {
        readState: () => ({
          kind: "active" as const,
          record: { version: 1 as const, session: activeSession, refreshedAt: NOW.toISOString() },
        }),
        withRefreshLock: async <T>(work: () => Promise<T>) => work(),
      } as never,
      client,
      authorize: async () => ({
        sessionGeneration: NOW.toISOString(),
        authorization: {
          identity: activeSession.identity,
          session: activeSession,
          signPersonalMessage: (message: string) => wallet.signMessage(message),
          signEvmTransaction: (transaction) => wallet.signTransaction({
            ...transaction,
            chainId: BigInt(transaction.chainId),
            nonce: Number(transaction.nonce),
            gasLimit: BigInt(transaction.gasLimit),
            maxFeePerGas: BigInt(transaction.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
            value: BigInt(transaction.value),
            accessList: [],
          }),
          dispose() {},
        },
      }),
      fetchFn: async (url, init) => {
        calls.push(String(init?.body));
        return options.fetch(url, init);
      },
      now: () => NOW,
      sleep: async () => {},
    });
  return { calls, prepared, run, store };
}

function envelope(record: SponsoredVaultFundingRecordV1, input: {
  status: "confirmed" | "pending" | "rejected" | "reverted";
  operationId?: string | null;
  error?: { code: string; message: string; retryable: boolean };
  phase?: string;
}) {
  const initial = record.activeRequest === "initial";
  return {
    version: 1,
    status: input.status,
    phase: input.phase ?? (input.status === "confirmed" ? "complete" : "deposit"),
    operationId: input.operationId === undefined
      ? (initial ? record.bundle.initialOperationId : record.bundle.depositOnlyOperationId)
      : input.operationId,
    consumer: input.operationId === null ? null : record.action.consumerAddress,
    approvalTransaction: input.operationId === null
      ? null
      : initial ? record.bundle.approvalHash : null,
    depositTransaction: input.operationId === null ? null : record.bundle.depositHash,
    fundingTransactions: [],
    ...(input.error ? { error: input.error } : {}),
  };
}

test("deposit-only sponsorship durably fences the send and clears after canonical success", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({
    reconciliations: [{ approval: null, deposit: { status: "succeeded", blockNumber: 101 } }],
    fetch: async () => Response.json(envelope(h.store.record!, { status: "confirmed" })),
  });
  const result = await h.run();
  assert.equal(result.mode, "sponsored");
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.record, null);
  assert.deepEqual(h.store.history.map(({ state, sendGeneration }) => [state, sendGeneration]), [
    ["ready", 0], ["sending", 1], ["pending", 1],
  ]);
});

test("a durable direct-funding action blocks sponsored construction under the scope lock", async () => {
  const h = harness({
    directRecord: true,
    fetch: async () => { throw new Error("unexpected facilitator call"); },
  });
  await assert.rejects(h.run(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_direct_funding_pending");
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.record, null);
});

test("approval success plus deterministic stale rejection rebuilds only the deposit-only request", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({
    kind: "approval",
    reconciliations: [
      {
        approval: { status: "succeeded", blockNumber: 101 },
        deposit: { status: "pending" },
      },
      {
        approval: { status: "succeeded", blockNumber: 101 },
        deposit: { status: "succeeded", blockNumber: 102 },
      },
    ],
    fetch: async () => {
      const record = h.store.record!;
      return h.calls.length === 1
        ? Response.json(envelope(record, {
            status: "rejected",
            phase: "validation",
            error: { code: "approval_not_required", message: "stale", retryable: true },
          }), { status: 409 })
        : Response.json(envelope(record, { status: "confirmed" }));
    },
  });
  const result = await h.run();
  assert.equal(result.mode, "sponsored");
  assert.equal(h.calls.length, 2);
  assert.ok(JSON.parse(h.calls[0]).approveTransaction);
  assert.equal(JSON.parse(h.calls[1]).approveTransaction, undefined);
  assert.equal(h.store.record, null);
});

test("a completed deterministic rejection proves the generation unsent", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({
    fetch: async () => Response.json(envelope(h.store.record!, {
      status: "rejected",
      operationId: null,
      phase: "validation",
      error: { code: "deposit_below_minimum", message: "too small", retryable: false },
    }), { status: 400 }),
  });
  await assert.rejects(h.run(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_sponsored_funding_rejected");
  assert.equal(h.store.record?.sendGeneration, 1);
  assert.equal(h.store.record?.provenUnsentThroughGeneration, 1);
  assert.equal(h.store.record?.disposition, "terminal");
});

test("a lost response retries only the same body and retains an ambiguous generation fence", async () => {
  const h = harness({ fetch: async () => { throw new Error("disconnect"); } });
  await assert.rejects(h.run(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_sponsored_funding_ambiguous");
  assert.equal(h.calls.length, 3);
  assert.equal(new Set(h.calls).size, 1);
  assert.equal(h.store.record?.sendGeneration, 3);
  assert.equal(h.store.record?.provenUnsentThroughGeneration, 0);
  assert.equal(h.store.record?.state, "ambiguous");
});

test("a complete retryable 5xx response reuses the byte-identical body", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({
    reconciliations: [{ approval: null, deposit: { status: "succeeded", blockNumber: 103 } }],
    fetch: async () => h.calls.length === 1
      ? Response.json(envelope(h.store.record!, {
          status: "rejected",
          operationId: null,
          phase: "validation",
          error: { code: "service_unavailable", message: "retry", retryable: true },
        }), { status: 503 })
      : Response.json(envelope(h.store.record!, { status: "confirmed" })),
  });
  assert.equal((await h.run()).mode, "sponsored");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0], h.calls[1]);
  assert.equal(h.store.history.filter(({ state }) => state === "sending").length, 2);
});

test("a malformed success response is not automatically resent", async () => {
  const h = harness({ fetch: async () => Response.json({ version: 1, status: "confirmed" }) });
  await assert.rejects(h.run(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_sponsored_funding_ambiguous");
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.record?.state, "ambiguous");
});

test("canonical revert evidence terminalizes and retains the signed operation", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({
    reconciliations: [{ approval: null, deposit: { status: "reverted", blockNumber: 105 } }],
    fetch: async () => Response.json(envelope(h.store.record!, {
      status: "reverted",
      error: { code: "deposit_reverted", message: "reverted", retryable: false },
    }), { status: 409 }),
  });
  await assert.rejects(h.run(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_sponsored_funding_reverted");
  assert.equal(h.store.record?.state, "reverted");
  assert.equal(h.store.record?.evidence.depositStatus, "reverted");
  assert.equal(h.store.record?.evidence.depositBlock, "105");
});

test("restart reconciles pending canonical hashes without signing or posting again", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({
    reconciliations: [
      { approval: null, deposit: { status: "pending" } },
      { approval: null, deposit: { status: "succeeded", blockNumber: 104 } },
    ],
    fetch: async () => Response.json(envelope(h.store.record!, { status: "pending" }), { status: 202 }),
  });
  await assert.rejects(h.run(), (error: unknown) =>
    error instanceof WalletAccessError && error.code === "privy_sponsored_funding_pending");
  assert.equal(h.calls.length, 1);
  const result = await h.run(null);
  assert.equal(result.mode, "sponsored");
  assert.equal(h.calls.length, 1);
});

test("concurrent startup attempts serialize and the second observes pending work", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let h!: ReturnType<typeof harness>;
  h = harness({
    reconciliations: [{ approval: null, deposit: { status: "pending" } }],
    fetch: async () => {
      await gate;
      return Response.json(envelope(h.store.record!, { status: "pending" }), { status: 202 });
    },
  });
  const first = h.run();
  const second = h.run();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(h.calls.length, 1);
});

test("the file store persists mode 0600 and refuses sends after an ambiguous generation", async () => {
  const root = mkdtempSync(`${os.tmpdir()}/halo-sponsored-store-`);
  const scope = {
    chainId: 8453,
    vaultAddress: VAULT,
    consumerAddress: wallet.address,
    derivationVersion: 1,
  } as const;
  try {
    const prepared = action();
    const signed = await wallet.signTransaction({
      ...prepared.transaction,
      chainId: 8453,
      nonce: 7,
      gasLimit: 100000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 500000000n,
      value: 0n,
      accessList: [],
    });
    const bundle = buildSponsoredVaultDepositBundle({
      action: prepared,
      signedDepositTransaction: signed,
    });
    const initial: SponsoredVaultFundingRecordV1 = {
      version: 1,
      catalogGeneration: 4,
      sessionGeneration: NOW.toISOString(),
      sendGeneration: 0,
      provenUnsentThroughGeneration: 0,
      state: "ready",
      disposition: "ready",
      activeRequest: "initial",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      action: prepared,
      bundle,
      evidence: {
        approvalBlock: null,
        approvalStatus: null,
        depositBlock: null,
        depositStatus: null,
      },
      lastResponse: null,
    };
    const store = new FileSponsoredVaultFundingStore(scope, root);
    store.write(initial);
    assert.equal(statSync(sponsoredVaultFundingPath(scope, root)).mode & 0o777, 0o600);
    const sending = {
      ...initial,
      sendGeneration: 1,
      state: "sending" as const,
      disposition: "ambiguous" as const,
    };
    store.write(sending);
    const ambiguousRecord = { ...sending, state: "ambiguous" as const };
    store.write(ambiguousRecord);
    assert.throws(() => store.write({
      ...ambiguousRecord,
      sendGeneration: 2,
      state: "sending",
    }), (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_sponsored_funding_state_ambiguous");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
