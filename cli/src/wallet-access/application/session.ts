import { getAddress, verifyMessage } from "ethers";
import { WalletAccessError } from "../domain/walletAccess";
import type {
  WalletAccessGateway,
  WalletAccessSession,
} from "../domain/walletAccess";

export const WALLET_ACCESS_PROOF = "Halo Wallet Access v1";

export interface SavedWalletAccessSession<
  Session extends WalletAccessSession = WalletAccessSession,
> {
  version: 1;
  state: "active";
  session: Session;
  verifiedAt: string;
  refreshedAt: string;
}

export interface WalletAccessSessionStore<
  Session extends WalletAccessSession = WalletAccessSession,
> {
  read(): SavedWalletAccessSession<Session> | null;
  write(record: SavedWalletAccessSession<Session>): void;
  clear(): void;
}

export async function loginWithWalletAccess<Session extends WalletAccessSession>(input: {
  gateway: WalletAccessGateway<Session>;
  store: WalletAccessSessionStore<Session>;
  onChallenge: (challenge: { verificationUri: string; userCode: string }) => void | Promise<void>;
  expectedAddress?: string;
  validateSession?: (session: Session) => void;
  now?: () => Date;
}): Promise<SavedWalletAccessSession<Session>> {
  const authorization = await input.gateway.authorize(input.onChallenge);
  try {
    const signature = await authorization.signPersonalMessage(
      WALLET_ACCESS_PROOF
    );
    let recovered: string;
    try {
      recovered = getAddress(
        verifyMessage(WALLET_ACCESS_PROOF, signature)
      );
    } catch {
      throw new WalletAccessError(
        "privy_protocol_error",
        "The wallet provider returned an invalid proof. No session was saved."
      );
    }
    let address: string;
    let sessionAddress: string;
    try {
      address = getAddress(authorization.identity.address);
      sessionAddress = getAddress(authorization.session.identity.address);
    } catch {
      throw new WalletAccessError(
        "privy_protocol_error",
        "The wallet provider returned an invalid identity. No session was saved."
      );
    }
    if (
      authorization.identity.backend !== authorization.session.identity.backend ||
      recovered !== address ||
      sessionAddress !== address
    ) {
      throw new WalletAccessError(
        "privy_protocol_error",
        "The wallet provider returned a proof for a different identity. No session was saved."
      );
    }
    if (
      input.expectedAddress !== undefined &&
      getAddress(input.expectedAddress) !== address
    ) {
      throw new WalletAccessError(
        "privy_wallet_identity_changed",
        "The wallet provider returned a different wallet. Run halo logout before changing the saved identity."
      );
    }
    const session = {
      ...authorization.session,
      identity: { ...authorization.session.identity, address },
    };
    const verifiedAt = (input.now ?? (() => new Date()))().toISOString();
    const record: SavedWalletAccessSession<Session> = {
      version: 1,
      state: "active",
      session,
      verifiedAt,
      refreshedAt: verifiedAt,
    };
    input.validateSession?.(record.session);
    input.store.write(record);
    return record;
  } finally {
    authorization.dispose();
  }
}

export async function proveSavedWalletAccess<Session extends WalletAccessSession>(input: {
  gateway: WalletAccessGateway<Session>;
  store: WalletAccessSessionStore<Session>;
}): Promise<SavedWalletAccessSession<Session>> {
  const record = input.store.read();
  if (!record) {
    throw new WalletAccessError(
      "privy_login_required",
      "No Wallet Access session exists. Run halo login first."
    );
  }
  const authorization = await input.gateway.resume(record.session);
  try {
    const signature = await authorization.signPersonalMessage(
      WALLET_ACCESS_PROOF
    );
    const recovered = getAddress(
      verifyMessage(WALLET_ACCESS_PROOF, signature)
    );
    if (recovered !== record.session.identity.address) {
      throw new WalletAccessError(
        "privy_protocol_error",
        "The wallet provider returned a proof for a different identity. The saved session was not changed."
      );
    }
    return record;
  } catch (error) {
    if (error instanceof WalletAccessError) throw error;
    throw new WalletAccessError(
      "privy_protocol_error",
      "The wallet provider returned an invalid proof. The saved session was not changed."
    );
  } finally {
    authorization.dispose();
  }
}

export function walletAccessSessionState<Session extends WalletAccessSession>(
  record: SavedWalletAccessSession<Session>,
  now = new Date()
): "active" | "expired" {
  return new Date(record.session.expiresAt).getTime() > now.getTime()
    ? "active"
    : "expired";
}
