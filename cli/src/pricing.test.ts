import assert from "node:assert/strict";
import { test } from "node:test";
import {
  estimateTokens,
  estimateRequestPromptTokens,
  estimateReservationTokens,
  IMAGE_PROMPT_TOKENS,
  LOW_DETAIL_IMAGE_PROMPT_TOKENS,
} from "@halo/vault-core";
import { estimatePromptTokens } from "./pricing";

test("estimatePromptTokens counts plain string content + per-message overhead", () => {
  // 8 chars -> ceil(8/4)=2 tokens, + 4/message = 6
  assert.equal(estimatePromptTokens([{ role: "user", content: "abcdefgh" }]), 6);
});

test("estimatePromptTokens counts image parts with a bounded, size-independent estimate", () => {
  // Image prompt tokens must NOT scale with the serialized URL/base64 length:
  // a huge data: URI must not inflate the ceiling (would falsely reject budget
  // requests), and a short URL must not under-count (would settle at a loss).
  const huge = [
    { type: "text", text: "hello world" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(800_000) } },
  ];
  const small = [
    { type: "text", text: "hello world" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ];
  const url = [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }];
  const hugeEst = estimatePromptTokens([{ role: "user", content: huge }]);
  // The 800k-char base64 is bounded: image counted as the flat estimate, not chars/4.
  assert.ok(hugeEst >= IMAGE_PROMPT_TOKENS && hugeEst < IMAGE_PROMPT_TOKENS + 1000);
  // Image estimate is independent of the image payload size.
  assert.equal(hugeEst, estimatePromptTokens([{ role: "user", content: small }]));
  // A short URL image floors to the flat estimate, not ~few tokens.
  assert.ok(estimatePromptTokens([{ role: "user", content: url }]) >= IMAGE_PROMPT_TOKENS);
  // A nested (Anthropic tool_result) image must ALSO be bounded, not char-counted via its base64.
  const nested = [
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          content: [{ type: "image", source: { type: "base64", data: "A".repeat(800_000) } }],
        },
      ],
    },
  ];
  const nestedEst = estimatePromptTokens(nested);
  assert.ok(nestedEst >= IMAGE_PROMPT_TOKENS && nestedEst < IMAGE_PROMPT_TOKENS + 1000);
  // An OpenAI detail:"low" image is charged the low-detail estimate, not the full flat one.
  const low = [
    { role: "user", content: [{ type: "image_url", image_url: { url: "https://e/x.png", detail: "low" } }] },
  ];
  assert.equal(estimatePromptTokens(low), LOW_DETAIL_IMAGE_PROMPT_TOKENS + 4);
  // Responses-style input_image carries detail on the part, not under image_url
  const inputImageLow = [
    { role: "user", content: [{ type: "input_image", detail: "low", image_url: "https://e/x.png" }] },
  ];
  assert.equal(estimatePromptTokens(inputImageLow), LOW_DETAIL_IMAGE_PROMPT_TOKENS + 4);
});

test("estimatePromptTokens tolerates malformed input, including non-serializable array parts", () => {
  assert.equal(estimatePromptTokens(undefined), 0);
  assert.equal(estimatePromptTokens("not-an-array"), 0);
  assert.equal(estimatePromptTokens([null, 42, { role: "user" }]), 3 * 4);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() =>
    estimatePromptTokens([{ role: "user", content: [undefined, cyclic, 10n] }])
  );
  // Non-serializable parts contribute 0 chars; only the per-message overhead remains.
  assert.equal(estimatePromptTokens([{ role: "user", content: [undefined, 10n] }]), 4);
});

test("operator gate and consumer reserve size the prompt identically (invariant #7)", () => {
  const msgs = [
    { role: "system", content: "abc" },
    { role: "user", content: "de" },
    {
      role: "user",
      content: [
        { type: "text", text: "f" },
        { type: "image_url", image_url: { url: "https://example.com/x.png" } },
      ],
    },
  ];
  // estimateTokens(messages, N) === estimatePromptTokens(messages) + N for all N.
  assert.equal(estimateTokens(msgs, 0), estimatePromptTokens(msgs));
  assert.equal(estimateTokens(msgs, 100), estimatePromptTokens(msgs) + 100);
});

test("estimateRequestPromptTokens counts tool schemas and tool_calls, not just message content", () => {
  const bigArg = "x".repeat(800_000);
  const body = {
    model: "gpt-4o",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: bigArg } }],
      },
    ],
    tools: [{ type: "function", function: { name: "f", description: "d".repeat(4000), parameters: {} } }],
  };
  // The 800k-char function-call argument is billed as prompt and must be counted (not ~4 tokens).
  assert.ok(estimateRequestPromptTokens(body) > 200_000);
  const bare = { model: "gpt-4o", messages: [{ role: "assistant", content: null }] };
  assert.ok(estimateRequestPromptTokens(body) > estimateRequestPromptTokens(bare) + 100_000);
});

test("estimateReservationTokens applies the reasoning completion ceiling, incl. omitted limit", () => {
  const reason16 = { model: "z-ai/glm-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  const reasonOmit = { model: "z-ai/glm-5", messages: [{ role: "user", content: "hi" }] };
  const plain16 = { model: "gpt-4o", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  assert.ok(estimateReservationTokens(reason16) >= 8192);
  assert.ok(estimateReservationTokens(reasonOmit) >= 8192);
  assert.ok(estimateReservationTokens(plain16) < 100);
});
