const assert = require("node:assert/strict");
const { test } = require("node:test");
const core = require("../dist/cjs/index.js");

const base = Object.freeze({
  eventVersion: 2,
  id: "evt_01J_TEST",
  operator: "0x1111111111111111111111111111111111111111",
  consumer: "0x2222222222222222222222222222222222222222",
  model: "openai/test",
  tokens: 17,
  amountUsdc: "25",
  durationMs: 42,
  timestamp: "2027-01-15T08:00:00.000Z",
  txHash: null,
  mode: "vault",
  vaultCycle: 7,
  cumulativeCheckpoint: "100",
  signature: `0x${"ab".repeat(65)}`,
});

test("signed vault event v2 has one golden canonical representation", () => {
  const parsed = core.validateVaultEventV2(base);
  assert.equal(parsed.ok, true);
  assert.equal(
    core.canonicalVaultEventMessage(base),
    'halo-vault-event-v2:[2,"evt_01J_TEST","0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222","openai/test",17,"25",42,"2027-01-15T08:00:00.000Z",null,"vault",7,"100"]'
  );
});

test("canonical signing binds every immutable vault event field", () => {
  const mutations = {
    eventVersion: 3,
    id: "evt_other",
    operator: "0x3333333333333333333333333333333333333333",
    consumer: "0x4444444444444444444444444444444444444444",
    model: null,
    tokens: 18,
    amountUsdc: "26",
    durationMs: 43,
    timestamp: "2027-01-15T08:00:00.001Z",
    txHash: `0x${"00".repeat(32)}`,
    mode: "budget",
    vaultCycle: 8,
    cumulativeCheckpoint: "101",
  };
  const canonical = core.canonicalVaultEventMessage(base);
  for (const [field, value] of Object.entries(mutations)) {
    const changed = { ...base, [field]: value };
    if (["eventVersion", "txHash", "mode"].includes(field)) {
      assert.throws(() => core.canonicalVaultEventMessage(changed), /invalid vault event v2/, field);
    } else {
      assert.notEqual(core.canonicalVaultEventMessage(changed), canonical, field);
    }
  }
});

test("vault event v2 shares exact amount, checkpoint, and numeric boundaries", () => {
  for (const value of [
    { ...base, amountUsdc: "1", cumulativeCheckpoint: "1" },
    {
      ...base,
      amountUsdc: core.MAX_VAULT_EVENT_AMOUNT_BASE.toString(),
      cumulativeCheckpoint: core.MAX_VAULT_EVENT_CHECKPOINT_BASE.toString(),
      tokens: core.MAX_VAULT_EVENT_TOKENS,
      durationMs: core.MAX_VAULT_EVENT_DURATION_MS,
    },
  ]) {
    assert.equal(core.validateVaultEventV2(value).ok, true);
  }

  const invalid = [
    ["invalid_event_schema", { unexpected: true }],
    ["invalid_event_id", { id: "bad id" }],
    ["invalid_event_id", { id: "x".repeat(core.MAX_VAULT_EVENT_ID_BYTES + 1) }],
    ["invalid_model", { model: "bad\nmodel" }],
    ["invalid_tokens", { tokens: -1 }],
    ["invalid_tokens", { tokens: core.MAX_VAULT_EVENT_TOKENS + 1 }],
    ["invalid_amount", { amountUsdc: "0" }],
    ["invalid_amount", { amountUsdc: "01" }],
    ["invalid_amount", { amountUsdc: (core.MAX_VAULT_EVENT_AMOUNT_BASE + 1n).toString() }],
    [
      "invalid_checkpoint",
      { cumulativeCheckpoint: (core.MAX_VAULT_EVENT_CHECKPOINT_BASE + 1n).toString() },
    ],
    ["invalid_duration", { durationMs: core.MAX_VAULT_EVENT_DURATION_MS + 1 }],
    ["invalid_timestamp", { timestamp: "2027-01-15T08:00:00Z" }],
    ["invalid_timestamp", { timestamp: "+275760-09-13T00:00:00.001Z" }],
    ["invalid_vault_cycle", { vaultCycle: 0 }],
    ["invalid_vault_cycle", { vaultCycle: "1" }],
    ["invalid_vault_cycle", { vaultCycle: core.MAX_VAULT_EVENT_CYCLE + 1 }],
    ["invalid_checkpoint", { cumulativeCheckpoint: "24" }],
    ["invalid_checkpoint", { cumulativeCheckpoint: "01" }],
    ["invalid_signature", { signature: "0xshort" }],
  ];
  for (const [errorCode, patch] of invalid) {
    assert.deepEqual(core.validateVaultEventV2({ ...base, ...patch }), { ok: false, errorCode });
  }
});
