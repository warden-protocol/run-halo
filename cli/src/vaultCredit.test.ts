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
  assert.equal(l.admit(C, O, CY, 600n, W).ok, true);
  assert.equal(l.admit(C, O, CY, 400n, W).ok, true);
  assert.equal(l.admit(C, O, CY, 1n, W).ok, false);
});

test("a single request larger than the window is admitted when nothing is outstanding", () => {
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  assert.equal(l.admit(C, O, CY, 1n, W).ok, false);
  l.settleServed(C, O, CY, 1500n, 1500n);
  l.recordReceipt(C, O, { cumulative: 1500n, signature: "0xsig", cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
});

test("while an over-window request is outstanding, EVERY follow-up admit waits until it drains", () => {
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  for (const c of [1n, 100n, 999n, 1000n, 2000n, 5000n]) {
    assert.equal(l.admit(C, O, CY, c, W).ok, false, `admit(${c}) must wait while 1500 is outstanding`);
  }
  l.settleServed(C, O, CY, 1500n, 1500n);
  l.recordReceipt(C, O, { cumulative: 1500n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 2000n, W).ok, true);
});

test("an over-window request that settles BELOW the window lets sub-window accumulation resume", () => {
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  l.settleServed(C, O, CY, 1500n, 300n);
  assert.equal(l.outstandingFor(C, O), 300n);
  assert.equal(l.admit(C, O, CY, 5000n, W).ok, false);
  assert.equal(l.admit(C, O, CY, 701n, W).ok, false);
  assert.equal(l.admit(C, O, CY, 700n, W).ok, true);
});

test("an over-signed but COLLECTABLE receipt can admit a 2nd over-window request, but un-receipted EXPOSURE stays capped at one ceiling", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 0n, 5000n);
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  assert.equal(l.outstandingFor(C, O), 1500n);
  l.recordReceipt(C, O, { cumulative: 1500n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  assert.equal(l.snapshot(C, O)!.inflight, 3000n);
  assert.equal(l.outstandingFor(C, O), 1500n);
});

test("outstanding clamps to 0 (never negative) when a receipt over-covers served + inflight", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 0n, 9000n);
  l.admit(C, O, CY, 1500n, W);
  l.recordReceipt(C, O, { cumulative: 9000n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.snapshot(C, O)!.outstanding, 0n);
});

test("ISSUE #437: a receipt BEYOND the collectable ceiling does not free the credit window", () => {
  const bigW = 100_000n;
  const run = (syncCeiling: boolean): VaultCreditLedger => {
    const l = new VaultCreditLedger();
    if (syncCeiling) l.syncOnchain(C, O, CY, 0n, 1000n);
    l.admit(C, O, CY, 1000n, bigW);
    l.settleServed(C, O, CY, 1000n, 1000n);
    l.recordReceipt(C, O, { cumulative: 1000n, signature: sig(1), cycle: CY });
    l.admit(C, O, CY, 300n, bigW);
    l.settleServed(C, O, CY, 300n, 300n);
    l.recordReceipt(C, O, { cumulative: 1300n, signature: sig(2), cycle: CY });
    return l;
  };

  const fixed = run(true);
  assert.equal(fixed.outstandingFor(C, O), 300n, "the uncollectable tail (1300 − 1000) stays outstanding");
  const snap = fixed.snapshot(C, O)!;
  assert.equal(snap.held, 1300n, "the true signed receipt is still kept — redeem collects the max (1000)");
  assert.equal(snap.ceiling, 1000n);
  assert.equal(fixed.admit(C, O, CY, 701n, 1000n).ok, false, "300 + 701 > 1000 → await a top-up");

  const buggy = run(false);
  assert.equal(buggy.outstandingFor(C, O), 0n, "without the ceiling, the 1300 receipt masks the uncollectable tail");
  assert.equal(buggy.admit(C, O, CY, 701n, 1000n).ok, true, "the bug: window looks free, over-serving continues");
});

test("ISSUE #437: a same-cycle top-up lifts the ceiling and reactivates the uncollectable tail", () => {
  const l = new VaultCreditLedger();
  const bigW = 100_000n;
  l.syncOnchain(C, O, CY, 0n, 1000n);
  l.admit(C, O, CY, 1300n, bigW);
  l.settleServed(C, O, CY, 1300n, 1300n);
  l.recordReceipt(C, O, { cumulative: 1300n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 300n, "300 uncollectable → window held closed");

  l.syncOnchain(C, O, CY, 0n, 1500n);
  assert.equal(l.snapshot(C, O)!.ceiling, 1500n);
  assert.equal(l.outstandingFor(C, O), 0n, "the 1300 receipt is now fully collectable → window reopens");

  l.syncOnchain(C, O, CY, 0n, 200n);
  assert.equal(l.snapshot(C, O)!.ceiling, 1500n, "a stale lower read never lowers the ceiling");
  assert.equal(l.outstandingFor(C, O), 0n);
});

test("ISSUE #437: a redeem shifts locked→redeemed without lowering the ceiling", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 0n, 1000n);
  l.admit(C, O, CY, 1000n, 100_000n);
  l.settleServed(C, O, CY, 1000n, 1000n);
  l.recordReceipt(C, O, { cumulative: 1000n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  l.syncOnchain(C, O, CY, 600n, 400n);
  const snap = l.snapshot(C, O)!;
  assert.equal(snap.ceiling, 1000n);
  assert.equal(snap.redeemed, 600n);
  assert.equal(l.outstandingFor(C, O), 0n, "coverage unchanged — the receipt still covers the served 1000");
});

test("ISSUE #437: noteRedeemed with a receipt's FULL cumulative can't reopen the window past the ceiling", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 0n, 1000n);
  l.admit(C, O, CY, 1300n, 100_000n);
  l.settleServed(C, O, CY, 1300n, 1300n);
  l.recordReceipt(C, O, { cumulative: 1300n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 300n, "300 tail uncollectable → window closed");

  l.noteRedeemed(C, O, 1300n, CY);
  assert.equal(l.snapshot(C, O)!.redeemed, 1000n, "records ACTUAL collected (min(cumulative, ceiling)), not the full 1300");
  assert.equal(l.redeemable(C, O), null, "ceiling exhausted → not offered (no resubmit spin)");

  assert.equal(l.outstandingFor(C, O), 300n, "window stays closed after redeem — no re-open on the uncollectable tail");
  assert.equal(l.admit(C, O, CY, 701n, 1000n).ok, false, "still refuses past the window");

  l.syncOnchain(C, O, CY, 1000n, 0n);
  assert.equal(l.outstandingFor(C, O), 300n);
});

test("ISSUE #437: a redeemed-then-topped-up receipt reactivates so the tail is collected", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 0n, 1000n);
  l.admit(C, O, CY, 1300n, 100_000n);
  l.settleServed(C, O, CY, 1300n, 1300n);
  l.recordReceipt(C, O, { cumulative: 1300n, signature: sig(1), cycle: CY });

  assert.equal(l.redeemable(C, O)?.cumulative, 1300n, "offered while there's collectable headroom");
  l.noteRedeemed(C, O, 1300n, CY);
  assert.equal(l.redeemable(C, O), null, "retired once the ceiling is exhausted");
  assert.deepEqual(l.pairsWithRedeemable(), [], "sweep won't spin on the ceiling-clamped receipt");
  assert.equal(l.outstandingFor(C, O), 300n, "300 tail still owed");

  l.syncOnchain(C, O, CY, 1000n, 500n);
  assert.equal(l.redeemable(C, O)?.cumulative, 1300n, "REACTIVATED: redeemable again once the ceiling covers it");
  assert.deepEqual(l.pairsWithRedeemable(), [{ consumer: C, operator: O }], "the sweep will now resubmit it");

  l.noteRedeemed(C, O, 1300n, CY);
  assert.equal(l.snapshot(C, O)!.redeemed, 1300n, "now fully collected (1300 ≤ ceiling 1500)");
  assert.equal(l.redeemable(C, O), null, "nothing left — retired for good");
  assert.equal(l.outstandingFor(C, O), 0n, "tail recovered — outstanding clears, row back-fills");
});

