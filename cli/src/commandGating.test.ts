import test from "node:test";
import assert from "node:assert/strict";
import { shouldPreRunUpdate, KNOWN_COMMANDS, LONG_RUNNING_COMMANDS } from "./commandGating";

test("shouldPreRunUpdate: known short-lived commands update; long-running and unknown do not", () => {
  // Round-4 finding: `service` (short-lived) must be covered by the pre-run check.
  assert.equal(shouldPreRunUpdate("service"), true);
  assert.equal(shouldPreRunUpdate("setup"), true);
  assert.equal(shouldPreRunUpdate("doctor"), true);
  assert.equal(shouldPreRunUpdate("pay"), true);

  // Long-running commands update on their own heartbeat — skip the pre-run check.
  assert.equal(shouldPreRunUpdate("run"), false);
  assert.equal(shouldPreRunUpdate("serve"), false);
  assert.equal(shouldPreRunUpdate("consume"), false);

  // Round-5 finding B: an unrecognized/typo command must NOT trigger an update
  // cycle (network + possible build/promote/relaunch) before "unknown command".
  assert.equal(shouldPreRunUpdate("dokctor"), false);
  assert.equal(shouldPreRunUpdate("frobnicate"), false);
  assert.equal(shouldPreRunUpdate(""), false);
  // `update`/`--version`/`--help` are handled before the gate, and aren't in the set.
  assert.equal(shouldPreRunUpdate("update"), false);
});

test("every long-running command is also a known command", () => {
  for (const c of LONG_RUNNING_COMMANDS) {
    assert.ok(KNOWN_COMMANDS.has(c), `${c} must be in KNOWN_COMMANDS`);
  }
});
