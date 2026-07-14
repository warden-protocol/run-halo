import test from "node:test";
import assert from "node:assert/strict";
import { HALO_VERSION } from "./version";
import { setCliVersionHeader } from "./versionHeader";
import { relayCliVersion, resetRelayVersionWarningForTest } from "./relayVersion";

test("setCliVersionHeader strips any caller-supplied version and forces the baked one", () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-halo-cli-version": "spoofed-lower",
    "X-HALO-CLI-VERSION": "spoofed-upper",
    "x-halo-operator": "0xabc",
  };
  setCliVersionHeader(headers);

  assert.equal(headers["X-Halo-Cli-Version"], HALO_VERSION);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["x-halo-operator"], "0xabc");
  const versionKeys = Object.keys(headers).filter(
    (k) => k.toLowerCase() === "x-halo-cli-version"
  );
  assert.deepEqual(versionKeys, ["X-Halo-Cli-Version"]);

  setCliVersionHeader(headers);
  assert.deepEqual(
    Object.keys(headers).filter((k) => k.toLowerCase() === "x-halo-cli-version"),
    ["X-Halo-Cli-Version"]
  );
});

test("relayCliVersion accepts an environment-only source-build override", () => {
  resetRelayVersionWarningForTest();
  assert.equal(
    relayCliVersion({
      HALO_NO_AUTOUPDATE: "1",
      HALO_UNSAFE_RELAY_CLI_VERSION: "0.2.2",
    }),
    "0.2.2"
  );
  assert.equal(
    relayCliVersion({
      HALO_NO_AUTOUPDATE: "1",
      HALO_UNSAFE_RELAY_CLI_VERSION: "cli-v1.2.3-14-gabcdef-dirty",
    }),
    "cli-v1.2.3-14-gabcdef-dirty"
  );
  assert.equal(
    relayCliVersion({
      HALO_NO_AUTOUPDATE: "1",
      HALO_UNSAFE_RELAY_CLI_VERSION: "1.2.3-dirty",
    }),
    "1.2.3-dirty"
  );
});

test("relayCliVersion rejects unsafe or malformed overrides before transport", () => {
  assert.throws(
    () => relayCliVersion({ HALO_UNSAFE_RELAY_CLI_VERSION: "0.2.2" }),
    /requires HALO_NO_AUTOUPDATE=1/
  );
  for (const value of ["", "v1.2.3", "1.2", "1.2.3future", "1.2.3-rc.1", "cli-v1.2.3-", " 1.2.3"]) {
    assert.throws(
      () =>
        relayCliVersion({
          HALO_NO_AUTOUPDATE: "1",
          HALO_UNSAFE_RELAY_CLI_VERSION: value,
        }),
      /invalid HALO_UNSAFE_RELAY_CLI_VERSION/
    );
  }
});
