const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = fs;
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  HaloVaultClient,
  VaultRedeemTerminalError,
} = require("../dist/vault");
const {
  MAX_DEAD_LETTER_ENTRIES,
  MAX_DEAD_LETTER_FILE_BYTES,
  acquireRedeemEvidenceOwnership,
  parseDeadLetterStore,
  serializeDeadLetterStore,
} = require("../dist/redeemEvidenceStore");

const CONSUMER = "0x0000000000000000000000000000000000000001";
const OPERATOR_A = "0x0000000000000000000000000000000000000002";
const OPERATOR_B = "0x0000000000000000000000000000000000000003";
const OPS = {
  locked: 100_000n,
  redeemed: 0n,
  expiry: 9_999_999_999n,
  created: 0n,
  cycle: 1n,
};
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

function fixture(t, overrides = {}, { stubPushReceipt = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "halo-sdk-dead-letter-"));
  const pendingStorePath = join(directory, "pending.json");
  const deadLetterStorePath = join(directory, "dead.json");
  const terminalErrors = [];
  const logs = [];
  let client;
  t.after(async () => {
    await client?.closeRedeemEvidenceStore().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });
  client = new HaloVaultClient(
    {
      getAddress: async () => CONSUMER,
      signTypedData: async () => "0xsigned",
    },
    {
      facilitatorUrl: "https://facilitator.invalid",
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      pendingStorePath,
      deadLetterStorePath,
      onTerminalRedeem: (error) => terminalErrors.push(error),
      log: (message) => logs.push(message),
      ...overrides,
    }
  );
  client.readOps = async () => OPS;
  client.signReceipt = async () => "0xsigned";
  if (stubPushReceipt) client.pushReceipt = async () => false;
  return {
    client,
    deadLetterStorePath,
    directory,
    logs,
    pendingStorePath,
    terminalErrors,
  };
}

function queue(client, operator = OPERATOR_A, cost = 1_000n) {
  client.recordAndRedeem(operator, OPS, 1n, cost);
}

function evidenceKey(vaultAddress, operator, cycle) {
  return JSON.stringify([
    8453,
    vaultAddress.toLowerCase(),
    CONSUMER.toLowerCase(),
    operator.toLowerCase(),
    cycle,
  ]);
}

function deadLetterEntry(
  vaultAddress,
  cumulative,
  {
    cycle = "1",
    operator = OPERATOR_A,
    reason = "invalid-request",
    signature = `0xdead-${cumulative}`,
  } = {}
) {
  return {
    key: evidenceKey(vaultAddress, operator, cycle),
    version: 1,
    vaultAddress,
    chainId: 8453,
    consumer: CONSUMER,
    operator,
    cumulative,
    signature,
    cycle,
    reason,
    recordedAt: "2026-07-23T00:00:00.000Z",
  };
}

function writeRestartEvidence(state, deadCumulative, activeCumulative) {
  const vaultAddress = state.client.cfg.vaultAddress;
  writeFileSync(
    state.deadLetterStorePath,
    JSON.stringify({
      version: 1,
      entries: [deadLetterEntry(vaultAddress, deadCumulative)],
    })
  );
  writeFileSync(
    state.pendingStorePath,
    JSON.stringify([
      {
        key: evidenceKey(vaultAddress, OPERATOR_A, "1"),
        vaultAddress,
        chainId: 8453,
        consumer: CONSUMER,
        operator: OPERATOR_A,
        cumulative: activeCumulative,
        signature: `0xactive-${activeCumulative}`,
        cycle: "1",
      },
    ])
  );
}

test("HTTP 426 is typed, durably quarantined, and never retried by the timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return new Response(
      JSON.stringify({
        error: "cli_outdated",
        detail: "sensitive upstream text must not be persisted",
      }),
      { status: 426, headers: { "content-type": "application/json" } }
    );
  };
  const state = fixture(t);

  queue(state.client);
  await state.client.flushRedeems();

  assert.equal(requests, 1);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(state.client.deadLetterRedeemCount, 1);
  assert.equal(state.terminalErrors.length, 1);
  assert.ok(state.terminalErrors[0] instanceof VaultRedeemTerminalError);
  assert.equal(state.terminalErrors[0].reason, "cli-outdated");
  assert.equal(state.terminalErrors[0].retryable, false);
  const persisted = readFileSync(state.deadLetterStorePath, "utf8");
  assert.match(persisted, /"version":1/);
  assert.match(persisted, /"reason":"cli-outdated"/);
  assert.doesNotMatch(persisted, /sensitive upstream text/);

  t.mock.timers.tick(60_000);
  await Promise.resolve();
  await state.client.flushRedeems();
  assert.equal(requests, 1, "terminal evidence must never auto-replay");
  assert.equal(JSON.parse(readFileSync(state.deadLetterStorePath, "utf8")).entries.length, 1);
});

test("an in-flight HTTP 426 quarantines the current same-key high-water before later redeem", async (t) => {
  const state = fixture(t);
  const key = evidenceKey(state.client.cfg.vaultAddress, OPERATOR_A, "1");
  state.client.pendingRedeems.set(key, {
    operator: OPERATOR_A,
    consumer: CONSUMER,
    cumulative: 1_000n,
    signature: "0xold",
    cycle: 1n,
    inFlight: false,
  });

  let releaseOldRedeem;
  let oldRedeemStartedResolve;
  const oldRedeemStarted = new Promise((resolve) => {
    oldRedeemStartedResolve = resolve;
  });
  const oldRedeemResult = new Promise((resolve) => {
    releaseOldRedeem = resolve;
  });
  let redeemRequests = 0;
  state.client.postRedeem = async (_operator, cumulative) => {
    redeemRequests += 1;
    assert.equal(cumulative, 1_000n, "no newer facilitator redeem may start");
    oldRedeemStartedResolve();
    await oldRedeemResult;
    throw new VaultRedeemTerminalError("cli-outdated");
  };

  let releaseReplacementReceipt;
  let replacementInstalledResolve;
  const replacementInstalled = new Promise((resolve) => {
    replacementInstalledResolve = resolve;
  });
  const replacementReceiptResult = new Promise((resolve) => {
    releaseReplacementReceipt = resolve;
  });
  state.client.pushReceipt = async (_operator, cumulative) => {
    assert.equal(cumulative, 1_500n);
    replacementInstalledResolve();
    await replacementReceiptResult;
    return false;
  };

  const oldAttempt = state.client.attemptRedeem(key);
  await oldRedeemStarted;
  queue(state.client, OPERATOR_A, 500n);
  await replacementInstalled;
  releaseOldRedeem();
  await oldAttempt;
  releaseReplacementReceipt();
  await state.client.flushRedeems();

  assert.equal(redeemRequests, 1);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(state.client.deadLetterRedeemCount, 1);
  const [entry] = parseDeadLetterStore(
    readFileSync(state.deadLetterStorePath, "utf8")
  ).entries;
  assert.equal(entry.cumulative, "1500");
  assert.equal(entry.signature, "0xsigned");
  assert.equal(entry.reason, "cli-outdated");
});

