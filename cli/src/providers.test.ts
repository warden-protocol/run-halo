import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_PRESETS,
  imageEndpointPathFor,
  imageGenerationIsTeeFor,
  teeModelsForProviderAnnouncement,
} from "./providers";

test("near exposes image generation without advertising image models as TEE", () => {
  assert.equal(imageEndpointPathFor("near"), "/images/generations");
  assert.equal(PROVIDER_PRESETS.near.imageEndpointPath, "/images/generations");
  assert.match(PROVIDER_PRESETS.near.label, /non-TEE images/);
  assert.equal(imageGenerationIsTeeFor("near"), false);
  const base = PROVIDER_PRESETS.near.baseUrl.replace(/\/+$/, "");
  assert.equal(
    `${base}${imageEndpointPathFor("near")}`,
    "https://cloud-api.near.ai/v1/images/generations"
  );
  assert.deepEqual(
    teeModelsForProviderAnnouncement(
      "near",
      ["deepseek-ai/DeepSeek-V4-Flash", "flux2-klein"],
      ["flux2-klein"]
    ),
    ["deepseek-ai/DeepSeek-V4-Flash"]
  );
  assert.deepEqual(
    teeModelsForProviderAnnouncement("near", ["flux2-klein"], ["flux2-klein"]),
    []
  );
});

test("providers without an image endpoint stay unsupported", () => {
  assert.equal(imageEndpointPathFor("claude-code"), null);
  assert.equal(imageEndpointPathFor("ollama"), null);
  assert.equal(imageEndpointPathFor("does-not-exist"), null);
});
