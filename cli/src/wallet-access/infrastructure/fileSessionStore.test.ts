import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import type { SavedWalletAccessSession } from "../application/session";
import { FileWalletAccessSessionStore } from "./fileSessionStore";
import type { PrivyWalletAccessSession } from "./privy";
import { WalletAccessError } from "../domain/walletAccess";

const APP_ID = "halo_test_app_123";
const ACTIVE_UNTIL = "2026-08-31T12:15:00.000Z";

test("file store writes a strict mode-0600 session and rejects broad permissions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-wallet-access-test-"));
  const file = path.join(directory, "privy-session.json");
  const store = new FileWalletAccessSessionStore(file);
  const wallet = Wallet.createRandom();
  const record: SavedWalletAccessSession<PrivyWalletAccessSession> = {
    version: 1,
    state: "active",
    session: {
      version: 1,
      identity: { backend: "privy", address: wallet.address },
      expiresAt: ACTIVE_UNTIL,
      appId: APP_ID,
      walletId: "wallet-1",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
    },
    verifiedAt: "2026-08-31T12:00:00.000Z",
    refreshedAt: "2026-08-31T12:00:00.000Z",
  };
  try {
    store.write(record);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.read(), record);
    const bytes = readFileSync(file, "utf8");
    assert.equal(bytes.includes("access-token-secret"), true);
    assert.equal(bytes.includes("authorizationKey"), false);
    assert.equal(bytes.includes("readiness"), false);

    chmodSync(file, 0o644);
    assert.throws(
      () => store.read(),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "privy_session_persistence_ambiguous"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file store durably replaces refresh tokens with a token-free reauthentication state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-wallet-access-refresh-test-"));
  const file = path.join(directory, "privy-session.json");
  const store = new FileWalletAccessSessionStore(file);
  const wallet = Wallet.createRandom();
  const session: PrivyWalletAccessSession = {
    version: 1,
    identity: { backend: "privy", address: wallet.address },
    expiresAt: ACTIVE_UNTIL,
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
  };
  const record: SavedWalletAccessSession<PrivyWalletAccessSession> = {
    version: 1,
    state: "active",
    session,
    verifiedAt: "2026-08-31T12:00:00.000Z",
    refreshedAt: "2026-08-31T12:00:00.000Z",
  };
  try {
    store.write(record);
    assert.deepEqual(store.readState(), {
      kind: "active",
      record,
    });

    store.writeReauthenticationRequired({
      version: 1,
      state: "reauthentication_required",
      identity: session.identity,
      appId: APP_ID,
      walletId: "wallet-1",
      reason: "refresh_rejected",
      verifiedAt: "2026-08-31T12:00:00.000Z",
      refreshedAt: "2026-08-31T12:00:00.000Z",
      updatedAt: "2026-08-31T12:15:00.000Z",
    });
    const bytes = readFileSync(file, "utf8");
    assert.equal(bytes.includes("access-token-secret"), false);
    assert.equal(bytes.includes("refresh-token-secret"), false);
    assert.deepEqual(store.readState(), {
      kind: "reauthentication_required",
      record: {
        version: 1,
        state: "reauthentication_required",
        identity: session.identity,
        appId: APP_ID,
        walletId: "wallet-1",
        reason: "refresh_rejected",
        verifiedAt: "2026-08-31T12:00:00.000Z",
        refreshedAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:15:00.000Z",
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("file store classifies persistence, lock ambiguity, and ordinary contention", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-wallet-access-errors-test-"));
  try {
    const blockedParent = path.join(directory, "not-a-directory");
    writeFileSync(blockedParent, "occupied", { mode: 0o600 });
    const inaccessible = new FileWalletAccessSessionStore(
      path.join(blockedParent, "session.json")
    );
    assert.throws(
      () => inaccessible.clear(),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_session_persistence_ambiguous"
    );
    await assert.rejects(
      inaccessible.withRefreshLock(async () => {}),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_session_lock_ambiguous"
    );

    const file = path.join(directory, "session.json");
    writeFileSync(`${file}.refresh.lock`, "other-owner\n", { mode: 0o600 });
    const contended = new FileWalletAccessSessionStore(file, {
      timeoutMs: 0,
      retryMs: 1,
      now: () => 1,
    });
    await assert.rejects(
      contended.withRefreshLock(async () => {}),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_session_lock_unavailable"
    );

    const directoryAtSessionPath = path.join(directory, "session-directory");
    mkdirSync(directoryAtSessionPath, { mode: 0o700 });
    assert.throws(
      () => new FileWalletAccessSessionStore(directoryAtSessionPath).clear(),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_session_persistence_ambiguous"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