test("an in-flight HTTP 426 remains terminal after its replacement settles", async (t) => {
  const state = fixture(t);
  const key = evidenceKey(state.client.cfg.vaultAddress, OPERATOR_A, "1");
  state.client.pendingRedeems.set(key, {
    operator: OPERATOR_A,
    consumer: CONSUMER,
    cumulative: 1_000n,
    signature: "0xold",
    cycle: 1n,
    inFlight: false,
  });

  let releaseOldRedeem;
  let oldRedeemStartedResolve;
  const oldRedeemStarted = new Promise((resolve) => {
    oldRedeemStartedResolve = resolve;
  });
  const oldRedeemResult = new Promise((resolve) => {
    releaseOldRedeem = resolve;
  });
  const redeems = [];
  state.client.postRedeem = async (_operator, cumulative) => {
    redeems.push(cumulative);
    if (cumulative === 1_000n) {
      oldRedeemStartedResolve();
      await oldRedeemResult;
      throw new VaultRedeemTerminalError("cli-outdated");
    }
    return {
      status: "confirmed",
      transaction: "0xconfirmed",
      cumulative: cumulative.toString(),
      cycle: "1",
    };
  };
  const receiptPushes = [];
  state.client.pushReceipt = async (_operator, cumulative) => {
    receiptPushes.push(cumulative);
    return false;
  };

  const oldAttempt = state.client.attemptRedeem(key);
  await oldRedeemStarted;
  queue(state.client, OPERATOR_A, 500n);
  await state.client.redeemQueue;
  assert.equal(state.client.pendingRedeemCount, 0);

  releaseOldRedeem();
  await oldAttempt;

  assert.equal(state.client.deadLetterRedeemCount, 1);
  assert.equal(state.terminalErrors.length, 1);
  assert.equal(state.terminalErrors[0].reason, "cli-outdated");
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "1000"
  );

  queue(state.client, OPERATOR_A, 500n);
  await state.client.flushRedeems();

  assert.deepEqual(receiptPushes, [1_500n]);
  assert.deepEqual(redeems, [1_000n, 1_500n]);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "2000"
  );
});

test("an older HTTP 426 preserves a replacement already in the dead-letter store", async (t) => {
  const state = fixture(t);
  const key = evidenceKey(state.client.cfg.vaultAddress, OPERATOR_A, "1");
  state.client.pendingRedeems.set(key, {
    operator: OPERATOR_A,
    consumer: CONSUMER,
    cumulative: 1_000n,
    signature: "0xold",
    cycle: 1n,
    inFlight: false,
  });
  state.client.signReceipt = async ({ cumulative }) => {
    assert.equal(cumulative, 1_500n);
    return "0xnew";
  };

  let releaseOldRedeem;
  let oldRedeemStartedResolve;
  const oldRedeemStarted = new Promise((resolve) => {
    oldRedeemStartedResolve = resolve;
  });
  const oldRedeemResult = new Promise((resolve) => {
    releaseOldRedeem = resolve;
  });
  state.client.postRedeem = async (_operator, cumulative) => {
    if (cumulative === 1_000n) {
      oldRedeemStartedResolve();
      await oldRedeemResult;
      throw new VaultRedeemTerminalError("cli-outdated");
    }
    assert.equal(cumulative, 1_500n);
    return {
      status: "rejected",
      reason: "invalid-request",
      error: "replacement is terminal",
    };
  };

  const oldAttempt = state.client.attemptRedeem(key);
  await oldRedeemStarted;
  queue(state.client, OPERATOR_A, 500n);
  await state.client.redeemQueue;

  assert.deepEqual(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries.map(
      ({ cumulative, signature, reason }) => ({ cumulative, signature, reason })
    ),
    [{ cumulative: "1500", signature: "0xnew", reason: "invalid-request" }]
  );

  releaseOldRedeem();
  await oldAttempt;

  assert.deepEqual(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries.map(
      ({ cumulative, signature, reason }) => ({ cumulative, signature, reason })
    ),
    [{ cumulative: "1500", signature: "0xnew", reason: "cli-outdated" }]
  );
  assert.equal(state.terminalErrors.at(-1).reason, "cli-outdated");

  const shared = {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  };
  await state.client.closeRedeemEvidenceStore();
  const restarted = fixture(t, shared);
  await restarted.client.resumePendingRedeems();

  assert.equal(restarted.client.pendingRedeemCount, 0);
  assert.equal(restarted.client.deadLetterRedeemCount, 1);
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "1500"
  );
});

test("an in-flight structural rejection stays receipt-local after same-key replacement", async (t) => {
  const state = fixture(t);
  const key = evidenceKey(state.client.cfg.vaultAddress, OPERATOR_A, "1");
  state.client.pendingRedeems.set(key, {
    operator: OPERATOR_A,
    consumer: CONSUMER,
    cumulative: 1_000n,
    signature: "0xold",
    cycle: 1n,
    inFlight: false,
  });

  let releaseOldRedeem;
  let oldRedeemStartedResolve;
  const oldRedeemStarted = new Promise((resolve) => {
    oldRedeemStartedResolve = resolve;
  });
  const oldRedeemResult = new Promise((resolve) => {
    releaseOldRedeem = resolve;
  });
  const redeems = [];
  state.client.postRedeem = async (_operator, cumulative) => {
    redeems.push(cumulative);
    if (cumulative === 1_000n) {
      oldRedeemStartedResolve();
      await oldRedeemResult;
      return {
        status: "rejected",
        reason: "invalid-request",
        error: "old receipt is invalid",
      };
    }
    return {
      status: "rejected",
      reason: "unavailable",
      error: "temporarily unavailable",
    };
  };

  let releaseReplacementReceipt;
  let replacementInstalledResolve;
  const replacementInstalled = new Promise((resolve) => {
    replacementInstalledResolve = resolve;
  });
  const replacementReceiptResult = new Promise((resolve) => {
    releaseReplacementReceipt = resolve;
  });
  state.client.pushReceipt = async () => {
    replacementInstalledResolve();
    await replacementReceiptResult;
    return false;
  };

  const oldAttempt = state.client.attemptRedeem(key);
  await oldRedeemStarted;
  queue(state.client, OPERATOR_A, 500n);
  await replacementInstalled;
  releaseOldRedeem();
  await oldAttempt;
  releaseReplacementReceipt();
  await state.client.flushRedeems();

  assert.deepEqual(redeems, [1_000n, 1_500n, 1_500n]);
  assert.equal(state.client.pendingRedeemCount, 1);
  assert.equal(state.client.deadLetterRedeemCount, 0);
  assert.equal(state.terminalErrors.length, 0);
});

