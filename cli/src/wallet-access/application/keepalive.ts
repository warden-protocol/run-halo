import { WalletAccessError } from "../domain/walletAccess";
import type {
  PrivySessionRefreshGateway,
  PrivySessionRefreshStore,
  PrivyWalletAccessStoredState,
} from "./refresh";
import {
  PRIVY_SESSION_KEEPALIVE_INTERVAL_MS,
  refreshPrivySessionForKeepalive,
} from "./refresh";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const PRIVY_SESSION_DEGRADED_RETRY_MS = 5 * 60 * 1_000;

type ScheduleWake = (
  delayMs: number,
  wake: () => Promise<void>
) => () => void;

export interface PrivySessionKeepaliveOptions {
  store: PrivySessionRefreshStore;
  gatewayForAppId: (appId: string) => PrivySessionRefreshGateway;
  now?: () => number;
  scheduleWake?: ScheduleWake;
  onAvailabilityChange?: (
    availability: PrivySessionKeepaliveAvailability
  ) => void;
  onReauthenticationRequired?: () => void;
  onFailure?: () => void;
}

export type PrivySessionKeepaliveAvailability =
  | { kind: "active" }
  | {
      kind: "degraded";
      reason: "provider_unavailable";
      retryInMs: number;
    };

function scheduleWakeWithTimer(
  delayMs: number,
  wake: () => Promise<void>
): () => void {
  const timer = setTimeout(() => void wake(), delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function startPrivySessionKeepalive(
  input: PrivySessionKeepaliveOptions
): () => void {
  const now = input.now ?? Date.now;
  const scheduleWake = input.scheduleWake ?? scheduleWakeWithTimer;
  let stopped = false;
  let degraded = false;
  let cancelPendingWake: (() => void) | null = null;

  const reportFailure = (): void => {
    try {
      input.onFailure?.();
    } catch {}
  };

  const publishAvailability = (
    availability: PrivySessionKeepaliveAvailability
  ): void => {
    try {
      input.onAvailabilityChange?.(availability);
    } catch {
      reportFailure();
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cancelPendingWake?.();
    cancelPendingWake = null;
  };

  const schedule = (delayMs: number): void => {
    cancelPendingWake = scheduleWake(delayMs, wake);
  };

  const arm = (state: PrivyWalletAccessStoredState): void => {
    if (stopped || state.kind !== "active") return;
    const dueAt =
      Date.parse(state.record.refreshedAt) +
      PRIVY_SESSION_KEEPALIVE_INTERVAL_MS;
    const delayMs = Math.min(
      Math.max(0, dueAt - now()),
      MAX_TIMER_DELAY_MS
    );
    schedule(delayMs);
  };

  async function wake(): Promise<void> {
    cancelPendingWake = null;
    if (stopped) return;
    try {
      const next = await refreshPrivySessionForKeepalive({
        gatewayForAppId: input.gatewayForAppId,
        store: input.store,
        now: () => new Date(now()),
      });
      if (stopped) return;
      if (next.kind === "reauthentication_required") {
        try {
          input.onReauthenticationRequired?.();
        } catch {
          reportFailure();
        }
        return;
      }
      if (degraded) {
        degraded = false;
        publishAvailability({ kind: "active" });
      }
      arm(next);
    } catch (error) {
      if (stopped) return;
      if (
        error instanceof WalletAccessError &&
        error.code === "privy_refresh_unavailable"
      ) {
        if (!degraded) {
          degraded = true;
          publishAvailability({
            kind: "degraded",
            reason: "provider_unavailable",
            retryInMs: PRIVY_SESSION_DEGRADED_RETRY_MS,
          });
        }
        try {
          schedule(PRIVY_SESSION_DEGRADED_RETRY_MS);
        } catch {
          reportFailure();
        }
        return;
      }
      reportFailure();
    }
  }

  try {
    arm(input.store.readState());
  } catch {
    reportFailure();
  }
  return stop;
}
