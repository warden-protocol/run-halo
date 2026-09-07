import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HaloConfigV1 } from "../../config";
import { loadConfig, saveConfig, validateConfig } from "../../config";
import {
  forgetPrivyWallet,
  preserveConfiguredKeystore,
  resolveWalletCatalog,
  selectPrivyWallet,
} from "./catalog";
import { WalletCatalogError } from "../domain/walletCatalog";

const KEYSTORE_ADDRESS = "0x0000000000000000000000000000000000000001";
const PRIVY_ADDRESS = "0x0000000000000000000000000000000000000002";
const APP_ID = "halo_test_app_123";

function configV1(directory = "/tmp"): HaloConfigV1 {
  return {
    version: 1,
    relayUrl: "https://relay.test",
    indexerUrl: "https://indexer.test",
    operator: {
      address: KEYSTORE_ADDRESS,
      keystorePath: path.join(directory, "keystore.json"),
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

test("config v1 projects an implicit keystore catalog without mutation", () => {
  const config = configV1();
  const resolved = resolveWalletCatalog(config);
  assert.equal(resolved.explicit, false);
  assert.deepEqual(resolved.catalog, {
    version: 1,
    selector: "keystore",
    generation: 0,
    keystoreIdentity: {
      backend: "keystore",
      address: KEYSTORE_ADDRESS,
      keystorePath: "/tmp/keystore.json",
    },
    privyIdentity: null,
    privyAppId: null,
  });
  assert.equal(config.version, 1);
  assert.equal("walletCatalog" in config, false);
});

test("config v1 preserves a valid lowercase legacy address byte-for-byte", () => {
  const config = configV1();
  config.operator.address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const resolved = resolveWalletCatalog(config);
  assert.equal(
    resolved.catalog.keystoreIdentity?.address,
    config.operator.address
  );
});

test("first Privy selection emits config v2 and retains the keystore", () => {
  const original = configV1();
  const selected = selectPrivyWallet(original, {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  assert.equal(selected.version, 2);
  assert.equal(selected.walletCatalog.selector, "privy");
  assert.equal(selected.walletCatalog.generation, 1);
  assert.deepEqual(selected.walletCatalog.keystoreIdentity, {
    backend: "keystore",
    address: KEYSTORE_ADDRESS,
    keystorePath: "/tmp/keystore.json",
  });
  assert.deepEqual(selected.walletCatalog.privyIdentity, {
    backend: "privy",
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
  });
  assert.equal(selected.walletCatalog.privyAppId, APP_ID);
  assert.deepEqual(selected.operator, original.operator);

  const repeated = selectPrivyWallet(selected, {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  assert.equal(repeated.walletCatalog.generation, 1);
});

test("a pinned Privy identity cannot change silently", () => {
  const selected = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  for (const [candidate, expected] of [
    [
      { address: "0x0000000000000000000000000000000000000003", walletId: "wallet-1", appId: APP_ID },
      "privy_wallet_identity_changed",
    ],
    [
      { address: PRIVY_ADDRESS, walletId: "wallet-2", appId: APP_ID },
      "privy_wallet_identity_changed",
    ],
    [
      { address: PRIVY_ADDRESS, walletId: "wallet-1", appId: "another_app_123" },
      "privy_tenant_mismatch",
    ],
  ] as const) {
    assert.throws(
      () => selectPrivyWallet(selected, candidate),
      (error: unknown) =>
        error instanceof WalletCatalogError &&
        error.code === expected
    );
  }
});

test("forgetting Privy requires the outgoing address and retains the keystore", () => {
  const selected = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });

  assert.throws(
    () =>
      forgetPrivyWallet(
        selected,
        "0x0000000000000000000000000000000000000003"
      ),
    (error: unknown) =>
      error instanceof WalletCatalogError &&
      error.code === "wallet_backend_transition_ambiguous"
  );
  assert.equal(selected.walletCatalog.selector, "privy");
  assert.equal(selected.walletCatalog.privyIdentity?.address, PRIVY_ADDRESS);

  const forgotten = forgetPrivyWallet(selected, PRIVY_ADDRESS);
  assert.equal(forgotten.walletCatalog.selector, "keystore");
  assert.equal(forgotten.walletCatalog.generation, 2);
  assert.deepEqual(
    forgotten.walletCatalog.keystoreIdentity,
    selected.walletCatalog.keystoreIdentity
  );
  assert.equal(forgotten.walletCatalog.privyIdentity, null);
  assert.equal(forgotten.walletCatalog.privyAppId, null);

  const adopted = selectPrivyWallet(forgotten, {
    address: "0x0000000000000000000000000000000000000003",
    walletId: "wallet-2",
    appId: APP_ID,
  });
  assert.equal(adopted.walletCatalog.generation, 3);
  assert.equal(
    adopted.walletCatalog.privyIdentity?.address,
    "0x0000000000000000000000000000000000000003"
  );
});

test("forgetting a retained non-selected Privy identity keeps the selector", () => {
  const selected = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  const keystoreSelected = {
    ...selected,
    walletCatalog: { ...selected.walletCatalog, selector: "keystore" as const },
  };

  const forgotten = forgetPrivyWallet(keystoreSelected, PRIVY_ADDRESS);
  assert.equal(forgotten.walletCatalog.selector, "keystore");
  assert.equal(forgotten.walletCatalog.generation, 2);
  assert.equal(forgotten.walletCatalog.privyIdentity, null);
});

test("forgetting fails closed when the catalog generation is exhausted", () => {
  const selected = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  selected.walletCatalog.generation = Number.MAX_SAFE_INTEGER;

  assert.throws(
    () => forgetPrivyWallet(selected, PRIVY_ADDRESS),
    (error: unknown) =>
      error instanceof WalletCatalogError &&
      error.code === "wallet_selector_generation_exhausted"
  );
  assert.equal(selected.walletCatalog.privyIdentity?.address, PRIVY_ADDRESS);
});

test("v2 rejects mirror conflicts, duplicate identities, and unknown catalog fields", () => {
  const selected = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  assert.throws(
    () => validateConfig({
      ...selected,
      operator: { ...selected.operator, address: "0x0000000000000000000000000000000000000003" },
    }),
    /mirror conflicts/
  );
  assert.throws(() => validateConfig({
    ...selected,
    walletCatalog: {
      ...selected.walletCatalog,
      privyIdentity: {
        backend: "privy",
        address: KEYSTORE_ADDRESS,
        walletId: "wallet-1",
      },
    },
  }), /must be distinct/);
  assert.throws(() => validateConfig({
    ...selected,
    walletCatalog: {
      ...selected.walletCatalog,
      unexpected: true,
    } as typeof selected.walletCatalog,
  }), /wallet catalog is invalid/i);
});

test("setup-style keystore preservation keeps an explicit Privy selection", () => {
  const selected = selectPrivyWallet(configV1(), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  const next = configV1();
  next.operator = {
    address: "0x0000000000000000000000000000000000000003",
    keystorePath: "/tmp/replaced-keystore.json",
  };
  const preserved = preserveConfiguredKeystore(selected, next);
  assert.equal(preserved.version, 2);
  if (preserved.version !== 2) assert.fail("expected config v2");
  assert.equal(preserved.walletCatalog.selector, "privy");
  assert.equal(preserved.walletCatalog.generation, 2);
  assert.equal(preserved.walletCatalog.keystoreIdentity?.address, next.operator.address);
  assert.equal(preserved.walletCatalog.privyIdentity?.address, PRIVY_ADDRESS);
});

test("config v2 is atomically persisted with restrictive permissions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-wallet-catalog-"));
  const filePath = path.join(directory, "config.json");
  const selected = selectPrivyWallet(configV1(directory), {
    address: PRIVY_ADDRESS,
    walletId: "wallet-1",
    appId: APP_ID,
  });
  saveConfig(selected, filePath);
  assert.deepEqual(loadConfig(filePath), selected);
  assert.equal(statSync(filePath).mode & 0o077, 0);
  assert.deepEqual(readdirSync(directory).sort(), ["config.json"]);
});
