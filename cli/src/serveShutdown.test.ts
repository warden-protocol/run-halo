import assert from "node:assert/strict";
import test from "node:test";
import { ActiveServeRequests, drainServeForShutdown } from "./serveShutdown";

test("shutdown waits for an active serve to durably enqueue before draining the outbox", async () => {
  const activeRequests = new ActiveServeRequests();
  let releaseServe!: () => void;
  const serveMayFinish = new Promise<void>((resolve) => {
    releaseServe = resolve;
  });
  const order: string[] = [];
  activeRequests.track(
    (async () => {
      await serveMayFinish;
      order.push("event-enqueued");
    })()
  );

  const shutdown = drainServeForShutdown({
    activeRequests,
    flushRedeems: async () => {
      order.push("redeems-flushed");
    },
    redeemFlushTimeoutMs: 1_000,
    drainOutbox: async () => {
      assert.deepEqual(order.slice(0, 1), ["event-enqueued"]);
      order.push("outbox-drained");
      return true;
    },
    closeOutbox: () => {
      order.push("outbox-closed");
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  releaseServe();
  assert.equal(await shutdown, true);
  assert.equal(order[0], "event-enqueued");
  assert.equal(order.at(-1), "outbox-closed");
});

test("shutdown seals a late receipt handler before releasing outbox ownership", async () => {
  const activeRequests = new ActiveServeRequests();
  let releaseActive!: () => void;
  activeRequests.track(
    new Promise<void>((resolve) => {
      releaseActive = resolve;
    })
  );
  let outboxMutations = 0;
  let outboxClosed = false;

  const shutdown = drainServeForShutdown({
    activeRequests,
    flushRedeems: async () => {},
    redeemFlushTimeoutMs: 1_000,
    drainOutbox: async () => true,
    closeOutbox: () => {
      outboxClosed = true;
    },
  });

  assert.equal(
    activeRequests.tryTrack(async () => {
      outboxMutations++;
    }),
    false
  );
  assert.equal(outboxClosed, false);
  releaseActive();
  assert.equal(await shutdown, true);
  assert.equal(outboxMutations, 0);
  assert.equal(outboxClosed, true);
});
