import type { HaloConfig, HaloConfigV1, HaloConfigV2 } from "../../config";
import {
  assertPrivyIdentityMatches,
  forgetPrivyIdentity,
  implicitKeystoreCatalog,
  retainKeystoreIdentity,
  selectPrivyIdentity,
  validateWalletCatalogMirror,
} from "../domain/walletCatalog";
import type { WalletCatalogV1 } from "../domain/walletCatalog";

export interface ResolvedWalletCatalog {
  catalog: WalletCatalogV1;
  explicit: boolean;
}

export function resolveWalletCatalog(config: HaloConfig): ResolvedWalletCatalog {
  if (config.version === 1) {
    return {
      catalog: implicitKeystoreCatalog(config.operator),
      explicit: false,
    };
  }
  const catalog = validateWalletCatalogMirror(config.walletCatalog, config.operator);
  return { catalog, explicit: true };
}

export function selectPrivyWallet(
  config: HaloConfig,
  input: { address: string; walletId: string; appId: string }
): HaloConfigV2 {
  const next = selectPrivyIdentity(resolveWalletCatalog(config).catalog, input);
  return { ...config, version: 2, walletCatalog: next };
}

export function assertPrivyWalletMatches(
  config: HaloConfig,
  input: { address: string; walletId: string; appId: string }
): void {
  assertPrivyIdentityMatches(resolveWalletCatalog(config).catalog, input);
}

export function forgetPrivyWallet(
  config: HaloConfig,
  confirmedAddress: string
): HaloConfigV2 {
  const walletCatalog = forgetPrivyIdentity(
    resolveWalletCatalog(config).catalog,
    confirmedAddress
  );
  return { ...config, version: 2, walletCatalog };
}

export function preserveConfiguredKeystore(
  previous: HaloConfig | null,
  nextV1: HaloConfigV1
): HaloConfig {
  if (previous === null) return nextV1;
  const resolved = resolveWalletCatalog(previous);
  if (
    !resolved.explicit &&
    previous.operator.address === nextV1.operator.address &&
    previous.operator.keystorePath === nextV1.operator.keystorePath
  ) {
    return nextV1;
  }
  const walletCatalog = retainKeystoreIdentity(resolved.catalog, nextV1.operator);
  return { ...nextV1, version: 2, walletCatalog };
}
