import assert from "node:assert/strict";
import test from "node:test";
import { resolveTeeBaseUrl } from "./commands/consume";

test("resolveTeeBaseUrl defaults to the configured relay proxy", () => {
  assert.equal(resolveTeeBaseUrl("https://relay.test///"), "https://relay.test/v1");
});

test("resolveTeeBaseUrl preserves an explicit normalized override", () => {
  assert.equal(
    resolveTeeBaseUrl("https://relay.test", "https://attest.test/custom/v1///"),
    "https://attest.test/custom/v1"
  );
});
