/**
 * Credit-window ledger spec (issue #369). Run: `npx ts-node --test src/vaultCredit.test.ts`
 *
 * The load-bearing property is invariant #3: floated un-receipted work
 * (`outstanding`) never exceeds the window, under any interleaving of
 * admit / settle / release / recordReceipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { VaultCreditLedger, creditWindowBase } from "./vaultCredit";

const C = "0x1111111111111111111111111111111111111111";
const O = "0x2222222222222222222222222222222222222222";
const CY = 1n;
const W = 1000n;

const sig = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

test("admits while within the window, refuses past it", () => {
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 600n, W).ok, true); // inflight 600
  assert.equal(l.admit(C, O, CY, 400n, W).ok, true); // inflight 1000 (==W)
  assert.equal(l.admit(C, O, CY, 1n, W).ok, false); // 1001 > W → refuse
});

test("a receipt drains the window so serving resumes", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 600n, W);
  l.settleServed(C, O, CY, 600n, 600n); // served 600, inflight 0 → outstanding 600
  assert.equal(l.outstandingFor(C, O), 600n);
  assert.equal(l.admit(C, O, CY, 500n, W).ok, false); // 600+500 > 1000
  l.recordReceipt(C, O, { cumulative: 600n, signature: sig(1), cycle: CY }); // held 600
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 500n, W).ok, true); // window freed
});

test("restart baseline prevents old cumulative receipts from granting fresh credit", () => {
  const l = new VaultCreditLedger();
  // Process starts midway through a cycle after 10k has already been redeemed.
  l.recordReceipt(C, O, { cumulative: 10_000n, signature: sig(1), cycle: CY });
  l.syncOnchain(C, O, CY, 10_000n);
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, W, W).ok, true);
  l.settleServed(C, O, CY, W, W);
  assert.equal(l.admit(C, O, CY, 1n, W).ok, false, "old receipt cannot offset post-restart work");
});

test("on-chain redeemed baseline alone starts with zero exposure", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 10_000n);
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, W, W).ok, true);
});

test("ceiling is reserved at admit, trued-up to actual on settle", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 900n, W); // pessimistic reserve at ceiling
  assert.equal(l.admit(C, O, CY, 200n, W).ok, false); // 900+200 > 1000 — ceiling protects the window
  l.settleServed(C, O, CY, 900n, 100n); // actual was only 100
  assert.equal(l.outstandingFor(C, O), 100n);
  assert.equal(l.admit(C, O, CY, 800n, W).ok, true); // now fits (100+800)
});

test("failed serve releases the reserved ceiling with no served value", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 700n, W);
  l.releaseInflight(C, O, CY, 700n);
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 1000n, W).ok, true);
});

test("INVARIANT: outstanding never exceeds the window across interleavings", () => {
  const l = new VaultCreditLedger();
  // Deterministic PRNG (no Math.random) so failures reproduce.
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 1 | s)) >>> 0), s / 4294967296);
  const pick = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  const inflight: bigint[] = []; // ceilings currently admitted
  let nextCum = 0n; // monotonic cumulative for receipts
  let servedTotal = 0n;

  for (let i = 0; i < 20000; i++) {
    const op = pick(0, 3);
    if (op === 0) {
      const ceiling = BigInt(pick(1, 300));
      const r = l.admit(C, O, CY, ceiling, W);
      // Whatever the verdict, the bound must hold immediately after.
      assert.ok(l.outstandingFor(C, O) <= W, `outstanding ${l.outstandingFor(C, O)} > W after admit`);
      if (r.ok) inflight.push(ceiling);
    } else if (op === 1 && inflight.length > 0) {
      const ceiling = inflight.shift()!;
      const actual = BigInt(pick(0, Number(ceiling)));
      l.settleServed(C, O, CY, ceiling, actual);
      servedTotal += actual;
    } else if (op === 2 && inflight.length > 0) {
      const ceiling = inflight.shift()!;
      l.releaseInflight(C, O, CY, ceiling);
    } else if (op === 3) {
      // A receipt can only ever cover work actually served so far.
      if (servedTotal > nextCum) {
        nextCum = servedTotal;
        l.recordReceipt(C, O, { cumulative: nextCum, signature: sig(i), cycle: CY });
      }
    }
    assert.ok(l.outstandingFor(C, O) <= W, `outstanding ${l.outstandingFor(C, O)} > W at step ${i}`);
  }
});

test("a cycle bump resets the ledger (prior-cycle receipts are worthless here)", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, 1n, 500n, W);
  l.settleServed(C, O, 1n, 500n, 500n);
  l.recordReceipt(C, O, { cumulative: 500n, signature: sig(1), cycle: 1n });
  assert.equal(l.snapshot(C, O)!.held, 500n);
  // New reservation generation → cycle 2 → everything resets.
  const r = l.admit(C, O, 2n, 900n, W);
  assert.equal(r.ok, true);
  const snap = l.snapshot(C, O)!;
  assert.equal(snap.cycle, 2n);
  assert.equal(snap.held, 0n);
  assert.equal(snap.served, 0n);
});

test("redeemable returns the highest unredeemed receipt, then nothing after noteRedeemed", () => {
  const l = new VaultCreditLedger();
  l.recordReceipt(C, O, { cumulative: 300n, signature: sig(1), cycle: CY });
  l.recordReceipt(C, O, { cumulative: 700n, signature: sig(2), cycle: CY }); // supersedes
  const r = l.redeemable(C, O);
  assert.equal(r?.cumulative, 700n);
  assert.equal(r?.signature, sig(2));
  l.noteRedeemed(C, O, 700n, CY);
  assert.equal(l.redeemable(C, O), null); // nothing left owed
});

test("stale (lower-cycle) and non-advancing receipts are ignored", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, 5n, 1n, W); // establishes current cycle = 5
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: sig(1), cycle: 4n }), false);
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: sig(2), cycle: 5n }), true);
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: sig(3), cycle: 5n }), false); // not higher
});

test("STALE-CYCLE GUARD: a late settle/release/redeem for a prior cycle can't corrupt the live window", () => {
  // Request admitted at cycle 1 (inflight 800), then the reservation bumps to a
  // fresh generation (cycle 2) and new work is admitted there — BEFORE the cycle-1
  // request's serve finishes / its receipt is redeemed. The trailing cycle-1
  // settle, release, and noteRedeemed must all no-op against the cycle-2 entry,
  // never freeing or over-crediting the new generation's window (invariant #3).
  const l = new VaultCreditLedger();
  l.admit(C, O, 1n, 800n, W); // cycle-1 request in flight
  l.admit(C, O, 2n, 900n, W); // cycle bumps; cycle-2 work admitted → entry resets, inflight 900
  assert.equal(l.snapshot(C, O)!.cycle, 2n);
  assert.equal(l.snapshot(C, O)!.inflight, 900n);

  // Trailing cycle-1 settle: must NOT subtract from cycle-2 inflight nor add served.
  l.settleServed(C, O, 1n, 800n, 800n);
  assert.equal(l.snapshot(C, O)!.inflight, 900n, "cycle-1 settle left cycle-2 inflight intact");
  assert.equal(l.snapshot(C, O)!.served, 0n, "cycle-1 served not leaked into cycle 2");

  // Trailing cycle-1 release: must NOT free cycle-2 inflight.
  l.releaseInflight(C, O, 1n, 800n);
  assert.equal(l.snapshot(C, O)!.inflight, 900n, "cycle-1 release didn't free cycle-2 headroom");

  // Trailing cycle-1 redeem (e.g. StaleReceipt/uncollectable for the old receipt):
  // must NOT write the old cumulative into cycle 2's redeemed → would over-credit.
  l.noteRedeemed(C, O, 9_000n, 1n);
  assert.equal(l.snapshot(C, O)!.redeemed, 0n, "old-cycle cumulative didn't over-credit cycle 2");
  assert.ok(l.outstandingFor(C, O) <= W, "outstanding still bounded by the window");
});

test("STALE-CYCLE GUARD: admit refuses a stale-cycle request without mutating the live entry", () => {
  // A request whose cached reservation check is a generation behind (the ledger
  // already advanced — e.g. a cycle-2 receipt landed via the uncached verify path)
  // must be REFUSED with `stale`, not reserved against the new cycle's window: a
  // stale admit would serve on coverage that no longer exists AND strand the
  // ceiling (its later same-cycle settle/release no-ops).
  const l = new VaultCreditLedger();
  l.admit(C, O, 2n, 300n, W); // ledger now at cycle 2, inflight 300
  const r = l.admit(C, O, 1n, 500n, W); // stale cycle-1 request
  assert.equal(r.ok, false);
  assert.equal(r.stale, true, "flagged stale so the caller refreshes + re-gates");
  assert.equal(l.snapshot(C, O)!.cycle, 2n);
  assert.equal(l.snapshot(C, O)!.inflight, 300n, "stale admit did NOT add to the live cycle's inflight");
});

test("creditWindowBase honors the env override and falls back to the default", () => {
  const prev = process.env.HALO_VAULT_CREDIT_WINDOW_BASE;
  delete process.env.HALO_VAULT_CREDIT_WINDOW_BASE;
  assert.equal(creditWindowBase(), 100_000n);
  process.env.HALO_VAULT_CREDIT_WINDOW_BASE = "250000";
  assert.equal(creditWindowBase(), 250_000n);
  process.env.HALO_VAULT_CREDIT_WINDOW_BASE = "garbage";
  assert.equal(creditWindowBase(), 100_000n); // invalid → default
  if (prev === undefined) delete process.env.HALO_VAULT_CREDIT_WINDOW_BASE;
  else process.env.HALO_VAULT_CREDIT_WINDOW_BASE = prev;
});
