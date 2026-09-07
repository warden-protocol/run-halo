import { getAddress } from "ethers";
import type { HaloConfig } from "../../config";
import {
  WalletCatalogError,
  type WalletCatalogSelector,
} from "../domain/walletCatalog";
import type { PrivyWalletAccessStoredState } from "./refresh";
import { resolveWalletCatalog } from "./catalog";

export interface PrivyWalletForgetAudit {
  result: "clear";
  outgoingAddress: string;
  selectedBackend: WalletCatalogSelector;
  catalogGeneration: number;
  sessionState: PrivyWalletAccessStoredState["kind"];
}

export interface PrivyWalletForgetAuditStore {
  readState(): PrivyWalletAccessStoredState;
}

function sameAddress(first: string, second: string): boolean {
  try {
    return getAddress(first) === getAddress(second);
  } catch {
    return false;
  }
}

export function readPrivyWalletForgetAudit(
  config: HaloConfig,
  store: PrivyWalletForgetAuditStore
): PrivyWalletForgetAudit {
  const catalog = resolveWalletCatalog(config).catalog;
  const outgoing = catalog.privyIdentity;
  if (outgoing === null || catalog.privyAppId === null) {
    throw new WalletCatalogError(
      "wallet_backend_transition_ambiguous",
      "No pinned Privy wallet exists to forget."
    );
  }

  const stored = store.readState();
  if (stored.kind !== "absent") {
    const session =
      stored.kind === "active" ? stored.record.session : stored.record;
    if (
      !sameAddress(outgoing.address, session.identity.address) ||
      outgoing.walletId !== session.walletId ||
      catalog.privyAppId !== session.appId
    ) {
      throw new WalletCatalogError(
        "wallet_backend_transition_ambiguous",
        "The saved Privy session does not match the pinned outgoing wallet; nothing was changed."
      );
    }
  }

  return {
    result: "clear",
    outgoingAddress: getAddress(outgoing.address),
    selectedBackend: catalog.selector,
    catalogGeneration: catalog.generation,
    sessionState: stored.kind,
  };
}
