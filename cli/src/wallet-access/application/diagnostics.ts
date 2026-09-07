import { getAddress } from "ethers";
import type { HaloConfig } from "../../config";
import type { PrivyWalletAccessStoredState } from "./refresh";
import { resolveWalletCatalog } from "./catalog";

export type WalletAccessSessionDiagnosticState =
  | "absent"
  | "active"
  | "reauthentication_required"
  | "invalid";

export type WalletAccessSessionFreshness =
  | "not_available"
  | "fresh"
  | "expired"
  | "unknown";

export type WalletAccessRemediation =
  | "none"
  | "reauthenticate_privy"
  | "restore_selected_wallet"
  | "inspect_ambiguous_wallet_state";

export interface WalletAccessDiagnostics {
  backend: "keystore" | "privy" | "none";
  boundAddress: string | null;
  sessionState: WalletAccessSessionDiagnosticState;
  sessionFreshness: WalletAccessSessionFreshness;
  lastSuccessfulRefreshAt: string | null;
  remediation: WalletAccessRemediation;
}

export type WalletAccessDiagnosticConfiguration =
  | { state: "valid"; config: HaloConfig }
  | { state: "absent" }
  | { state: "invalid" };

export interface WalletAccessDiagnosticStore {
  readState(): PrivyWalletAccessStoredState;
}

function selectedWallet(configuration: WalletAccessDiagnosticConfiguration): {
  backend: WalletAccessDiagnostics["backend"];
  boundAddress: string | null;
} {
  if (configuration.state !== "valid") {
    return { backend: "none", boundAddress: null };
  }
  const catalog = resolveWalletCatalog(configuration.config).catalog;
  if (catalog.selector === "keystore") {
    return {
      backend: "keystore",
      boundAddress: catalog.keystoreIdentity?.address ?? null,
    };
  }
  if (catalog.selector === "privy") {
    return {
      backend: "privy",
      boundAddress: catalog.privyIdentity?.address ?? null,
    };
  }
  return { backend: "none", boundAddress: null };
}

function sameAddress(first: string, second: string): boolean {
  try {
    return getAddress(first) === getAddress(second);
  } catch {
    return false;
  }
}

function sessionMatchesCatalog(
  configuration: WalletAccessDiagnosticConfiguration,
  state: Exclude<PrivyWalletAccessStoredState, { kind: "absent" }>
): boolean {
  if (configuration.state !== "valid") return false;
  if (configuration.config.version === 1) return true;
  const catalog = resolveWalletCatalog(configuration.config).catalog;
  const identity = catalog.privyIdentity;
  const session = state.kind === "active" ? state.record.session : state.record;
  return (
    identity !== null &&
    sameAddress(identity.address, session.identity.address) &&
    identity.walletId === session.walletId &&
    catalog.privyAppId === session.appId
  );
}

function remediationForUsableSelection(
  backend: WalletAccessDiagnostics["backend"],
  sessionNeedsAuthentication: boolean
): WalletAccessRemediation {
  if (backend === "none") return "restore_selected_wallet";
  if (backend === "privy" && sessionNeedsAuthentication) {
    return "reauthenticate_privy";
  }
  return "none";
}

export function readWalletAccessDiagnostics(
  configuration: WalletAccessDiagnosticConfiguration,
  store: WalletAccessDiagnosticStore,
  now = new Date()
): WalletAccessDiagnostics {
  const selected = selectedWallet(configuration);
  let stored: PrivyWalletAccessStoredState;
  try {
    stored = store.readState();
  } catch {
    return {
      ...selected,
      sessionState: "invalid",
      sessionFreshness: "unknown",
      lastSuccessfulRefreshAt: null,
      remediation: "inspect_ambiguous_wallet_state",
    };
  }

  if (configuration.state === "invalid") {
    return {
      ...selected,
      sessionState: "invalid",
      sessionFreshness: "unknown",
      lastSuccessfulRefreshAt:
        stored.kind === "active" ? stored.record.refreshedAt : null,
      remediation: "inspect_ambiguous_wallet_state",
    };
  }
  if (stored.kind === "absent") {
    return {
      ...selected,
      sessionState: "absent",
      sessionFreshness: "not_available",
      lastSuccessfulRefreshAt: null,
      remediation: remediationForUsableSelection(selected.backend, true),
    };
  }
  if (!sessionMatchesCatalog(configuration, stored)) {
    return {
      ...selected,
      sessionState: "invalid",
      sessionFreshness: "unknown",
      lastSuccessfulRefreshAt:
        stored.kind === "active" ? stored.record.refreshedAt : null,
      remediation: "inspect_ambiguous_wallet_state",
    };
  }
  if (stored.kind === "reauthentication_required") {
    return {
      ...selected,
      sessionState: "reauthentication_required",
      sessionFreshness: "not_available",
      lastSuccessfulRefreshAt: stored.record.refreshedAt,
      remediation: remediationForUsableSelection(selected.backend, true),
    };
  }

  const expired = Date.parse(stored.record.session.expiresAt) <= now.getTime();
  return {
    ...selected,
    sessionState: "active",
    sessionFreshness: expired ? "expired" : "fresh",
    lastSuccessfulRefreshAt: stored.record.refreshedAt,
    remediation: remediationForUsableSelection(selected.backend, expired),
  };
}
