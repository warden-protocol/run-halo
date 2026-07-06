const test = require("node:test");
const assert = require("node:assert/strict");

const { callX402Json } = require("../dist/bazaar");

test("callX402Json does not surface an un-payable 402 error body as data", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  // fetchWithX402 now returns an un-payable 402 (no PAYMENT-REQUIRED) as a normal
  // Response. callX402Json must NOT expose its error body as `data`, or a caller
  // that reads `data` and ignores `status`/`paid` would treat a payment-gate error
  // as a successful resource result.
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { type: "vault_payment_required" } }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  const result = await callX402Json("https://relay.invalid", { method: "POST" }, {});
  assert.equal(result.status, 402);
  assert.equal(result.paid, false);
  assert.equal(result.data, null);
  // The error body is still surfaced — but under `errorBody`, never `data` — so a
  // caller can explain the failure without mistaking it for a successful result.
  assert.deepEqual(result.errorBody, { error: { type: "vault_payment_required" } });
});

test("callX402Json returns the parsed body on a 2xx", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const result = await callX402Json("https://relay.invalid", { method: "POST" }, {});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(result.errorBody, undefined);
});
