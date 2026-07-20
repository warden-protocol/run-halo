import test from "node:test";
import assert from "node:assert/strict";
import { RelayDeliveryTracker } from "./relayDelivery";

test("relay delivery confirmation wins once and ignores a late abort", async () => {
  const tracker = new RelayDeliveryTracker(100);
  const waiting = tracker.sendAndWait("confirmed", async () => undefined);

  assert.equal(tracker.confirm("confirmed"), true);
  assert.deepEqual(await waiting, { ok: true });
  assert.equal(tracker.abort("confirmed"), false);
});

test("relay abort wins a terminal-delivery race and a late completion cannot reverse it", async () => {
  const tracker = new RelayDeliveryTracker(100);
  const waiting = tracker.sendAndWait("aborted", async () => undefined);

  assert.equal(tracker.abort("aborted"), true);
  assert.deepEqual(await waiting, { ok: false, reason: "relay-aborted" });
  assert.equal(tracker.confirm("aborted"), false);
});

test("terminal send failure, confirmation timeout, and socket close all fail closed", async () => {
  const sendFailure = new RelayDeliveryTracker(100);
  assert.deepEqual(
    await sendFailure.sendAndWait("send-failure", async () => {
      throw new Error("socket write failed");
    }),
    { ok: false, reason: "terminal-send-failed" }
  );

  const timeout = new RelayDeliveryTracker(5);
  assert.deepEqual(
    await timeout.sendAndWait(
      "timeout",
      () => new Promise<void>(() => {})
    ),
    { ok: false, reason: "confirmation-timeout" }
  );

  const closed = new RelayDeliveryTracker(100);
  const waiting = closed.sendAndWait("closed", async () => undefined);
  closed.close();
  assert.deepEqual(await waiting, { ok: false, reason: "socket-closed" });
});
