import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { VaultEventV2 } from "@halo/vault-core";
import { VaultCreditLedger } from "./vaultCredit";
import {
  EventOutbox,
  eventOutboxRuntimeOptions,
  readEventOutboxStatus,
  type EventOutboxFetch,
  type EventOutboxOptions,
} from "./eventOutbox";

const OUTBOX_SCOPE = {
  chainId: 8453,
  vaultAddress: "0x3333333333333333333333333333333333333333",
  operator: "0x1111111111111111111111111111111111111111",
};

function event(id = "evt_test"): VaultEventV2 {
  return {
    eventVersion: 2,
    id,
    operator: "0x1111111111111111111111111111111111111111",
    consumer: "0x2222222222222222222222222222222222222222",
    model: "test/model",
    tokens: 7,
    amountUsdc: "10",
    durationMs: 20,
    timestamp: "2027-01-15T08:00:00.000Z",
    txHash: null,
    mode: "vault",
    vaultCycle: 3,
    cumulativeCheckpoint: "30",
    signature: `0x${"ab".repeat(65)}`,
  };
}

function response(status: number, value: unknown) {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  let sent = false;
  return {
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
          async cancel() {},
        };
      },
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for event outbox state");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

type FixtureOptions = Partial<
  Pick<
    EventOutboxOptions,
    | "maxEntries"
    | "maxBytes"
    | "concurrency"
    | "requestTimeoutMs"
    | "retryBaseMs"
    | "retryCapMs"
    | "onPersistStep"
  >
>;

function create(fetcher: EventOutboxFetch, options: FixtureOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-event-outbox-"));
  const filePath = path.join(dir, "outbox.json");
  const outbox = new EventOutbox({
    filePath,
    indexerUrl: "https://indexer.example/base",
    scope: OUTBOX_SCOPE,
    fetch: fetcher,
    retryBaseMs: 1,
    retryCapMs: 2,
    requestTimeoutMs: 20,
    random: () => 0,
    ...options,
  });
  return { dir, filePath, outbox };
}

