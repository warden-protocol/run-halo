/**
 * Credit-window ledger spec (issue #369).
 * Run: `node --require ts-node/register --test src/vaultCredit.test.ts`
 *
 * The load-bearing property (issue #369; single-request rule relaxed in #395):
 * the window caps the ACCUMULATION of un-receipted work, so floated `outstanding`
 * never exceeds max(window, the largest single admitted ceiling), under any
 * interleaving of admit / settle / release / recordReceipt. A single request may
 * exceed the window only from a zero-outstanding state, bounded instead by the
 * on-chain reservation. (This is a bound on the EXPOSURE value, not on the count
 * of in-flight over-window requests — an over-signed receipt can admit a second;
 * see the over-signed-receipt test.)
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

test("a single request larger than the window is admitted when nothing is outstanding", () => {
  // Premium model: one request's ceiling (1500) exceeds the window (1000). With
  // no un-receipted prior work it MUST be admitted — it's already bounded by the
  // on-chain reservation; the window only caps ACCUMULATION. (Regression: this
  // used to refuse with "credit window exceeded (floating 0 + 1500 > 1000)".)
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  // But now 1500 is outstanding (> W) → the NEXT request waits for a receipt.
  assert.equal(l.admit(C, O, CY, 1n, W).ok, false);
  // Settle + receipt drains it → another large request is admitted again.
  l.settleServed(C, O, CY, 1500n, 1500n);
  l.recordReceipt(C, O, { cumulative: 1500n, signature: "0xsig", cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
});

test("while an over-window request is outstanding, EVERY follow-up admit waits until it drains", () => {
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true); // over-window, admitted from zero
  // Not just a 1-unit follow-up: NOTHING is admitted while outstanding (1500) > W,
  // regardless of the next request's size (including another over-window one).
  for (const c of [1n, 100n, 999n, 1000n, 2000n, 5000n]) {
    assert.equal(l.admit(C, O, CY, c, W).ok, false, `admit(${c}) must wait while 1500 is outstanding`);
  }
  // Drain via settle + receipt → serving resumes.
  l.settleServed(C, O, CY, 1500n, 1500n);
  l.recordReceipt(C, O, { cumulative: 1500n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.admit(C, O, CY, 2000n, W).ok, true);
});

test("an over-window request that settles BELOW the window lets sub-window accumulation resume", () => {
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true); // ceiling 1500 > W, admitted from zero
  l.settleServed(C, O, CY, 1500n, 300n); // actual only 300 → trued DOWN below W
  assert.equal(l.outstandingFor(C, O), 300n);
  // No over-window bypass now (outstanding is 300 > 0): a huge ceiling is refused.
  assert.equal(l.admit(C, O, CY, 5000n, W).ok, false);
  // Normal accumulation resumes against the 300 floor.
  assert.equal(l.admit(C, O, CY, 701n, W).ok, false); // 300 + 701 > 1000
  assert.equal(l.admit(C, O, CY, 700n, W).ok, true); // 300 + 700 == 1000
});

test("an over-signed receipt can admit a 2nd over-window request, but un-receipted EXPOSURE stays capped at one ceiling", () => {
  // The ledger trusts any validly-signed receipt: recordReceipt (and the on-chain
  // verifyReceipt) gate on signature + cycle, NOT on cumulative <= served. So a
  // consumer CAN sign for more than served. That is consumer self-harm (over-pay,
  // still on-chain-bounded by `locked`), never operator bleed — the receipt is
  // collectible value that only LOWERS outstanding. This documents that the count
  // of in-flight over-window requests is NOT bounded to one; only the un-receipted
  // exposure (`outstanding`) is — which is the actual money invariant.
  const l = new VaultCreditLedger();
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true); // 1st over-window, from zero
  assert.equal(l.outstandingFor(C, O), 1500n);
  // Over-signed: cumulative 1500 while nothing has actually been served yet.
  l.recordReceipt(C, O, { cumulative: 1500n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n); // receipt covers the in-flight ceiling
  // outstanding is 0 again → a 2nd over-window request admits while the 1st is
  // still in flight: TWO over-window ceilings reserved at once (count > 1).
  assert.equal(l.admit(C, O, CY, 1500n, W).ok, true);
  assert.equal(l.snapshot(C, O)!.inflight, 3000n);
  // But exposure stays capped at ONE ceiling (1500), not 3000 — the over-signed
  // receipt backs the first. This is the real, provable money bound.
  assert.equal(l.outstandingFor(C, O), 1500n);
});

test("outstanding clamps to 0 (never negative) when a receipt over-covers served + inflight", () => {
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 1500n, W); // inflight 1500, served 0
  // A grossly over-signed receipt covers far more than served + inflight. The raw
  // served + inflight − covered is negative, but exposure is reported as 0 — never
  // a negative value that could confuse a downstream reader/metric.
  l.recordReceipt(C, O, { cumulative: 9000n, signature: sig(1), cycle: CY });
  assert.equal(l.outstandingFor(C, O), 0n);
  assert.equal(l.snapshot(C, O)!.outstanding, 0n);
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

test("syncOnchain never lowers served when the on-chain redeemed read lags local serving", () => {
  // The operator serves synchronously but redemption is async/consumer-driven, so
  // the on-chain `redeemed` counter (synced before EVERY admit) legitimately TRAILS
  // local `served`. syncOnchain must NOT overwrite served downward to that lower
  // baseline — doing so would under-count outstanding and let the operator float a
  // fresh window on top of still-unredeemed work.
  const l = new VaultCreditLedger();
  l.admit(C, O, CY, 900n, W);
  l.settleServed(C, O, CY, 900n, 900n); // served 900, nothing redeemed yet
  assert.equal(l.outstandingFor(C, O), 900n);
  l.syncOnchain(C, O, CY, 500n); // on-chain redeemed (500) lags local served (900)
  const snap = l.snapshot(C, O)!;
  assert.equal(snap.served, 900n, "served is monotonic — a lagging on-chain read must not lower it");
  assert.equal(snap.redeemed, 500n); // redeemed still advances to the on-chain baseline
  assert.equal(l.outstandingFor(C, O), 400n); // 900 served − 500 redeemed
  assert.equal(l.admit(C, O, CY, 700n, W).ok, false); // 400 + 700 > 1000 — still gated
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

test("INVARIANT: outstanding <= max(window, largest single admitted ceiling) across interleavings", () => {
  const l = new VaultCreditLedger();
  // Deterministic PRNG (no Math.random) so failures reproduce.
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 1 | s)) >>> 0), s / 4294967296);
  const pick = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  const inflight: bigint[] = []; // ceilings currently admitted
  let nextCum = 0n; // monotonic cumulative for receipts
  let servedTotal = 0n;
  let maxAdmitted = 0n; // largest ceiling ever admitted (running max)

  // The window caps ACCUMULATION of un-receipted work, so outstanding can exceed
  // W only via a single over-window request admitted from a zero-outstanding
  // state (#395) — never beyond the largest single admitted ceiling. This bounds
  // the EXPOSURE value, not the COUNT of in-flight over-window requests: an
  // over-signed receipt can admit a second (see the over-signed-receipt test),
  // but the receipt covers it so outstanding stays within this bound regardless.
  // This harness models a well-behaved consumer (receipts never exceed served).
  const boundHolds = (where: string) => {
    const cap = W > maxAdmitted ? W : maxAdmitted;
    assert.ok(l.outstandingFor(C, O) <= cap, `outstanding ${l.outstandingFor(C, O)} > max(W, ${maxAdmitted}) ${where}`);
  };

  for (let i = 0; i < 20000; i++) {
    const op = pick(0, 3);
    if (op === 0) {
      // Ceilings span BELOW and ABOVE W (1000) so the new over-window admit path
      // (#395) is actually exercised — not just the steady-state accumulation.
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
      // A receipt can only ever cover work actually served so far.
      if (servedTotal > nextCum) {
        nextCum = servedTotal;
        l.recordReceipt(C, O, { cumulative: nextCum, signature: sig(i), cycle: CY });
      }
    }
    boundHolds(`at step ${i}`);
  }
  // Guard the guard: the widened range must have actually admitted an
  // over-window ceiling, else this fuzz would silently only test the old bound.
  assert.ok(maxAdmitted > W, "fuzz never admitted an over-window ceiling — range too narrow to exercise #395");
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
  // redeemed is monotonic within a cycle (invariant #5): a later, LOWER
  // confirmation must not resurrect the already-collected 700 receipt.
  l.noteRedeemed(C, O, 300n, CY);
  assert.equal(l.redeemable(C, O), null, "a lower confirmation must not resurrect a collected receipt");
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
