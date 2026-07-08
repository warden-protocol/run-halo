import test from "node:test";
import assert from "node:assert/strict";
import { payAndFetch } from "./x402-consume";
import { HALO_VERSION } from "./version";
import { setCliVersionHeader } from "./versionHeader";

test("setCliVersionHeader strips any caller-supplied version and forces the baked one", () => {
  // Directly covers the shared strip-then-set helper both payment rails use —
  // the vault rail (vaultSend) only had indirect coverage before. Any casing of
  // a spoofed x-halo-cli-version must be removed, other headers left intact, and
  // the canonical header set to HALO_VERSION.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-halo-cli-version": "spoofed-lower",
    "X-HALO-CLI-VERSION": "spoofed-upper",
    "x-halo-operator": "0xabc",
  };
  setCliVersionHeader(headers);

  assert.equal(headers["X-Halo-Cli-Version"], HALO_VERSION);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["x-halo-operator"], "0xabc");
  // Exactly one CLI-version header remains, and it is the canonical one.
  const versionKeys = Object.keys(headers).filter(
    (k) => k.toLowerCase() === "x-halo-cli-version"
  );
  assert.deepEqual(versionKeys, ["X-Halo-Cli-Version"]);

  // Idempotent on an already-canonical header.
  setCliVersionHeader(headers);
  assert.deepEqual(
    Object.keys(headers).filter((k) => k.toLowerCase() === "x-halo-cli-version"),
    ["X-Halo-Cli-Version"]
  );
});

test("exact consumer requests always send the baked CLI version", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  let sentVersion: string | null = null;
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentVersion = new Headers(init?.headers).get("X-Halo-Cli-Version");
    return new Response('{"choices":[]}', { status: 200 });
  }) as typeof fetch;

  await payAndFetch(
    "https://relay.invalid/v1/chat/completions",
    { model: "model" },
    { wallet: {} as never },
    { forwardHeaders: { "x-halo-cli-version": "spoofed" } }
  );

  assert.equal(sentVersion, HALO_VERSION);
});
