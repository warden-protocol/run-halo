import test from "node:test";
import assert from "node:assert/strict";
import {
  CapabilityAnnouncementSync,
  FacilitatorIdentityProbe,
  retainVaultIdentityAnnouncement,
} from "./vaultCapability";
import type { FacilitatorVaultStatus } from "./vault-address";

const MATCH: FacilitatorVaultStatus = {
  status: "match",
  live: "0x0000000000000000000000000000000000000001",
};

test("retainVaultIdentityAnnouncement gives only unavailable state a bounded directory grace", () => {
  const unavailable: FacilitatorVaultStatus = {
    status: "unavailable",
    live: null,
    detail: "timeout",
  };
  assert.equal(retainVaultIdentityAnnouncement(unavailable, false, 90, 100, 20), false);
  assert.equal(retainVaultIdentityAnnouncement(unavailable, true, 90, 100, 20), true);
  assert.equal(retainVaultIdentityAnnouncement(unavailable, true, 70, 100, 20), false);
  assert.equal(
    retainVaultIdentityAnnouncement(
      { status: "mismatch", live: "0x0000000000000000000000000000000000000002" },
      true,
      99,
      100,
      20
    ),
    false
  );
});

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("FacilitatorIdentityProbe caches recent results and deduplicates concurrent checks", async () => {
  let now = 1_000;
  let calls = 0;
  const pending = deferred();
  const probe = new FacilitatorIdentityProbe(async () => {
    calls += 1;
    await pending.promise;
    return MATCH;
  }, () => now, 50);

  const first = probe.check();
  const concurrent = probe.check();
  assert.equal(calls, 1);
  pending.resolve();
  assert.deepEqual(await first, MATCH);
  assert.deepEqual(await concurrent, MATCH);
  assert.deepEqual(await probe.check(), MATCH);
  assert.equal(calls, 1);

  now += 51;
  assert.deepEqual(await probe.check(), MATCH);
  assert.equal(calls, 2);
});

test("FacilitatorIdentityProbe caches unavailable briefly and a forced check can recover immediately", async () => {
  let calls = 0;
  const statuses: FacilitatorVaultStatus[] = [
    { status: "unavailable", live: null, detail: "timeout" },
    MATCH,
  ];
  const probe = new FacilitatorIdentityProbe(async () => statuses[calls++]!, () => 100, 50);

  assert.equal((await probe.check()).status, "unavailable");
  assert.equal((await probe.check()).status, "unavailable");
  assert.equal(calls, 1);
  assert.equal((await probe.check(true)).status, "match");
  assert.equal(calls, 2);
  assert.equal(probe.lastMatchAt, 100);
});

test("FacilitatorIdentityProbe invalidates a cached match after a forced unavailable result", async () => {
  let now = 100;
  let calls = 0;
  const statuses: FacilitatorVaultStatus[] = [
    MATCH,
    { status: "unavailable", live: null, detail: "timeout" },
    MATCH,
  ];
  const probe = new FacilitatorIdentityProbe(async () => statuses[calls++]!, () => now, 50);

  assert.equal((await probe.check()).status, "match");
  assert.equal((await probe.check(true)).status, "unavailable");
  assert.equal((await probe.check()).status, "unavailable");
  assert.equal(calls, 2);
  now += 51;
  assert.equal((await probe.check()).status, "match");
  assert.equal(calls, 3);
});

test("FacilitatorIdentityProbe clears a failed in-flight check so a later call retries", async () => {
  let calls = 0;
  const probe = new FacilitatorIdentityProbe(async () => {
    calls += 1;
    if (calls === 1) throw new Error("network failure");
    return MATCH;
  });

  await assert.rejects(() => probe.check(), /network failure/);
  assert.deepEqual(await probe.check(), MATCH);
  assert.equal(calls, 2);
});

test("CapabilityAnnouncementSync serializes transitions and commits the latest desired state", async () => {
  const sends: boolean[] = [];
  const pending = [deferred(), deferred()];
  const sync = new CapabilityAnnouncementSync(true, async (capability) => {
    sends.push(capability);
    await pending[sends.length - 1]!.promise;
  });

  const demote = sync.sync(false);
  const promote = sync.sync(true);
  assert.deepEqual(sends, [false]);
  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sends, [false, true]);
  pending[1].resolve();
  await Promise.all([demote, promote]);
  assert.equal(sync.announcedCapability, true);
});

test("CapabilityAnnouncementSync coalesces duplicates and retries a rejected transition", async () => {
  let calls = 0;
  const sync = new CapabilityAnnouncementSync(true, async () => {
    calls += 1;
    if (calls === 1) throw new Error("send failed");
  });

  const first = sync.sync(false);
  const duplicate = sync.sync(false);
  await assert.rejects(() => first, /send failed/);
  await assert.rejects(() => duplicate, /send failed/);
  assert.equal(sync.announcedCapability, true);
  await sync.sync(false);
  assert.equal(sync.announcedCapability, false);
  assert.equal(calls, 2);
});
