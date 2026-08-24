import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
  VAULT_SSE_REPLAY_RECEIPT_TYPES,
  vaultSseReplayDomain,
  vaultSseReplayReceiptValue,
  type VaultSseReplayPair,
  type VaultSseReplayReceiptDelivery,
} from "@halo/vault-core";
import {
  commitOperatorVaultReplayReceipt,
  OperatorVaultReplayError,
  OperatorVaultReplayStore,
  validateReplayReceiptCheckpoint,
  type OperatorVaultReplayState,
} from "./vaultSseReplay";

const consumer = new Wallet(
  "0x8b3a350cf5c34c9194ca3a545d8b23a5c09490d05716d6013b6a2f72d7bcf343"
);
const operator = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const vault = "0x1111111111111111111111111111111111111111";
const pair: VaultSseReplayPair = {
  chainId: "8453",
  vault,
  consumer: consumer.address.toLowerCase(),
  operator: operator.address.toLowerCase(),
  cycle: "7",
  keyEpoch: "2",
};
const requestDigest =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function store() {
  return new OperatorVaultReplayStore({
    chainId: "8453",
    vault,
    operator: operator.address,
  });
}

function beginInput(
  requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  pairValue: VaultSseReplayPair = pair
) {
  return { requestId, pair: pairValue, requestDigest };
}

async function deliveryFor(
  state: OperatorVaultReplayState,
  overrides: Partial<Omit<VaultSseReplayReceiptDelivery, "signature">> = {}
): Promise<VaultSseReplayReceiptDelivery> {
  const unsigned: Omit<VaultSseReplayReceiptDelivery, "signature"> = {
    protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    requestId: state.requestId,
    responseDigest: state.responseDigest,
    pair: state.pair,
    priorCumulative: "100",
    targetCumulative: "105",
    receiptSignature: "0x" + "11".repeat(65),
    expiresAtMs: 20_000,
    ...overrides,
  };
  return {
    ...unsigned,
    signature: await consumer.signTypedData(
      vaultSseReplayDomain(pair.chainId, pair.vault),
      VAULT_SSE_REPLAY_RECEIPT_TYPES,
      vaultSseReplayReceiptValue(unsigned)
    ),
  };
}

