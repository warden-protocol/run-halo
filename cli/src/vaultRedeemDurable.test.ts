/**
 * Restart-durable redeem spec (issue #369 follow-up). A pending redeem persisted
 * by one process must be resumed and settled by the next — so a consumer restart
 * never abandons the served tail.
 *
 * Run: node --require ts-node/register --test src/vaultRedeemDurable.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return new Promise<{ url: string; count: () => number; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, count: () => n, close: () => server.close() })
    )
  );
}

const client = (facUrl: string, store: string) => {
  const c = new VaultConsumeClient(Wallet.createRandom(), {
    facilitatorUrl: facUrl,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 8453,
    relayUrl: "",
    pendingStorePath: store,
  });
  // Stale-cycle guard reads on-chain ops() before posting; no live RPC here, so
  // return current-cycle state (no-op guard) and drive drops via the facilitator.
  c.readOps = async () => OPS;
  return c;
};

test("a pending redeem persists to disk and a fresh client resumes + settles it", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-${process.pid}-${Date.now()}.json`);
  const down = await mockFacilitator(() => ({ status: 500, body: { error: "down" } }));
  try {
    // Process A: facilitator down → redeem fails transiently → stays pending + persisted.
    const a = client(down.url, store);
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

  // Process B: NEW client (simulating a restart) with the same store + a healthy
  // facilitator. resumePendingRedeems() must load and settle it.
  const up = await mockFacilitator(() => ({ status: 200, body: { hash: "0xok" } }));
  try {
    const b = client(up.url, store);
    assert.equal(b.pendingRedeemCount, 0, "fresh client starts empty (in-memory)");
    b.resumePendingRedeems();
    assert.equal(b.pendingRedeemCount, 1, "resumed the persisted pending redeem");
    await b.flushRedeems();
    assert.equal(b.pendingRedeemCount, 0, "the resumed redeem settled after restart");
    assert.ok(up.count() >= 1, "submitted the resumed redeem to the facilitator");
    const left = JSON.parse(fs.readFileSync(store, "utf-8"));
    assert.equal(left.length, 0, "store emptied once collected");
  } finally {
    up.close();
    try {
      fs.unlinkSync(store);
    } catch {
      /* ignore */
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
      // no pendingStorePath
    });
    c.readOps = async () => OPS; // no-op stale-cycle guard (no live RPC)
    c.recordAndRedeem(OP, OPS, 0n, 1_000n);
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 1, "still retries in memory");
    c.resumePendingRedeems(); // no-op without a store path — must not throw
  } finally {
    up.close();
  }
});

test("stale persisted entry (cycle moved on) is dropped on resume, not retried forever", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-stale-${process.pid}-${Date.now()}.json`);
  // Hand-write a persisted entry for an old cycle.
  fs.writeFileSync(
    store,
    JSON.stringify([{ key: `${OP}:1`, operator: OP, cumulative: "1000", signature: "0xsig", cycle: "1" }])
  );
  // Facilitator rejects with a terminal BadSignature (cycle moved on).
  const fac = await mockFacilitator(() => ({ status: 400, body: { error: "vault submit failed: BadSignature()" } }));
  try {
    const c = client(fac.url, store);
    c.resumePendingRedeems();
    await c.flushRedeems();
    assert.equal(c.pendingRedeemCount, 0, "stale entry abandoned, not stuck");
    assert.equal(JSON.parse(fs.readFileSync(store, "utf-8")).length, 0, "store self-healed");
  } finally {
    fac.close();
    try {
      fs.unlinkSync(store);
    } catch {
      /* ignore */
    }
  }
});

test("a truncated/corrupt pending file is skipped, not fatal, on resume", async () => {
  const store = path.join(os.tmpdir(), `halo-pending-corrupt-${process.pid}-${Date.now()}.json`);
  // Simulate a torn write from a crash mid-persist: valid-prefix, truncated JSON.
  fs.writeFileSync(store, '[{"key":"0x2222:1","operator":"0x2222","cumu');
  const fac = await mockFacilitator(() => ({ status: 200, body: { hash: "0xok" } }));
  try {
    const c = client(fac.url, store);
    c.resumePendingRedeems(); // must not throw on a corrupt file
    assert.equal(c.pendingRedeemCount, 0, "corrupt file yields no resumed redeems");
    await c.flushRedeems();
    assert.equal(fac.count(), 0, "nothing submitted from a corrupt file");
  } finally {
    fac.close();
    try {
      fs.unlinkSync(store);
    } catch {
      /* ignore */
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
      /* ignore */
    }
  }
});
