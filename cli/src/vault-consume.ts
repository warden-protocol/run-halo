import { Wallet, type HDNodeWallet } from "ethers";
import {
  HaloVaultClient,
  type VaultConfig as SdkVaultConfig,
} from "halo-sdk";
import {
  VAULT_ADDRESS,
  deriveSubKeyPrivateKey,
  formatUsdcBase,
  subKeyDerivationMessage,
} from "@halo/vault-core";
import {
  facilitatorVaultError,
  inspectFacilitatorVault,
  resolveVaultAddress,
  type FacilitatorVaultStatus,
} from "./vault-address";

export {
  VAULT_ADDRESS,
  computeReserveAmount,
  estimateTokens,
  completionCeilingTokens,
  priceTokens,
} from "@halo/vault-core";
export type { OpsState, VaultState } from "@halo/vault-core";

type SignerWallet = Wallet | HDNodeWallet;

export interface VaultConfig
  extends Omit<SdkVaultConfig, "log" | "reserveLiquiditySlots"> {
  relayUrl?: string;
}

const reserveLiquiditySlots = (() => {
  const value = Number(process.env.HALO_VAULT_RESERVE_SLOTS ?? "8");
  return Number.isFinite(value) && value >= 1 ? BigInt(Math.floor(value)) : 8n;
})();

export class VaultConsumeClient extends HaloVaultClient {
  constructor(wallet: SignerWallet, cfg: VaultConfig, sessionSigner?: SignerWallet) {
    super(
      wallet,
      {
        ...cfg,
        reserveLiquiditySlots,
        log: (message) => console.log(`  ${message}`),
      },
      sessionSigner
    );
  }
}

export function fmtUsd(base: bigint): string {
  return formatUsdcBase(base);
}

/** Receipt signer mode: main wallet or browser-compatible derived key. */
export type SessionKeyMode = "wallet" | "browser";

/** Derive the browser-compatible session key from the shared signed message. */
export async function deriveBrowserSessionKey(wallet: SignerWallet): Promise<Wallet> {
  const owner = await wallet.getAddress();
  const sig = await wallet.signMessage(subKeyDerivationMessage(owner));
  return new Wallet(deriveSubKeyPrivateKey(sig));
}

/** Resolve the session-key signer for a mode: `undefined` for "wallet" (the wallet
 *  itself signs), or the derived browser sub-wallet for "browser". */
export async function resolveSessionSigner(
  wallet: SignerWallet,
  mode: SessionKeyMode
): Promise<Wallet | undefined> {
  return mode === "browser" ? deriveBrowserSessionKey(wallet) : undefined;
}

/** Compare the selected and live vault; unavailable or missing state fails closed. */
export async function checkVaultAddressFresh(
  facilitatorUrl: string,
  vaultAddress: string = VAULT_ADDRESS
): Promise<FacilitatorVaultStatus> {
  return inspectFacilitatorVault(facilitatorUrl, resolveVaultAddress(vaultAddress));
}

/** Block every unverifiable or mismatched vault identity; --force is not an authority bypass. */
export async function guardVaultFresh(
  facilitatorUrl: string,
  vaultAddress: string = VAULT_ADDRESS,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  const selected = resolveVaultAddress(vaultAddress);
  const result = await checkVaultAddressFresh(facilitatorUrl, selected);
  if (result.status === "match") return true;
  console.error(`\n  ✗ ${facilitatorVaultError(selected, result, opts.force)}\n`);
  return false;
}
