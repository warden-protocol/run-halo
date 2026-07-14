import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Wallet } from "ethers";
import { VaultConsumeClient, type OpsState } from "./vault-consume";

const OP = "0x2222222222222222222222222222222222222222";
const OPS: OpsState = { locked: 100_000n, redeemed: 0n, expiry: 9_999_999_999n, created: 0n, cycle: 1n };

function mockFacilitator(handler: (n: number) => { status: number; body: unknown }) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n++;
      const { status, body } = handler(n);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ url: string; count: () => number; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        count: () => n,
        close: () => server.close(),
      })
    );
  });
}

function client(facUrl: string): VaultConsumeClient {
  const c = new VaultConsumeClient(Wallet.createRandom(), {
    facilitatorUrl: facUrl,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
    relayUrl: "",
  });
  c.readOps = async () => OPS;
  return c;
}

test("a successful redeem clears the pending receipt", async () => {
  const fac = await mockFacilitator(() => ({ status: 200, body: { hash: "0xok" } }));
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 0, "redeemed → nothing pending");
    assert.ok(fac.count() >= 1);
  } finally {
    fac.close();
  }
});

test("a transient failure KEEPS the receipt pending for retry", async () => {
  const fac = await mockFacilitator(() => ({ status: 500, body: { error: "rpc blip" } }));
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 1, "transient failure → kept pending (timer will retry)");
    assert.ok(fac.count() >= 2, "retried at least once");
  } finally {
    fac.close();
  }
});

test("StaleReceipt (already collected) drops the pending receipt — no endless retry", async () => {
  const fac = await mockFacilitator(() => ({
    status: 400,
    body: { error: "vault submit failed: StaleReceipt()" },
  }));
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 0, "operator already collected → not pending");
  } finally {
    fac.close();
  }
});

test("BadSignature (cycle moved on) is abandoned, not retried forever", async () => {
  const fac = await mockFacilitator(() => ({
    status: 400,
    body: { error: "vault submit failed: BadSignature()" },
  }));
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 0, "uncollectable → abandoned");
  } finally {
    fac.close();
  }
});

test("recovers: transient failures then a success clears it", async () => {
  const fac = await mockFacilitator((n) =>
    n < 2 ? { status: 500, body: { error: "down" } } : { status: 200, body: { hash: "0xok" } }
  );
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 0, "eventually collected");
  } finally {
    fac.close();
  }
});

test("a higher cumulative supersedes the pending entry for the same cycle", async () => {
  const fac = await mockFacilitator(() => ({ status: 500, body: { error: "down" } }));
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    c.recordAndRedeem(OP, OPS, 0n, 2_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 1, "one pending entry per (operator, cycle)");
  } finally {
    fac.close();
  }
});

test("TRANSIENT OVERMATCH: an RPC error containing 'already'/'stale' is KEPT pending, not dropped", async () => {
  const fac = await mockFacilitator(() => ({
    status: 400,
    body: { error: "vault submit failed: nonce too low: transaction already known" },
  }));
  try {
    const c = client(fac.url);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 1, "transient 'already known' → kept pending for retry");
    assert.ok(fac.count() >= 2, "retried, not one-shot abandoned");
  } finally {
    fac.close();
  }
});
