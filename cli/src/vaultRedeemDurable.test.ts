import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { Wallet } from "ethers";
import { VAULT_ADDRESS } from "@halo/vault-core";
import { VaultConsumeClient, type OpsState } from "./vault-consume";

const OP = "0x2222222222222222222222222222222222222222";
const OPS: OpsState = { locked: 100_000n, redeemed: 0n, expiry: 9_999_999_999n, created: 0n, cycle: 1n };
const confirmed = () => ({
  status: "confirmed",
  transaction: `0x${"a".repeat(64)}`,
  cumulative: "1000",
  cycle: "1",
});

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
  return new Promise<{ url: string; count: () => number; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => n, close: () => server.close() })
    )
  );
}

const client = (facUrl: string, store: string, wallet = Wallet.createRandom()) => {
  const c = new VaultConsumeClient(wallet, {
    facilitatorUrl: facUrl,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
    relayUrl: "",
    pendingStorePath: store,
  });
  c.readOps = async () => OPS;
  return c;
};

test("a pending redeem persists to disk and a fresh client resumes + settles it", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-${process.pid}-${Date.now()}.json`);
  const wallet = Wallet.createRandom();
  const down = await mockFacilitator(() => ({ status: 500, body: { error: "down" } }));
  try {
    const a = client(down.url, store, wallet);
    a.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await a.flushRedeems();
    assert.equal(a.pendingRedeemCount, 1, "kept pending after transient failure");
    assert.ok(fs.existsSync(store), "pending queue persisted to disk");
    const persisted = JSON.parse(fs.readFileSync(store, "utf-8"));
    assert.equal(persisted.length, 1, "one entry persisted");
    assert.equal(persisted[0].cumulative, "1000");
  } finally {
    down.close();
  }

  const up = await mockFacilitator(() => ({ status: 200, body: confirmed() }));
  try {
    const b = client(up.url, store, wallet);
    assert.equal(b.pendingRedeemCount, 0, "fresh client starts empty (in-memory)");
    await b.resumePendingRedeems();
    assert.ok(up.count() >= 1, "submitted the resumed redeem to the facilitator");
    assert.equal(b.pendingRedeemCount, 0, "the resumed redeem settled during replay");
    await b.flushRedeems();
    assert.equal(b.pendingRedeemCount, 0, "the resumed redeem remains settled after flush");
    const left = JSON.parse(fs.readFileSync(store, "utf-8"));
    assert.equal(left.length, 0, "store emptied once collected");
  } finally {
    up.close();
    try {
      fs.unlinkSync(store);
    } catch {
    }
  }
});

test("no store path → in-memory only, no file written (back-compat)", async () => {
  const up = await mockFacilitator(() => ({ status: 500, body: { error: "down" } }));
  try {
    const c = new VaultConsumeClient(Wallet.createRandom(), {
      facilitatorUrl: up.url,
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      relayUrl: "",
    });
    c.readOps = async () => OPS;
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 1, "still retries in memory");
    await c.resumePendingRedeems();
  } finally {
    up.close();
  }
});

test("stale persisted entry (cycle moved on) is dropped on resume, not retried forever", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-stale-${process.pid}-${Date.now()}.json`);
  const wallet = Wallet.createRandom();
  fs.writeFileSync(
    store,
    JSON.stringify([
      {
        key: `${OP}:1`,
        chainId: 8453,
        vaultAddress: VAULT_ADDRESS,
        consumer: wallet.address,
        operator: OP,
        cumulative: "1000",
        signature: "0xsig",
        cycle: "1",
      },
    ])
  );
  const fac = await mockFacilitator(() => ({ status: 400, body: { error: "vault submit failed: BadSignature()" } }));
  try {
    const c = client(fac.url, store, wallet);
    await c.resumePendingRedeems();
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 0, "stale entry abandoned, not stuck");
    assert.equal(JSON.parse(fs.readFileSync(store, "utf-8")).length, 0, "store self-healed");
  } finally {
    fac.close();
    try {
      fs.unlinkSync(store);
    } catch {
    }
  }
});

test("a truncated/corrupt pending file is skipped, not fatal, on resume", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-corrupt-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(store, '[{"key":"0x2222:1","operator":"0x2222","cumu');
  const fac = await mockFacilitator(() => ({ status: 200, body: confirmed() }));
  try {
    const c = client(fac.url, store);
    await c.resumePendingRedeems();
    assert.equal(c.pendingRedeemCount, 0, "corrupt file yields no resumed redeems");
    await c.flushRedeems();
    assert.equal(fac.count(), 0, "nothing submitted from a corrupt file");
  } finally {
    fac.close();
    try {
      fs.unlinkSync(store);
    } catch {
    }
  }
});

test("persist is atomic — no leftover .tmp file after a redeem is queued", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-atomic-${process.pid}-${Date.now()}.json`);
  const down = await mockFacilitator(() => ({ status: 500, body: { error: "down" } }));
  try {
    const c = client(down.url, store);
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.ok(fs.existsSync(store), "queue persisted");
    assert.ok(!fs.existsSync(`${store}.tmp`), "temp file renamed away, not left behind");
  } finally {
    down.close();
    try {
      fs.unlinkSync(store);
    } catch {
    }
  }
});
