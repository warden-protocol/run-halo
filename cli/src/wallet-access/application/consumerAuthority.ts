import { Wallet, getAddress, verifyMessage } from "ethers";
import {
  deriveSubKeyPrivateKey,
  subKeyDerivationMessage,
  type VaultState,
} from "@halo/vault-core";
import type { WalletCatalogV1 } from "../domain/walletCatalog";
import {
  WalletAccessError,
  type PrivyWalletAccessSession,
  type WalletAccessAuthorization,
  type WalletAccessGateway,
} from "../domain/walletAccess";
import type {
  ConsumeSessionKeyScope,
  ConsumeSessionKeyRecordV1,
  ConsumeSessionKeyStore,
} from "../infrastructure/fileConsumeSessionKeyStore";
import {
  refreshExpiredPrivySession,
  type PrivySessionRefreshGateway,
  type PrivySessionRefreshStore,
} from "./refresh";
import { walletAccessSessionState } from "./session";

type PrivyConsumeGateway = WalletAccessGateway<PrivyWalletAccessSession> &
  PrivySessionRefreshGateway;

export interface PrivyTransactionAuthorization {
  authorization: WalletAccessAuthorization<PrivyWalletAccessSession>;
  sessionGeneration: string;
}

export interface PrivyConsumerAuthority {
  backend: "privy";
  ownerAddress: string;
  sessionWallet: Wallet;
  restored: boolean;
}

export async function readPrivyConsumeVaultPreflight(input: {
  readState: () => Promise<VaultState>;
  expectedSessionAddress: string;
}): Promise<VaultState> {
  let state: VaultState;
  let expected: string;
  try {
    expected = getAddress(input.expectedSessionAddress);
    state = await input.readState();
    if (state.lockedTotal < 0n || state.keyEpoch < 0n) throw new Error("invalid state");
  } catch {
    throw new WalletAccessError(
      "privy_session_key_read_unavailable",
      "The selected HaloVault account state could not be read. No pending receipt, reservation, or request was sent."
    );
  }
  let registered: string;
  try {
    registered = getAddress(state.sessionKey);
  } catch {
    throw new WalletAccessError(
      "privy_session_key_read_unavailable",
      "The selected HaloVault account returned invalid session-key state. No pending receipt, reservation, or request was sent."
    );
  }
  if (registered !== expected) {
    throw new WalletAccessError(
      "privy_session_key_mismatch",
      "The registered HaloVault session key does not match this Privy consumer. Register the expected key with no active reservations before retrying."
    );
  }
  return state;
}

function assertSessionScope(
  session: PrivyWalletAccessSession,
  catalog: WalletCatalogV1
): void {
  const pinned = catalog.privyIdentity;
  let sessionAddress: string | null = null;
  try {
    sessionAddress = getAddress(session.identity.address);
  } catch {}
  if (
    catalog.selector !== "privy" ||
    pinned === null ||
    catalog.privyAppId === null ||
    session.appId !== catalog.privyAppId ||
    session.walletId !== pinned.walletId ||
    sessionAddress !== getAddress(pinned.address)
  ) {
    throw new WalletAccessError(
      "privy_wallet_identity_changed",
      "The selected Privy identity does not match the saved Wallet Access session. Inspect Wallet Access state before retrying."
    );
  }
}

function restoredAuthority(record: ConsumeSessionKeyRecordV1): PrivyConsumerAuthority {
  return {
    backend: "privy",
    ownerAddress: getAddress(record.consumerAddress),
    sessionWallet: new Wallet(record.privateKey),
    restored: true,
  };
}

export async function resolvePrivyTransactionAuthorization(input: {
  catalog: WalletCatalogV1;
  sessionStore: PrivySessionRefreshStore;
  gateway: PrivyConsumeGateway;
  now?: () => Date;
}): Promise<PrivyTransactionAuthorization> {
  const pinned = input.catalog.privyIdentity;
  if (
    input.catalog.selector !== "privy" ||
    pinned === null ||
    input.catalog.privyAppId === null
  ) {
    throw new WalletAccessError(
      "wallet_backend_unsupported_for_command",
      "Direct Privy funding requires the selected pinned Privy wallet."
    );
  }
  let state = input.sessionStore.readState();
  if (
    state.kind === "active" &&
    walletAccessSessionState(state.record, (input.now ?? (() => new Date()))()) === "expired"
  ) {
    state = await refreshExpiredPrivySession({
      gateway: input.gateway,
      store: input.sessionStore,
      appId: input.catalog.privyAppId,
      now: input.now,
    });
  }
  if (state.kind !== "active") {
    throw new WalletAccessError(
      "privy_login_required",
      "No active Wallet Access session can authorize direct Vault funding. Run halo login first."
    );
  }
  assertSessionScope(state.record.session, input.catalog);
  const authorization = await input.gateway.resume(state.record.session);
  try {
    assertSessionScope(authorization.session, input.catalog);
    if (getAddress(authorization.identity.address) !== getAddress(pinned.address)) {
      throw new WalletAccessError(
        "privy_wallet_identity_changed",
        "Privy authorized a different wallet. No funding transaction was sent."
      );
    }
    if (authorization.sendEvmTransaction === undefined) {
      throw new WalletAccessError(
        "wallet_backend_unsupported_for_command",
        "The selected Wallet Access backend cannot authorize Base transactions."
      );
    }
    return { authorization, sessionGeneration: state.record.refreshedAt };
  } catch (error) {
    authorization.dispose();
    throw error;
  }
}

