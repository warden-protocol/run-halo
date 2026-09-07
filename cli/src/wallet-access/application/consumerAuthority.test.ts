import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VoidSigner, Wallet, verifyTypedData } from "ethers";
import {
  RECEIPT_TYPES,
  RESERVE_TYPES,
  deriveSubKeyPrivateKey,
  subKeyDerivationMessage,
  vaultDomain,
} from "@halo/vault-core";
import { payInference } from "halo-sdk";
import { VaultConsumeClient } from "../../vault-consume";
import { WalletAccessError, type PrivyWalletAccessSession } from "../domain/walletAccess";
import type { WalletCatalogV1 } from "../domain/walletCatalog";
import type {
  ConsumeSessionKeyRecordV1,
  ConsumeSessionKeyStore,
} from "../infrastructure/fileConsumeSessionKeyStore";
import type { PrivyWalletAccessStoredState } from "./refresh";
import {
  readPrivyConsumeVaultPreflight,
  resolvePrivyConsumerAuthority,
} from "./consumerAuthority";

const owner = new Wallet(`0x${"4".repeat(64)}`);
const other = new Wallet(`0x${"5".repeat(64)}`);
const vaultAddress = "0x1111111111111111111111111111111111111111";
const appId = "privy_app_1108";
const walletId = "wallet-1108";
const catalog: WalletCatalogV1 = {
  version: 1,
  selector: "privy",
  generation: 1,
  keystoreIdentity: null,
  privyIdentity: { backend: "privy", address: owner.address, walletId },
  privyAppId: appId,
};
const session: PrivyWalletAccessSession = {
  version: 1,
  identity: { backend: "privy", address: owner.address },
  appId,
  walletId,
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const active = {
  kind: "active",
  record: {
    version: 1,
    state: "active",
    session,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    refreshedAt: "2026-01-01T00:00:00.000Z",
  },
} as const satisfies PrivyWalletAccessStoredState;

class MemoryKeyStore implements ConsumeSessionKeyStore {
  record: ConsumeSessionKeyRecordV1 | null = null;
  writes = 0;
  read(): ConsumeSessionKeyRecordV1 | null {
    return this.record;
  }
  write(record: ConsumeSessionKeyRecordV1): void {
    this.writes += 1;
    this.record = record;
  }
  withScopeLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    return operation();
  }
}

function dependencies(signer = owner) {
  const keyStore = new MemoryKeyStore();
  let signatures = 0;
  let resumes = 0;
  return {
    keyStore,
    counts: () => ({ signatures, resumes }),
    sessionStore: {
      read: () => active.record,
      readState: () => active,
      write: () => {},
      clear: () => {},
      writeReauthenticationRequired: () => {},
      withRefreshLock: async <Result>(operation: () => Promise<Result>) => operation(),
    },
    gateway: {
      authorize: async () => {
        throw new Error("not used");
      },
      refresh: async () => session,
      resume: async () => {
        resumes += 1;
        return {
          identity: session.identity,
          session,
          signPersonalMessage: async (message: string) => {
            signatures += 1;
            return signer.signMessage(message);
          },
          dispose: () => {},
        };
      },
    },
  };
}

const scope = {
  chainId: 8453 as const,
  vaultAddress,
  consumerAddress: owner.address,
  derivationVersion: 1 as const,
};

test("first Privy consume derives once, persists before return, and restores without Wallet Access", async () => {
  const deps = dependencies();
  const first = await resolvePrivyConsumerAuthority({ catalog, scope, ...deps });
  assert.equal(first.restored, false);
  assert.deepEqual(deps.counts(), { signatures: 1, resumes: 1 });
  assert.equal(deps.keyStore.writes, 1);
  const expectedSignature = await owner.signMessage(subKeyDerivationMessage(owner.address));
  assert.equal(first.sessionWallet.privateKey, deriveSubKeyPrivateKey(expectedSignature));

  const restored = await resolvePrivyConsumerAuthority({
    catalog,
    scope,
    keyStore: deps.keyStore,
    sessionStore: { ...deps.sessionStore, readState: () => ({ kind: "absent" as const }) },
    gateway: {
      ...deps.gateway,
      resume: async () => {
        throw new Error("restored state must not call Privy");
      },
    },
  });
  assert.equal(restored.restored, true);
  assert.deepEqual(deps.counts(), { signatures: 1, resumes: 1 });
});

test("a signature for another owner fails closed without persisting a fallback", async () => {
  const deps = dependencies(other);
  await assert.rejects(
    resolvePrivyConsumerAuthority({ catalog, scope, ...deps }),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_consume_signature_incompatible"
  );
  assert.equal(deps.keyStore.record, null);
  assert.deepEqual(deps.counts(), { signatures: 1, resumes: 1 });
});

test("missing first-use authorization requires login before any signature", async () => {
  const deps = dependencies();
  await assert.rejects(
    resolvePrivyConsumerAuthority({
      catalog,
      scope,
      ...deps,
      sessionStore: { ...deps.sessionStore, readState: () => ({ kind: "absent" as const }) },
    }),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_login_required"
  );
  assert.deepEqual(deps.counts(), { signatures: 0, resumes: 0 });
});

test("a changed saved identity fails before first-use signing", async () => {
  const deps = dependencies();
  const changed = {
    ...active,
    record: {
      ...active.record,
      session: {
        ...active.record.session,
        walletId: "another-wallet",
        identity: { backend: "privy" as const, address: other.address },
      },
    },
  };
  await assert.rejects(
    resolvePrivyConsumerAuthority({
      catalog,
      scope,
      ...deps,
      sessionStore: { ...deps.sessionStore, readState: () => changed },
    }),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_wallet_identity_changed"
  );
  assert.deepEqual(deps.counts(), { signatures: 0, resumes: 0 });
});

