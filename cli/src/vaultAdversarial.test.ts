/**
 * Adversarial / failure-mode spec for operator-driven redeem (issue #369).
 * Covers rogue consumers (forged/tampered/replayed receipts), the credit-window
 * bound under abuse, and facilitator failure handling. No chain needed.
 *
 * Run: node --require ts-node/register --test src/vaultAdversarial.test.ts
 */
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

// Mirror exactly what a real consumer signs (vault-consume.ts / vaultPay.ts).
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

// ── Rogue consumer: forged / tampered / replayed receipts ────────────────────

test("FORGERY: an honest receipt recovers to the consumer's session key", async () => {
  const sessionKey = Wallet.createRandom();
  const consumer = sessionKey.address; // session key signs on the consumer's behalf
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
  // Operator verifies the INFLATED amount the attacker wants credited.
  const tampered = recoverReceiptSigner(CHAIN, { ...value, cumulative: 5_000_000n }, sig);
  assert.notEqual(tampered, sessionKey.address.toLowerCase(), "inflated cumulative → wrong signer → rejected");
});

test("FORGERY: a signature from a non-session key never matches", async () => {
  const attacker = Wallet.createRandom();
  const victim = Wallet.createRandom();
  const value = { consumer: victim.address, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await attacker.signTypedData(DOMAIN, TYPES, value);
  const recovered = recoverReceiptSigner(CHAIN, value, sig);
  // Recovers to the attacker, NOT the victim — verifyReceipt compares against the
  // victim's on-chain session key, so this is refused.
  assert.equal(recovered, attacker.address.toLowerCase());
  assert.notEqual(recovered, victim.address.toLowerCase());
});

test("REPLAY: a receipt signed for another cycle recovers to a different address", async () => {
  const sessionKey = Wallet.createRandom();
  const consumer = sessionKey.address;
  const value = { consumer, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await sessionKey.signTypedData(DOMAIN, TYPES, value);
  // Operator always verifies against the CURRENT on-chain cycle; an old-cycle
  // receipt presented after a cycle bump fails to recover to the session key.
  const atNewCycle = recoverReceiptSigner(CHAIN, { ...value, cycle: 2n }, sig);
  assert.notEqual(atNewCycle, sessionKey.address.toLowerCase(), "cycle-bound digest blocks cross-cycle replay");
});

test("REPLAY: a receipt signed for another chain recovers to a different address", async () => {
  const sessionKey = Wallet.createRandom();
  const value = { consumer: sessionKey.address, operator: OP, cumulative: 500n, keyEpoch: 0n, cycle: 1n };
  const sig = await sessionKey.signTypedData(DOMAIN, TYPES, value);
  const onOtherChain = recoverReceiptSigner(84532n, value, sig); // base-sepolia domain
  assert.notEqual(onOtherChain, sessionKey.address.toLowerCase(), "domain chainId blocks cross-chain replay");
});

test("FORGERY: garbage signature returns null, not a throw", () => {
  const value = { consumer: OP, operator: OP, cumulative: 1n, keyEpoch: 0n, cycle: 1n };
  assert.equal(recoverReceiptSigner(CHAIN, value, "0xdeadbeef"), null);
  assert.equal(recoverReceiptSigner(CHAIN, value, "not-hex"), null);
});

// ── Rogue consumer: ghosting (stop sending receipts) ─────────────────────────

test("GHOST: operator refuses to serve past the window with no receipts, resumes on one", () => {
  const C = "0x1111111111111111111111111111111111111111";
  const W = 1000n;
  const l = new VaultCreditLedger();
  // Serve until the window is exhausted (no receipts arrive).
  l.admit(C, OP, 1n, 600n, W);
  l.settleServed(C, OP, 1n, 600n, 600n);
  l.admit(C, OP, 1n, 400n, W);
  l.settleServed(C, OP, 1n, 400n, 400n); // outstanding 1000 == W
  assert.equal(l.admit(C, OP, 1n, 1n, W).ok, false, "ghosting consumer is refused at the window");
  // A single receipt for the served work frees it and serving resumes.
  l.recordReceipt(C, OP, { cumulative: 1000n, signature: "0xsig", cycle: 1n });
  assert.equal(l.outstandingFor(C, OP), 0n);
  assert.equal(l.admit(C, OP, 1n, 1000n, W).ok, true);
});

test("BOUND: even a huge (over-signed) receipt only grants its own worth of room", () => {
  const C = "0x1111111111111111111111111111111111111111";
  const W = 1000n;
  const l = new VaultCreditLedger();
  // Consumer over-signs cumulative = 10×W (it's their own authorization to pay).
  l.recordReceipt(C, OP, { cumulative: 10_000n, signature: "0xsig", cycle: 1n });
  // The operator can now serve up to held + W before refusing — and every unit
  // is backed by the consumer's signature, so worst-case uncollected stays ≤ W.
  let served = 0n;
  while (l.admit(C, OP, 1n, 100n, W).ok) {
    l.settleServed(C, OP, 1n, 100n, 100n);
    served += 100n;
    if (served > 20_000n) break; // safety
  }
  assert.equal(served, 11_000n, "served up to held(10000) + W(1000), then refused");
  assert.ok(l.outstandingFor(C, OP) <= W, "un-receipted exposure never exceeds W");
});

// ── Facilitator failure handling ─────────────────────────────────────────────

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
  // Port 1 → connection refused immediately.
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
  // Regression: classifyRedeemError must key off the HaloVault custom-error NAMES,
  // not bare words. RPC/broadcast noise like "nonce too low: already known" or a
  // "stale" block read is transient — misreading it as collected would mark a real,
  // still-collectible receipt redeemed and silently drop the operator's revenue.
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
  const fac = await mockFacilitator(() => ({ status: 200, body: { hash: "0xok" } }));
  try {
    const l = new VaultCreditLedger();
    l.recordReceipt(C, OP, { cumulative: 700n, signature: "0xsig", cycle: 1n });
    const r = new OperatorRedeemer(fac.url, l);
    // No explicit kick — the periodic sweep discovers the held receipt.
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