test("a receipt drains the window so serving resumes", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 600n, W);
  l.settleServed(C, O, CY, 600n, 600n);
  assert.equal(l.outstandingFor(C, O), 600n);
  assert.equal(l.admit(C, O, CY, 500n, W).ok, false);
  l.recordReceipt(C, O, { cumulative: 600n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 500n, W).ok, true);
});

test("restart baseline prevents old cumulative receipts from granting fresh credit", () => {
  const l = new VaultCreditLedger();
  l.recordReceipt(C, O, { cumulative: 10_000n, signature: sig(1), cycle: CY });
  l.syncOnchain(C, O, CY, 10_000n, 0n);
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, W, W).ok, true);
  l.settleServed(C, O, CY, W, W);
  assert.equal(l.admit(C, O, CY, 1n, W).ok, false, "old receipt cannot offset post-restart work");
});

test("on-chain redeemed baseline alone starts with zero exposure", () => {
  const l = new VaultCreditLedger();
  l.syncOnchain(C, O, CY, 10_000n, 0n);
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, W, W).ok, true);
});

test("syncOnchain never lowers served when the on-chain redeemed read lags local serving", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 900n, W);
  l.settleServed(C, O, CY, 900n, 900n);
  assert.equal(l.outstandingFor(C, O), 900n);
  l.syncOnchain(C, O, CY, 500n, 0n);
  const snap = l.snapshot(C, O)!;
  assert.equal(snap.served, 900n, "served is monotonic — a lagging on-chain read must not lower it");
  assert.equal(snap.redeemed, 500n);
  assert.equal(l.outstandingFor(C, O), 400n);
  assert.equal(l.admit(C, O, CY, 700n, W).ok, false);
});

