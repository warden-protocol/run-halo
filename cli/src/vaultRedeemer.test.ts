import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { VaultCreditLedger } from "./vaultCredit";
import { OperatorRedeemer } from "./vaultRedeemer";

const C = "0x1111111111111111111111111111111111111111";
const O = "0x2222222222222222222222222222222222222222";
const CY = 1n;

interface Hit { consumer: string; operator: string; cumulative: string; cycle: string; signature: string }

const TX = `0x${"a".repeat(64)}`;
const confirmed = (cumulative: string) => ({
  status: "confirmed",
  transaction: TX,
  cumulative,
  cycle: CY.toString(),
});

function mockFacilitator(handler: (hit: Hit, n: number) => { status: number; body: unknown }) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const hit = JSON.parse(raw) as Hit;
      hits.push(hit);
      const { status, body } = handler(hit, hits.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise<{ url: string; hits: Hit[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, hits, close: () => server.close() });
    });
  });
}

test("kick redeems the held receipt with the correct body, then marks it collected", async () => {
  const fac = await mockFacilitator((hit) => ({ status: 200, body: confirmed(hit.cumulative) }));
  try {
    const ledger = new VaultCreditLedger();
    ledger.recordReceipt(C, O, { cumulative: 500n, signature: "0xsig", cycle: CY });
    const r = new OperatorRedeemer(fac.url, ledger);
    r.kick(C, O);
    await r.flush();
    assert.equal(fac.hits.length, 1);
    assert.deepEqual(fac.hits[0], {
      consumer: C,
      operator: O,
      cumulative: "500",
      cycle: "1",
      signature: "0xsig",
    });
    assert.equal(ledger.redeemable(C, O), null, "nothing left owed after a confirmed redeem");
  } finally {
    fac.close();
  }
});

test("retries a transient failure and eventually collects", async () => {
  const fac = await mockFacilitator((_h, n) =>
    n < 3
      ? { status: 500, body: { error: "rpc blip" } }
      : { status: 200, body: confirmed("700") }
  );
  try {
    const ledger = new VaultCreditLedger();
    ledger.recordReceipt(C, O, { cumulative: 700n, signature: "0xsig", cycle: CY });
    const r = new OperatorRedeemer(fac.url, ledger);
    r.kick(C, O);
    await r.flush();
    assert.equal(fac.hits.length, 3, "two failures then success");
    assert.equal(ledger.redeemable(C, O), null);
  } finally {
    fac.close();
  }
});

test("coalesces many kicks into one redeem of the HIGHEST cumulative", async () => {
  const fac = await mockFacilitator((hit) => ({ status: 200, body: confirmed(hit.cumulative) }));
  try {
    const ledger = new VaultCreditLedger();
    const r = new OperatorRedeemer(fac.url, ledger);
    ledger.recordReceipt(C, O, { cumulative: 100n, signature: "0xa", cycle: CY });
    r.kick(C, O);
    ledger.recordReceipt(C, O, { cumulative: 250n, signature: "0xb", cycle: CY });
    r.kick(C, O);
    ledger.recordReceipt(C, O, { cumulative: 400n, signature: "0xc", cycle: CY });
    r.kick(C, O);
    await r.flush();
    const last = fac.hits[fac.hits.length - 1];
    assert.equal(last.cumulative, "400");
    assert.equal(last.signature, "0xc");
    assert.equal(ledger.redeemable(C, O), null);
  } finally {
    fac.close();
  }
});

test("pending and reverted responses retain the receipt for a later sweep", async () => {
  for (const status of ["pending", "reverted"] as const) {
    const fac = await mockFacilitator((hit) => ({
      status: status === "pending" ? 202 : 200,
      body: {
        status,
        transaction: TX,
        cumulative: hit.cumulative,
        cycle: hit.cycle,
        ...(status === "pending" ? { coalesced: false } : {}),
      },
    }));
    try {
      const ledger = new VaultCreditLedger();
      ledger.recordReceipt(C, O, { cumulative: 600n, signature: "0xsig", cycle: CY });
      const r = new OperatorRedeemer(fac.url, ledger);
      r.kick(C, O);
      await r.flush();
      assert.equal(fac.hits.length, 1);
      assert.notEqual(ledger.redeemable(C, O), null, `${status} must remain retryable`);
    } finally {
      fac.close();
    }
  }
});

test("confirmed already-covered responses are terminal only in the signed cycle", async () => {
  const fac = await mockFacilitator((_hit, n) => ({
    status: 200,
    body: {
      status: "already-redeemed",
      redeemed: "700",
      cycle: n === 1 ? "2" : "1",
    },
  }));
  try {
    const ledger = new VaultCreditLedger();
    ledger.recordReceipt(C, O, { cumulative: 700n, signature: "0xsig", cycle: CY });
    const r = new OperatorRedeemer(fac.url, ledger);
    r.kick(C, O);
    await r.flush();
    assert.equal(fac.hits.length, 2, "mismatched-cycle coverage is retried");
    assert.equal(ledger.redeemable(C, O), null);
  } finally {
    fac.close();
  }
});

test("typed invalid receipts are abandoned while unavailable responses are retried", async () => {
  const invalid = await mockFacilitator(() => ({
    status: 400,
    body: { status: "rejected", reason: "invalid-receipt", error: "BadSignature" },
  }));
  try {
    const ledger = new VaultCreditLedger();
    ledger.recordReceipt(C, O, { cumulative: 800n, signature: "0xbad", cycle: CY });
    const r = new OperatorRedeemer(invalid.url, ledger);
    r.kick(C, O);
    await r.flush();
    assert.equal(invalid.hits.length, 1);
    assert.equal(ledger.redeemable(C, O), null);
  } finally {
    invalid.close();
  }

  const unavailable = await mockFacilitator((hit, n) =>
    n === 1
      ? {
          status: 503,
          body: { status: "rejected", reason: "unavailable", error: "RPC unavailable" },
        }
      : { status: 200, body: confirmed(hit.cumulative) }
  );
  try {
    const ledger = new VaultCreditLedger();
    ledger.recordReceipt(C, O, { cumulative: 850n, signature: "0xsig", cycle: CY });
    const r = new OperatorRedeemer(unavailable.url, ledger);
    r.kick(C, O);
    await r.flush();
    assert.equal(unavailable.hits.length, 2);
    assert.equal(ledger.redeemable(C, O), null);
  } finally {
    unavailable.close();
  }
});

test("treats a StaleReceipt revert as already-collected (no infinite retry)", async () => {
  const fac = await mockFacilitator(() => ({
    status: 400,
    body: { error: "vault submit failed: StaleReceipt()" },
  }));
  try {
    const ledger = new VaultCreditLedger();
    ledger.recordReceipt(C, O, { cumulative: 900n, signature: "0xsig", cycle: CY });
    const r = new OperatorRedeemer(fac.url, ledger);
    r.kick(C, O);
    await r.flush();
    assert.equal(fac.hits.length, 1, "a stale revert is terminal — no retry");
    assert.equal(ledger.redeemable(C, O), null, "marked collected so we don't resubmit");
  } finally {
    fac.close();
  }
});
