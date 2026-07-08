import { HALO_VERSION } from "./version";

/**
 * Force the outbound CLI version header on an outgoing request.
 *
 * Strips any caller-supplied `x-halo-cli-version` (in any casing) first so a
 * forwarded or spoofed value cannot override the baked build version, then sets
 * the canonical header to `HALO_VERSION`. Kept in ONE place so both payment
 * rails — x402 (`payAndFetch`) and vault (`vaultSend`) — report identically;
 * drift between them would let one rail send a stale or spoofable version and
 * defeat the relay's minimum-version floor check, which trusts this header.
 *
 * (version.ts is code-generated and clobbered on every build, so this helper
 * cannot live alongside HALO_VERSION there.)
 */
export function setCliVersionHeader(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-halo-cli-version") delete headers[key];
  }
  headers["X-Halo-Cli-Version"] = HALO_VERSION;
}
