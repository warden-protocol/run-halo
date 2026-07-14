import test from "node:test";
import assert from "node:assert/strict";
import { drainForShutdown } from "./commands/consume";

test("drainForShutdown waits for the redeem flush before resolving", async () => {
  let resolveClose!: () => void;
  const closeServer = () => new Promise<void>((r) => (resolveClose = r));
  let resolveFlush!: () => void;
  let flushed = false;
  const flushRedeems = () =>
    new Promise<void>((r) => (resolveFlush = () => {
      flushed = true;
      r();
    }));

  let resolved = false;
  const p = drainForShutdown(closeServer, flushRedeems, 60_000).then(() => {
    resolved = true;
  });

  resolveClose();
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "must not resolve before the redeem flush completes");
  assert.equal(flushed, false);

  resolveFlush();
  await p;
  assert.equal(resolved, true);
  assert.equal(flushed, true);
});

test("drainForShutdown is bounded — resolves on the timeout even if a stage hangs", async () => {
  const hang = () => new Promise<void>(() => {});
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await drainForShutdown(hang, hang, 20);
    assert.ok(true);
  } finally {
    clearInterval(keepAlive);
  }
});

test("drainForShutdown tolerates a null flush and a rejecting flush", async () => {
  await drainForShutdown(() => Promise.resolve(), null, 60_000);
  await drainForShutdown(
    () => Promise.resolve(),
    () => Promise.reject(new Error("redeem boom")),
    60_000
  );
  assert.ok(true);
});
