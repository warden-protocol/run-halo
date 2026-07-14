import { HALO_VERSION } from "./version";

const RELAY_VERSION_RE =
  /^(?:cli-v)?\d+\.\d+\.\d+(?:-(?:\d+-g[0-9a-fA-F]+(?:-dirty)?|dirty))?$/;

let warnedFor: string | null = null;

/** Resolve the version reported only to relay transports. */
export function relayCliVersion(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HALO_UNSAFE_RELAY_CLI_VERSION;
  if (raw === undefined) return HALO_VERSION;

  const reported = raw;
  if (env.HALO_NO_AUTOUPDATE !== "1") {
    throw new Error(
      "HALO_UNSAFE_RELAY_CLI_VERSION requires HALO_NO_AUTOUPDATE=1; refusing the unsafe relay compatibility override"
    );
  }
  if (!RELAY_VERSION_RE.test(reported)) {
    throw new Error(
      `invalid HALO_UNSAFE_RELAY_CLI_VERSION ${JSON.stringify(raw)}; expected X.Y.Z or cli-vX.Y.Z with an optional git-describe suffix`
    );
  }
  if (warnedFor !== reported) {
    console.warn(
      `\n  ⚠ UNSAFE RELAY VERSION OVERRIDE — source is ${HALO_VERSION}, reporting ${reported} to the relay only.\n` +
        "    This bypasses the compatibility gate; it does not make this source revision compatible.\n"
    );
    warnedFor = reported;
  }
  return reported;
}

/** Reset warning state for isolated tests. */
export function resetRelayVersionWarningForTest(): void {
  warnedFor = null;
}
