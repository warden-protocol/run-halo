import assert from "node:assert/strict";
import { test } from "node:test";
import { estimatePromptTokens } from "./pricing";

test("estimatePromptTokens counts plain string content + per-message overhead", () => {
  // 8 chars -> ceil(8/4)=2 tokens, + 4/message = 6
  assert.equal(estimatePromptTokens([{ role: "user", content: "abcdefgh" }]), 6);
});

test("estimatePromptTokens counts array-form (multimodal/tool) content, not just strings", () => {
  // Previously array content was counted as 0 chars -> the operator's vault
  // ceiling under-priced these prompts and settled at a loss. It must now count
  // the parts (JSON.stringify each), matching @halo/vault-core estimateTokens.
  const parts = [
    { type: "text", text: "hello world" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ];
  const chars = parts.reduce((n, p) => n + JSON.stringify(p).length, 0);
  const expected = Math.ceil(chars / 4) + 1 * 4;
  assert.equal(estimatePromptTokens([{ role: "user", content: parts }]), expected);
  // and it is strictly greater than the old string-only estimate (which was 0 + 4)
  assert.ok(estimatePromptTokens([{ role: "user", content: parts }]) > 4);
});

test("estimatePromptTokens tolerates malformed input", () => {
  assert.equal(estimatePromptTokens(undefined), 0);
  assert.equal(estimatePromptTokens("not-an-array"), 0);
  assert.equal(estimatePromptTokens([null, 42, { role: "user" }]), 3 * 4);
});