test("an equal-content replacement keeps structural invalid-request terminal", async (t) => {
  const state = fixture(t);
  const cappedOps = { ...OPS, locked: 1_000n };
  const key = evidenceKey(state.client.cfg.vaultAddress, OPERATOR_A, "1");
  state.client.pendingRedeems.set(key, {
    operator: OPERATOR_A,
    consumer: CONSUMER,
    cumulative: 1_000n,
    signature: "0xsame",
    cycle: 1n,
    inFlight: false,
  });
  state.client.readOps = async () => cappedOps;
  state.client.signReceipt = async () => "0xsame";

  let redeemStartedResolve;
  const redeemStarted = new Promise((resolve) => {
    redeemStartedResolve = resolve;
  });
  let releaseRedeem;
  const redeemResult = new Promise((resolve) => {
    releaseRedeem = resolve;
  });
  let requests = 0;
  state.client.postRedeem = async () => {
    requests += 1;
    redeemStartedResolve();
    await redeemResult;
    return {
      status: "rejected",
      reason: "invalid-request",
      error: "same signed receipt is invalid",
    };
  };

  let replacementInstalledResolve;
  const replacementInstalled = new Promise((resolve) => {
    replacementInstalledResolve = resolve;
  });
  let releaseReplacementReceipt;
  const replacementReceiptResult = new Promise((resolve) => {
    releaseReplacementReceipt = resolve;
  });
  state.client.pushReceipt = async () => {
    replacementInstalledResolve();
    await replacementReceiptResult;
    return false;
  };

  const oldAttempt = state.client.attemptRedeem(key);
  await redeemStarted;
  state.client.recordAndRedeem(OPERATOR_A, cappedOps, 1n, 1n);
  await replacementInstalled;
  assert.notEqual(state.client.pendingRedeems.get(key).inFlight, true);

  releaseRedeem();
  await oldAttempt;
  releaseReplacementReceipt();
  await state.client.flushRedeems();

  assert.equal(requests, 1);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(state.client.deadLetterRedeemCount, 1);
  assert.equal(state.terminalErrors.length, 1);
  assert.deepEqual(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries.map(
      ({ cumulative, signature, reason }) => ({ cumulative, signature, reason })
    ),
    [{ cumulative: "1000", signature: "0xsame", reason: "invalid-request" }]
  );
});

test("an equal-content replacement is cleared by exact collected coverage", async (t) => {
  const state = fixture(t);
  const cappedOps = { ...OPS, locked: 1_000n };
  const key = evidenceKey(state.client.cfg.vaultAddress, OPERATOR_A, "1");
  state.client.pendingRedeems.set(key, {
    operator: OPERATOR_A,
    consumer: CONSUMER,
    cumulative: 1_000n,
    signature: "0xsame",
    cycle: 1n,
    inFlight: false,
  });
  state.client.readOps = async () => cappedOps;
  state.client.signReceipt = async () => "0xsame";

  let redeemStartedResolve;
  const redeemStarted = new Promise((resolve) => {
    redeemStartedResolve = resolve;
  });
  let releaseRedeem;
  const redeemResult = new Promise((resolve) => {
    releaseRedeem = resolve;
  });
  let requests = 0;
  state.client.postRedeem = async () => {
    requests += 1;
    redeemStartedResolve();
    await redeemResult;
    return {
      status: "confirmed",
      transaction: `0x${"e".repeat(64)}`,
      cumulative: "1000",
      cycle: "1",
    };
  };

  let replacementInstalledResolve;
  const replacementInstalled = new Promise((resolve) => {
    replacementInstalledResolve = resolve;
  });
  let releaseReplacementReceipt;
  const replacementReceiptResult = new Promise((resolve) => {
    releaseReplacementReceipt = resolve;
  });
  state.client.pushReceipt = async () => {
    replacementInstalledResolve();
    await replacementReceiptResult;
    return false;
  };

  const oldAttempt = state.client.attemptRedeem(key);
  await redeemStarted;
  state.client.recordAndRedeem(OPERATOR_A, cappedOps, 1n, 1n);
  await replacementInstalled;
  releaseRedeem();
  await oldAttempt;
  releaseReplacementReceipt();
  await state.client.flushRedeems();

  assert.equal(requests, 1);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(state.client.deadLetterRedeemCount, 0);
  assert.equal(state.terminalErrors.length, 0);
});

test("relay receipt HTTP 426 quarantines before facilitator redeem", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const requests = [];
  global.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://relay.invalid/v1/receipt") {
      return new Response(
        JSON.stringify({
          error: "cli_outdated",
          detail: "sensitive relay text must not be persisted",
        }),
        { status: 426, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected later network call: ${url}`);
  };
  const state = fixture(
    t,
    { relayUrl: "https://relay.invalid" },
    { stubPushReceipt: false }
  );

  queue(state.client);
  await state.client.flushRedeems();

  assert.deepEqual(requests, ["https://relay.invalid/v1/receipt"]);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(state.client.deadLetterRedeemCount, 1);
  assert.equal(state.terminalErrors.length, 1);
  assert.ok(state.terminalErrors[0] instanceof VaultRedeemTerminalError);
  assert.equal(state.terminalErrors[0].reason, "cli-outdated");
  assert.match(state.terminalErrors[0].message, /compatibility is outdated/);
  assert.doesNotMatch(state.terminalErrors[0].message, /sensitive relay text/);
  const persisted = readFileSync(state.deadLetterStorePath, "utf8");
  assert.match(persisted, /"reason":"cli-outdated"/);
  assert.doesNotMatch(persisted, /sensitive relay text/);
});

test("relay receipt connection loss keeps facilitator unavailable retryable", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let relayRequests = 0;
  let facilitatorRequests = 0;
  global.fetch = async (input) => {
    const url = String(input);
    if (url === "https://relay.invalid/v1/receipt") {
      relayRequests += 1;
      throw new TypeError("simulated relay connection loss");
    }
    if (url === "https://facilitator.invalid/vault/redeem") {
      facilitatorRequests += 1;
      return new Response(
        JSON.stringify({
          status: "rejected",
          reason: "unavailable",
          error: "temporarily unavailable",
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected network call: ${url}`);
  };
  const state = fixture(
    t,
    { relayUrl: "https://relay.invalid" },
    { stubPushReceipt: false }
  );

  queue(state.client);
  await state.client.flushRedeems();

  assert.equal(relayRequests, 1);
  assert.ok(facilitatorRequests >= 1);
  assert.equal(state.client.pendingRedeemCount, 1);
  assert.equal(state.client.deadLetterRedeemCount, 0);
  assert.equal(state.terminalErrors.length, 0);
});

test("structural invalid-request is terminal while unavailable remains active", async (t) => {
  const state = fixture(t);
  let requests = 0;
  state.client.postRedeem = async (operator) => {
    requests += 1;
    return operator.toLowerCase() === OPERATOR_A
      ? { status: "rejected", reason: "invalid-request", error: "unsafe raw detail" }
      : { status: "rejected", reason: "unavailable", error: "temporarily unavailable" };
  };

  queue(state.client, OPERATOR_A, 1_000n);
  queue(state.client, OPERATOR_B, 2_000n);
  await state.client.flushRedeems();

  assert.ok(requests >= 2);
  assert.equal(state.client.deadLetterRedeemCount, 1);
  assert.equal(state.client.pendingRedeemCount, 1);
  assert.equal(state.terminalErrors[0].reason, "invalid-request");
  assert.doesNotMatch(readFileSync(state.deadLetterStorePath, "utf8"), /unsafe raw detail/);
});

