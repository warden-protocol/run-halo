const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Wallet } = require("ethers");
const replay = require("../dist/cjs/vaultSseReplay.js");

test("result expiry is future-bounded by the protocol maximum", () => {
  const now = 1_000_000;
  assert.equal(replay.isVaultSseReplayResultExpiry(now, now), false);
  assert.equal(replay.isVaultSseReplayResultExpiry(now + 1, now), true);
  assert.equal(
    replay.isVaultSseReplayResultExpiry(
      now + replay.VAULT_SSE_REPLAY_MAX_RESULT_TTL_MS,
      now
    ),
    true
  );
  assert.equal(
    replay.isVaultSseReplayResultExpiry(
      now + replay.VAULT_SSE_REPLAY_MAX_RESULT_TTL_MS + 1,
      now
    ),
    false
  );
});

const vault = "0x0000000000000000000000000000000000000001";
const consumer = Wallet.createRandom();
const operator = Wallet.createRandom();
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = randomBytes(32).toString("base64url");
const pair = {
  chainId: "8453",
  vault,
  consumer: consumer.address,
  operator: operator.address,
  cycle: "1",
  keyEpoch: "2",
};

test("prepare parsing is exact and requires encrypted text streaming", () => {
  const requestBody = JSON.stringify({
    model: "model",
    stream: true,
    _enc: { v: 1, alg: "test" },
    maxAmountUsdc: "100",
  });
  const parsed = replay.parseVaultSseReplayPrepareRequest({
    protocol: replay.VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    path: "/v1/chat/completions",
    requestBody,
    pair,
  });
  assert.equal(parsed.requestBody, requestBody);
  assert.equal(replay.vaultSseReplayRequestChargeCeiling(requestBody), "100");
  assert.equal(parsed.pair.consumer, consumer.address.toLowerCase());
  assert.equal(
    replay.parseVaultSseReplayPrepareRequest({
      protocol: replay.VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
      path: "/v1/chat/completions",
      requestBody: JSON.stringify({ model: "model", stream: true }),
      pair,
    }),
    null
  );
  assert.equal(
    replay.vaultSseReplayRequestChargeCeiling(
      JSON.stringify({
        model: "model",
        stream: true,
        _enc: { v: 1 },
        maxAmountUsdc: "0",
      })
    ),
    null
  );
});

test("request IDs, tokens, uints, and response hash chaining are strict", () => {
  assert.equal(replay.isCanonicalVaultSseReplayRequestId(requestId), true);
  assert.equal(
    replay.isCanonicalVaultSseReplayRequestId(requestId.toUpperCase()),
    false
  );
  assert.equal(replay.isVaultSseReplayToken(token), true);
  assert.equal(replay.isVaultSseReplayToken(token + "="), false);
  assert.equal(replay.canonicalVaultSseReplayUint("01", 64), null);
  const one = replay.advanceVaultSseReplayDigest(
    replay.EMPTY_VAULT_SSE_REPLAY_DIGEST,
    "{\"frame\":1}"
  );
  const two = replay.advanceVaultSseReplayDigest(one, "{\"frame\":2}");
  assert.notEqual(one, two);
  assert.equal(two, replay.advanceVaultSseReplayDigest(one, "{\"frame\":2}"));
});

test("resume commands recover only the signing browser session", async () => {
  const unsigned = {
    protocol: replay.VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    command: "resume",
    requestId,
    resumeToken: token,
    pair,
    expiresAtMs: Date.now() + 10_000,
  };
  const signature = await consumer.signTypedData(
    replay.vaultSseReplayDomain(pair.chainId, pair.vault),
    replay.VAULT_SSE_REPLAY_COMMAND_TYPES,
    replay.vaultSseReplayCommandValue(unsigned)
  );
  const command = { ...unsigned, signature };
  assert.deepEqual(replay.parseVaultSseReplayCommand(command), {
    ...command,
    pair: {
      ...pair,
      consumer: pair.consumer.toLowerCase(),
      operator: pair.operator.toLowerCase(),
    },
  });
  assert.equal(
    replay.parseVaultSseReplayCommand({ ...command, unexpected: true }),
    null
  );
  assert.equal(
    replay.recoverVaultSseReplayCommandSigner(command),
    consumer.address.toLowerCase()
  );
  assert.notEqual(
    replay.recoverVaultSseReplayCommandSigner({
      ...command,
      requestId: "22222222-2222-4222-8222-222222222222",
    }),
    consumer.address.toLowerCase()
  );
});

test("operator manifests bind every payment and frame field", async () => {
  const frameData = "{\"ciphertext\":\"one\"}";
  const responseDigest = replay.advanceVaultSseReplayDigest(
    replay.EMPTY_VAULT_SSE_REPLAY_DIGEST,
    frameData
  );
  const unsigned = {
    protocol: replay.VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    requestId,
    requestDigest: replay.digestVaultSseReplayRequest("{}"),
    responseDigest,
    vault,
    consumer: consumer.address,
    operator: operator.address,
    cycle: "1",
    keyEpoch: "2",
    amountUsdc: "7",
    frameCount: 1,
    outcome: "success",
  };
  const signature = await operator.signTypedData(
    replay.vaultSseReplayDomain(pair.chainId, pair.vault),
    replay.VAULT_SSE_REPLAY_MANIFEST_TYPES,
    replay.vaultSseReplayManifestValue(unsigned)
  );
  assert.equal(
    replay.recoverVaultSseReplayManifestSigner(
      { ...unsigned, signature },
      pair.chainId
    ),
    operator.address.toLowerCase()
  );
  assert.ok(replay.parseVaultSseReplayManifest({ ...unsigned, signature }));
  assert.equal(
    replay.parseVaultSseReplayManifest({ ...unsigned, signature, extra: 1 }),
    null
  );
  assert.throws(() =>
    replay.vaultSseReplayManifestValue({ ...unsigned, amountUsdc: "0" })
  );
});

test("request-bound receipt delivery preserves the contract receipt", async () => {
  const receiptSignature = await consumer.signMessage("synthetic receipt");
  const unsigned = {
    protocol: replay.VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    requestId,
    responseDigest: replay.EMPTY_VAULT_SSE_REPLAY_DIGEST,
    pair,
    priorCumulative: "5",
    targetCumulative: "12",
    receiptSignature,
    expiresAtMs: Date.now() + 10_000,
  };
  const signature = await consumer.signTypedData(
    replay.vaultSseReplayDomain(pair.chainId, pair.vault),
    replay.VAULT_SSE_REPLAY_RECEIPT_TYPES,
    replay.vaultSseReplayReceiptValue(unsigned)
  );
  assert.equal(
    replay.recoverVaultSseReplayReceiptSigner({ ...unsigned, signature }),
    consumer.address.toLowerCase()
  );
  assert.ok(
    replay.parseVaultSseReplayReceiptDelivery({ ...unsigned, signature })
  );
  assert.equal(
    replay.parseVaultSseReplayReceiptDelivery({
      ...unsigned,
      signature,
      extra: true,
    }),
    null
  );
  assert.throws(() =>
    replay.vaultSseReplayReceiptValue({
      ...unsigned,
      targetCumulative: unsigned.priorCumulative,
    })
  );
});
