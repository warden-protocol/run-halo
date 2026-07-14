import test from "node:test";
import assert from "node:assert/strict";
import { computeReserveAmount, VaultConsumeClient } from "./vault-consume";

const base = {
  estCost: 100n,
  locked: 0n,
  withdrawable: 100_000n,
  reserveMultiple: 5n,
  liquiditySlots: 8n,
  live: false,
};

test("ample balance → full batch (reserveMultiple × estCost)", () => {
  assert.equal(computeReserveAmount({ ...base, withdrawable: 100_000n }), 500n);
});

test("tight balance → capped at 1/liquiditySlots of free, not the whole deposit (#367)", () => {
  assert.equal(computeReserveAmount({ ...base, withdrawable: 800n }), 100n);
});

test("cap never under-serves the request — always ≥ estCost", () => {
  assert.equal(computeReserveAmount({ ...base, withdrawable: 200n }), 100n);
});

test("never reserves more than the free balance", () => {
  assert.equal(computeReserveAmount({ ...base, withdrawable: 60n }), 60n);
});

test("already covered and live → reserve nothing", () => {
  assert.equal(
    computeReserveAmount({ ...base, locked: 500n, withdrawable: 100_000n, live: true }),
    0n
  );
});

test("already covered but expiring → minimal 1-unit bump to refresh expiry", () => {
  assert.equal(
    computeReserveAmount({ ...base, locked: 500n, withdrawable: 100_000n, live: false }),
    1n
  );
});

test("partial existing reservation tops up toward the batch, still capped", () => {
  assert.equal(computeReserveAmount({ ...base, locked: 200n, withdrawable: 100_000n }), 300n);
  assert.equal(computeReserveAmount({ ...base, locked: 200n, withdrawable: 1_600n }), 200n);
});

test("fan-out simulation: 8 operators each lock ≤ 1/8 of remaining free, deposit never fully locks", () => {
  let free = 100_000n;
  let totalLocked = 0n;
  for (let i = 0; i < 8; i++) {
    const amt = computeReserveAmount({ ...base, locked: 0n, withdrawable: free, live: false });
    assert.ok(amt <= free / 8n || amt === base.estCost, `op ${i} took too much: ${amt} of ${free}`);
    free -= amt;
    totalLocked += amt;
  }
  assert.ok(free > 0n, "free balance never floored to 0 by fan-out");
});

const OP = `0x${"a".repeat(40)}`;
function reclaimHarness(over: {
  grace?: () => Promise<bigint>;
  ops?: () => Promise<{ locked: bigint; expiry: bigint }>;
}): { c: VaultConsumeClient; releases: () => number } {
  const wallet = { address: `0x${"1".repeat(40)}` } as never;
  const c = new VaultConsumeClient(wallet, {
    facilitatorUrl: "http://127.0.0.1:0",
    rpcUrl: "http://127.0.0.1:0",
    chainId: 8453,
  } as never);
  let releases = 0;
  const a = c as unknown as Record<string, unknown>;
  a.redeemGrace = over.grace ?? (async () => 60n);
  a.readOps = over.ops ?? (async () => ({ locked: 500n, expiry: 1n }));
  a.postRelease = async () => {
    releases++;
    return "0xhash";
  };
  (a.reservedOperators as Set<string>).add(OP);
  return { c, releases: () => releases };
}

test("reclaim: a settled (locked==0) operator is pruned and never released", async () => {
  const { c, releases } = reclaimHarness({ ops: async () => ({ locked: 0n, expiry: 1n }) });
  const released = await c.releaseExpiredReservations();
  assert.equal(released, false);
  assert.equal(releases(), 0, "nothing to reclaim → no release call");
  assert.equal((c as unknown as { reservedOperators: Set<string> }).reservedOperators.has(OP), false, "pruned");
});

test("reclaim: an expired operator is released but RETAINED (so a dropped release retries)", async () => {
  const { c, releases } = reclaimHarness({});
  const released = await c.releaseExpiredReservations();
  assert.equal(released, true);
  assert.equal(releases(), 1);
  assert.equal(
    (c as unknown as { reservedOperators: Set<string> }).reservedOperators.has(OP),
    true,
    "NOT deleted on an unconfirmed broadcast — kept for retry until a read shows locked==0"
  );
});

test("reclaim: cooldown prevents re-broadcasting a release while one is in flight", async () => {
  const { c, releases } = reclaimHarness({});
  await c.releaseExpiredReservations();
  await c.releaseExpiredReservations();
  assert.equal(releases(), 1, "second pass is throttled — no duplicate release");
});

test("reclaim: skips entirely when redeemGrace can't be read (never guesses grace=0)", async () => {
  const { c, releases } = reclaimHarness({
    grace: async () => {
      throw new Error("rpc down");
    },
  });
  const released = await c.releaseExpiredReservations();
  assert.equal(released, false);
  assert.equal(releases(), 0, "unknown grace → no release attempted (avoids NotExpired reverts)");
});
