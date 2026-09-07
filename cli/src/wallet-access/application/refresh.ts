import { getAddress } from "ethers";
import {
  WalletAccessError,
  type PrivyWalletAccessSession,
} from "../domain/walletAccess";
import type {
  SavedWalletAccessSession,
  WalletAccessSessionStore,
} from "./session";

export type PrivyReauthenticationReason =
  | "refresh_failed"
  | "refresh_rejected"
  | "refresh_invalid"
  | "refresh_scope_mismatch";

export interface PrivyReauthenticationRecord {
  version: 1;
  state: "reauthentication_required";
  identity: { backend: "privy"; address: string };
  appId: string;
  walletId: string;
  reason: PrivyReauthenticationReason;
  verifiedAt: string;
  refreshedAt: string;
  updatedAt: string;
}

export type PrivyWalletAccessStoredState =
  | { kind: "absent" }
  | {
      kind: "active";
      record: SavedWalletAccessSession<PrivyWalletAccessSession>;
    }
  | {
      kind: "reauthentication_required";
      record: PrivyReauthenticationRecord;
    };

export interface PrivySessionRefreshStore
  extends WalletAccessSessionStore<PrivyWalletAccessSession> {
  readState(): PrivyWalletAccessStoredState;
  writeReauthenticationRequired(record: PrivyReauthenticationRecord): void;
  withRefreshLock<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export interface PrivySessionRefreshGateway {
  refresh(session: PrivyWalletAccessSession): Promise<PrivyWalletAccessSession>;
}

export const PRIVY_SESSION_KEEPALIVE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

function sameIdentity(
  first: PrivyWalletAccessSession,
  second: PrivyWalletAccessSession
): boolean {
  try {
    return getAddress(first.identity.address) === getAddress(second.identity.address);
  } catch {
    return false;
  }
}

function reauthenticationReason(error: unknown): PrivyReauthenticationReason {
  if (error instanceof WalletAccessError) {
    if (error.code === "privy_login_required") return "refresh_rejected";
    if (error.code === "privy_protocol_error") return "refresh_invalid";
    if (
      error.code === "privy_tenant_mismatch" ||
      error.code === "privy_wallet_identity_changed"
    ) {
      return "refresh_scope_mismatch";
    }
  }
  return "refresh_failed";
}

function retainsRefreshAuthority(error: unknown): boolean {
  return (
    error instanceof WalletAccessError &&
    (error.code === "privy_operation_cancelled" ||
      error.code === "privy_refresh_unavailable" ||
      error.code === "privy_protocol_error")
  );
}

async function refreshLockedPrivySession(input: {
  current: SavedWalletAccessSession<PrivyWalletAccessSession>;
  gateway: PrivySessionRefreshGateway;
  store: PrivySessionRefreshStore;
  appId: string;
  shouldRefresh: (
    current: SavedWalletAccessSession<PrivyWalletAccessSession>,
    observedAt: Date
  ) => boolean;
  now: () => Date;
}): Promise<PrivyWalletAccessStoredState> {
  const observedAt = input.now();
  const session = input.current.session;
  if (session.appId !== input.appId) {
    input.store.writeReauthenticationRequired({
      version: 1,
      state: "reauthentication_required",
      identity: session.identity,
      appId: session.appId,
      walletId: session.walletId,
      reason: "refresh_scope_mismatch",
      verifiedAt: input.current.verifiedAt,
      refreshedAt: input.current.refreshedAt,
      updatedAt: observedAt.toISOString(),
    });
    return input.store.readState();
  }
  if (!input.shouldRefresh(input.current, observedAt)) {
    return { kind: "active", record: input.current };
  }

  let refreshed: PrivyWalletAccessSession;
  try {
    refreshed = await input.gateway.refresh(session);
  } catch (error) {
    if (retainsRefreshAuthority(error)) throw error;
    input.store.writeReauthenticationRequired({
      version: 1,
      state: "reauthentication_required",
      identity: session.identity,
      appId: session.appId,
      walletId: session.walletId,
      reason: reauthenticationReason(error),
      verifiedAt: input.current.verifiedAt,
      refreshedAt: input.current.refreshedAt,
      updatedAt: input.now().toISOString(),
    });
    return input.store.readState();
  }

  const completedAt = input.now();
  if (
    refreshed.appId !== session.appId ||
    refreshed.walletId !== session.walletId ||
    !sameIdentity(refreshed, session) ||
    new Date(refreshed.expiresAt).getTime() <= completedAt.getTime()
  ) {
    input.store.writeReauthenticationRequired({
      version: 1,
      state: "reauthentication_required",
      identity: session.identity,
      appId: session.appId,
      walletId: session.walletId,
      reason: "refresh_scope_mismatch",
      verifiedAt: input.current.verifiedAt,
      refreshedAt: input.current.refreshedAt,
      updatedAt: completedAt.toISOString(),
    });
    return input.store.readState();
  }

  input.store.write({
    version: 1,
    state: "active",
    session: refreshed,
    verifiedAt: input.current.verifiedAt,
    refreshedAt: completedAt.toISOString(),
  });
  return input.store.readState();
}

export async function refreshExpiredPrivySession(input: {
  gateway: PrivySessionRefreshGateway;
  store: PrivySessionRefreshStore;
  appId: string;
  now?: () => Date;
}): Promise<PrivyWalletAccessStoredState> {
  const now = input.now ?? (() => new Date());
  return input.store.withRefreshLock(async () => {
    const current = input.store.readState();
    if (current.kind !== "active") return current;
    return refreshLockedPrivySession({
      current: current.record,
      gateway: input.gateway,
      store: input.store,
      appId: input.appId,
      shouldRefresh: (record, observedAt) =>
        new Date(record.session.expiresAt).getTime() <= observedAt.getTime(),
      now,
    });
  });
}

export async function refreshPrivySessionForKeepalive(input: {
  gatewayForAppId: (appId: string) => PrivySessionRefreshGateway;
  store: PrivySessionRefreshStore;
  now?: () => Date;
}): Promise<PrivyWalletAccessStoredState> {
  const now = input.now ?? (() => new Date());
  return input.store.withRefreshLock(async () => {
    const current = input.store.readState();
    if (current.kind !== "active") return current;
    const appId = current.record.session.appId;
    return refreshLockedPrivySession({
      current: current.record,
      gateway: input.gatewayForAppId(appId),
      store: input.store,
      appId,
      shouldRefresh: (record, observedAt) =>
        Date.parse(record.refreshedAt) + PRIVY_SESSION_KEEPALIVE_INTERVAL_MS <=
        observedAt.getTime(),
      now,
    });
  });
}
