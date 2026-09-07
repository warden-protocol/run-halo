const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { Wallet } = require("ethers");
const { RECEIPT_TYPES, VAULT_ADDRESS, vaultDomain } = require("@halo/vault-core");
const { HaloVaultClient } = require("../dist/vault");

const operator = "0x2222222222222222222222222222222222222222";
const keyEpoch = 7n;
const cycle = 3n;
const cumulative = 1_000n;

async function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "halo-key-epoch-"));
  const pendingStorePath = path.join(directory, "pending.json");
  const owner = new Wallet(`0x${"6".repeat(64)}`);
  const session = new Wallet(`0x${"7".repeat(64)}`);
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "temporarily unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = new HaloVaultClient(
    owner,
    {
      facilitatorUrl: `http://127.0.0.1:${address.port}`,
      rpcUrl: "http://127.0.0.1:1",
      chainId: 8453,
      vaultAddress: VAULT_ADDRESS,
      pendingStorePath,
    },
    session
  );
  client.readOps = async () => {
    throw new Error("canonical ops unavailable in fixture");
  };
  t.after(async () => {
    await client.closeRedeemEvidenceStore().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  return { client, owner, session, pendingStorePath, requests: () => requests };
}

async function legacyEntry(owner, session) {
  const signature = await session.signTypedData(
    vaultDomain(8453, VAULT_ADDRESS),
    RECEIPT_TYPES,
    {
      consumer: owner.address,
      operator,
      cumulative,
      keyEpoch,
      cycle,
    }
  );
  return {
    key: "legacy-key",
    vaultAddress: VAULT_ADDRESS,
    chainId: 8453,
    consumer: owner.address,
    operator,
    cumulative: cumulative.toString(),
    signature,
    cycle: cycle.toString(),
  };
}

test("strict recovery atomically upgrades a valid legacy receipt with authoritative keyEpoch", async (t) => {
  const state = await fixture(t);
  const entry = await legacyEntry(state.owner, state.session);
  delete entry.vaultAddress;
  delete entry.chainId;
  delete entry.consumer;
  writeFileSync(
    state.pendingStorePath,
    JSON.stringify([entry]),
    { mode: 0o600 }
  );
  await state.client.resumePendingRedeems({
    keyEpoch,
    sessionAddress: state.session.address,
    strict: true,
  });
  const [persisted] = JSON.parse(readFileSync(state.pendingStorePath, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.keyEpoch, "7");
  assert.equal(persisted.consumer, state.owner.address.toLowerCase());
  assert.ok(state.requests() >= 1);
});

test("strict recovery rejects a stale key epoch before facilitator dispatch", async (t) => {
  const state = await fixture(t);
  const entry = { ...(await legacyEntry(state.owner, state.session)), version: 1, keyEpoch: "6" };
  writeFileSync(state.pendingStorePath, JSON.stringify([entry]), { mode: 0o600 });
  await assert.rejects(
    state.client.resumePendingRedeems({
      keyEpoch,
      sessionAddress: state.session.address,
      strict: true,
    }),
    /another key epoch/
  );
  assert.equal(state.requests(), 0);
  assert.deepEqual(JSON.parse(readFileSync(state.pendingStorePath, "utf8")), [entry]);
});

test("strict recovery rejects future schemas without replay", async (t) => {
  const state = await fixture(t);
  const entry = await legacyEntry(state.owner, state.session);
  writeFileSync(
    state.pendingStorePath,
    JSON.stringify([{ ...entry, version: 2, keyEpoch: "7" }]),
    { mode: 0o600 }
  );
  await assert.rejects(
    state.client.resumePendingRedeems({
      keyEpoch,
      sessionAddress: state.session.address,
      strict: true,
    }),
    /unsupported version/
  );
  assert.equal(state.requests(), 0);
});

test("strict recovery rejects a foreign signature without replay", async (t) => {
  const state = await fixture(t);
  const entry = await legacyEntry(state.owner, state.session);
  const foreignSession = new Wallet(`0x${"8".repeat(64)}`);
  entry.signature = await foreignSession.signTypedData(
    vaultDomain(8453, VAULT_ADDRESS),
    RECEIPT_TYPES,
    {
      consumer: state.owner.address,
      operator,
      cumulative,
      keyEpoch,
      cycle,
    }
  );
  const versioned = { ...entry, version: 1, keyEpoch: "7" };
  writeFileSync(state.pendingStorePath, JSON.stringify([versioned]), { mode: 0o600 });
  await assert.rejects(
    state.client.resumePendingRedeems({
      keyEpoch,
      sessionAddress: state.session.address,
      strict: true,
    }),
    /does not match the active session key/
  );
  assert.equal(state.requests(), 0);
  assert.deepEqual(JSON.parse(readFileSync(state.pendingStorePath, "utf8")), [versioned]);
});

test("strict recovery rejects foreign scope without replay", async (t) => {
  const state = await fixture(t);
  const entry = await legacyEntry(state.owner, state.session);
  const foreign = {
    ...entry,
    version: 1,
    keyEpoch: "7",
    vaultAddress: "0x1111111111111111111111111111111111111111",
  };
  writeFileSync(state.pendingStorePath, JSON.stringify([foreign]), { mode: 0o600 });
  await assert.rejects(
    state.client.resumePendingRedeems({
      keyEpoch,
      sessionAddress: state.session.address,
      strict: true,
    }),
    /another scope/
  );
  assert.equal(state.requests(), 0);
});

test("strict recovery rejects an impossible epoch without replay", async (t) => {
  const state = await fixture(t);
  const entry = await legacyEntry(state.owner, state.session);
  const impossible = {
    ...entry,
    version: 1,
    keyEpoch: (2n ** 256n).toString(),
  };
  writeFileSync(state.pendingStorePath, JSON.stringify([impossible]), { mode: 0o600 });
  await assert.rejects(
    state.client.resumePendingRedeems({
      keyEpoch,
      sessionAddress: state.session.address,
      strict: true,
    }),
    /key epoch is invalid/
  );
  assert.equal(state.requests(), 0);
});

test("strict recovery leaves corrupt state unchanged and performs no replay", async (t) => {
  const state = await fixture(t);
  writeFileSync(state.pendingStorePath, "{not-json", { mode: 0o600 });
  await assert.rejects(
    state.client.resumePendingRedeems({
      keyEpoch,
      sessionAddress: state.session.address,
      strict: true,
    }),
    /file is corrupt/
  );
  assert.equal(readFileSync(state.pendingStorePath, "utf8"), "{not-json");
  assert.equal(state.requests(), 0);
});
