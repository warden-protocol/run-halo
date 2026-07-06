/**
 * CLI adapter for the shared headless HaloVault client.
 *
 * Stateful reserve/redeem orchestration lives in `halo-sdk`'s
 * `HaloVaultClient`; the CLI only supplies its wallet-oriented defaults and log
 * sink. Keeping this adapter deliberately thin prevents money-path fixes from
 * needing a second ~560-line implementation.
 */
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

/** Session-key scheme for the vault rail:
 *  - "wallet" (default): the CLI wallet IS the session key (signs receipts directly).
 *  - "browser": derive the SAME in-browser sub-wallet the Halo web app registers,
 *    so one wallet works on BOTH surfaces (#426 cross-surface). */
export type SessionKeyMode = "wallet" | "browser";

/**
 * Derive the browser-compatible session sub-wallet from the main wallet using the
 * IDENTICAL deterministic derivation the Halo web app uses (shared message +
 * keccak256 of the personal_sign — `@halo/vault-core`). One wallet then reproduces
 * the SAME session key on both the CLI and the browser. Local signature only — no
 * popup, no gas. Works for a plain EOA main wallet (the CLI keystore always is);
 * a browser smart-account wallet would derive differently and can't be shared.
 */
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

/**
 * Detect a stale build: compare our PINNED `VAULT_ADDRESS` against the live vault
 * the facilitator submits to (`GET /vault/info`). After a vault redeploy, an
 * out-of-date binary silently targets the OLD vault — wrong reads, and redeems
 * land where the network isn't watching (issue #392). Fails OPEN: an old
 * facilitator without the endpoint, or a network blip, returns `match: true`
 * (`live: null`) so it never blocks consume; only a CONFIRMED different address
 * returns `match: false`.
 */
export async function checkVaultAddressFresh(
  facilitatorUrl: string
): Promise<{ match: boolean; live: string | null }> {
  try {
    const res = await fetch(`${facilitatorUrl.replace(/\/+$/, "")}/vault/info`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { match: true, live: null };
    const body = (await res.json()) as { vault?: string | null };
    const live = (body.vault || "").toLowerCase();
    if (!live) return { match: true, live: null };
    return { match: live === VAULT_ADDRESS.toLowerCase(), live: body.vault ?? null };
  } catch {
    return { match: true, live: null };
  }
}

/**
 * Fail-CLOSED staleness gate for fund-moving paths (#392). Runs
 * {@link checkVaultAddressFresh} and, on a CONFIRMED mismatch, refuses to move
 * funds so a stale build can't deposit/reserve/redeem against the WRONG vault —
 * the failure mode #392 exists to prevent. `force` downgrades the block to a
 * warning. Fails OPEN (returns `true`) for old facilitators / network blips, so
 * a missing endpoint or blip never blocks a correct build. Returns whether the
 * caller may proceed; the caller decides how to abort (exit vs skip).
 */
export async function guardVaultFresh(
  facilitatorUrl: string,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  const fresh = await checkVaultAddressFresh(facilitatorUrl);
  if (fresh.match) return true;
  const detail =
    `\n  ⚠ STALE VAULT ADDRESS — this build pins ${VAULT_ADDRESS}\n` +
    `    but the facilitator's live vault is ${fresh.live}.\n` +
    `    Deposits/reserves/redeems would hit the WRONG (old) vault.\n`;
  if (opts.force) {
    console.warn(detail + `    Proceeding anyway (--force).\n`);
    return true;
  }
  console.error(
    detail + `    Refusing to move funds. Rebuild/upgrade the CLI, or pass --force to override.\n`
  );
  return false;
}