test("exclusive store ownership preserves distinct terminal keys across successors and restart", async (t) => {
  const first = fixture(t);
  const shared = {
    pendingStorePath: first.pendingStorePath,
    deadLetterStorePath: first.deadLetterStorePath,
  };
  assert.throws(
    () => fixture(t, shared),
    /vault redeem evidence is already owned by this process/
  );

  first.client.postRedeem = async () => ({
    status: "rejected",
    reason: "invalid-request",
    error: "terminal A",
  });
  queue(first.client, OPERATOR_A);
  await first.client.flushRedeems();
  assert.deepEqual(
    parseDeadLetterStore(readFileSync(first.deadLetterStorePath, "utf8")).entries.map(
      (entry) => entry.operator
    ),
    [OPERATOR_A]
  );
  await first.client.closeRedeemEvidenceStore();

  const second = fixture(t, shared);
  second.client.postRedeem = async () => ({
    status: "rejected",
    reason: "invalid-request",
    error: "terminal B",
  });
  queue(second.client, OPERATOR_B);
  await second.client.flushRedeems();
  assert.deepEqual(
    new Set(
      parseDeadLetterStore(readFileSync(first.deadLetterStorePath, "utf8")).entries.map(
        (entry) => entry.operator
      )
    ),
    new Set([OPERATOR_A, OPERATOR_B])
  );
  await second.client.closeRedeemEvidenceStore();

  let replayed = 0;
  const restarted = fixture(t, shared);
  restarted.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("terminal evidence must not replay");
  };
  queue(restarted.client, OPERATOR_A);
  queue(restarted.client, OPERATOR_B);
  await restarted.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(restarted.client.pendingRedeemCount, 0);
  assert.equal(restarted.client.deadLetterRedeemCount, 2);
  assert.equal(JSON.parse(readFileSync(first.pendingStorePath, "utf8")).length, 0);
});

test("exclusive store ownership preserves retryable active evidence for the successor", async (t) => {
  const first = fixture(t);
  const shared = {
    pendingStorePath: first.pendingStorePath,
    deadLetterStorePath: first.deadLetterStorePath,
  };
  first.client.postRedeem = async () => ({
    status: "rejected",
    reason: "unavailable",
    error: "retry",
  });
  queue(first.client, OPERATOR_A);
  await first.client.flushRedeems();
  const activeBefore = readFileSync(first.pendingStorePath, "utf8");
  assert.equal(JSON.parse(activeBefore).length, 1);

  assert.throws(
    () => fixture(t, shared),
    /vault redeem evidence is already owned by this process/
  );
  assert.equal(readFileSync(first.pendingStorePath, "utf8"), activeBefore);
  assert.equal(existsSync(first.deadLetterStorePath), false);
  await first.client.closeRedeemEvidenceStore();

  const successor = fixture(t, shared);
  let resumed = 0;
  successor.client.postRedeem = async () => {
    resumed += 1;
    return {
      status: "confirmed",
      transaction: `0x${"a".repeat(64)}`,
      cumulative: "1000",
      cycle: "1",
    };
  };
  await successor.client.resumePendingRedeems();
  await successor.client.flushRedeems();

  assert.equal(resumed, 1);
  assert.equal(successor.client.pendingRedeemCount, 0);
  assert.equal(JSON.parse(readFileSync(first.pendingStorePath, "utf8")).length, 0);
});

test("a pending-only upgrade derives terminal storage and never replays its quarantine", async (t) => {
  const first = fixture(t, { deadLetterStorePath: "" });
  const derivedDeadLetterStorePath = `${first.pendingStorePath}.dead-letter`;
  const shared = {
    pendingStorePath: first.pendingStorePath,
    deadLetterStorePath: "",
  };
  writeFileSync(
    first.pendingStorePath,
    JSON.stringify([
      {
        key: "legacy-pending-key-is-recomputed",
        vaultAddress: first.client.cfg.vaultAddress,
        chainId: 8453,
        consumer: CONSUMER,
        operator: OPERATOR_A,
        cumulative: "1000",
        signature: "0xlegacy-active",
        cycle: "1",
      },
    ])
  );
  assert.equal(first.client.cfg.deadLetterStorePath, derivedDeadLetterStorePath);
  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: "",
        deadLetterStorePath: derivedDeadLetterStorePath,
      }),
    /vault redeem evidence is already owned by this process/
  );
  let requests = 0;
  first.client.postRedeem = async () => {
    requests += 1;
    return {
      status: "rejected",
      reason: "invalid-request",
      error: "legacy active receipt is terminal",
    };
  };

  await first.client.resumePendingRedeems();
  await first.client.flushRedeems();

  assert.equal(requests, 1);
  assert.equal(first.client.pendingRedeemCount, 0);
  assert.equal(
    parseDeadLetterStore(readFileSync(derivedDeadLetterStorePath, "utf8")).entries[0]
      .signature,
    "0xlegacy-active"
  );
  await first.client.closeRedeemEvidenceStore();

  let replayed = 0;
  const restarted = fixture(t, shared);
  restarted.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("derived terminal evidence must not replay");
  };
  await restarted.client.resumePendingRedeems();
  await restarted.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(restarted.client.pendingRedeemCount, 0);
  assert.equal(restarted.client.deadLetterRedeemCount, 1);
});

test("client ownership fences partial path overlap in either direction", async (t) => {
  const both = fixture(t);
  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: both.pendingStorePath,
        deadLetterStorePath: "",
      }),
    /vault redeem evidence is already owned by this process/
  );
  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: "",
        deadLetterStorePath: both.deadLetterStorePath,
      }),
    /vault redeem evidence is already owned by this process/
  );
  await both.client.closeRedeemEvidenceStore();

  const pendingOnly = fixture(t, { deadLetterStorePath: "" });
  assert.throws(
    () => fixture(t, { pendingStorePath: pendingOnly.pendingStorePath }),
    /vault redeem evidence is already owned by this process/
  );
  await pendingOnly.client.closeRedeemEvidenceStore();

  const deadOnly = fixture(t, { pendingStorePath: "" });
  assert.throws(
    () => fixture(t, { deadLetterStorePath: deadOnly.deadLetterStorePath }),
    /vault redeem evidence is already owned by this process/
  );
  await deadOnly.client.closeRedeemEvidenceStore();
});

