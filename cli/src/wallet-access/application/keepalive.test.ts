import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Wallet } from "ethers";
import { WalletAccessError } from "../domain/walletAccess";
import type { PrivyWalletAccessSession } from "../domain/walletAccess";
import type { SavedWalletAccessSession } from "./session";
import { FileWalletAccessSessionStore } from "../infrastructure/fileSessionStore";
import { PRIVY_SESSION_KEEPALIVE_INTERVAL_MS } from "./refresh";
import {
  PRIVY_SESSION_DEGRADED_RETRY_MS,
  startPrivySessionKeepalive,
  type PrivySessionKeepaliveAvailability,
} from "./keepalive";

const APP_ID = "halo_test_app_123";

function activeRecord(): SavedWalletAccessSession<PrivyWalletAccessSession> {
  return {
    version: 1,
    state: "active",
    session: {
      version: 1,
      identity: { backend: "privy", address: Wallet.createRandom().address },
      expiresAt: "2026-08-31T12:15:00.000Z",
      appId: APP_ID,
      walletId: "wallet-1",
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
    },
    verifiedAt: "2026-08-31T12:00:00.000Z",
    refreshedAt: "2026-08-31T12:00:00.000Z",
  };
}

interface ScheduledWake {
  delayMs: number;
  wake: () => Promise<void>;
  cancelled: boolean;
}

