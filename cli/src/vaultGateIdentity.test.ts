import assert from "node:assert/strict";
import { test } from "node:test";
import { noteServed, reservationGateIdentity } from "./vault";

test("reservation gate identity binds vault, consumer, operator, and cycle", () => {
  const vault = "0x0000000000000000000000000000000000000001";
  const consumer = "0x0000000000000000000000000000000000000002";
  const operator = "0x0000000000000000000000000000000000000003";
  const base = reservationGateIdentity(vault, consumer, operator, 1n);
  for (const changed of [
    reservationGateIdentity("0x0000000000000000000000000000000000000004", consumer, operator, 1n),
    reservationGateIdentity(vault, "0x0000000000000000000000000000000000000004", operator, 1n),
    reservationGateIdentity(vault, consumer, "0x0000000000000000000000000000000000000004", 1n),
    reservationGateIdentity(vault, consumer, operator, 2n),
  ]) {
    assert.notEqual(changed, base);
  }
});

test("served gate accounting rejects negative amounts", () => {
  assert.throws(
    () =>
      noteServed(
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
        1n,
        -1n
      ),
    /non-negative/
  );
});