test("begin is idempotent by request id and one-active-per-pair", () => {
  const states = store();
  const first = states.begin(beginInput());
  assert.equal(first.dispatch, true);
  assert.equal(states.begin(beginInput()).dispatch, false);
  assert.throws(
    () =>
      states.begin(
        beginInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      ),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError &&
      error.code === "pair_busy"
  );
  assert.throws(
    () =>
      states.begin({
        ...beginInput(),
        requestDigest:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError &&
      error.code === "duplicate_request"
  );
});

test("indexed frames and success manifest bind exact response and settlement", () => {
  const states = store();
  const input = beginInput();
  states.begin(input);
  const zero = states.appendFrame(input.requestId, "cipher-0");
  const one = states.appendFrame(input.requestId, "cipher-1");
  assert.equal(zero.index, 0);
  assert.equal(one.index, 1);
  assert.notEqual(zero.responseDigest, one.responseDigest);
  const manifest = states.completeSuccess(input.requestId, {
    ceiling: 9n,
    amount: 5n,
    tokens: 3,
    model: "test",
    durationMs: 12,
  });
  assert.equal(manifest.frameCount, 2);
  assert.equal(manifest.responseDigest, one.responseDigest);
  assert.equal(manifest.amountUsdc, "5");
  assert.throws(
    () => states.appendFrame(input.requestId, "late"),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError && error.code === "terminal"
  );
});

test("valid request-bound receipt claims before expiry and removes on ack", async () => {
  const states = store();
  const input = beginInput();
  states.begin(input);
  states.appendFrame(input.requestId, "cipher");
  states.completeSuccess(input.requestId, {
    ceiling: 9n,
    amount: 5n,
    tokens: 3,
    model: "test",
    durationMs: 12,
  });
  const state = states.get(input.requestId)!;
  const delivery = await deliveryFor(state);
  assert.equal(states.validateReceipt(delivery, 10_000, consumer.address), state);
  assert.equal(states.claimReceipt(delivery, 10_000, consumer.address).phase, "committing");
  assert.equal(states.expire(input.requestId), null);
  states.acknowledge(input.requestId);
  assert.equal(states.get(input.requestId)!.phase, "acknowledged");
  assert.equal(
    states.claimReceipt(delivery, 10_000, consumer.address).phase,
    "acknowledged"
  );
});

test("event enqueue failure releases receipt custody for an exact retry", async () => {
  const states = store();
  const input = beginInput();
  states.begin(input);
  states.appendFrame(input.requestId, "cipher");
  states.completeSuccess(input.requestId, {
    ceiling: 9n,
    amount: 5n,
    tokens: 3,
    model: "test",
    durationMs: 12,
  });
  const delivery = await deliveryFor(states.get(input.requestId)!);
  let eventAttempts = 0;
  let custodyAttempts = 0;
  const commit = () =>
    commitOperatorVaultReplayReceipt({
      store: states,
      delivery,
      nowMs: 10_000,
      expectedSessionSigner: consumer.address,
      enqueueEvent: () => {
        eventAttempts += 1;
        if (eventAttempts === 1) throw new Error("persistence failed");
      },
      recordReceipt: () => {
        custodyAttempts += 1;
        return true;
      },
      noteServed: () => {},
      settleServed: () => 105n,
      expectedCheckpoint: 105n,
    });

  assert.throws(commit, /persistence failed/);
  assert.equal(states.get(input.requestId)!.phase, "complete");
  assert.equal(custodyAttempts, 0);
  commit();
  assert.equal(states.get(input.requestId)!.phase, "acknowledged");
  assert.equal(eventAttempts, 2);
  assert.equal(custodyAttempts, 1);
});

test("receipt custody must advance the exact served checkpoint", async () => {
  const states = store();
  const input = beginInput();
  states.begin(input);
  states.appendFrame(input.requestId, "cipher");
  states.completeSuccess(input.requestId, {
    ceiling: 9n,
    amount: 5n,
    tokens: 3,
    model: "test",
    durationMs: 12,
  });
  const state = states.get(input.requestId)!;
  const delivery = await deliveryFor(state);

  assert.equal(
    validateReplayReceiptCheckpoint(state, delivery, {
      cycle: 7n,
      served: 100n,
      held: 95n,
    }),
    105n
  );
  assert.throws(
    () =>
      validateReplayReceiptCheckpoint(state, delivery, {
        cycle: 7n,
        served: 100n,
        held: 105n,
      }),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError &&
      error.code === "invalid_receipt"
  );
  assert.throws(
    () =>
      validateReplayReceiptCheckpoint(state, delivery, {
        cycle: 7n,
        served: 105n,
        held: 105n,
      }),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError &&
      error.code === "invalid_receipt"
  );
});

test("expiry wins over a late receipt and releases the pair for new work", async () => {
  const states = store();
  const input = beginInput();
  states.begin(input);
  states.appendFrame(input.requestId, "cipher");
  states.completeSuccess(input.requestId, {
    ceiling: 9n,
    amount: 5n,
    tokens: 3,
    model: null,
    durationMs: 12,
  });
  const state = states.get(input.requestId)!;
  const delivery = await deliveryFor(state);
  assert.equal(states.expire(input.requestId)!.phase, "expired");
  assert.throws(
    () => states.claimReceipt(delivery, 10_000, consumer.address),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError && error.code === "invalid_receipt"
  );
  assert.equal(
    states.begin(
      beginInput("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    ).dispatch,
    true
  );
});

test("wrong signer, amount, and pair cannot claim receipt custody", async () => {
  const states = store();
  const input = beginInput();
  states.begin(input);
  states.appendFrame(input.requestId, "cipher");
  states.completeSuccess(input.requestId, {
    ceiling: 9n,
    amount: 5n,
    tokens: 3,
    model: "test",
    durationMs: 12,
  });
  const state = states.get(input.requestId)!;
  const wrongAmount = await deliveryFor(state, { targetCumulative: "106" });
  assert.throws(
    () => states.validateReceipt(wrongAmount, 10_000, consumer.address),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError && error.code === "invalid_receipt"
  );
  const unsigned: Omit<VaultSseReplayReceiptDelivery, "signature"> = {
    ...(await deliveryFor(state)),
  };
  delete (unsigned as Partial<VaultSseReplayReceiptDelivery>).signature;
  const wrongSigner = {
    ...unsigned,
    signature: await operator.signTypedData(
      vaultSseReplayDomain(pair.chainId, pair.vault),
      VAULT_SSE_REPLAY_RECEIPT_TYPES,
      vaultSseReplayReceiptValue(unsigned)
    ),
  };
  assert.throws(
    () => states.validateReceipt(wrongSigner, 10_000, consumer.address),
    (error: unknown) =>
      error instanceof OperatorVaultReplayError && error.code === "invalid_receipt"
  );
});

test("cancel applies only before a terminal result and failures remain unserved", () => {
  const running = store();
  const first = beginInput();
  running.begin(first);
  assert.equal(running.cancel(first.requestId)!.phase, "cancelled");
  assert.equal(running.cancel(first.requestId), null);

  const failed = store();
  failed.begin(first);
  const manifest = failed.completeFailure(first.requestId);
  assert.equal(manifest.outcome, "failed-unserved");
  assert.equal(manifest.amountUsdc, "0");
  assert.equal(failed.cancel(first.requestId), null);
  assert.equal(failed.expire(first.requestId)!.phase, "expired");
});
