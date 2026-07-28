import { HALO_VERSION } from "./version";
import { relayCliVersion } from "./relayVersion";

function setVersionHeader(headers: Record<string, string>, version: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-halo-cli-version") delete headers[key];
  }
  headers["X-Halo-Cli-Version"] = version;
}

/** Replace any caller-supplied version header with the relay-reported CLI version. */
export function setCliVersionHeader(headers: Record<string, string>): void {
  setVersionHeader(headers, relayCliVersion());
}

/** Report the generated CLI version to facilitator routes without the relay-only override. */
export function setFacilitatorCliVersionHeader(headers: Record<string, string>): void {
  setVersionHeader(headers, HALO_VERSION);
}