export async function resolvePrivySponsoredTransactionAuthorization(input: {
  catalog: WalletCatalogV1;
  sessionStore: PrivySessionRefreshStore;
  gateway: PrivyConsumeGateway;
  now?: () => Date;
}): Promise<PrivyTransactionAuthorization> {
  const resolved = await resolvePrivyTransactionAuthorization(input);
  if (resolved.authorization.signEvmTransaction === undefined) {
    resolved.authorization.dispose();
    throw new WalletAccessError(
      "wallet_backend_unsupported_for_command",
      "The selected Wallet Access backend cannot sign sponsored Base transactions."
    );
  }
  return resolved;
}

export async function resolvePrivyConsumerAuthority(input: {
  catalog: WalletCatalogV1;
  scope: ConsumeSessionKeyScope;
  keyStore: ConsumeSessionKeyStore;
  sessionStore: PrivySessionRefreshStore;
  gateway: PrivyConsumeGateway;
  now?: () => Date;
}): Promise<PrivyConsumerAuthority> {
  const pinned = input.catalog.privyIdentity;
  if (
    input.catalog.selector !== "privy" ||
    pinned === null ||
    input.catalog.privyAppId === null
  ) {
    throw new WalletAccessError(
      "wallet_backend_unsupported_for_command",
      "halo consume requires a selected keystore or Privy wallet."
    );
  }
  const ownerAddress = getAddress(pinned.address);
  const appId = input.catalog.privyAppId;
  if (
    input.scope.chainId !== 8453 ||
    input.scope.derivationVersion !== 1 ||
    getAddress(input.scope.consumerAddress) !== ownerAddress
  ) {
    throw new WalletAccessError(
      "privy_consume_key_state_ambiguous",
      "The Privy consume-key scope does not match the selected wallet."
    );
  }
  return input.keyStore.withScopeLock(async () => {
    const existing = input.keyStore.read();
    if (existing !== null) return restoredAuthority(existing);

    let state = input.sessionStore.readState();
    if (
      state.kind === "active" &&
      walletAccessSessionState(state.record, (input.now ?? (() => new Date()))()) === "expired"
    ) {
      state = await refreshExpiredPrivySession({
        gateway: input.gateway,
        store: input.sessionStore,
        appId,
        now: input.now,
      });
    }
    if (state.kind !== "active") {
      throw new WalletAccessError(
        "privy_login_required",
        "No active Wallet Access session can derive the Privy consume key. Run halo login first."
      );
    }
    assertSessionScope(state.record.session, input.catalog);

    const authorization = await input.gateway.resume(state.record.session);
    try {
      assertSessionScope(authorization.session, input.catalog);
      if (getAddress(authorization.identity.address) !== ownerAddress) {
        throw new WalletAccessError(
          "privy_wallet_identity_changed",
          "Privy authorized a different wallet. The consume key was not persisted."
        );
      }
      const message = subKeyDerivationMessage(ownerAddress);
      const signature = await authorization.signPersonalMessage(message);
      let recovered: string;
      try {
        recovered = getAddress(verifyMessage(message, signature));
      } catch {
        throw new WalletAccessError(
          "privy_consume_signature_incompatible",
          "Privy returned a nonconforming consume-key signature. No local key was persisted."
        );
      }
      if (recovered !== ownerAddress) {
        throw new WalletAccessError(
          "privy_consume_signature_incompatible",
          "Privy returned a consume-key signature for a different owner. No local key was persisted."
        );
      }
      const privateKey = deriveSubKeyPrivateKey(signature).toLowerCase();
      let sessionWallet: Wallet;
      try {
        sessionWallet = new Wallet(privateKey);
      } catch {
        throw new WalletAccessError(
          "privy_consume_signature_incompatible",
          "Privy returned a consume-key signature that cannot derive a valid local key."
        );
      }
      const record: ConsumeSessionKeyRecordV1 = {
        version: 1,
        chainId: "8453",
        vaultAddress: getAddress(input.scope.vaultAddress).toLowerCase(),
        consumerAddress: ownerAddress.toLowerCase(),
        derivationVersion: 1,
        privateKey,
        sessionAddress: sessionWallet.address.toLowerCase(),
      };
      input.keyStore.write(record);
      return {
        backend: "privy",
        ownerAddress,
        sessionWallet,
        restored: false,
      };
    } finally {
      authorization.dispose();
    }
  });
}