test("store paths cannot overlap live ownership metadata and poison a successor", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "halo-sdk-lock-namespace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const deadLetterStorePath = join(directory, "store");
  const collidingPendingStorePath = `${deadLetterStorePath}.lock`;
  const caseAliasedLockPath = `${deadLetterStorePath}.LOCK`;

  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: collidingPendingStorePath,
        deadLetterStorePath,
      }),
    /must not overlap redeem evidence lock metadata/
  );
  assert.equal(existsSync(`${deadLetterStorePath}.lock`), false);
  assert.equal(existsSync(`${collidingPendingStorePath}.lock`), false);
  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: "",
        deadLetterStorePath: caseAliasedLockPath,
      }),
    /must not overlap redeem evidence lock metadata/
  );

  const pendingStorePath = join(directory, "pending");
  const first = fixture(t, { pendingStorePath, deadLetterStorePath });
  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: "",
        deadLetterStorePath: collidingPendingStorePath,
      }),
    /must not overlap redeem evidence lock metadata/
  );
  first.client.postRedeem = async () => ({
    status: "rejected",
    reason: "unavailable",
    error: "retain active evidence",
  });
  queue(first.client);
  await first.client.flushRedeems();
  await first.client.closeRedeemEvidenceStore();

  const successor = fixture(t, { pendingStorePath, deadLetterStorePath });
  successor.client.postRedeem = async () => ({
    status: "confirmed",
    transaction: `0x${"d".repeat(64)}`,
    cumulative: "1000",
    cycle: "1",
  });
  await successor.client.resumePendingRedeems();
  await successor.client.flushRedeems();

  assert.equal(successor.client.pendingRedeemCount, 0);
  await successor.client.closeRedeemEvidenceStore();
  assert.equal(existsSync(`${deadLetterStorePath}.lock`), false);
  assert.equal(existsSync(`${pendingStorePath}.lock`), false);
});