test("keepalive schedules from refreshedAt and rearms from the locked refresh", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-keepalive-schedule-test-"));
  const store = new FileWalletAccessSessionStore(path.join(directory, "session.json"));
  store.write(activeRecord());
  let nowMs = Date.parse("2026-09-01T11:00:00.000Z");
  let refreshCalls = 0;
  const scheduled: ScheduledWake[] = [];

  try {
    const stop = startPrivySessionKeepalive({
      store,
      gatewayForAppId: () => ({
        refresh: async (current) => {
          refreshCalls += 1;
          return {
            ...current,
            expiresAt: "2026-09-01T12:15:00.000Z",
            accessToken: "rotated-access-token",
            refreshToken: "rotated-refresh-token",
          };
        },
      }),
      now: () => nowMs,
      scheduleWake: (delayMs, wake) => {
        const pending = { delayMs, wake, cancelled: false };
        scheduled.push(pending);
        return () => {
          pending.cancelled = true;
        };
      },
    });

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delayMs, 60 * 60 * 1_000);
    nowMs += scheduled[0].delayMs;
    await scheduled[0].wake();
    assert.equal(refreshCalls, 1);
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1].delayMs, PRIVY_SESSION_KEEPALIVE_INTERVAL_MS);
    const stored = store.readState();
    assert.equal(stored.kind, "active");
    if (stored.kind === "active") {
      assert.equal(stored.record.refreshedAt, "2026-09-01T12:00:00.000Z");
    }

    stop();
    assert.equal(scheduled[1].cancelled, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown cancels a pending keepalive wake", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-keepalive-cancel-test-"));
  const store = new FileWalletAccessSessionStore(path.join(directory, "session.json"));
  store.write(activeRecord());
  const scheduled: ScheduledWake[] = [];
  let refreshCalls = 0;

  try {
    const stop = startPrivySessionKeepalive({
      store,
      gatewayForAppId: () => ({
        refresh: async (current) => {
          refreshCalls += 1;
          return current;
        },
      }),
      now: () => Date.parse("2026-09-01T11:00:00.000Z"),
      scheduleWake: (delayMs, wake) => {
        const pending = { delayMs, wake, cancelled: false };
        scheduled.push(pending);
        return () => {
          pending.cancelled = true;
        };
      },
    });

    stop();
    assert.equal(scheduled[0].cancelled, true);
    await scheduled[0].wake();
    assert.equal(refreshCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider failure ends keepalive without rejecting the daemon callback", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-keepalive-failure-test-"));
  const store = new FileWalletAccessSessionStore(path.join(directory, "session.json"));
  store.write(activeRecord());
  const scheduled: ScheduledWake[] = [];
  let reauthenticationRequired = 0;
  let backgroundFailures = 0;

  try {
    startPrivySessionKeepalive({
      store,
      gatewayForAppId: () => ({
        refresh: async () => {
          throw new WalletAccessError(
            "privy_refresh_ambiguous",
            "safe provider failure"
          );
        },
      }),
      now: () => Date.parse("2026-09-01T12:00:00.000Z"),
      scheduleWake: (delayMs, wake) => {
        const pending = { delayMs, wake, cancelled: false };
        scheduled.push(pending);
        return () => {
          pending.cancelled = true;
        };
      },
      onReauthenticationRequired: () => {
        reauthenticationRequired += 1;
      },
      onFailure: () => {
        backgroundFailures += 1;
      },
    });

    assert.equal(scheduled[0].delayMs, 0);
    await scheduled[0].wake();
    assert.equal(reauthenticationRequired, 1);
    assert.equal(backgroundFailures, 0);
    assert.equal(scheduled.length, 1);
    assert.equal(store.readState().kind, "reauthentication_required");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider unavailability degrades, retries, and explicitly recovers", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-keepalive-degraded-test-"));
  const store = new FileWalletAccessSessionStore(path.join(directory, "session.json"));
  const initial = activeRecord();
  store.write(initial);
  const scheduled: ScheduledWake[] = [];
  const availability: PrivySessionKeepaliveAvailability[] = [];
  let nowMs = Date.parse("2026-09-01T12:00:00.000Z");
  let refreshCalls = 0;
  let reauthenticationRequired = 0;
  let backgroundFailures = 0;

  try {
    const stop = startPrivySessionKeepalive({
      store,
      gatewayForAppId: () => ({
        refresh: async (current) => {
          refreshCalls += 1;
          if (refreshCalls <= 2) {
            throw new WalletAccessError(
              "privy_refresh_unavailable",
              "safe provider exhaustion"
            );
          }
          return {
            ...current,
            expiresAt: "2026-09-01T12:20:00.000Z",
            accessToken: "rotated-access-token",
            refreshToken: "rotated-refresh-token",
          };
        },
      }),
      now: () => nowMs,
      scheduleWake: (delayMs, wake) => {
        const pending = { delayMs, wake, cancelled: false };
        scheduled.push(pending);
        return () => {
          pending.cancelled = true;
        };
      },
      onAvailabilityChange: (next) => availability.push(next),
      onReauthenticationRequired: () => {
        reauthenticationRequired += 1;
      },
      onFailure: () => {
        backgroundFailures += 1;
      },
    });

    assert.equal(scheduled[0].delayMs, 0);
    await scheduled[0].wake();
    assert.equal(refreshCalls, 1);
    assert.deepEqual(availability, [
      {
        kind: "degraded",
        reason: "provider_unavailable",
        retryInMs: PRIVY_SESSION_DEGRADED_RETRY_MS,
      },
    ]);
    assert.equal(scheduled[1].delayMs, PRIVY_SESSION_DEGRADED_RETRY_MS);
    const retained = store.readState();
    assert.equal(retained.kind, "active");
    if (retained.kind === "active") {
      assert.equal(retained.record.session.accessToken, initial.session.accessToken);
      assert.equal(retained.record.session.refreshToken, initial.session.refreshToken);
    }

    nowMs += PRIVY_SESSION_DEGRADED_RETRY_MS;
    await scheduled[1].wake();
    assert.equal(refreshCalls, 2);
    assert.equal(scheduled[2].delayMs, PRIVY_SESSION_DEGRADED_RETRY_MS);
    assert.deepEqual(availability, [
      {
        kind: "degraded",
        reason: "provider_unavailable",
        retryInMs: PRIVY_SESSION_DEGRADED_RETRY_MS,
      },
    ]);

    nowMs += PRIVY_SESSION_DEGRADED_RETRY_MS;
    await scheduled[2].wake();
    assert.equal(refreshCalls, 3);
    assert.deepEqual(availability, [
      {
        kind: "degraded",
        reason: "provider_unavailable",
        retryInMs: PRIVY_SESSION_DEGRADED_RETRY_MS,
      },
      { kind: "active" },
    ]);
    assert.equal(scheduled[3].delayMs, PRIVY_SESSION_KEEPALIVE_INTERVAL_MS);
    const recovered = store.readState();
    assert.equal(recovered.kind, "active");
    if (recovered.kind === "active") {
      assert.equal(recovered.record.session.accessToken, "rotated-access-token");
      assert.equal(recovered.record.session.refreshToken, "rotated-refresh-token");
    }
    assert.equal(reauthenticationRequired, 0);
    assert.equal(backgroundFailures, 0);

    stop();
    assert.equal(scheduled[3].cancelled, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
