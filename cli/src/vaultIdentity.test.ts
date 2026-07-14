import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  inspectFacilitatorVault,
  resolveVaultAddress,
} from "./vault-address";
import { guardVaultFresh } from "./vault-consume";

const EXPECTED = "0x000000000000000000000000000000000000dEaD";

function mockInfo(status: number, body: unknown) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test("resolveVaultAddress validates and normalizes config", () => {
  assert.equal(resolveVaultAddress(EXPECTED), EXPECTED);
  assert.throws(() => resolveVaultAddress("0x1234"), /invalid vaultAddress/);
  assert.throws(() => resolveVaultAddress("  "), /invalid vaultAddress/);
});

test("facilitator vault identity matches case-insensitively after normalization", async () => {
  const mock = await mockInfo(200, { vault: EXPECTED.toLowerCase() });
  try {
    assert.deepEqual(await inspectFacilitatorVault(mock.url, EXPECTED), {
      status: "match",
      live: EXPECTED,
    });
  } finally {
    mock.close();
  }
});

test("facilitator vault identity fails closed for missing, invalid, mismatched, and unavailable state", async () => {
  for (const [body, status] of [
    [{ vault: null }, "missing"],
    [{ vault: "0x1234" }, "invalid"],
    [{ vault: "0x0000000000000000000000000000000000000001" }, "mismatch"],
  ] as const) {
    const mock = await mockInfo(200, body);
    try {
      assert.equal((await inspectFacilitatorVault(mock.url, EXPECTED)).status, status);
    } finally {
      mock.close();
    }
  }
  const mock = await mockInfo(503, {});
  try {
    assert.equal((await inspectFacilitatorVault(mock.url, EXPECTED)).status, "unavailable");
  } finally {
    mock.close();
  }
});

test("--force cannot bypass a mismatched facilitator vault", async () => {
  const mock = await mockInfo(200, {
    vault: "0x0000000000000000000000000000000000000001",
  });
  const originalError = console.error;
  let diagnostic = "";
  console.error = (...values: unknown[]) => {
    diagnostic += values.join(" ");
  };
  try {
    assert.equal(await guardVaultFresh(mock.url, EXPECTED, { force: true }), false);
    assert.match(diagnostic, /--force cannot bypass/);
  } finally {
    console.error = originalError;
    mock.close();
  }
});
