import test from "node:test";
import assert from "node:assert/strict";
import type { HaloConfigV1 } from "../../config";
import type { PrivyWalletAccessStoredState } from "./refresh";
import { selectPrivyWallet } from "./catalog";
import { readWalletAccessDiagnostics } from "./diagnostics";

const KEYSTORE_ADDRESS = "0x0000000000000000000000000000000000000001";
const PRIVY_ADDRESS = "0x0000000000000000000000000000000000000002";
const APP_ID = "diagnostic_app_123";
const WALLET_ID = "diagnostic-wallet-id";

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

function store(state: PrivyWalletAccessStoredState): {
  readState(): PrivyWalletAccessStoredState;
} {
  return { readState: () => state };
}

function activeState(expiresAt: string): PrivyWalletAccessStoredState {
  return {
    kind: "active",
    record: {
      version: 1,
      state: "active",
      session: {
        version: 1,
        identity: { backend: "privy", address: PRIVY_ADDRESS },
        expiresAt,
        appId: APP_ID,
        walletId: WALLET_ID,
        accessToken: "diagnostic-access-token-secret",
        refreshToken: "diagnostic-refresh-token-secret",
      },
      verifiedAt: "2026-09-03T10:00:00.000Z",
      refreshedAt: "2026-09-03T10:05:00.000Z",
    },
  };
}

test("reports an implicit keystore selection without requiring a Privy session", () => {
  const config = configV1();
  assert.deepEqual(
    readWalletAccessDiagnostics(
      { state: "valid", config },
      store({ kind: "absent" })
    ),
    {
      backend: "keystore",
      boundAddress: KEYSTORE_ADDRESS,
      sessionState: "absent",
      sessionFreshness: "not_available",
      lastSuccessfulRefreshAt: null,
      remediation: "none",
    }
  );
  assert.equal(config.version, 1);
  assert.equal("walletCatalog" in config, false);
});

test("reports only allowlisted public fields for a fresh Privy session", () => {
  const config = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: WALLET_ID,
    appId: APP_ID,
  });
  const diagnostics = readWalletAccessDiagnostics(
    { state: "valid", config },
    store(activeState("2026-09-03T12:00:00.000Z")),
    new Date("2026-09-03T11:00:00.000Z")
  );

  assert.deepEqual(diagnostics, {
    backend: "privy",
    boundAddress: PRIVY_ADDRESS,
    sessionState: "active",
    sessionFreshness: "fresh",
    lastSuccessfulRefreshAt: "2026-09-03T10:05:00.000Z",
    remediation: "none",
  });
  const serialized = JSON.stringify(diagnostics);
  for (const forbidden of [
    APP_ID,
    WALLET_ID,
    "diagnostic-access-token-secret",
    "diagnostic-refresh-token-secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("an expired selected Privy session has one reauthentication remediation", () => {
  const config = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: WALLET_ID,
    appId: APP_ID,
  });
  assert.deepEqual(
    readWalletAccessDiagnostics(
      { state: "valid", config },
      store(activeState("2026-09-03T11:00:00.000Z")),
      new Date("2026-09-03T11:00:00.000Z")
    ),
    {
      backend: "privy",
      boundAddress: PRIVY_ADDRESS,
      sessionState: "active",
      sessionFreshness: "expired",
      lastSuccessfulRefreshAt: "2026-09-03T10:05:00.000Z",
      remediation: "reauthenticate_privy",
    }
  );
});

test("a durable reauthentication state omits provider scope and wallet IDs", () => {
  const config = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: WALLET_ID,
    appId: APP_ID,
  });
  const diagnostics = readWalletAccessDiagnostics(
    { state: "valid", config },
    store({
      kind: "reauthentication_required",
      record: {
        version: 1,
        state: "reauthentication_required",
        identity: { backend: "privy", address: PRIVY_ADDRESS },
        appId: APP_ID,
        walletId: WALLET_ID,
        reason: "refresh_rejected",
        verifiedAt: "2026-09-03T10:00:00.000Z",
        refreshedAt: "2026-09-03T10:05:00.000Z",
        updatedAt: "2026-09-03T11:00:00.000Z",
      },
    })
  );

  assert.deepEqual(diagnostics, {
    backend: "privy",
    boundAddress: PRIVY_ADDRESS,
    sessionState: "reauthentication_required",
    sessionFreshness: "not_available",
    lastSuccessfulRefreshAt: "2026-09-03T10:05:00.000Z",
    remediation: "reauthenticate_privy",
  });
  assert.equal(JSON.stringify(diagnostics).includes(WALLET_ID), false);
  assert.equal(JSON.stringify(diagnostics).includes(APP_ID), false);
});

test("invalid readback and catalog mismatch collapse to secret-safe ambiguity", () => {
  const config = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: WALLET_ID,
    appId: APP_ID,
  });
  const failedRead = readWalletAccessDiagnostics(
    { state: "valid", config },
    {
      readState() {
        throw new Error("raw-provider-response diagnostic-access-token-secret");
      },
    }
  );
  assert.deepEqual(failedRead, {
    backend: "privy",
    boundAddress: PRIVY_ADDRESS,
    sessionState: "invalid",
    sessionFreshness: "unknown",
    lastSuccessfulRefreshAt: null,
    remediation: "inspect_ambiguous_wallet_state",
  });
  assert.equal(JSON.stringify(failedRead).includes("raw-provider-response"), false);

  const mismatched = activeState("2026-09-03T12:00:00.000Z");
  if (mismatched.kind !== "active") assert.fail("expected active fixture");
  mismatched.record.session.walletId = "another-wallet-id";
  assert.equal(
    readWalletAccessDiagnostics(
      { state: "valid", config },
      store(mismatched)
    ).remediation,
    "inspect_ambiguous_wallet_state"
  );
});

test("missing and invalid configuration produce deterministic recovery codes", () => {
  assert.equal(
    readWalletAccessDiagnostics(
      { state: "absent" },
      store({ kind: "absent" })
    ).remediation,
    "restore_selected_wallet"
  );
  assert.deepEqual(
    readWalletAccessDiagnostics(
      { state: "invalid" },
      store({ kind: "absent" })
    ),
    {
      backend: "none",
      boundAddress: null,
      sessionState: "invalid",
      sessionFreshness: "unknown",
      lastSuccessfulRefreshAt: null,
      remediation: "inspect_ambiguous_wallet_state",
    }
  );
});
