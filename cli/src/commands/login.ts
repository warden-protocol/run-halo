import prompts from "prompts";
import { existsSync } from "node:fs";
import {
  PrivyWalletAccessGateway,
  validatePrivyAppId,
} from "../wallet-access/infrastructure/privy";
import { WalletAccessError } from "../wallet-access/domain/walletAccess";
import {
  loginWithWalletAccess,
  proveSavedWalletAccess,
  walletAccessSessionState,
} from "../wallet-access/application/session";
import { FileWalletAccessSessionStore } from "../wallet-access/infrastructure/fileSessionStore";
import { refreshExpiredPrivySession } from "../wallet-access/application/refresh";
import { configPath, DEFAULT_PRIVY_APP_ID, loadConfig, saveConfig } from "../config";
import {
  assertPrivyWalletMatches,
  forgetPrivyWallet,
  resolveWalletCatalog,
  selectPrivyWallet,
} from "../wallet-access/application/catalog";
import {
  readPrivyWalletForgetAudit,
  type PrivyWalletForgetAudit,
} from "../wallet-access/application/forget";
import { WalletCatalogError } from "../wallet-access/domain/walletCatalog";
import type { PrivyWalletAccessSession } from "../wallet-access/domain/walletAccess";

function loadWalletAccessConfig(): ReturnType<typeof loadConfig> {
  const path = configPath();
  try {
    return loadConfig(path);
  } catch {
    if (!existsSync(path)) {
      throw new WalletAccessError(
        "halo_setup_required",
        `No config at ${path}. Run: halo setup`
      );
    }
    throw new WalletAccessError(
      "wallet_backend_transition_ambiguous",
      "The wallet configuration is invalid. Inspect it before using Wallet Access."
    );
  }
}

export interface LogoutOptions {
  forgetWallet?: boolean;
  confirmedAddress?: string;
  requestConfirmation?: (outgoingAddress: string) => Promise<string | undefined>;
}

function selectedConfigForSession(
  config: ReturnType<typeof loadConfig>,
  session: PrivyWalletAccessSession
) {
  return selectPrivyWallet(config, {
    address: session.identity.address,
    walletId: session.walletId,
    appId: session.appId,
  });
}

function saveCatalogChange(
  current: ReturnType<typeof loadConfig>,
  next: ReturnType<typeof selectedConfigForSession>
): void {
  if (
    current.version === 1 ||
    current.walletCatalog.generation !== next.walletCatalog.generation
  ) {
    saveConfig(next);
  }
}

export async function cmdLogin(): Promise<void> {
  const config = loadWalletAccessConfig();
  const resolvedCatalog = resolveWalletCatalog(config);
  const appId = validatePrivyAppId(process.env.HALO_PRIVY_APP_ID ?? DEFAULT_PRIVY_APP_ID);
  const store = new FileWalletAccessSessionStore();
  const gateway = new PrivyWalletAccessGateway({ appId });
  let stored = store.readState();
  const initialIdentity =
    stored.kind === "active"
      ? stored.record.session
      : stored.kind === "reauthentication_required"
        ? stored.record
        : null;
  if (initialIdentity && resolvedCatalog.catalog.privyIdentity !== null) {
    assertPrivyWalletMatches(config, {
      address: initialIdentity.identity.address,
      walletId: initialIdentity.walletId,
      appId: initialIdentity.appId,
    });
  }
  const storedAppId =
    stored.kind === "active"
      ? stored.record.session.appId
      : stored.kind === "reauthentication_required"
        ? stored.record.appId
        : null;
  const refreshRequired =
    stored.kind === "active" &&
    walletAccessSessionState(stored.record) === "expired";
  if (refreshRequired) {
    stored = await refreshExpiredPrivySession({ gateway, store, appId });
  }
  if (storedAppId !== null && storedAppId !== appId) {
    throw new WalletAccessError(
      "privy_tenant_mismatch",
      "The saved Privy session belongs to another app. Run halo logout before changing HALO_PRIVY_APP_ID."
    );
  }
  const storedIdentity =
    stored.kind === "active"
      ? stored.record.session
      : stored.kind === "reauthentication_required"
        ? stored.record
        : null;
  if (stored.kind === "active") {
    const reused = await proveSavedWalletAccess({ gateway, store });
    saveCatalogChange(config, selectedConfigForSession(config, reused.session));
    console.log(
      `  ✓ ${refreshRequired ? "Refreshed" : "Reused active"} Privy session: ${reused.session.identity.address}`
    );
    console.log("  Selected wallet backend: Privy");
    console.log(`  Access token expires: ${reused.session.expiresAt}`);
    console.log("  halo consume now uses this selected Privy wallet when its Vault account is pre-funded and its session key matches.\n");
    return;
  }
  let selectedConfig: ReturnType<typeof selectedConfigForSession> | null = null;
  const record = await loginWithWalletAccess({
    gateway,
    store,
    onChallenge: ({ verificationUri, userCode }) => {
      console.log("\n  Privy Wallet Access");
      console.log("  ─────────────────────────────");
      console.log(`  Visit: ${verificationUri}`);
      console.log(`  Code:  ${userCode}`);
      console.log("  Waiting for browser approval…\n");
    },
    expectedAddress:
      resolvedCatalog.catalog.privyIdentity?.address ??
      storedIdentity?.identity.address,
    validateSession: (session) => {
      selectedConfig = selectedConfigForSession(config, session);
    },
  });
  saveCatalogChange(
    config,
    selectedConfig ?? selectedConfigForSession(config, record.session)
  );
  console.log(`  ✓ Privy session active: ${record.session.identity.address}`);
  console.log("  Selected wallet backend: Privy");
  console.log(`  Access token expires: ${record.session.expiresAt}`);
  console.log("  A later halo login can reuse or refresh this session without browser approval.");
  console.log("  halo consume now uses this selected Privy wallet when its Vault account is pre-funded and its session key matches.\n");
}