test("ceiling is reserved at admit, trued-up to actual on settle", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 900n, W);
  assert.equal(l.admit(C, O, CY, 200n, W).ok, false);
  l.settleServed(C, O, CY, 900n, 100n);
  assert.equal(l.outstandingFor(C, O), 100n);
  assert.equal(l.admit(C, O, CY, 800n, W).ok, true);
});

test("failed serve releases the reserved ceiling with no served value", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 700n, W);
  l.releaseInflight(C, O, CY, 700n);
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 1000n, W).ok, true);
});

test("INVARIANT: outstanding <= max(window, largest single admitted ceiling) across interleavings", () => {
  const l = new VaultCreditLedger();
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 1 | s)) >>> 0), s / 4294967296);
  const pick = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  const inflight: bigint[] = [];
  let nextCum = 0n;
  let servedTotal = 0n;
  let maxAdmitted = 0n;

  const boundHolds = (where: string) => {
    const cap = W > maxAdmitted ? W : maxAdmitted;
    assert.ok(l.outstandingFor(C, O) <= cap, `outstanding ${l.outstandingFor(C, O)} > max(W, ${maxAdmitted}) ${where}`);
  };

  for (let i = 0; i < 20000; i++) {
    const op = pick(0, 3);
    if (op === 0) {
      const ceiling = BigInt(pick(1, 1500));
      const r = l.admit(C, O, CY, ceiling, W);
      if (r.ok) {
        inflight.push(ceiling);
        if (ceiling > maxAdmitted) maxAdmitted = ceiling;
      }
      boundHolds(`after admit at step ${i}`);
    } else if (op === 1 && inflight.length > 0) {
      const ceiling = inflight.shift()!;
      const actual = BigInt(pick(0, Number(ceiling)));
      l.settleServed(C, O, CY, ceiling, actual);
      servedTotal += actual;
    } else if (op === 2 && inflight.length > 0) {
      const ceiling = inflight.shift()!;
      l.releaseInflight(C, O, CY, ceiling);
    } else if (op === 3) {
      if (servedTotal > nextCum) {
        nextCum = servedTotal;
        l.recordReceipt(C, O, { cumulative: nextCum, signature: sig(i), cycle: CY });
      }
    }
    boundHolds(`at step ${i}`);
  }
  assert.ok(maxAdmitted > W, "fuzz never admitted an over-window ceiling — range too narrow to exercise #395");
});

