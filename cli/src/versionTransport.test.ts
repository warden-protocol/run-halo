import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { HALO_VERSION } from "./version";
import {
  setCliVersionHeader,
  setFacilitatorCliVersionHeader,
} from "./versionHeader";
import { relayCliVersion, resetRelayVersionWarningForTest } from "./relayVersion";
import { VaultConsumeClient } from "./vault-consume";
import { vaultSend } from "./commands/consume";

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

test("facilitator headers always use the generated version, not the relay override", () => {
  const headers = {
    "content-type": "application/json",
    "x-halo-cli-version": "cli-v99.99.99",
  };
  setFacilitatorCliVersionHeader(headers);
  assert.deepEqual(headers, {
    "content-type": "application/json",
    "X-Halo-Cli-Version": HALO_VERSION,
  });
});

test("the CLI SDK adapter keeps the unsafe override relay-only", () => {
  const previousNoUpdate = process.env.HALO_NO_AUTOUPDATE;
  const previousOverride = process.env.HALO_UNSAFE_RELAY_CLI_VERSION;
  process.env.HALO_NO_AUTOUPDATE = "1";
  process.env.HALO_UNSAFE_RELAY_CLI_VERSION = "cli-v9.9.9";
  resetRelayVersionWarningForTest();
  try {
    const client = new VaultConsumeClient(Wallet.createRandom(), {
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
    });
    const protocolHeaders = (
      client as unknown as {
        protocolHeaders(target: "relay" | "facilitator"): Record<string, string>;
      }
    ).protocolHeaders.bind(client);
    assert.equal(protocolHeaders("relay")["X-Halo-Cli-Version"], "cli-v9.9.9");
    assert.equal(protocolHeaders("facilitator")["X-Halo-Cli-Version"], HALO_VERSION);
  } finally {
    if (previousNoUpdate === undefined) delete process.env.HALO_NO_AUTOUPDATE;
    else process.env.HALO_NO_AUTOUPDATE = previousNoUpdate;
    if (previousOverride === undefined) delete process.env.HALO_UNSAFE_RELAY_CLI_VERSION;
    else process.env.HALO_UNSAFE_RELAY_CLI_VERSION = previousOverride;
    resetRelayVersionWarningForTest();
  }
});

test("CLI relay transport binds its version across supported, 426, connection-loss, transient, and completed outcomes", async () => {
  const originalFetch = global.fetch;
  const cases: Array<{
    name: string;
    reply: () => Response | Promise<Response>;
    rejects: boolean;
  }> = [
    {
      name: "supported",
      reply: () =>
        new Response(JSON.stringify({ choices: [], usage: { total_tokens: 0 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      rejects: false,
    },
    {
      name: "terminal-426",
      reply: () =>
        new Response(JSON.stringify({ error: "cli_outdated" }), {
          status: 426,
          headers: { "content-type": "application/json" },
        }),
      rejects: false,
    },
    {
      name: "connection-loss",
      reply: () => Promise.reject(new Error("connection lost after send")),
      rejects: true,
    },
    {
      name: "transient-503",
      reply: () =>
        new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      rejects: false,
    },
    {
      name: "completed-response",
      reply: () =>
        new Response(JSON.stringify({ choices: [], usage: { total_tokens: 0 } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      rejects: false,
    },
  ];
  const client = {
    ensureReservation: async () => ({
      ops: { locked: 10n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
      keyEpoch: 1n,
    }),
    consumer: async () => "0x0000000000000000000000000000000000000001",
    recordAndRedeem: () => {},
  } as unknown as VaultConsumeClient;

  try {
    for (const scenario of cases) {
      const seen: Array<{ path: string; version: string | null }> = [];
      global.fetch = async (url, init) => {
        seen.push({
          path: new URL(String(url)).pathname,
          version: new Headers(init?.headers).get("X-Halo-Cli-Version"),
        });
        return scenario.reply();
      };
      const request = vaultSend(
        client,
        "https://relay.invalid/v1/chat/completions",
        { model: "model", messages: [] },
        {
          forwardHeaders: {},
          signal: new AbortController().signal,
          operator: "0x0000000000000000000000000000000000000002",
          priceUsdPerMtok: 1,
          estTokens: 1,
        }
      );
      if (scenario.rejects) await assert.rejects(request);
      else await request;
      assert.deepEqual(
        seen,
        [{ path: "/v1/chat/completions", version: relayCliVersion() }],
        scenario.name
      );
    }
  } finally {
    global.fetch = originalFetch;
  }
});
