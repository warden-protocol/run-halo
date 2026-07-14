import { getAddress, isAddress } from "ethers";
import { VAULT_ADDRESS } from "@halo/vault-core";

export { VAULT_ADDRESS } from "@halo/vault-core";

export type FacilitatorVaultStatus =
  | { status: "match"; live: string }
  | { status: "mismatch"; live: string }
  | { status: "missing"; live: null }
  | { status: "invalid"; live: string }
  | { status: "unavailable"; live: null; detail: string };

/** Resolve a configured vault or the repository consensus fallback once. */
export function resolveVaultAddress(configured?: string | null): string {
  const candidate = configured === undefined || configured === null ? VAULT_ADDRESS : configured.trim();
  if (!isAddress(candidate)) {
    throw new Error(
      `invalid vaultAddress in config: ${JSON.stringify(candidate)} (must be a 20-byte 0x hex address)`
    );
  }
  return getAddress(candidate);
}

/** Compare the selected vault with the facilitator's live public identity. */
export async function inspectFacilitatorVault(
  facilitatorUrl: string,
  expectedVault: string
): Promise<FacilitatorVaultStatus> {
  try {
    const res = await fetch(`${facilitatorUrl.replace(/\/+$/, "")}/vault/info`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { status: "unavailable", live: null, detail: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { vault?: unknown };
    if (typeof body.vault !== "string" || body.vault.trim() === "") {
      return { status: "missing", live: null };
    }
    if (!isAddress(body.vault)) return { status: "invalid", live: body.vault };
    const live = getAddress(body.vault);
    return live === getAddress(expectedVault)
      ? { status: "match", live }
      : { status: "mismatch", live };
  } catch (err) {
    return {
      status: "unavailable",
      live: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** A concise diagnostic that never treats --force as authority to move funds. */
export function facilitatorVaultError(
  expectedVault: string,
  result: Exclude<FacilitatorVaultStatus, { status: "match" }>,
  force = false
): string {
  const live = result.live ?? "not reported";
  const reason =
    result.status === "mismatch"
      ? `reports ${live}`
      : result.status === "invalid"
        ? "reports an invalid address"
        : result.status === "missing"
          ? "omits its live vault address"
          : `is unavailable (${result.detail})`;
  return (
    `facilitator vault identity check failed: selected ${expectedVault}, but /vault/info ${reason}. ` +
    `Refusing vault-paid or fund-moving work.${force ? " --force cannot bypass an unverifiable or mismatched vault." : ""}`
  );
}
