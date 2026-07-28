const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { HaloVaultClient, payInference } = require("../dist/vault");
const publicSdk = require("halo-sdk");

const SDK_VERSION = "cli-v0.6.0";
const CONSUMER = "0x0000000000000000000000000000000000000001";
const OPERATOR = "0x0000000000000000000000000000000000000002";

function versionFrom(init) {
  return new Headers(init?.headers).get("X-Halo-Cli-Version");
}

test("packed SDK consumers cannot import or activate the CLI-only version seam", () => {
  assert.equal(publicSdk.INTERNAL_CLI_VERSION_PROVIDER, undefined);
  assert.throws(
    () => require("halo-sdk/dist/versionHeader"),
    (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
  );

  const consumerRoot = mkdtempSync(join(tmpdir(), "halo-sdk-consumer-"));
  try {
    const packJson = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--pack-destination", consumerRoot],
        {
          cwd: join(__dirname, ".."),
          encoding: "utf8",
        }
      )
    );
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8")
    );
    assert.deepEqual(Object.keys(packageJson.exports), [".", "./package.json"]);
    assert.ok(
      packJson[0].files.some((file) => file.path === "dist/versionHeader.js"),
      "the internal artifact may be packaged for the first-party CLI"
    );

    const installedSdk = join(consumerRoot, "node_modules", "halo-sdk");
    mkdirSync(installedSdk, { recursive: true });
    execFileSync(
      "tar",
      [
        "-xzf",
        join(consumerRoot, packJson[0].filename),
        "-C",
        installedSdk,
        "--strip-components=1",
      ],
      { stdio: "pipe" }
    );
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        "try { require('halo-sdk/dist/versionHeader'); process.exit(2); } catch (error) { process.stdout.write(String(error.code)); }",
      ],
      { cwd: consumerRoot, encoding: "utf8" }
    );
    assert.equal(output, "ERR_PACKAGE_PATH_NOT_EXPORTED");
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});

test("SDK representative gated transport binds the fixed header across HTTP outcomes", async (t) => {
  const originalFetch = global.fetch;
  const cases = [
    {
      name: "supported",
      reply: () =>
        new Response(JSON.stringify({ hash: `0x${"a".repeat(64)}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      succeeds: true,
    },
    {
      name: "terminal-426",
      reply: () =>
        new Response(JSON.stringify({ error: "cli_outdated" }), {
          status: 426,
          headers: { "content-type": "application/json" },
        }),
      succeeds: false,
    },
    {
      name: "connection-loss",
      reply: () => Promise.reject(new Error("connection lost after send")),
      succeeds: false,
    },
    {
      name: "transient-503",
      reply: () =>
        new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      succeeds: false,
    },
    {
      name: "completed-response",
      reply: () =>
        new Response(JSON.stringify({ hash: `0x${"b".repeat(64)}` }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      succeeds: true,
    },
  ];
  t.after(() => {
    global.fetch = originalFetch;
  });

  for (const scenario of cases) {
    const seen = [];
    global.fetch = async (url, init) => {
      seen.push({
        path: new URL(url).pathname,
        version: versionFrom(init),
      });
      return scenario.reply();
    };
    const client = new HaloVaultClient(
      {
        getAddress: async () => CONSUMER,
        signTypedData: async () => "0xsigned",
      },
      {
        facilitatorUrl: "https://facilitator.invalid",
        rpcUrl: "http://127.0.0.1:1",
        chainId: 8453,
      }
    );
    client.consumer = async () => CONSUMER;

    const request = client.postReserve(
      { operator: OPERATOR, amount: 10n, expiry: 20n, nonce: 1n },
      "0xsigned"
    );
    if (scenario.succeeds) await request;
    else await assert.rejects(request);
    assert.deepEqual(
      seen,
      [{ path: "/vault/reserve", version: SDK_VERSION }],
      `${scenario.name} must preserve one fixed-version attempt`
    );
  }
});

test("SDK vault writes and receipt delivery use the built-in non-overridable version", async (t) => {
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    seen.push({ path, version: versionFrom(init) });
    if (path === "/vault/redeem") {
      return new Response(
        JSON.stringify({
          status: "confirmed",
          transaction: `0x${"a".repeat(64)}`,
          cumulative: "10",
          cycle: "1",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (path === "/v1/receipt") return new Response("", { status: 202 });
    return new Response(JSON.stringify({ hash: `0x${"b".repeat(64)}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new HaloVaultClient(
    {
      getAddress: async () => CONSUMER,
      signTypedData: async () => "0xsigned",
    },
    {
      facilitatorUrl: "https://facilitator.invalid",
      relayUrl: "https://relay.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      cliVersion: "cli-v99.99.99",
    }
  );
  client.consumer = async () => CONSUMER;

  await client.postReserve(
    { operator: OPERATOR, amount: 10n, expiry: 20n, nonce: 1n },
    "0xsigned"
  );
  await client.postRedeem(OPERATOR, 10n, 1n, "0xsigned");
  assert.equal(await client.pushReceipt(OPERATOR, 10n, "0xsigned"), true);
  await client.postRelease(OPERATOR);

  assert.deepEqual(seen, [
    { path: "/vault/reserve", version: SDK_VERSION },
    { path: "/vault/redeem", version: SDK_VERSION },
    { path: "/v1/receipt", version: SDK_VERSION },
    { path: "/vault/release", version: SDK_VERSION },
  ]);
});

test("SDK chat POST carries the version while operator discovery remains unversioned", async (t) => {
  const originalFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    seen.push({ path, method: init?.method ?? "GET", version: versionFrom(init) });
    if (path === "/v1/operators") {
      return new Response(
        JSON.stringify({
          operators: [
            {
              address: OPERATOR,
              models: ["model"],
              pricing: { model: 0.001 },
              vaultPayments: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ choices: [], usage: { total_tokens: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await payInference({
    signer: {},
    relayUrl: "https://relay.invalid",
    facilitatorUrl: "https://facilitator.invalid",
    rpcUrl: "http://127.0.0.1:1",
    body: { model: "model", messages: [] },
    client: {
      ensureReservation: async () => ({
        ops: { locked: 100n, redeemed: 0n, expiry: 0n, created: 0n, cycle: 1n },
        keyEpoch: 1n,
      }),
      consumer: async () => CONSUMER,
      recordAndRedeem: () => {
        throw new Error("zero usage must not redeem");
      },
    },
  });

  assert.deepEqual(seen, [
    { path: "/v1/operators", method: "GET", version: null },
    { path: "/v1/chat/completions", method: "POST", version: SDK_VERSION },
  ]);
});
