import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import type {
  WalletAccessAuthorization,
  WalletAccessGateway,
  WalletAccessSession,
} from "../domain/walletAccess";
import {
  loginWithWalletAccess,
  proveSavedWalletAccess,
  WALLET_ACCESS_PROOF,
  walletAccessSessionState,
} from "./session";
import type { SavedWalletAccessSession, WalletAccessSessionStore } from "./session";

const APP_ID = "halo_test_app_123";
const ACTIVE_UNTIL = "2026-08-31T12:15:00.000Z";

interface TestWalletAccessSession extends WalletAccessSession {
  identity: { backend: "privy"; address: string };
  appId: string;
  walletId: string;
  accessToken: string;
}

class MemoryStore implements WalletAccessSessionStore<TestWalletAccessSession> {
  record: SavedWalletAccessSession<TestWalletAccessSession> | null = null;

  read(): SavedWalletAccessSession<TestWalletAccessSession> | null {
    return this.record;
  }

  write(record: SavedWalletAccessSession<TestWalletAccessSession>): void {
    this.record = structuredClone(record);
  }

  clear(): void {
    this.record = null;
  }
}

function authorization(
  wallet: { address: string; signMessage(message: string): Promise<string> },
  session: TestWalletAccessSession,
  onDispose: () => void
): WalletAccessAuthorization<TestWalletAccessSession> {
  return {
    identity: { backend: "privy", address: wallet.address },
    session,
    signPersonalMessage: (message) => wallet.signMessage(message),
    dispose: onDispose,
  };
}

test("Wallet Access application persists and reuses one session", async () => {
  assert.equal(WALLET_ACCESS_PROOF, "Halo Wallet Access v1");
  const wallet = Wallet.createRandom();
  const store = new MemoryStore();
  const session: TestWalletAccessSession = {
    version: 1,
    identity: { backend: "privy", address: wallet.address },
    expiresAt: ACTIVE_UNTIL,
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "access-token-secret",
  };
  let authorizeCalls = 0;
  let resumeCalls = 0;
  let disposeCalls = 0;
  const firstGateway: WalletAccessGateway<TestWalletAccessSession> = {
    authorize: async (onChallenge) => {
      authorizeCalls += 1;
      await onChallenge({
        verificationUri: "https://privy.test/activate",
        userCode: "HALO-CODE",
      });
      return authorization(wallet, session, () => {
        disposeCalls += 1;
      });
    },
    resume: async () => {
      throw new Error("first instance must not resume");
    },
  };
  const record = await loginWithWalletAccess({
    gateway: firstGateway,
    store,
    onChallenge: () => {},
    now: () => new Date("2026-08-31T12:00:00.000Z"),
  });
  assert.equal(record.session.accessToken, "access-token-secret");
  assert.equal(record.version, 1);
  assert.equal(record.state, "active");
  assert.equal(record.refreshedAt, record.verifiedAt);

  const restartedGateway: WalletAccessGateway<TestWalletAccessSession> = {
    authorize: async () => {
      throw new Error("restart must not authorize again");
    },
    resume: async (saved) => {
      resumeCalls += 1;
      assert.deepEqual(saved, session);
      return authorization(wallet, saved, () => {
        disposeCalls += 1;
      });
    },
  };
  const resumed = await proveSavedWalletAccess({
    gateway: restartedGateway,
    store,
  });
  assert.equal(resumed.session.identity.address, wallet.address);
  assert.equal(authorizeCalls, 1);
  assert.equal(resumeCalls, 1);
  assert.equal(disposeCalls, 2);
  assert.equal(
    walletAccessSessionState(
      resumed,
      new Date("2026-08-31T12:14:59.999Z")
    ),
    "active"
  );
  assert.equal(
    walletAccessSessionState(
      resumed,
      new Date("2026-08-31T12:15:00.000Z")
    ),
    "expired"
  );
});

test("Wallet Access refuses identity replacement before persisting", async () => {
  const oldWallet = Wallet.createRandom();
  const newWallet = Wallet.createRandom();
  const store = new MemoryStore();
  const gateway: WalletAccessGateway<TestWalletAccessSession> = {
    authorize: async () =>
      authorization(
        newWallet,
        {
          version: 1,
          identity: { backend: "privy", address: newWallet.address },
          expiresAt: ACTIVE_UNTIL,
          appId: APP_ID,
          walletId: "wallet-2",
          accessToken: "new-access-token-secret",
        },
        () => {}
      ),
    resume: async () => {
      throw new Error("not used");
    },
  };
  await assert.rejects(
    loginWithWalletAccess({
      gateway,
      store,
      onChallenge: () => {},
      expectedAddress: oldWallet.address,
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "privy_wallet_identity_changed"
  );
  assert.equal(store.read(), null);
});

test("Wallet Access validates a verified session before persistence", async () => {
  const wallet = Wallet.createRandom();
  const store = new MemoryStore();
  const session: TestWalletAccessSession = {
    version: 1,
    identity: { backend: "privy", address: wallet.address },
    expiresAt: ACTIVE_UNTIL,
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "access-token-secret",
  };
  const gateway: WalletAccessGateway<TestWalletAccessSession> = {
    authorize: async () => authorization(wallet, session, () => {}),
    resume: async () => {
      throw new Error("not used");
    },
  };
  await assert.rejects(
    loginWithWalletAccess({
      gateway,
      store,
      onChallenge: () => {},
      validateSession: () => {
        throw new Error("catalog identity conflict");
      },
    }),
    /catalog identity conflict/
  );
  assert.equal(store.read(), null);
});
