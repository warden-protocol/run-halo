import test from "node:test";
import assert from "node:assert/strict";
import { drainForShutdown } from "./commands/consume";

test("drainForShutdown waits for the redeem flush before resolving", async () => {
  // The money-path guard: the auto-update path calls process.exit() the instant
  // drain resolves, so the redeem flush must complete first. This fails if the
  // flush is ever made fire-and-forget again.
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

  resolveClose(); // server closes first, flush still pending
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "must not resolve before the redeem flush completes");
  assert.equal(flushed, false);

  resolveFlush();
  await p;
  assert.equal(resolved, true);
  assert.equal(flushed, true);
});

test("drainForShutdown is bounded — resolves on the timeout even if a stage hangs", async () => {
  const hang = () => new Promise<void>(() => {}); // never resolves
  // The ceiling timer is intentionally unref'd (a backstop, not a loop-keeper),
  // so hold the loop open with a ref'd handle for the duration of the assertion;
  // otherwise there's nothing to keep the process alive until the 20ms ceiling.
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
  // A flush that rejects must not reject the drain (it's caught internally).
  await drainForShutdown(
    () => Promise.resolve(),
    () => Promise.reject(new Error("redeem boom")),
    60_000
  );
  assert.ok(true);
});
