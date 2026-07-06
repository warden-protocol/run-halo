const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchWithX402 } = require("../dist/x402-client");

test("fetchWithX402 surfaces an un-payable 402 (no PAYMENT-REQUIRED header) as a normal Response", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  // A relay vault gate returns 402 with a JSON body but no PAYMENT-REQUIRED
  // header — not an x402 challenge we can pay. Per the documented contract it
  // must come back as a Response (paid=false, body intact), not an exception.
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { type: "vault_payment_required" } }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  const result = await fetchWithX402(
    "https://relay.invalid/v1/chat/completions",
    { method: "POST" },
    {}
  );
  assert.equal(result.paid, false);
  assert.equal(result.response.status, 402);
  const body = await result.response.text();
  assert.match(body, /vault_payment_required/);
});

test("fetchWithX402 passes a non-402 response straight through unpaid", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const result = await fetchWithX402("https://relay.invalid", { method: "POST" }, {});
  assert.equal(result.paid, false);
  assert.equal(result.response.status, 200);
});
