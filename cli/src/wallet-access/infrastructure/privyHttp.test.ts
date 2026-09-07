import test from "node:test";
import assert from "node:assert/strict";
import { WalletAccessError } from "../domain/walletAccess";
import {
  PRIVY_HTTP_REQUEST_TIMEOUT_MS,
  PrivyHttpTransport,
  type PrivyHttpRetryPolicy,
} from "./privyHttp";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

function response(status: number, retryAfter?: string): Response {
  return new Response(null, {
    status,
    headers: retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
  });
}

test("replay-safe requests use three attempts with fixed bounded backoff", async () => {
  const statuses = [503, 408, 200];
  const sleeps: number[] = [];
  let calls = 0;
  const transport = new PrivyHttpTransport({
    fetch: async () => response(statuses[calls++] ?? 500),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => NOW,
  });

  const result = await transport.request(
    "https://privy.test/request",
    { method: "POST" },
    "replay-safe",
    async (result) => result.status
  );

  assert.equal(result, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1_000]);
});

test("Retry-After accepts only bounded canonical seconds or IMF-fixdate", async () => {
  const cases = [
    { value: "2", expected: 2_000 },
    { value: "Mon, 31 Aug 2026 12:00:10 GMT", expected: 10_000 },
    { value: "Mon, 31 Aug 2026 12:01:00 GMT", expected: 30_000 },
    { value: "1e2", expected: 500 },
    { value: "0002", expected: 500 },
    { value: "99999999999", expected: 500 },
    { value: "9".repeat(129), expected: 500 },
  ];

  for (const retryAfter of cases) {
    let calls = 0;
    const sleeps: number[] = [];
    const transport = new PrivyHttpTransport({
      fetch: async () => response(calls++ === 0 ? 429 : 200, retryAfter.value),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      now: () => NOW,
    });

    const result = await transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "rate-limit-only",
      async (response) => response.status
    );

    assert.equal(result, 200, retryAfter.value);
    assert.deepEqual(sleeps, [retryAfter.expected], retryAfter.value);
  }
});

test("each replay-safe attempt has its own timeout", async () => {
  assert.equal(PRIVY_HTTP_REQUEST_TIMEOUT_MS, 15_000);
  let calls = 0;
  const sleeps: number[] = [];
  const transport = new PrivyHttpTransport({
    fetch: async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("request aborted")),
          { once: true }
        );
      });
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => NOW,
    requestTimeoutMs: 1,
  });

  await assert.rejects(
    transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "replay-safe",
      async (response) => response.status
    )
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 1_000]);
});

test("a status retry requires its bounded response body to complete", async () => {
  let calls = 0;
  const transport = new PrivyHttpTransport({
    fetch: async () => {
      calls += 1;
      return new Response(new ReadableStream<Uint8Array>(), { status: 503 });
    },
    sleep: async () => {
      assert.fail("an incomplete response must not reach retry delay");
    },
    now: () => NOW,
    requestTimeoutMs: 1,
  });

  await assert.rejects(
    transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "complete-response-only",
      async () => assert.fail("retryable status handler must not run")
    )
  );
  assert.equal(calls, 1);
});

test("caller cancellation interrupts retry delay and prevents another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = new PrivyHttpTransport({
    fetch: async () => {
      calls += 1;
      return response(503);
    },
    sleep: async () => {
      controller.abort();
    },
    now: () => NOW,
    signal: controller.signal,
  });

  await assert.rejects(
    transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "replay-safe",
      async (response) => response.status
    ),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_operation_cancelled"
  );
  assert.equal(calls, 1);
});

test("caller cancellation aborts an in-flight request without replay", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = new PrivyHttpTransport({
    fetch: async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("request aborted")),
          { once: true }
        );
        controller.abort();
      });
    },
    sleep: async () => {},
    now: () => NOW,
    signal: controller.signal,
  });

  await assert.rejects(
    transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "replay-safe",
      async (response) => response.status
    ),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_operation_cancelled"
  );
  assert.equal(calls, 1);
});

test("in-flight cancellation of an ambiguous request is not a safe cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const transport = new PrivyHttpTransport({
    fetch: async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("request aborted")),
          { once: true }
        );
        controller.abort();
      });
    },
    sleep: async () => {},
    now: () => NOW,
    signal: controller.signal,
  });

  await assert.rejects(
    transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "rate-limit-only",
      async (response) => response.status
    ),
    (error: unknown) => !(error instanceof WalletAccessError)
  );
  assert.equal(calls, 1);
});

test("ambiguous request policies never replay transport loss", async () => {
  for (const policy of [
    "complete-response-only",
    "rate-limit-only",
  ] satisfies PrivyHttpRetryPolicy[]) {
    let calls = 0;
    const transport = new PrivyHttpTransport({
      fetch: async () => {
        calls += 1;
        throw new Error("response lost after possible send");
      },
      sleep: async () => {},
      now: () => NOW,
    });

    await assert.rejects(
      transport.request(
        "https://privy.test/request",
        { method: "POST" },
        policy,
        async (response) => response.status
      )
    );
    assert.equal(calls, 1, policy);
  }
});

test("rate-limit-only requests do not replay ambiguous HTTP statuses", async () => {
  for (const status of [408, 500, 503, 599]) {
    let calls = 0;
    const transport = new PrivyHttpTransport({
      fetch: async () => {
        calls += 1;
        return response(status);
      },
      sleep: async () => {},
      now: () => NOW,
    });

    const result = await transport.request(
      "https://privy.test/request",
      { method: "POST" },
      "rate-limit-only",
      async (response) => response.status
    );
    assert.equal(result, status);
    assert.equal(calls, 1, String(status));
  }
});

test("Privy transport disables redirects for every request", async () => {
  const transport = new PrivyHttpTransport({
    fetch: async (_url, init) => {
      assert.equal(init?.redirect, "manual");
      return response(302);
    },
    sleep: async () => {},
    now: () => NOW,
  });

  const status = await transport.request(
    "https://privy.test/request",
    { method: "POST" },
    "complete-response-only",
    async (result) => result.status
  );
  assert.equal(status, 302);
});
