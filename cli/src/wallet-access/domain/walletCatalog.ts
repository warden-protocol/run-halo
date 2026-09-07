import path from "node:path";
import { getAddress } from "ethers";
import { WalletAccessError } from "./walletAccess";

export type WalletCatalogSelector = "keystore" | "privy" | "none";

export interface KeystoreWalletIdentity {
  backend: "keystore";
  address: string;
  keystorePath: string;
}

export interface PrivyWalletIdentity {
  backend: "privy";
  address: string;
  walletId: string;
}

export interface WalletCatalogV1 {
  version: 1;
  selector: WalletCatalogSelector;
  generation: number;
  keystoreIdentity: KeystoreWalletIdentity | null;
  privyIdentity: PrivyWalletIdentity | null;
  privyAppId: string | null;
}

export type WalletCatalogFailureCode =
  | "privy_tenant_mismatch"
  | "privy_wallet_identity_changed"
  | "wallet_backend_transition_ambiguous"
  | "wallet_selector_generation_exhausted";

export class WalletCatalogError extends WalletAccessError {
  readonly name = "WalletCatalogError";

  constructor(code: WalletCatalogFailureCode, message: string) {
    super(code, message);
  }
}

function invalidCatalog(message = "The configured wallet catalog is invalid."): WalletCatalogError {
  return new WalletCatalogError("wallet_backend_transition_ambiguous", message);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validatedAddress(value: unknown): string {
  if (typeof value !== "string") throw invalidCatalog();
  try {
    getAddress(value);
  } catch {
    throw invalidCatalog();
  }
  return value;
}

function parseKeystoreIdentity(value: unknown): KeystoreWalletIdentity | null {
  if (value === null) return null;
  const identity = record(value);
  if (
    identity === null ||
    !exactKeys(identity, ["backend", "address", "keystorePath"]) ||
    identity.backend !== "keystore" ||
    typeof identity.keystorePath !== "string" ||
    identity.keystorePath.length === 0 ||
    !path.isAbsolute(identity.keystorePath)
  ) {
    throw invalidCatalog();
  }
  return {
    backend: "keystore",
    address: validatedAddress(identity.address),
    keystorePath: identity.keystorePath,
  };
}

function parsePrivyIdentity(value: unknown): PrivyWalletIdentity | null {
  if (value === null) return null;
  const identity = record(value);
  if (
    identity === null ||
    !exactKeys(identity, ["backend", "address", "walletId"]) ||
    identity.backend !== "privy" ||
    typeof identity.walletId !== "string" ||
    identity.walletId.length === 0 ||
    identity.walletId.length > 256
  ) {
    throw invalidCatalog();
  }
  return {
    backend: "privy",
    address: validatedAddress(identity.address),
    walletId: identity.walletId,
  };
}

export function validateWalletCatalog(value: unknown): WalletCatalogV1 {
  const catalog = record(value);
  if (
    catalog === null ||
    !exactKeys(catalog, [
      "version",
      "selector",
      "generation",
      "keystoreIdentity",
      "privyIdentity",
      "privyAppId",
    ]) ||
    catalog.version !== 1 ||
    (catalog.selector !== "keystore" &&
      catalog.selector !== "privy" &&
      catalog.selector !== "none") ||
    !Number.isSafeInteger(catalog.generation) ||
    Number(catalog.generation) < 0
  ) {
    throw invalidCatalog();
  }

  const keystoreIdentity = parseKeystoreIdentity(catalog.keystoreIdentity);
  const privyIdentity = parsePrivyIdentity(catalog.privyIdentity);
  const privyAppId = catalog.privyAppId;
  if (
    (privyAppId !== null &&
      (typeof privyAppId !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(privyAppId))) ||
    (privyIdentity === null) !== (privyAppId === null) ||
    (catalog.selector === "keystore" && keystoreIdentity === null) ||
    (catalog.selector === "privy" && privyIdentity === null)
  ) {
    throw invalidCatalog();
  }
  if (
    keystoreIdentity !== null &&
    privyIdentity !== null &&
    getAddress(keystoreIdentity.address) === getAddress(privyIdentity.address)
  ) {
    throw invalidCatalog("Keystore and Privy catalog identities must be distinct.");
  }

  return {
    version: 1,
    selector: catalog.selector,
    generation: Number(catalog.generation),
    keystoreIdentity,
    privyIdentity,
    privyAppId: privyAppId as string | null,
  };
}

export function validateWalletCatalogMirror(
  value: unknown,
  mirror: { address: string; keystorePath: string }
): WalletCatalogV1 {
  const catalog = validateWalletCatalog(value);
  if (
    catalog.keystoreIdentity === null ||
    catalog.keystoreIdentity.address !== mirror.address ||
    catalog.keystoreIdentity.keystorePath !== mirror.keystorePath
  ) {
    throw invalidCatalog("The config wallet mirror conflicts with the wallet catalog.");
  }
  return catalog;
}

export function implicitKeystoreCatalog(input: {
  address: string;
  keystorePath: string;
}): WalletCatalogV1 {
  return validateWalletCatalog({
    version: 1,
    selector: "keystore",
    generation: 0,
    keystoreIdentity: {
      backend: "keystore",
      address: input.address,
      keystorePath: input.keystorePath,
    },
    privyIdentity: null,
    privyAppId: null,
  });
}

function nextGeneration(generation: number): number {
  if (generation === Number.MAX_SAFE_INTEGER) {
    throw new WalletCatalogError(
      "wallet_selector_generation_exhausted",
      "The wallet catalog generation is exhausted; no wallet change was saved."
    );
  }
  return generation + 1;
}

export function selectPrivyIdentity(
  current: WalletCatalogV1,
  input: { address: string; walletId: string; appId: string }
): WalletCatalogV1 {
  const normalized = validateWalletCatalog(current);
  assertPrivyIdentityMatches(normalized, input);
  const candidate = validateWalletCatalog({
    ...normalized,
    selector: "privy",
    privyIdentity: {
      backend: "privy",
      address: input.address,
      walletId: input.walletId,
    },
    privyAppId: input.appId,
  });
  if (normalized.selector === "privy" && normalized.privyIdentity !== null) {
    return normalized;
  }
  return { ...candidate, generation: nextGeneration(normalized.generation) };
}

export function assertPrivyIdentityMatches(
  current: WalletCatalogV1,
  input: { address: string; walletId: string; appId: string }
): void {
  const normalized = validateWalletCatalog(current);
  const candidate = validateWalletCatalog({
    ...normalized,
    privyIdentity: {
      backend: "privy",
      address: input.address,
      walletId: input.walletId,
    },
    privyAppId: input.appId,
  });
  if (
    normalized.privyIdentity !== null &&
    normalized.privyAppId !== candidate.privyAppId
  ) {
    throw new WalletCatalogError(
      "privy_tenant_mismatch",
      "The configured Privy app does not match this Wallet Access session."
    );
  }
  if (
    normalized.privyIdentity !== null &&
    (normalized.privyIdentity.address !== candidate.privyIdentity?.address ||
      normalized.privyIdentity.walletId !== candidate.privyIdentity.walletId)
  ) {
    throw new WalletCatalogError(
      "privy_wallet_identity_changed",
      "Privy returned a different wallet identity; the configured wallet was not changed."
    );
  }
}

export function forgetPrivyIdentity(
  current: WalletCatalogV1,
  confirmedAddress: string
): WalletCatalogV1 {
  const normalized = validateWalletCatalog(current);
  const outgoing = normalized.privyIdentity;
  if (outgoing === null) {
    throw new WalletCatalogError(
      "wallet_backend_transition_ambiguous",
      "No pinned Privy wallet exists to forget."
    );
  }

  let confirmed: string;
  try {
    confirmed = getAddress(confirmedAddress);
  } catch {
    throw new WalletCatalogError(
      "wallet_backend_transition_ambiguous",
      "The confirmation must be the complete outgoing Privy wallet address."
    );
  }
  if (confirmed !== getAddress(outgoing.address)) {
    throw new WalletCatalogError(
      "wallet_backend_transition_ambiguous",
      "The confirmation does not match the outgoing Privy wallet address."
    );
  }

  const candidate = validateWalletCatalog({
    ...normalized,
    selector:
      normalized.selector === "privy"
        ? normalized.keystoreIdentity === null
          ? "none"
          : "keystore"
        : normalized.selector,
    privyIdentity: null,
    privyAppId: null,
  });
  return { ...candidate, generation: nextGeneration(normalized.generation) };
}

export function retainKeystoreIdentity(
  current: WalletCatalogV1,
  input: { address: string; keystorePath: string }
): WalletCatalogV1 {
  const normalized = validateWalletCatalog(current);
  const candidate = validateWalletCatalog({
    ...normalized,
    keystoreIdentity: {
      backend: "keystore",
      address: input.address,
      keystorePath: input.keystorePath,
    },
  });
  const previousIdentity = normalized.keystoreIdentity;
  const nextIdentity = candidate.keystoreIdentity;
  if (
    previousIdentity !== null &&
    nextIdentity !== null &&
    previousIdentity.address === nextIdentity.address &&
    previousIdentity.keystorePath === nextIdentity.keystorePath
  ) {
    return normalized;
  }
  return { ...candidate, generation: nextGeneration(normalized.generation) };
}
