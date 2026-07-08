import test from "node:test";
import assert from "node:assert/strict";
import { buildServiceEnvironment } from "./commands/service";

test("service environment preserves the auto-update opt-out and service marker", () => {
  const env = buildServiceEnvironment(
    {
      PATH: "/test/bin",
      HALO_PASSPHRASE: "secret",
      HALO_NO_AUTOUPDATE: "1",
      HTTPS_PROXY: "http://proxy.invalid",
      UNRELATED_SECRET: "must-not-leak",
    },
    "/test/home"
  );

  assert.deepEqual(env, {
    HOME: "/test/home",
    PATH: "/test/bin",
    HALO_SERVICE: "1",
    HALO_PASSPHRASE: "secret",
    HALO_NO_AUTOUPDATE: "1",
    HTTPS_PROXY: "http://proxy.invalid",
  });
});
