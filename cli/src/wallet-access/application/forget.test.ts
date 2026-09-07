import test from "node:test";
import assert from "node:assert/strict";
import type { HaloConfigV1 } from "../../config";
import { WalletCatalogError } from "../domain/walletCatalog";
import type { PrivyWalletAccessStoredState } from "./refresh";
import { selectPrivyWallet } from "./catalog";
import { readPrivyWalletForgetAudit } from "./forget";

const KEYSTORE_ADDRESS = "0x0000000000000000000000000000000000000001";
const PRIVY_ADDRESS = "0x0000000000000000000000000000000000000002";
const APP_ID = "forget_audit_app";
const WALLET_ID = "forget-audit-wallet";

function configV1(): HaloConfigV1 {
  return {
    version: 1,
    relayUrl: "https://relay.test",
    indexerUrl: "https://indexer.test",
    operator: {
      address: KEYSTORE_ADDRESS,
      keystorePath: "/tmp/keystore.json",
    },
    provider: {
      slug: "test",
      baseUrl: "https://provider.test/v1",
      models: ["test/model"],
    },
    pricing: {
      mode: "flat",
      flatUsdcPer1KTokens: 0.001,
      fallbackPerRequestUsdc: 0.01,
    },
    facilitator: { url: "https://facilitator.test" },
  };
}

function selectedConfig() {
  return selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: WALLET_ID,
    appId: APP_ID,
  });
}

function store(state: PrivyWalletAccessStoredState) {
  return { readState: () => state };
}

function activeState(
  overrides: Partial<{
    address: string;
    walletId: string;
    appId: string;
  }> = {}
): PrivyWalletAccessStoredState {
  return {
    kind: "active",
    record: {
      version: 1,
      state: "active",
      session: {
        version: 1,
        identity: {
          backend: "privy",
          address: overrides.address ?? PRIVY_ADDRESS,
        },
        expiresAt: "2099-09-03T12:00:00.000Z",
        appId: overrides.appId ?? APP_ID,
        walletId: overrides.walletId ?? WALLET_ID,
        accessToken: "forget-audit-access-token",
        refreshToken: "forget-audit-refresh-token",
      },
      verifiedAt: "2026-09-03T10:00:00.000Z",
      refreshedAt: "2026-09-03T10:05:00.000Z",
    },
  };
}

test("forget audit accepts an absent or exactly matching local session", () => {
  assert.deepEqual(
    readPrivyWalletForgetAudit(selectedConfig(), store({ kind: "absent" })),
    {
      result: "clear",
      outgoingAddress: PRIVY_ADDRESS,
      selectedBackend: "privy",
      catalogGeneration: 1,
      sessionState: "absent",
    }
  );
  assert.equal(
    readPrivyWalletForgetAudit(selectedConfig(), store(activeState())).sessionState,
    "active"
  );
});

test("forget audit rejects every catalog and session scope mismatch", () => {
  for (const state of [
    activeState({
      address: "0x0000000000000000000000000000000000000003",
    }),
    activeState({ walletId: "different-wallet" }),
    activeState({ appId: "different_app_id" }),
  ]) {
    assert.throws(
      () => readPrivyWalletForgetAudit(selectedConfig(), store(state)),
      (error: unknown) =>
        error instanceof WalletCatalogError &&
        error.code === "wallet_backend_transition_ambiguous"
    );
  }
});

test("forget audit rejects a catalog without a pinned Privy identity", () => {
  assert.throws(
    () =>
      readPrivyWalletForgetAudit(
        configV1(),
        store({ kind: "absent" })
      ),
    (error: unknown) =>
      error instanceof WalletCatalogError &&
      error.code === "wallet_backend_transition_ambiguous"
  );
});