test("outbox retries network, 429, and 5xx failures until one exact acknowledgement", async () => {
  const steps: Array<"throw" | number> = ["throw", 429, 503, 200];
  let calls = 0;
  const fixture = create(async (_url, init) => {
    const step = steps[calls++];
    if (step === "throw") throw new Error("connection reset");
    const id = (JSON.parse(init.body) as { id: string }).id;
    return response(step, step === 200 ? { accepted: true, deduped: false, eventId: id } : {});
  });
  try {
    fixture.outbox.enqueue(event());
    fixture.outbox.start();
    await waitFor(() => calls === 4 && fixture.outbox.status().length === 0);
    assert.equal(calls, 4);
    assert.equal(statSync(fixture.filePath).mode & 0o777, 0o600);
    await fixture.outbox.drain(20);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("deterministic 4xx responses dead-letter once with the stable server code", async () => {
  let calls = 0;
  const fixture = create(async () => {
    calls++;
    return response(409, { accepted: false, errorCode: "event_id_conflict" });
  });
  try {
    fixture.outbox.enqueue(event());
    fixture.outbox.start();
    await waitFor(() => fixture.outbox.status()[0]?.state === "dead_letter");
    assert.deepEqual(fixture.outbox.status(), [
      { id: "evt_test", state: "dead_letter", attempts: 1, lastErrorCode: "event_id_conflict" },
    ]);
    const persisted = JSON.parse(readFileSync(fixture.filePath, "utf8"));
    assert.equal(persisted.entries[0].payload.id, "evt_test");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    await fixture.outbox.drain(20);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("an oversized deterministic 4xx body is still terminal and never hot-loops", async () => {
  let calls = 0;
  const fixture = create(async () => {
    calls++;
    return response(400, "x".repeat(16 * 1024 + 1));
  });
  try {
    fixture.outbox.enqueue(event());
    fixture.outbox.start();
    await waitFor(() => fixture.outbox.status()[0]?.state === "dead_letter");
    assert.equal(fixture.outbox.status()[0]?.lastErrorCode, "http_400");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 1);
    await fixture.outbox.drain(20);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("immutable ids dedupe exact payloads and reject conflicting payloads", async () => {
  const fixture = create(async () => response(500, {}));
  try {
    assert.equal(fixture.outbox.enqueue(event()), "queued");
    assert.equal(fixture.outbox.enqueue(event()), "duplicate");
    assert.throws(
      () => fixture.outbox.enqueue({ ...event(), amountUsdc: "11" }),
      /event id conflict/
    );
    assert.equal(fixture.outbox.status().length, 1);
    await fixture.outbox.drain(0);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("restart replays an ambiguous delivery and accepts the indexer's exact duplicate ack", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-event-restart-"));
  const filePath = path.join(dir, "outbox.json");
  let firstCalls = 0;
  const first = new EventOutbox({
    filePath,
    indexerUrl: "https://indexer.example",
    scope: OUTBOX_SCOPE,
    retryBaseMs: 100,
    retryCapMs: 100,
    requestTimeoutMs: 10,
    fetch: async () => {
      firstCalls++;
      throw new Error("ack was lost");
    },
  });
  try {
    first.enqueue(event());
    first.start();
    await waitFor(() => first.status()[0]?.attempts === 1);
    await first.drain(0);
    first.close();
    assert.ok(firstCalls >= 1);

    let replayCalls = 0;
    const replay = new EventOutbox({
      filePath,
      indexerUrl: "https://indexer.example",
      scope: OUTBOX_SCOPE,
      retryBaseMs: 1,
      retryCapMs: 1,
      requestTimeoutMs: 10,
      fetch: async (_url, init) => {
        replayCalls++;
        const id = (JSON.parse(init.body) as { id: string }).id;
        return response(200, { accepted: true, deduped: true, eventId: id });
      },
    });
    replay.start();
    await waitFor(() => replayCalls === 1 && replay.status().length === 0);
    assert.equal(replayCalls, 1);
    await replay.drain(20);
    replay.close();

    let postAckCalls = 0;
    const postAck = new EventOutbox({
      filePath,
      indexerUrl: "https://indexer.example",
      scope: OUTBOX_SCOPE,
      fetch: async () => {
        postAckCalls++;
        return response(500, {});
      },
    });
    postAck.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(postAckCalls, 0);
    await postAck.drain(20);
    postAck.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acknowledged served high-water survives compaction and seeds the next restart checkpoint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-event-checkpoint-"));
  const filePath = path.join(dir, "outbox.json");
  const first = new EventOutbox({
    filePath,
    indexerUrl: "https://indexer.example",
    scope: OUTBOX_SCOPE,
    retryBaseMs: 1,
    retryCapMs: 1,
    fetch: async (_url, init) => {
      const id = (JSON.parse(init.body) as { id: string }).id;
      return response(200, { accepted: true, deduped: false, eventId: id });
    },
  });
  try {
    first.enqueue({
      ...event("evt_first"),
      amountUsdc: "400",
      cumulativeCheckpoint: "400",
    });
    first.start();
    await waitFor(() => first.status().length === 0);
    assert.equal(first.servedCheckpoints()[0]?.cumulativeCheckpoint, "400");
    first.close();

    const recovered = new EventOutbox({
      filePath,
      indexerUrl: "https://indexer.example",
      scope: OUTBOX_SCOPE,
      fetch: async () => response(500, {}),
    });
    const ledger = new VaultCreditLedger();
    for (const checkpoint of recovered.servedCheckpoints()) {
      ledger.restoreServed(
        checkpoint.consumer,
        checkpoint.operator,
        BigInt(checkpoint.vaultCycle),
        BigInt(checkpoint.cumulativeCheckpoint)
      );
    }
    ledger.syncOnchain(event().consumer, event().operator, 3n, 0n, 1_000n);
    assert.equal(ledger.admit(event().consumer, event().operator, 3n, 300n, 1_000n).ok, true);
    const nextCheckpoint = ledger.settleServed(
      event().consumer,
      event().operator,
      3n,
      300n,
      300n
    );
    assert.equal(nextCheckpoint, 700n);
    recovered.enqueue({
      ...event("evt_second"),
      amountUsdc: "300",
      cumulativeCheckpoint: String(nextCheckpoint),
    });
    const persisted = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(persisted.entries[0].payload.cumulativeCheckpoint, "700");
    assert.equal(recovered.servedCheckpoints()[0]?.cumulativeCheckpoint, "700");

    recovered.observeOnchain(event().consumer, event().operator, 3n, 699n);
    assert.equal(recovered.servedCheckpoints().length, 1);
    recovered.observeOnchain(event().consumer, event().operator, 3n, 700n);
    assert.deepEqual(recovered.servedCheckpoints(), []);
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence faults reconcile pre- and post-rename state and fence later writes", () => {
  for (const step of [
    "before_rename",
    "after_rename",
    "after_directory_fsync",
  ] as const) {
    let armed = false;
    const fixture = create(async () => response(500, {}), {
      onPersistStep(observed) {
        if (armed && observed === step) throw new Error(`injected ${step}`);
      },
    });
    try {
      armed = true;
      assert.throws(() => fixture.outbox.enqueue(event()), /restart is required/);
      assert.throws(
        () =>
          fixture.outbox.reserve({
            id: "evt_later",
            operator: event().operator,
            consumer: event().consumer,
            model: event().model,
          }),
        /restart is required/
      );
      assert.throws(
        () => fixture.outbox.enqueue(event("evt_later")),
        /restart is required/
      );
      fixture.outbox.close();

      const recovered = new EventOutbox({
        filePath: fixture.filePath,
        indexerUrl: "https://indexer.example",
        scope: OUTBOX_SCOPE,
        fetch: async () => response(500, {}),
      });
      const expectedEntries = step === "before_rename" ? 0 : 1;
      assert.equal(recovered.status().length, expectedEntries, step);
      assert.equal(recovered.servedCheckpoints().length, expectedEntries, step);
      recovered.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});

test("a persistence fault fences every concurrent delivery before later writes or fetches", async () => {
  let armed = false;
  let faulted = false;
  let fetches = 0;
  let fetchesAfterFault = 0;
  let abortedFetches = 0;
  let attemptPersists = 0;
  let persistStepsAfterFault = 0;
  const fixture = create(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        fetches++;
        if (faulted) fetchesAfterFault++;
        init.signal.addEventListener("abort", () => {
          abortedFetches++;
          const error = new Error("aborted after persistence fault");
          error.name = "AbortError";
          reject(error);
        });
      }),
    {
      concurrency: 4,
      onPersistStep(step) {
        if (armed && step === "before_rename") attemptPersists++;
        if (armed && step === "before_rename" && attemptPersists === 2) {
          faulted = true;
          throw new Error("injected attempt persistence failure");
        }
        if (faulted) persistStepsAfterFault++;
      },
    }
  );
  try {
    for (let i = 0; i < 4; i++) fixture.outbox.enqueue(event(`evt_${i}`));
    armed = true;
    fixture.outbox.start();
    await waitFor(() => faulted);
    assert.equal(await fixture.outbox.drain(20), false);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(fetches, 1);
    assert.equal(fetchesAfterFault, 0);
    assert.equal(abortedFetches, 1);
    assert.equal(persistStepsAfterFault, 0);
    assert.equal(
      fixture.outbox.status().reduce((sum, entry) => sum + entry.attempts, 0),
      1
    );
    assert.ok(fixture.outbox.status().every((entry) => entry.lastErrorCode === null));
    assert.throws(() => fixture.outbox.start(), /restart is required/);
    assert.throws(
      () => fixture.outbox.observeOnchain(event().consumer, event().operator, 3n, 30n),
      /restart is required/
    );
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("stale-lock recovery preserves the one contender that acquires after compare-and-remove", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-event-lock-race-"));
  const filePath = path.join(dir, "outbox.json");
  const stalePid = 999_999_999;
  writeFileSync(`${filePath}.lock`, `${stalePid}\n`, { mode: 0o600 });
  const winners: EventOutbox[] = [];
  try {
    assert.throws(
      () =>
        new EventOutbox({
          filePath,
          indexerUrl: "https://indexer.example",
          scope: OUTBOX_SCOPE,
          onLockStep(step) {
            if (step !== "stale_unlinked" || winners.length > 0) return;
            winners.push(
              new EventOutbox({
                filePath,
                indexerUrl: "https://indexer.example",
                scope: OUTBOX_SCOPE,
              })
            );
          },
        }),
      /already locked/
    );
    assert.equal(winners.length, 1);
    assert.throws(
      () =>
        new EventOutbox({
          filePath,
          indexerUrl: "https://indexer.example",
          scope: OUTBOX_SCOPE,
        }),
      /already locked/
    );
    assert.equal(existsSync(`${filePath}.lock.recovery`), false);
    winners[0].close();
    assert.equal(existsSync(`${filePath}.lock`), false);
  } finally {
    for (const winner of winners) winner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart recovers an attempt persisted immediately before the process disappeared", async () => {
  const fixture = create(async (_url, init) => {
    const id = (JSON.parse(init.body) as { id: string }).id;
    return response(200, { accepted: true, deduped: false, eventId: id });
  });
  try {
    fixture.outbox.enqueue(event());
    fixture.outbox.close();
    const persisted = JSON.parse(readFileSync(fixture.filePath, "utf8"));
    persisted.entries[0].attempts = 1;
    persisted.entries[0].nextAttemptAt = Number.MAX_SAFE_INTEGER;
    writeFileSync(fixture.filePath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

    let calls = 0;
    const recovered = new EventOutbox({
      filePath: fixture.filePath,
      indexerUrl: "https://indexer.example",
      scope: OUTBOX_SCOPE,
      retryBaseMs: 1,
      retryCapMs: 1,
      fetch: async (_url, init) => {
        calls++;
        const id = (JSON.parse(init.body) as { id: string }).id;
        return response(200, { accepted: true, deduped: true, eventId: id });
      },
    });
    recovered.start();
    await waitFor(() => calls === 1 && recovered.status().length === 0);
    assert.equal(calls, 1);
    recovered.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("only an exact bounded acknowledgement retires a pending event", async () => {
  let calls = 0;
  const fixture = create(async (_url, init) => {
    calls++;
    const id = (JSON.parse(init.body) as { id: string }).id;
    if (calls === 1) {
      return response(200, { accepted: true, deduped: false, eventId: id, extra: true });
    }
    if (calls === 2) return response(200, "x".repeat(16 * 1024 + 1));
    return response(200, { accepted: true, deduped: true, eventId: id });
  });
  try {
    fixture.outbox.enqueue(event());
    fixture.outbox.start();
    await waitFor(() => calls === 3 && fixture.outbox.status().length === 0);
    assert.equal(calls, 3);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("corrupt state fails closed without overwriting the evidence", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-event-corrupt-"));
  const filePath = path.join(dir, "outbox.json");
  writeFileSync(filePath, "{broken", { mode: 0o600 });
  try {
    assert.throws(
      () =>
        new EventOutbox({
          filePath,
          indexerUrl: "https://indexer.example",
          scope: OUTBOX_SCOPE,
        }),
      /corrupt/
    );
    assert.equal(readFileSync(filePath, "utf8"), "{broken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entry and byte bounds reserve space for every legal pending transition", async () => {
  const fixture = create(async () => response(400, { errorCode: "terminal" }), {
    maxEntries: 1,
    maxBytes: 2_048,
  });
  try {
    fixture.outbox.enqueue(event("evt_one"));
    assert.throws(() => fixture.outbox.enqueue(event("evt_two")), /capacity exhausted/);
    fixture.outbox.start();
    await waitFor(() => fixture.outbox.status()[0]?.state === "dead_letter");
    await fixture.outbox.drain(20);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }

  const tooSmall = create(async () => response(200, {}), { maxBytes: 512 });
  try {
    assert.throws(() => tooSmall.outbox.enqueue(event()), /byte capacity exhausted/);
    await tooSmall.outbox.drain(0);
    tooSmall.outbox.close();
  } finally {
    rmSync(tooSmall.dir, { recursive: true, force: true });
  }
});

test("pre-work reservations fence concurrent serves against remaining durable capacity", () => {
  const fixture = create(async () => response(500, {}), { maxEntries: 1 });
  try {
    fixture.outbox.reserve({
      id: "evt_one",
      operator: event().operator,
      consumer: event().consumer,
      model: event().model,
    });
    assert.throws(
      () =>
        fixture.outbox.reserve({
          id: "evt_two",
          operator: event().operator,
          consumer: event().consumer,
          model: event().model,
        }),
      /capacity exhausted/
    );
    assert.equal(fixture.outbox.enqueue(event("evt_one")), "queued");
    assert.throws(
      () =>
        fixture.outbox.reserve({
          id: "evt_two",
          operator: event().operator,
          consumer: event().consumer,
          model: event().model,
        }),
      /capacity exhausted/
    );
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("bounded shutdown aborts an active request and leaves it durably pending", async () => {
  const fixture = create(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    { requestTimeoutMs: 50 }
  );
  try {
    fixture.outbox.enqueue(event());
    fixture.outbox.start();
    await waitFor(() => fixture.outbox.status()[0]?.attempts === 1);
    assert.equal(await fixture.outbox.drain(5), false);
    assert.equal(fixture.outbox.status()[0]?.state, "pending");
    assert.equal(fixture.outbox.status()[0]?.lastErrorCode, "request_timeout");
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("shutdown drains every queued batch within the configured concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  const fixture = create(
    async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      const id = (JSON.parse(init.body) as { id: string }).id;
      return response(200, { accepted: true, deduped: false, eventId: id });
    },
    { concurrency: 1 }
  );
  try {
    fixture.outbox.enqueue(event("evt_one"));
    fixture.outbox.enqueue(event("evt_two"));
    fixture.outbox.enqueue(event("evt_three"));
    assert.equal(await fixture.outbox.drain(200), true);
    assert.equal(peak, 1);
    assert.deepEqual(fixture.outbox.status(), []);
    fixture.outbox.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("exclusive ownership, configured status bounds, and environment validation fail closed", () => {
  const fixture = create(async () => response(500, {}), { maxEntries: 2_000 });
  try {
    assert.throws(
      () =>
        new EventOutbox({
          filePath: fixture.filePath,
          indexerUrl: "https://indexer.example",
          scope: OUTBOX_SCOPE,
        }),
      /already locked/
    );
    assert.deepEqual(
      readEventOutboxStatus(fixture.filePath, { maxEntries: 2_000, maxBytes: 8 * 1024 * 1024 }),
      []
    );
    assert.throws(
      () => eventOutboxRuntimeOptions({ HALO_EVENT_OUTBOX_CONCURRENCY: "0" }),
      /HALO_EVENT_OUTBOX_CONCURRENCY/
    );
    assert.equal(
      eventOutboxRuntimeOptions({ HALO_EVENT_OUTBOX_MAX_ENTRIES: "2000" }).maxEntries,
      2_000
    );
    fixture.outbox.close();
    assert.throws(
      () =>
        new EventOutbox({
          filePath: fixture.filePath,
          indexerUrl: "https://indexer.example",
          scope: { ...OUTBOX_SCOPE, vaultAddress: "0x4444444444444444444444444444444444444444" },
        }),
      /scope does not match/
    );
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