test("a cycle bump resets the ledger (prior-cycle receipts are worthless here)", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, 1n, 500n, W);
  l.settleServed(C, O, 1n, 500n, 500n);
  l.recordReceipt(C, O, { cumulative: 500n, signature: sig(1), cycle: 1n });
  assert.equal(l.snapshot(C, O)!.held, 500n);
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
  l.recordReceipt(C, O, { cumulative: 700n, signature: sig(2), cycle: CY });
  const r = l.redeemable(C, O);
  assert.equal(r?.cumulative, 700n);
  assert.equal(r?.signature, sig(2));
  l.noteRedeemed(C, O, 700n, CY);
  assert.equal(l.redeemable(C, O), null);
  l.noteRedeemed(C, O, 300n, CY);
  assert.equal(l.redeemable(C, O), null, "a lower confirmation must not resurrect a collected receipt");
});

test("stale (lower-cycle) and non-advancing receipts are ignored", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, 5n, 1n, W);
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: sig(1), cycle: 4n }), false);
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: sig(2), cycle: 5n }), true);
  assert.equal(l.recordReceipt(C, O, { cumulative: 100n, signature: sig(3), cycle: 5n }), false);
});

test("STALE-CYCLE GUARD: a late settle/release/redeem for a prior cycle can't corrupt the live window", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, 1n, 800n, W);
  l.admit(C, O, 2n, 900n, W);
  assert.equal(l.snapshot(C, O)!.cycle, 2n);
  assert.equal(l.snapshot(C, O)!.inflight, 900n);

  assert.equal(l.settleServed(C, O, 1n, 800n, 800n), null, "stale-cycle settle returns null (no checkpoint)");
  assert.equal(l.snapshot(C, O)!.inflight, 900n, "cycle-1 settle left cycle-2 inflight intact");
  assert.equal(l.snapshot(C, O)!.served, 0n, "cycle-1 served not leaked into cycle 2");

  l.releaseInflight(C, O, 1n, 800n);
  assert.equal(l.snapshot(C, O)!.inflight, 900n, "cycle-1 release didn't free cycle-2 headroom");

  l.noteRedeemed(C, O, 9_000n, 1n);
  assert.equal(l.snapshot(C, O)!.redeemed, 0n, "old-cycle cumulative didn't over-credit cycle 2");
  assert.ok(l.outstandingFor(C, O) <= W, "outstanding still bounded by the window");
});

test("settleServed return contract: live settle yields the post-settle cumulative (the #379 checkpoint)", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 100n, W);
  assert.equal(l.settleServed(C, O, CY, 100n, 100n), 100n);
  l.admit(C, O, CY, 250n, W);
  assert.equal(l.settleServed(C, O, CY, 250n, 250n), 350n);
  l.admit(C, O, CY, 50n, W);
  assert.equal(l.settleServed(C, O, CY, 50n, 0n), 350n);
});

test("STALE-CYCLE GUARD: admit refuses a stale-cycle request without mutating the live entry", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, 2n, 300n, W);
  const r = l.admit(C, O, 1n, 500n, W);
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
  assert.equal(creditWindowBase(), 100_000n);
  if (prev === undefined) delete process.env.HALO_VAULT_CREDIT_WINDOW_BASE;
  else process.env.HALO_VAULT_CREDIT_WINDOW_BASE = prev;
});