test("store paths cannot occupy stale-lock recovery metadata", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "halo-sdk-recovery-namespace-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, "store");
  const recoveryPath = `${target}.lock.recovery`;
  const modulePath = require.resolve("../dist/redeemEvidenceStore");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(modulePath)}).acquireRedeemEvidenceOwnership(${JSON.stringify([
        target,
      ])})`,
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  const staleOwner = readFileSync(`${target}.lock`, "utf8");
  writeFileSync(recoveryPath, "reserved recovery namespace");

  assert.throws(
    () => acquireRedeemEvidenceOwnership([target, recoveryPath]),
    /must not overlap redeem evidence lock metadata/
  );
  assert.throws(
    () =>
      fixture(t, {
        pendingStorePath: "",
        deadLetterStorePath: recoveryPath,
      }),
    /must not overlap redeem evidence lock metadata/
  );
  assert.throws(
    () => acquireRedeemEvidenceOwnership([`${target}.LoCk.ReCoVeRy`]),
    /must not overlap redeem evidence lock metadata/
  );
  assert.equal(readFileSync(`${target}.lock`, "utf8"), staleOwner);
  assert.equal(readFileSync(recoveryPath, "utf8"), "reserved recovery namespace");
  assert.equal(existsSync(`${recoveryPath}.lock`), false);

  rmSync(recoveryPath);
  const recovered = acquireRedeemEvidenceOwnership([target]);
  recovered.release();
  const successor = acquireRedeemEvidenceOwnership([target]);
  successor.release();
  assert.equal(existsSync(`${target}.lock`), false);
  assert.equal(existsSync(recoveryPath), false);
});

test("client state I/O remains bound to the paths resolved at construction", async (t) => {
  const originalDirectory = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "halo-sdk-resolved-path-"));
  const firstDirectory = join(root, "first");
  const secondDirectory = join(root, "second");
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  t.after(() => {
    process.chdir(originalDirectory);
    rmSync(root, { recursive: true, force: true });
  });

  process.chdir(firstDirectory);
  const first = fixture(t, {
    pendingStorePath: "pending.json",
    deadLetterStorePath: "dead.json",
  });
  process.chdir(secondDirectory);
  const second = fixture(t, {
    pendingStorePath: "pending.json",
    deadLetterStorePath: "dead.json",
  });
  first.client.postRedeem = second.client.postRedeem = async () => ({
    status: "rejected",
    reason: "unavailable",
    error: "retain active evidence",
  });

  queue(first.client, OPERATOR_A);
  await first.client.flushRedeems();
  queue(second.client, OPERATOR_B);
  await second.client.flushRedeems();

  assert.deepEqual(
    JSON.parse(readFileSync(join(firstDirectory, "pending.json"), "utf8")).map(
      (entry) => entry.operator
    ),
    [OPERATOR_A]
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(secondDirectory, "pending.json"), "utf8")).map(
      (entry) => entry.operator
    ),
    [OPERATOR_B]
  );
  await first.client.closeRedeemEvidenceStore();
  await second.client.closeRedeemEvidenceStore();
  process.chdir(originalDirectory);
});

test("a closed predecessor cannot flush stale state over its successor", async (t) => {
  const first = fixture(t);
  const shared = {
    pendingStorePath: first.pendingStorePath,
    deadLetterStorePath: first.deadLetterStorePath,
  };
  first.client.postRedeem = async () => ({
    status: "rejected",
    reason: "unavailable",
    error: "retain predecessor evidence",
  });
  queue(first.client, OPERATOR_A);
  await first.client.flushRedeems();
  await first.client.closeRedeemEvidenceStore();

  const successor = fixture(t, shared);
  successor.client.postRedeem = async () => ({
    status: "rejected",
    reason: "unavailable",
    error: "retain successor evidence",
  });
  await successor.client.resumePendingRedeems();
  queue(successor.client, OPERATOR_B);
  await successor.client.flushRedeems();
  const before = readFileSync(first.pendingStorePath, "utf8");
  assert.deepEqual(
    new Set(JSON.parse(before).map((entry) => entry.operator)),
    new Set([OPERATOR_A, OPERATOR_B])
  );

  first.client.postRedeem = async () => ({
    status: "confirmed",
    transaction: `0x${"c".repeat(64)}`,
    cumulative: "1000",
    cycle: "1",
  });
  await assert.rejects(
    first.client.flushRedeems(),
    /vault redeem evidence ownership is closing or closed/
  );
  assert.equal(readFileSync(first.pendingStorePath, "utf8"), before);
});

test("close seals and drains an in-memory client without configured store paths", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const state = fixture(t, {
    pendingStorePath: "",
    deadLetterStorePath: "",
  });
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  let releaseResolve;
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  let requests = 0;
  state.client.postRedeem = async () => {
    requests += 1;
    enteredResolve();
    await release;
    return {
      status: "confirmed",
      transaction: `0x${"f".repeat(64)}`,
      cumulative: "1000",
      cycle: "1",
    };
  };

  queue(state.client);
  await entered;
  let closed = false;
  const closing = state.client.closeRedeemEvidenceStore().then(() => {
    closed = true;
  });
  await Promise.resolve();

  assert.equal(closed, false);
  assert.throws(
    () => queue(state.client, OPERATOR_B),
    /vault redeem evidence ownership is closing or closed/
  );
  await assert.rejects(
    state.client.resumePendingRedeems(),
    /vault redeem evidence ownership is closing or closed/
  );
  await assert.rejects(
    state.client.flushRedeems(),
    /vault redeem evidence ownership is closing or closed/
  );
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(requests, 1);

  releaseResolve();
  await closing;
  assert.equal(closed, true);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(state.client.closeRedeemEvidenceStore(), state.client.redeemEvidenceClosePromise);

  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.throws(
    () => queue(state.client, OPERATOR_B),
    /vault redeem evidence ownership is closing or closed/
  );
});

test("close waits for a standalone active redeem before releasing store ownership", async (t) => {
  const state = fixture(t);
  const shared = {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  };
  let requests = 0;
  state.client.postRedeem = async () => {
    requests += 1;
    return {
      status: "rejected",
      reason: "unavailable",
      error: "seed retryable evidence",
    };
  };
  queue(state.client);
  await state.client.flushRedeems();
  const [{ key }] = JSON.parse(readFileSync(state.pendingStorePath, "utf8"));
  const seededRequests = requests;
  assert.ok(seededRequests > 0);

  let entered;
  const active = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  state.client.postRedeem = async () => {
    requests += 1;
    entered();
    return blocked;
  };
  const attempt = state.client.attemptRedeem(key);
  await active;

  let closed = false;
  const closing = state.client.closeRedeemEvidenceStore().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(
    () => fixture(t, shared),
    /vault redeem evidence is already owned by this process/
  );

  release({
    status: "rejected",
    reason: "unavailable",
    error: "retry after ambiguous wait",
  });
  await Promise.all([attempt, closing]);
  assert.equal(closed, true);
  assert.equal(requests, seededRequests + 1);

  const successor = fixture(t, shared);
  successor.client.postRedeem = async () => ({
    status: "confirmed",
    transaction: `0x${"b".repeat(64)}`,
    cumulative: "1000",
    cycle: "1",
  });
  await successor.client.resumePendingRedeems();
  await successor.client.flushRedeems();
  assert.equal(successor.client.pendingRedeemCount, 0);
  await successor.client.closeRedeemEvidenceStore();
});

test("ownership recovers dead processes and rolls back partial lock acquisition", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "halo-sdk-ownership-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = join(directory, "first.json");
  const second = join(directory, "second.json");
  const third = join(directory, "aaa-partial.json");
  const fourth = join(directory, "fourth.json");
  const modulePath = require.resolve("../dist/redeemEvidenceStore");
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `require(${JSON.stringify(modulePath)}).acquireRedeemEvidenceOwnership(${JSON.stringify([
        first,
        second,
      ])})`,
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(`${first}.lock`), true);
  assert.equal(existsSync(`${second}.lock`), true);

  const recovered = acquireRedeemEvidenceOwnership([first, second]);
  assert.throws(
    () => acquireRedeemEvidenceOwnership([third, second]),
    /already owned by this process/
  );
  const rollbackProbe = acquireRedeemEvidenceOwnership([third, fourth]);
  rollbackProbe.release();
  recovered.release();
  assert.equal(existsSync(`${first}.lock`), false);
  assert.equal(existsSync(`${second}.lock`), false);
});

test("a dead-letter write failure leaves a restart-stable active terminal fence", async (t) => {
  const state = fixture(t);
  const shared = {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  };
  let requests = 0;
  state.client.postRedeem = async () => {
    requests += 1;
    return { status: "rejected", reason: "invalid-request", error: "bad request" };
  };
  state.client.persistDeadLetters = () => {
    throw new Error("injected dead-letter write failure");
  };

  queue(state.client);
  await state.client.flushRedeems();
  queue(state.client, OPERATOR_A, 500n);
  await state.client.flushRedeems();

  assert.equal(requests, 1);
  assert.equal(state.client.pendingRedeemCount, 1);
  assert.equal(state.client.deadLetterRedeemCount, 1);
  assert.throws(() => readFileSync(state.deadLetterStorePath, "utf8"), {
    code: "ENOENT",
  });
  const [active] = JSON.parse(readFileSync(state.pendingStorePath, "utf8"));
  assert.equal(active.cumulative, "1500");
  assert.equal(active.terminalReason, "invalid-request");
  assert.match(state.logs.join("\n"), /active terminal fence/);

  await state.client.closeRedeemEvidenceStore();
  let replayed = 0;
  const restarted = fixture(t, shared);
  restarted.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("terminal active evidence must not replay");
  };
  await restarted.client.resumePendingRedeems();
  await restarted.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(restarted.client.pendingRedeemCount, 0);
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "1500"
  );
  assert.equal(JSON.parse(readFileSync(state.pendingStorePath, "utf8")).length, 0);
});

test("a post-rename directory-sync failure fences later dead-letter writes and restart replay", async (t) => {
  const state = fixture(t);
  let requests = 0;
  state.client.postRedeem = async () => {
    requests += 1;
    return { status: "rejected", reason: "invalid-request", error: "bad request" };
  };
  const originalFsync = fs.fsyncSync;
  let directorySyncs = 0;
  fs.fsyncSync = (descriptor) => {
    if (fstatSync(descriptor).isDirectory()) {
      directorySyncs += 1;
      if (directorySyncs === 3) {
        throw new Error("injected post-rename directory sync failure");
      }
    }
    return originalFsync(descriptor);
  };
  t.after(() => {
    fs.fsyncSync = originalFsync;
  });

  queue(state.client);
  await state.client.flushRedeems();

  assert.equal(requests, 1);
  assert.equal(state.client.pendingRedeemCount, 1);
  const committed = readFileSync(state.deadLetterStorePath, "utf8");
  assert.equal(parseDeadLetterStore(committed).entries.length, 1);
  assert.match(state.logs.join("\n"), /persistence is ambiguous/);

  const later = deadLetterEntry(state.client.cfg.vaultAddress, "2000", {
    operator: OPERATOR_B,
  });
  state.client.deadLetters.set(later.key, later);
  assert.throws(
    () => state.client.persistDeadLetters(),
    /persistence became ambiguous; restart is required/
  );
  assert.equal(
    readFileSync(state.deadLetterStorePath, "utf8"),
    committed,
    "a later writer must not replace the target after an ambiguous commit"
  );

  await state.client.closeRedeemEvidenceStore();
  let replayed = 0;
  const restarted = fixture(t, {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  });
  restarted.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("terminal evidence must not replay");
  };
  await restarted.client.resumePendingRedeems();
  await restarted.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(restarted.client.pendingRedeemCount, 0);
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries
      .length,
    1
  );
});

test("restart suppresses the active duplicate when cleanup fails after durable quarantine", async (t) => {
  const state = fixture(t);
  state.client.postRedeem = async () => ({
    status: "rejected",
    reason: "invalid-request",
    error: "bad request",
  });
  const persistPending = state.client.persistPending.bind(state.client);
  let requiredWrites = 0;
  state.client.persistPending = (required) => {
    if (required) {
      requiredWrites += 1;
      if (requiredWrites === 3) throw new Error("injected active cleanup failure");
    }
    return persistPending(required);
  };

  queue(state.client);
  await state.client.flushRedeems();

  assert.equal(state.client.pendingRedeemCount, 0);
  const [activeFence] = JSON.parse(readFileSync(state.pendingStorePath, "utf8"));
  assert.equal(activeFence.terminalReason, "invalid-request");
  assert.equal(JSON.parse(readFileSync(state.deadLetterStorePath, "utf8")).entries.length, 1);

  await state.client.closeRedeemEvidenceStore();
  let replayed = 0;
  const restarted = fixture(t, {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  });
  restarted.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("must not replay");
  };
  await restarted.client.resumePendingRedeems();
  await restarted.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(restarted.client.pendingRedeemCount, 0);
  assert.equal(JSON.parse(readFileSync(state.pendingStorePath, "utf8")).length, 0);
  assert.equal(JSON.parse(readFileSync(state.deadLetterStorePath, "utf8")).entries.length, 1);
});

test("restart preserves the terminal cumulative high-water for lower, equal, and higher active duplicates", async (t) => {
  for (const [activeCumulative, expectedCumulative] of [
    ["900", "1000"],
    ["1000", "1000"],
    ["1500", "1500"],
  ]) {
    const state = fixture(t);
    writeRestartEvidence(state, "1000", activeCumulative);
    let replayed = 0;
    state.client.postRedeem = async () => {
      replayed += 1;
      throw new Error("terminal evidence must not replay");
    };

    await state.client.resumePendingRedeems();
    await state.client.flushRedeems();

    const deadStore = parseDeadLetterStore(
      readFileSync(state.deadLetterStorePath, "utf8")
    );
    assert.equal(deadStore.entries[0].cumulative, expectedCumulative);
    assert.equal(
      deadStore.entries[0].signature,
      activeCumulative === "1500" ? "0xactive-1500" : "0xdead-1000"
    );
    assert.equal(JSON.parse(readFileSync(state.pendingStorePath, "utf8")).length, 0);
    assert.equal(replayed, 0);
  }
});

test("a failed restart high-water promotion retains both durable files and fences replay", async (t) => {
  const state = fixture(t);
  writeRestartEvidence(state, "1000", "1500");
  state.client.persistDeadLetters = () => {
    throw new Error("injected high-water promotion failure");
  };
  let replayed = 0;
  state.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("terminal evidence must not replay");
  };

  await state.client.resumePendingRedeems();
  await state.client.flushRedeems();

  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "1000"
  );
  assert.equal(
    JSON.parse(readFileSync(state.pendingStorePath, "utf8"))[0].cumulative,
    "1500"
  );
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(replayed, 0);
  assert.match(state.logs.join("\n"), /promotion is unavailable/);

  await state.client.closeRedeemEvidenceStore();
  const restarted = fixture(t, {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  });
  await restarted.client.resumePendingRedeems();
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "1500"
  );
  assert.equal(JSON.parse(readFileSync(state.pendingStorePath, "utf8")).length, 0);
});

test("a failed active cleanup after high-water promotion remains restart-safe", async (t) => {
  const state = fixture(t);
  writeRestartEvidence(state, "1000", "1500");
  state.client.persistPending = () => false;
  let replayed = 0;
  state.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("terminal evidence must not replay");
  };

  await state.client.resumePendingRedeems();
  await state.client.flushRedeems();

  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries[0]
      .cumulative,
    "1500"
  );
  assert.equal(
    JSON.parse(readFileSync(state.pendingStorePath, "utf8"))[0].cumulative,
    "1500"
  );
  assert.equal(replayed, 0);

  await state.client.closeRedeemEvidenceStore();
  const restarted = fixture(t, {
    pendingStorePath: state.pendingStorePath,
    deadLetterStorePath: state.deadLetterStorePath,
  });
  await restarted.client.resumePendingRedeems();
  assert.equal(JSON.parse(readFileSync(state.pendingStorePath, "utf8")).length, 0);
  assert.equal(restarted.client.pendingRedeemCount, 0);
});

test("every persisted maximum-count store is restart-readable and oversized growth is refused", (t) => {
  const state = fixture(t);
  const vaultAddress = state.client.cfg.vaultAddress;
  for (let index = 0; index < MAX_DEAD_LETTER_ENTRIES; index += 1) {
    const cycle = String(index + 1);
    const entry = deadLetterEntry(vaultAddress, String(index + 1), {
      cycle,
      signature: "s",
    });
    state.client.deadLetters.set(entry.key, entry);
  }

  state.client.persistDeadLetters();
  const persisted = readFileSync(state.deadLetterStorePath, "utf8");
  assert.ok(Buffer.byteLength(persisted, "utf8") <= MAX_DEAD_LETTER_FILE_BYTES);
  assert.equal(
    parseDeadLetterStore(persisted).entries.length,
    MAX_DEAD_LETTER_ENTRIES
  );

  state.client.deadLetters.clear();
  for (let index = 0; index < MAX_DEAD_LETTER_ENTRIES; index += 1) {
    const entry = deadLetterEntry(vaultAddress, MAX_UINT256.toString(), {
      cycle: String(index + 1),
      signature: "é".repeat(1024),
    });
    state.client.deadLetters.set(entry.key, entry);
  }
  assert.throws(
    () => state.client.persistDeadLetters(),
    /exceeds the 16 MiB recovery limit/
  );
  assert.equal(
    parseDeadLetterStore(readFileSync(state.deadLetterStorePath, "utf8")).entries
      .length,
    MAX_DEAD_LETTER_ENTRIES
  );
});

test("count and byte capacity failures preserve terminal fences across restart", async (t) => {
  for (const capacity of ["entry-count", "file-bytes"]) {
    const state = fixture(t);
    const shared = {
      pendingStorePath: state.pendingStorePath,
      deadLetterStorePath: state.deadLetterStorePath,
    };
    const vaultAddress = state.client.cfg.vaultAddress;
    let entries;
    if (capacity === "entry-count") {
      entries = Array.from({ length: MAX_DEAD_LETTER_ENTRIES }, (_, index) =>
        deadLetterEntry(vaultAddress, String(index + 1), {
          cycle: String(index + 1),
          signature: "s",
        })
      );
    } else {
      entries = Array.from({ length: 8_000 }, (_, index) =>
        deadLetterEntry(vaultAddress, String(index + 1), {
          cycle: String(index + 1),
          signature: "é".repeat(800),
        })
      );
      let raw = JSON.stringify({ version: 1, entries });
      let paddingCharacters = Math.floor(
        (MAX_DEAD_LETTER_FILE_BYTES - Buffer.byteLength(raw, "utf8") - 128) / 2
      );
      for (const entry of entries) {
        if (paddingCharacters <= 0) break;
        const added = Math.min(1024 - entry.signature.length, paddingCharacters);
        entry.signature += "é".repeat(added);
        paddingCharacters -= added;
      }
    }
    const originalStore = serializeDeadLetterStore({ version: 1, entries });
    if (capacity === "file-bytes") {
      const remaining = MAX_DEAD_LETTER_FILE_BYTES - Buffer.byteLength(originalStore, "utf8");
      assert.ok(remaining >= 0 && remaining < 512, `unexpected byte headroom: ${remaining}`);
      const exactCandidate = deadLetterEntry(vaultAddress, "1000", {
        operator: OPERATOR_B,
        signature: "0xsigned",
      });
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ version: 1, entries: [...entries, exactCandidate] }),
          "utf8"
        ) > MAX_DEAD_LETTER_FILE_BYTES
      );
    }
    writeFileSync(state.deadLetterStorePath, originalStore);

    let requests = 0;
    state.client.postRedeem = async () => {
      requests += 1;
      return {
        status: "rejected",
        reason: "invalid-request",
        error: "terminal capacity fixture",
      };
    };
    queue(state.client, OPERATOR_B);
    await state.client.flushRedeems();

    assert.equal(requests, 1);
    assert.equal(state.client.pendingRedeemCount, 1);
    assert.equal(readFileSync(state.deadLetterStorePath, "utf8"), originalStore);
    assert.equal(
      JSON.parse(readFileSync(state.pendingStorePath, "utf8"))[0].terminalReason,
      "invalid-request"
    );

    await state.client.closeRedeemEvidenceStore();
    let replayed = 0;
    const restarted = fixture(t, shared);
    restarted.client.postRedeem = async () => {
      replayed += 1;
      throw new Error("capacity-fenced terminal evidence must not replay");
    };
    await restarted.client.resumePendingRedeems();
    await restarted.client.flushRedeems();

    assert.equal(replayed, 0);
    assert.equal(restarted.client.pendingRedeemCount, 1);
    assert.equal(readFileSync(state.deadLetterStorePath, "utf8"), originalStore);
    assert.equal(
      JSON.parse(readFileSync(state.pendingStorePath, "utf8"))[0].terminalReason,
      "invalid-request"
    );
    await restarted.client.closeRedeemEvidenceStore();
  }
});

test("dead-letter numeric domains accept maxima and reject uint overflow", (t) => {
  const state = fixture(t);
  const vaultAddress = state.client.cfg.vaultAddress;
  const maximum = deadLetterEntry(vaultAddress, MAX_UINT256.toString(), {
    cycle: MAX_UINT64.toString(),
  });
  const maximumStore = { version: 1, entries: [maximum] };

  assert.equal(
    parseDeadLetterStore(JSON.stringify(maximumStore)).entries[0].cumulative,
    MAX_UINT256.toString()
  );
  assert.equal(
    parseDeadLetterStore(serializeDeadLetterStore(maximumStore)).entries[0].cycle,
    MAX_UINT64.toString()
  );

  const cumulativeOverflow = {
    version: 1,
    entries: [
      deadLetterEntry(vaultAddress, (MAX_UINT256 + 1n).toString()),
    ],
  };
  assert.throws(
    () => parseDeadLetterStore(JSON.stringify(cumulativeOverflow)),
    /invalid dead-letter entry/
  );
  assert.throws(
    () => serializeDeadLetterStore(cumulativeOverflow),
    /invalid dead-letter entry/
  );

  const cycleOverflow = {
    version: 1,
    entries: [
      deadLetterEntry(vaultAddress, "1", {
        cycle: (MAX_UINT64 + 1n).toString(),
      }),
    ],
  };
  assert.throws(
    () => parseDeadLetterStore(JSON.stringify(cycleOverflow)),
    /invalid dead-letter entry/
  );
  assert.throws(
    () => serializeDeadLetterStore(cycleOverflow),
    /invalid dead-letter entry/
  );
});

test("overflow dead-letter state cannot suppress valid active evidence on restart", async (t) => {
  const state = fixture(t);
  writeRestartEvidence(state, (MAX_UINT256 + 1n).toString(), "1000");
  const activeBefore = readFileSync(state.pendingStorePath, "utf8");
  let replayed = 0;
  state.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("corrupt terminal state must fence replay");
  };

  await state.client.resumePendingRedeems();
  await state.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(readFileSync(state.pendingStorePath, "utf8"), activeBefore);
  assert.match(state.logs.join("\n"), /dead-letter file is invalid/);
});

test("corrupt dead-letter state fails closed before pending replay", async (t) => {
  const state = fixture(t);
  writeFileSync(
    state.pendingStorePath,
    JSON.stringify([
      {
        key: "recomputed",
        chainId: 8453,
        consumer: CONSUMER,
        operator: OPERATOR_A,
        cumulative: "1000",
        signature: "0xsigned",
        cycle: "1",
      },
    ])
  );
  writeFileSync(state.deadLetterStorePath, '{"version":1,"entries":[');
  let replayed = 0;
  state.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("must not replay");
  };

  await state.client.resumePendingRedeems();
  await state.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.match(state.logs.join("\n"), /dead-letter file is invalid/);
  assert.equal(JSON.parse(readFileSync(state.pendingStorePath, "utf8")).length, 1);
});

test("corrupt dead-letter state fails closed before recording new work", async (t) => {
  const state = fixture(t);
  writeFileSync(state.deadLetterStorePath, '{"version":1,"entries":[');
  let signatures = 0;
  let receiptPushes = 0;
  let redeems = 0;
  state.client.signReceipt = async () => {
    signatures += 1;
    return "0xsigned";
  };
  state.client.pushReceipt = async () => {
    receiptPushes += 1;
    return false;
  };
  state.client.postRedeem = async () => {
    redeems += 1;
    throw new Error("corrupt terminal state must fence new work");
  };

  queue(state.client);
  await state.client.flushRedeems();

  assert.equal(signatures, 0);
  assert.equal(receiptPushes, 0);
  assert.equal(redeems, 0);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.throws(() => readFileSync(state.pendingStorePath, "utf8"), {
    code: "ENOENT",
  });
  assert.match(state.logs.join("\n"), /dead-letter file is invalid/);
});

test("an invalid active terminal fence fails closed without rewriting or replay", async (t) => {
  const state = fixture(t);
  const raw = JSON.stringify([
    {
      key: "recomputed",
      vaultAddress: state.client.cfg.vaultAddress,
      chainId: 8453,
      consumer: CONSUMER,
      operator: OPERATOR_A,
      cumulative: "1000",
      signature: "0xsigned",
      cycle: "1",
      terminalReason: "unknown-terminal-reason",
    },
  ]);
  writeFileSync(state.pendingStorePath, raw);
  let replayed = 0;
  state.client.postRedeem = async () => {
    replayed += 1;
    throw new Error("invalid terminal fence must not replay");
  };

  await state.client.resumePendingRedeems();
  await state.client.flushRedeems();

  assert.equal(replayed, 0);
  assert.equal(state.client.pendingRedeemCount, 0);
  assert.equal(readFileSync(state.pendingStorePath, "utf8"), raw);
  assert.match(state.logs.join("\n"), /invalid terminal fence/);
});