test("Privy vault preflight accepts only an exact registered key and preserves epoch", async () => {
  const state = {
    balance: 10n,
    lockedTotal: 2n,
    withdrawable: 8n,
    sessionKey: owner.address,
    reserveNonce: 3n,
    keyEpoch: 4n,
  };
  assert.equal(
    (
      await readPrivyConsumeVaultPreflight({
        readState: async () => state,
        expectedSessionAddress: owner.address,
      })
    ).keyEpoch,
    4n
  );
  await assert.rejects(
    readPrivyConsumeVaultPreflight({
      readState: async () => ({ ...state, sessionKey: other.address }),
      expectedSessionAddress: owner.address,
    }),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_session_key_mismatch"
  );
  await assert.rejects(
    readPrivyConsumeVaultPreflight({
      readState: async () => ({
        ...state,
        sessionKey: "0x0000000000000000000000000000000000000000",
      }),
      expectedSessionAddress: owner.address,
    }),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_session_key_mismatch"
  );
  await assert.rejects(
    readPrivyConsumeVaultPreflight({
      readState: async () => {
        throw new Error("secret rpc response");
      },
      expectedSessionAddress: owner.address,
    }),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_session_key_read_unavailable" &&
      !error.message.includes("secret")
  );
});

test("first Privy authority completes a fake reserve, inference, receipt, and redeem cycle", async (t) => {
  const deps = dependencies();
  const authority = await resolvePrivyConsumerAuthority({ catalog, scope, ...deps });
  const directory = mkdtempSync(path.join(tmpdir(), "halo-privy-consume-cycle-"));
  const originalFetch = global.fetch;
  let reserved = 0n;
  const calls: string[] = [];
  const state = {
    balance: 1_000_000n,
    lockedTotal: 0n,
    withdrawable: 1_000_000n,
    sessionKey: authority.sessionWallet.address,
    reserveNonce: 0n,
    keyEpoch: 7n,
  };
  const client = new VaultConsumeClient(
    new VoidSigner(authority.ownerAddress),
    {
      facilitatorUrl: "https://facilitator.invalid",
      relayUrl: "https://relay.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      vaultAddress,
      reserveMultiple: 1n,
      reserveTtlSec: 600,
      pendingStorePath: path.join(directory, "pending.json"),
      deadLetterStorePath: path.join(directory, "dead-letter.json"),
    },
    authority.sessionWallet
  );
  client.readVaultState = async () => state;
  client.readOps = async () => ({
    locked: reserved,
    redeemed: 0n,
    expiry: 0n,
    created: 0n,
    cycle: 1n,
  });
  t.after(async () => {
    global.fetch = originalFetch;
    await client.closeRedeemEvidenceStore().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });

  global.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/operators")) {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: other.address,
              models: ["model"],
              pricing: { model: 0.001 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/vault/reserve")) {
      calls.push("reserve");
      const body = JSON.parse(String(init?.body)) as {
        consumer: string;
        operator: string;
        amount: string;
        expiry: string;
        nonce: string;
        signature: string;
      };
      assert.equal(
        verifyTypedData(
          vaultDomain(8453, vaultAddress),
          RESERVE_TYPES,
          {
            consumer: body.consumer,
            operator: body.operator,
            amount: BigInt(body.amount),
            expiry: BigInt(body.expiry),
            nonce: BigInt(body.nonce),
            keyEpoch: state.keyEpoch,
          },
          body.signature
        ),
        authority.sessionWallet.address
      );
      reserved = BigInt(body.amount);
      return Response.json({ hash: `0x${"a".repeat(64)}` });
    }
    if (url.endsWith("/v1/chat/completions")) {
      calls.push("inference");
      const payment = Buffer.from(JSON.stringify({ amountUsdc: "77" })).toString("base64");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "payment-response": payment },
      });
    }
    if (url.endsWith("/v1/receipt")) {
      calls.push("receipt");
      return new Response(null, { status: 202 });
    }
    if (url.endsWith("/vault/redeem")) {
      calls.push("redeem");
      const body = JSON.parse(String(init?.body)) as {
        consumer: string;
        operator: string;
        cumulative: string;
        cycle: string;
        signature: string;
      };
      assert.equal(
        verifyTypedData(
          vaultDomain(8453, vaultAddress),
          RECEIPT_TYPES,
          {
            consumer: body.consumer,
            operator: body.operator,
            cumulative: BigInt(body.cumulative),
            keyEpoch: state.keyEpoch,
            cycle: BigInt(body.cycle),
          },
          body.signature
        ),
        authority.sessionWallet.address
      );
      return Response.json({
        status: "confirmed",
        transaction: `0x${"b".repeat(64)}`,
        cumulative: body.cumulative,
        cycle: body.cycle,
      });
    }
    throw new Error(`unexpected fake request: ${url}`);
  };

  await readPrivyConsumeVaultPreflight({
    readState: async () => state,
    expectedSessionAddress: authority.sessionWallet.address,
  });
  const result = await payInference({
    signer: new VoidSigner(authority.ownerAddress),
    sessionSigner: authority.sessionWallet,
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    vaultAddress,
    body: { model: "model", messages: [{ role: "user", content: "hello" }] },
    client,
  });
  await result.flushRedeems?.();
  assert.equal(result.paid, true);
  assert.equal(result.chargedBase, "77");
  assert.deepEqual(calls, ["reserve", "inference", "receipt", "redeem"]);
  assert.deepEqual(deps.counts(), { signatures: 1, resumes: 1 });
});
