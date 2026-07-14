import { relayCliVersion } from "./relayVersion";

/** Replace any caller-supplied version header with the relay-reported CLI version. */
export function setCliVersionHeader(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "x-halo-cli-version") delete headers[key];
  }
  headers["X-Halo-Cli-Version"] = relayCliVersion();
}
