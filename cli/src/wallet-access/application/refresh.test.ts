import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import { WalletAccessError } from "../domain/walletAccess";
import type { PrivyWalletAccessSession } from "../domain/walletAccess";
import type { SavedWalletAccessSession } from "./session";
import { FileWalletAccessSessionStore } from "../infrastructure/fileSessionStore";
import {
  refreshExpiredPrivySession,
  refreshPrivySessionForKeepalive,
} from "./refresh";

const APP_ID = "halo_test_app_123";
const NOW = new Date("2026-08-31T12:00:00.000Z");

function expiredSession(): PrivyWalletAccessSession {
  return {
    version: 1,
    identity: { backend: "privy", address: Wallet.createRandom().address },
    expiresAt: "2026-08-31T11:59:59.000Z",
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "expired-access-token",
    refreshToken: "old-refresh-token",
  };
}

function activeRecord(
  session: PrivyWalletAccessSession
): SavedWalletAccessSession<PrivyWalletAccessSession> {
  return {
    version: 1,
    state: "active",
    session,
    verifiedAt: "2026-08-31T11:45:00.000Z",
    refreshedAt: "2026-08-31T11:45:00.000Z",
  };
}

test("concurrent refresh callers serialize and the second rereads rotated state", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-refresh-serialization-test-"));
  const file = path.join(directory, "session.json");
  const firstStore = new FileWalletAccessSessionStore(file);
  const secondStore = new FileWalletAccessSessionStore(file);
  const session = expiredSession();
  firstStore.write(activeRecord(session));
  let refreshCalls = 0;
  const gateway = {
    refresh: async (current: PrivyWalletAccessSession) => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ...current,
        expiresAt: "2026-08-31T12:15:00.000Z",
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
      };
    },
  };

  try {
    const [first, second] = await Promise.all([
      refreshExpiredPrivySession({
        gateway,
        store: firstStore,
        appId: APP_ID,
        now: () => NOW,
      }),
      refreshExpiredPrivySession({
        gateway,
        store: secondStore,
        appId: APP_ID,
        now: () => NOW,
      }),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.kind, "active");
    assert.equal(second.kind, "active");
    const stored = firstStore.readState();
    assert.equal(stored.kind, "active");
    if (stored.kind === "active") {
      assert.equal(stored.record.session.accessToken, "rotated-access-token");
      assert.equal(stored.record.session.refreshToken, "rotated-refresh-token");
      assert.equal(stored.record.version, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent keepalive wakes recheck the persisted refresh anchor under the lock", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-keepalive-serialization-test-"));
  const file = path.join(directory, "session.json");
  const firstStore = new FileWalletAccessSessionStore(file);
  const secondStore = new FileWalletAccessSessionStore(file);
  const observedAt = new Date("2026-09-01T11:45:00.000Z");
  const session = {
    ...expiredSession(),
    expiresAt: "2026-09-01T12:15:00.000Z",
  };
  firstStore.write(activeRecord(session));
  let refreshCalls = 0;
  const gatewayForAppId = (appId: string) => ({
    refresh: async (current: PrivyWalletAccessSession) => {
      assert.equal(appId, APP_ID);
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ...current,
        expiresAt: "2026-09-01T12:15:00.000Z",
        accessToken: "keepalive-access-token",
        refreshToken: "keepalive-refresh-token",
      };
    },
  });

  try {
    const [first, second] = await Promise.all([
      refreshPrivySessionForKeepalive({
        gatewayForAppId,
        store: firstStore,
        now: () => observedAt,
      }),
      refreshPrivySessionForKeepalive({
        gatewayForAppId,
        store: secondStore,
        now: () => observedAt,
      }),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.kind, "active");
    assert.equal(second.kind, "active");
    const stored = firstStore.readState();
    assert.equal(stored.kind, "active");
    if (stored.kind === "active") {
      assert.equal(stored.record.refreshedAt, observedAt.toISOString());
      assert.equal(stored.record.session.accessToken, "keepalive-access-token");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed refresh classes durably remove both tokens and require reauthentication", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-refresh-rejection-test-"));
  const file = path.join(directory, "session.json");
  const store = new FileWalletAccessSessionStore(file);
  const session = expiredSession();
  try {
    const cases = [
      {
        error: new WalletAccessError(
          "privy_login_required",
          "safe rejection"
        ),
        reason: "refresh_rejected",
      },
      {
        error: new WalletAccessError(
          "privy_refresh_ambiguous",
          "safe ambiguous response"
        ),
        reason: "refresh_failed",
      },
      { error: new Error("safe transport failure"), reason: "refresh_failed" },
    ] as const;
    for (const refreshCase of cases) {
      store.write(activeRecord(session));
      const state = await refreshExpiredPrivySession({
        gateway: {
          refresh: async () => {
            throw refreshCase.error;
          },
        },
        store,
        appId: APP_ID,
        now: () => NOW,
      });
      assert.equal(state.kind, "reauthentication_required");
      if (state.kind === "reauthentication_required") {
        assert.equal(state.record.reason, refreshCase.reason);
      }
      const bytes = readFileSync(file, "utf8");
      assert.equal(bytes.includes("expired-access-token"), false);
      assert.equal(bytes.includes("old-refresh-token"), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelled refresh retains the active token pair", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-refresh-cancel-test-"));
  const file = path.join(directory, "session.json");
  const store = new FileWalletAccessSessionStore(file);
  const session = expiredSession();
  store.write(activeRecord(session));

  try {
    await assert.rejects(
      refreshExpiredPrivySession({
        gateway: {
          refresh: async () => {
            throw new WalletAccessError(
              "privy_operation_cancelled",
              "safe cancellation"
            );
          },
        },
        store,
        appId: APP_ID,
        now: () => NOW,
      }),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_operation_cancelled"
    );
    const retained = store.readState();
    assert.equal(retained.kind, "active");
    if (retained.kind === "active") {
      assert.equal(retained.record.session.accessToken, "expired-access-token");
      assert.equal(retained.record.session.refreshToken, "old-refresh-token");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("proven provider unavailability retains refresh authority", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-refresh-unavailable-test-"));
  const file = path.join(directory, "session.json");
  const store = new FileWalletAccessSessionStore(file);
  const session = expiredSession();
  store.write(activeRecord(session));

  try {
    await assert.rejects(
      refreshExpiredPrivySession({
        gateway: {
          refresh: async () => {
            throw new WalletAccessError(
              "privy_refresh_unavailable",
              "safe provider exhaustion"
            );
          },
        },
        store,
        appId: APP_ID,
        now: () => NOW,
      }),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_refresh_unavailable"
    );
    const retained = store.readState();
    assert.equal(retained.kind, "active");
    if (retained.kind === "active") {
      assert.equal(retained.record.session.accessToken, "expired-access-token");
      assert.equal(retained.record.session.refreshToken, "old-refresh-token");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a complete refresh protocol error retains refresh authority", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-refresh-protocol-test-"));
  const file = path.join(directory, "session.json");
  const store = new FileWalletAccessSessionStore(file);
  const session = expiredSession();
  store.write(activeRecord(session));

  try {
    await assert.rejects(
      refreshExpiredPrivySession({
        gateway: {
          refresh: async () => {
            throw new WalletAccessError(
              "privy_protocol_error",
              "safe complete response failure"
            );
          },
        },
        store,
        appId: APP_ID,
        now: () => NOW,
      }),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_protocol_error"
    );
    const retained = store.readState();
    assert.equal(retained.kind, "active");
    if (retained.kind === "active") {
      assert.equal(retained.record.session.accessToken, "expired-access-token");
      assert.equal(retained.record.session.refreshToken, "old-refresh-token");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("app-scope mismatch becomes a stable token-free state", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-refresh-state-test-"));
  const file = path.join(directory, "session.json");
  const store = new FileWalletAccessSessionStore(file);
  const session = expiredSession();
  let refreshCalls = 0;
  try {
    store.write(activeRecord(session));
    const state = await refreshExpiredPrivySession({
      gateway: {
        refresh: async (current) => {
          refreshCalls += 1;
          return current;
        },
      },
      store,
      appId: "different_app_123",
      now: () => NOW,
    });
    assert.equal(state.kind, "reauthentication_required");
    if (state.kind === "reauthentication_required") {
      assert.equal(state.record.reason, "refresh_scope_mismatch");
    }
    assert.equal(refreshCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
