import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Wallet, TypedDataDomain } from "ethers";
import { recoverReceiptSigner, VAULT_ADDRESS } from "./vault";
import { VaultCreditLedger } from "./vaultCredit";
import { OperatorRedeemer } from "./vaultRedeemer";

const CHAIN = 8453n;
const OP = "0x2222222222222222222222222222222222222222";

const DOMAIN: TypedDataDomain = {
  name: "Halo",
  version: "2",
  chainId: Number(CHAIN),
  verifyingContract: VAULT_ADDRESS,
};
const TYPES = {
  Receipt: [
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "cumulative", type: "uint256" },
    { name: "keyEpoch", type: "uint256" },
    { name: "cycle", type: "uint64" },
  ],
};


test("FORGERY: an honest receipt recovers to the consumer's session key", async () => {
  const sessionKey = Wallet.createRandom();
  const consumer = sessionKey.address;
  const value = { consumer, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await sessionKey.signTypedData(DOMAIN, TYPES, value);
  const recovered = recoverReceiptSigner(CHAIN, value, sig);
  assert.equal(recovered, sessionKey.address.toLowerCase(), "recovers to the signer → operator accepts");
});

test("FORGERY: tampering cumulative after signing breaks recovery", async () => {
  const sessionKey = Wallet.createRandom();
  const consumer = sessionKey.address;
  const value = { consumer, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await sessionKey.signTypedData(DOMAIN, TYPES, value);
  const tampered = recoverReceiptSigner(CHAIN, { ...value, cumulative: 5_000_000n }, sig);
  assert.notEqual(tampered, sessionKey.address.toLowerCase(), "inflated cumulative → wrong signer → rejected");
});

test("FORGERY: a signature from a non-session key never matches", async () => {
  const attacker = Wallet.createRandom();
  const victim = Wallet.createRandom();
  const value = { consumer: victim.address, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await attacker.signTypedData(DOMAIN, TYPES, value);
  const recovered = recoverReceiptSigner(CHAIN, value, sig);
  assert.equal(recovered, attacker.address.toLowerCase());
  assert.notEqual(recovered, victim.address.toLowerCase());
});

test("REPLAY: a receipt signed for another cycle recovers to a different address", async () => {
  const sessionKey = Wallet.createRandom();
  const consumer = sessionKey.address;
  const value = { consumer, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await sessionKey.signTypedData(DOMAIN, TYPES, value);
  const atNewCycle = recoverReceiptSigner(CHAIN, { ...value, cycle: 2n }, sig);
  assert.notEqual(atNewCycle, sessionKey.address.toLowerCase(), "cycle-bound digest blocks cross-cycle replay");
});

test("REPLAY: a receipt signed for another chain recovers to a different address", async () => {
  const sessionKey = Wallet.createRandom();
  const value = { consumer: sessionKey.address, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await sessionKey.signTypedData(DOMAIN, TYPES, value);
  const onOtherChain = recoverReceiptSigner(1n, value, sig);
  assert.notEqual(onOtherChain, sessionKey.address.toLowerCase(), "domain chainId blocks cross-chain replay");
});

test("FORGERY: garbage signature returns null, not a throw", () => {
  const value = { consumer: OP, operator: OP, cumulative: 1n, keyEpoch: 0n, cycle: 1n };
  assert.equal(recoverReceiptSigner(CHAIN, value, "0xdeadbeef"), null);
  assert.equal(recoverReceiptSigner(CHAIN, value, "not-hex"), null);
});


test("GHOST: operator refuses to serve past the window with no receipts, resumes on one", () => {
  const C = "0x1111111111111111111111111111111111111111";
  const W = 1000n;
  const l = new VaultCreditLedger();
  l.admit(C, OP, 1n, 600n, W);
  l.settleServed(C, OP, 1n, 600n, 600n);
  l.admit(C, OP, 1n, 400n, W);
  l.settleServed(C, OP, 1n, 400n, 400n);
  assert.equal(l.admit(C, OP, 1n, 1n, W).ok, false, "ghosting consumer is refused at the window");
  l.recordReceipt(C, OP, { cumulative: 1000n, signature: "0xsig", cycle: 1n });
  assert.equal(l.outstandingFor(C, OP), 0n);
  assert.equal(l.admit(C, OP, 1n, 1000n, W).ok, true);
});

test("BOUND: a huge but COLLECTABLE over-signed receipt only grants its own worth of room", () => {
  const C = "0x1111111111111111111111111111111111111111";
  const W = 1000n;
  const l = new VaultCreditLedger();
  l.syncOnchain(C, OP, 1n, 0n, 10_000n);
  l.recordReceipt(C, OP, { cumulative: 10_000n, signature: "0xsig", cycle: 1n });
  let served = 0n;
  while (l.admit(C, OP, 1n, 100n, W).ok) {
    l.settleServed(C, OP, 1n, 100n, 100n);
    served += 100n;
    if (served > 20_000n) break;
  }
  assert.equal(served, 11_000n, "served up to held(10000) + W(1000), then refused");
  assert.ok(l.outstandingFor(C, OP) <= W, "un-receipted exposure never exceeds W");
});

test("BLEED (#437): a receipt PAST the collectable ceiling can't unlock unbounded serving", () => {
  const C = "0x1111111111111111111111111111111111111111";
  const W = 1000n;
  const l = new VaultCreditLedger();
  l.syncOnchain(C, OP, 1n, 0n, 1000n);
  l.recordReceipt(C, OP, { cumulative: 10_000n, signature: "0xsig", cycle: 1n });
  let served = 0n;
  while (l.admit(C, OP, 1n, 100n, W).ok) {
    l.settleServed(C, OP, 1n, 100n, 100n);
    served += 100n;
    if (served > 20_000n) break;
  }
  assert.equal(served, 2_000n, "served only ceiling(1000) + W(1000), then refused — no bleed to 11000");
  assert.ok(l.outstandingFor(C, OP) <= W, "uncollectable exposure stays bounded by the window");
  assert.equal(l.snapshot(C, OP)!.held, 10_000n, "the receipt is still kept for redeem (collects the 1000 ceiling)");
});


function mockFacilitator(handler: (n: number) => { status: number; body: unknown }) {
  let n = 0;
  const server = http.createServer((_req, res) => {
    n++;
    const { status, body } = handler(n);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
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

test("FACILITATOR DOWN: total outage leaves the receipt for a later retry (not lost)", async () => {
  const C = "0x1111111111111111111111111111111111111111";
  const fac = await mockFacilitator(() => ({ status: 500, body: { error: "down" } }));
  try {
    const l = new VaultCreditLedger();
    l.recordReceipt(C, OP, { cumulative: 700n, signature: "0xsig", cycle: 1n });
    const r = new OperatorRedeemer(fac.url, l);
    r.kick(C, OP);
    await r.flush();
    assert.equal(fac.count(), 4, "tried the full retry budget");
    assert.notEqual(l.redeemable(C, OP), null, "receipt is KEPT for a future kick — never dropped on outage");
  } finally {
    fac.close();
  }
});

test("FACILITATOR UNREACHABLE: connection refused is retried, receipt kept", async () => {
  const C = "0x1111111111111111111111111111111111111111";
  const l = new VaultCreditLedger();
  l.recordReceipt(C, OP, { cumulative: 700n, signature: "0xsig", cycle: 1n });
  const r = new OperatorRedeemer("http://127.0.0.1:1", l);
  r.kick(C, OP);
  await r.flush();
  assert.notEqual(l.redeemable(C, OP), null, "unreachable facilitator never strands collection state");
});

test("UNCOLLECTABLE: a BadSignature revert is terminal — no retry, abandoned", async () => {
  const C = "0x1111111111111111111111111111111111111111";
  const fac = await mockFacilitator(() => ({
    status: 400,
    body: { error: "vault submit failed: BadSignature()" },
  }));
  try {
    const l = new VaultCreditLedger();
    l.recordReceipt(C, OP, { cumulative: 700n, signature: "0xsig", cycle: 1n });
    const r = new OperatorRedeemer(fac.url, l);
    r.kick(C, OP);
    await r.flush();
    assert.equal(fac.count(), 1, "deterministic verify failure is NOT retried");
    assert.equal(l.redeemable(C, OP), null, "abandoned so the sweep won't spin on it forever");
  } finally {
    fac.close();
  }
});

test("TRANSIENT OVERMATCH: an RPC error containing 'already'/'stale' is RETRIED, not abandoned", async () => {
  const C = "0x1111111111111111111111111111111111111111";
  const fac = await mockFacilitator(() => ({
    status: 400,
    body: { error: "vault submit failed: nonce too low: transaction already known" },
  }));
  try {
    const l = new VaultCreditLedger();
    l.recordReceipt(C, OP, { cumulative: 700n, signature: "0xsig", cycle: 1n });
    const r = new OperatorRedeemer(fac.url, l);
    r.kick(C, OP);
    await r.flush();
    assert.equal(fac.count(), 4, "treated as transient → full retry budget, not a one-shot abandon");
    assert.notEqual(l.redeemable(C, OP), null, "collectible receipt KEPT for a later kick/sweep");
  } finally {
    fac.close();
  }
});

test("SWEEP: re-kicks pairs that still hold an unredeemed receipt", async () => {
  const C = "0x1111111111111111111111111111111111111111";
  const fac = await mockFacilitator(() => ({
    status: 200,
    body: {
      status: "confirmed",
      transaction: `0x${"a".repeat(64)}`,
      cumulative: "700",
      cycle: "1",
    },
  }));
  try {
    const l = new VaultCreditLedger();
    l.recordReceipt(C, OP, { cumulative: 700n, signature: "0xsig", cycle: 1n });
    const r = new OperatorRedeemer(fac.url, l);
    assert.deepEqual(l.pairsWithRedeemable(), [{ consumer: C, operator: OP }]);
    r.sweep();
    await r.flush();
    assert.equal(fac.count(), 1, "sweep collected the straggler");
    assert.equal(l.redeemable(C, OP), null);
    assert.deepEqual(l.pairsWithRedeemable(), [], "nothing left to sweep");
  } finally {
    fac.close();
  }
});