function printForgetAudit(audit: PrivyWalletForgetAudit): void {
  console.log("\n  Privy wallet forget audit");
  console.log("  ─────────────────────────");
  console.log(`  Outgoing address:   ${audit.outgoingAddress}`);
  console.log(`  Selected backend:   ${audit.selectedBackend}`);
  console.log(`  Catalog generation: ${audit.catalogGeneration}`);
  console.log(`  Local session:      ${audit.sessionState}`);
  console.log(`  Audit result:       ${audit.result}`);
  console.log("  State copied to replacement: none");
}

async function requestForgetConfirmation(
  options: LogoutOptions,
  outgoingAddress: string
): Promise<string> {
  if (options.confirmedAddress !== undefined) return options.confirmedAddress;
  if (options.requestConfirmation !== undefined) {
    return (await options.requestConfirmation(outgoingAddress)) ?? "";
  }
  const response = await prompts({
    type: "text",
    name: "address",
    message: `Type the complete outgoing address ${outgoingAddress} to confirm`,
  });
  return typeof response.address === "string" ? response.address : "";
}

export async function cmdLogout(options: LogoutOptions = {}): Promise<void> {
  const store = new FileWalletAccessSessionStore();
  if (options.forgetWallet) {
    const initialAudit = readPrivyWalletForgetAudit(loadWalletAccessConfig(), store);
    printForgetAudit(initialAudit);
    const confirmedAddress = await requestForgetConfirmation(
      options,
      initialAudit.outgoingAddress
    );
    const committed = await store.withRefreshLock(async () => {
      const currentConfig = loadWalletAccessConfig();
      const lockedAudit = readPrivyWalletForgetAudit(currentConfig, store);
      if (
        lockedAudit.outgoingAddress !== initialAudit.outgoingAddress ||
        lockedAudit.catalogGeneration !== initialAudit.catalogGeneration
      ) {
        throw new WalletCatalogError(
          "wallet_backend_transition_ambiguous",
          "The outgoing Privy wallet changed during confirmation; nothing was changed."
        );
      }
      const nextConfig = forgetPrivyWallet(currentConfig, confirmedAddress);
      store.clear();
      saveConfig(nextConfig);
      return {
        outgoingAddress: lockedAudit.outgoingAddress,
        previousGeneration: lockedAudit.catalogGeneration,
        generation: nextConfig.walletCatalog.generation,
        selectedBackend: nextConfig.walletCatalog.selector,
      };
    });
    console.log(`\n  ✓ Forgot pinned Privy wallet ${committed.outgoingAddress}`);
    console.log(
      `  Catalog generation: ${committed.previousGeneration} → ${committed.generation}`
    );
    console.log(`  Selected wallet backend: ${committed.selectedBackend}`);
    console.log("  Local Privy Wallet Access session removed.");
    console.log("  Other identity-scoped state was retained and was not copied.");
    console.log("  Provider-side authorization was not revoked.\n");
    return;
  }
  try {
    store.clear();
  } catch (error) {
    if (error instanceof WalletAccessError) throw error;
    throw new WalletAccessError(
      "privy_session_persistence_ambiguous",
      "Could not remove the local Privy session record."
    );
  }
  console.log("Local Privy Wallet Access session removed.");
  console.log("Provider-side authorization was not revoked; see #1068 limitations.");
}
