export const SDK_CLI_VERSION = "cli-v0.6.0";

export type VersionHeaderTarget = "relay" | "facilitator";
export type VersionHeaderProvider = (target: VersionHeaderTarget) => string;

/** @internal First-party CLI and test seam; intentionally absent from the package index. */
export const INTERNAL_CLI_VERSION_PROVIDER = Symbol("halo-sdk.cli-version-provider");

export type InternalVersionConfig = {
  [INTERNAL_CLI_VERSION_PROVIDER]?: VersionHeaderProvider;
};

export function cliVersionHeader(version: string = SDK_CLI_VERSION): Record<string, string> {
  return { "X-Halo-Cli-Version": version };
}
