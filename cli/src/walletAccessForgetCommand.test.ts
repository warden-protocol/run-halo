import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HaloConfigV1 } from "./config";
import { configDir, loadConfig, saveConfig } from "./config";
import { cmdLogout } from "./commands/login";
import {
  selectPrivyWallet,
} from "./wallet-access/application/catalog";
import { WalletCatalogError } from "./wallet-access/domain/walletCatalog";
import { FileWalletAccessSessionStore } from "./wallet-access/infrastructure/fileSessionStore";

const KEYSTORE_ADDRESS = "0x0000000000000000000000000000000000000001";
const PRIVY_ADDRESS = "0x0000000000000000000000000000000000000002";
const NEXT_PRIVY_ADDRESS = "0x0000000000000000000000000000000000000003";
const APP_ID = "forget_command_app";
const WALLET_ID = "forget-command-wallet";
const ACCESS_TOKEN = "forget-command-access-token";
const REFRESH_TOKEN = "forget-command-refresh-token";

function configV1(directory: string): HaloConfigV1 {
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

function saveSelectedState(): ReturnType<typeof selectPrivyWallet> {
  const selected = selectPrivyWallet(configV1(configDir()), {
    address: PRIVY_ADDRESS,
    walletId: WALLET_ID,
    appId: APP_ID,
  });
  saveConfig(selected);
  new FileWalletAccessSessionStore().write({
    version: 1,
    state: "active",
    session: {
      version: 1,
      identity: { backend: "privy", address: PRIVY_ADDRESS },
      expiresAt: "2099-09-03T12:00:00.000Z",
      appId: APP_ID,
      walletId: WALLET_ID,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    },
    verifiedAt: "2026-09-03T10:00:00.000Z",
    refreshedAt: "2026-09-03T10:05:00.000Z",
  });
  return selected;
}

async function captureOutput(operation: () => Promise<void>): Promise<string> {
  const original = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  };
  try {
    await operation();
  } finally {
    console.log = original;
  }
  return output.join("\n");
}

async function withTemporaryHome(
  operation: (home: string) => Promise<void>
): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "halo-wallet-forget-command-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await operation(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("ordinary logout removes only the local session and keeps the Privy pin", async () => {
  await withTemporaryHome(async () => {
    const selected = saveSelectedState();

    await cmdLogout();

    assert.deepEqual(loadConfig(), selected);
    assert.deepEqual(new FileWalletAccessSessionStore().readState(), {
      kind: "absent",
    });
    assert.throws(
      () =>
        selectPrivyWallet(loadConfig(), {
          address: NEXT_PRIVY_ADDRESS,
          walletId: "next-wallet",
          appId: APP_ID,
        }),
      (error: unknown) =>
        error instanceof WalletCatalogError &&
        error.code === "privy_wallet_identity_changed"
    );
  });
});

test("forget rejects a missing or mismatched exact-address confirmation without writes", async () => {
  await withTemporaryHome(async () => {
    const selected = saveSelectedState();
    for (const operation of [
      () =>
        cmdLogout({
          forgetWallet: true,
          confirmedAddress: NEXT_PRIVY_ADDRESS,
        }),
      () =>
        cmdLogout({
          forgetWallet: true,
          requestConfirmation: async () => undefined,
        }),
    ]) {
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof WalletCatalogError &&
          error.code === "wallet_backend_transition_ambiguous"
      );
      assert.deepEqual(loadConfig(), selected);
      assert.equal(
        new FileWalletAccessSessionStore().readState().kind,
        "active"
      );
    }
  });
});

test("forget rejects a mismatched outgoing session before confirmation", async () => {
  await withTemporaryHome(async () => {
    const selected = saveSelectedState();
    const store = new FileWalletAccessSessionStore();
    const state = store.readState();
    if (state.kind !== "active") assert.fail("expected active session");
    store.write({
      ...state.record,
      session: { ...state.record.session, walletId: "foreign-wallet" },
    });
    let requested = false;

    await assert.rejects(
      () =>
        cmdLogout({
          forgetWallet: true,
          requestConfirmation: async () => {
            requested = true;
            return PRIVY_ADDRESS;
          },
        }),
      (error: unknown) =>
        error instanceof WalletCatalogError &&
        error.code === "wallet_backend_transition_ambiguous"
    );
    assert.equal(requested, false);
    assert.deepEqual(loadConfig(), selected);
    assert.equal(store.readState().kind, "active");
  });
});

test("confirmed forget removes the pin, retains unrelated state, and permits re-adoption", async () => {
  await withTemporaryHome(async () => {
    saveSelectedState();
    const retainedPath = path.join(configDir(), "identity-scoped-history.json");
    const retainedBytes = '{"owner":"outgoing","state":"historical"}\n';
    writeFileSync(retainedPath, retainedBytes, { mode: 0o600 });

    const output = await captureOutput(() =>
      cmdLogout({
        forgetWallet: true,
        confirmedAddress: PRIVY_ADDRESS,
      })
    );

    const forgotten = loadConfig();
    assert.equal(forgotten.version, 2);
    if (forgotten.version !== 2) assert.fail("expected config v2");
    assert.equal(forgotten.walletCatalog.selector, "keystore");
    assert.equal(forgotten.walletCatalog.generation, 2);
    assert.equal(forgotten.walletCatalog.privyIdentity, null);
    assert.equal(forgotten.walletCatalog.privyAppId, null);
    assert.deepEqual(new FileWalletAccessSessionStore().readState(), {
      kind: "absent",
    });
    assert.equal(readFileSync(retainedPath, "utf8"), retainedBytes);

    const adopted = selectPrivyWallet(forgotten, {
      address: NEXT_PRIVY_ADDRESS,
      walletId: "next-wallet",
      appId: APP_ID,
    });
    assert.equal(adopted.walletCatalog.generation, 3);
    assert.equal(
      adopted.walletCatalog.privyIdentity?.address,
      NEXT_PRIVY_ADDRESS
    );

    assert.match(output, /Privy wallet forget audit/);
    assert.match(output, /Audit result:\s+clear/);
    assert.match(output, new RegExp(PRIVY_ADDRESS));
    assert.match(output, /Catalog generation: 1 → 2/);
    assert.match(output, /Other identity-scoped state was retained/);
    for (const secret of [APP_ID, WALLET_ID, ACCESS_TOKEN, REFRESH_TOKEN]) {
      assert.equal(output.includes(secret), false);
    }
  });
});
