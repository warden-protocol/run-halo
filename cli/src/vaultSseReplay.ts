import {
  EMPTY_VAULT_SSE_REPLAY_DIGEST,
  VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
  advanceVaultSseReplayDigest,
  canonicalVaultSseReplayAddress,
  canonicalVaultSseReplayPair,
  canonicalVaultSseReplayUint,
  isCanonicalVaultSseReplayRequestId,
  recoverVaultSseReplayReceiptSigner,
  vaultSseReplayPairKey,
  type VaultSseReplayPair,
  type VaultSseReplayReceiptDelivery,
  type VaultSseReplayUnsignedManifest,
} from "@halo/vault-core";

const DIGEST = /^0x[0-9a-f]{64}$/;
export const OPERATOR_VAULT_REPLAY_MAX_FRAMES = 65_536;

export type OperatorVaultReplayPhase =
  | "running"
  | "complete"
  | "committing"
  | "acknowledged"
  | "cancelled"
  | "expired";

export interface OperatorVaultReplaySettlement {
  ceiling: bigint;
  amount: bigint;
  tokens: number;
  model: string | null;
  durationMs: number;
}

export interface OperatorVaultReplayState {
  requestId: string;
  pair: VaultSseReplayPair;
  pairKey: string;
  requestDigest: string;
  responseDigest: string;
  frameCount: number;
  phase: OperatorVaultReplayPhase;
  settlement: OperatorVaultReplaySettlement | null;
  manifest: VaultSseReplayUnsignedManifest | null;
  acceptedDelivery: VaultSseReplayReceiptDelivery | null;
}

export interface BeginOperatorVaultReplay {
  requestId: string;
  pair: VaultSseReplayPair;
  requestDigest: string;
}

export function commitOperatorVaultReplayReceipt(input: {
  store: OperatorVaultReplayStore;
  delivery: VaultSseReplayReceiptDelivery;
  nowMs: number;
  expectedSessionSigner: string;
  enqueueEvent: () => void;
  recordReceipt: () => boolean;
  noteServed: () => void;
  settleServed: () => bigint | null;
  expectedCheckpoint: bigint;
}): void {
  input.store.claimReceipt(
    input.delivery,
    input.nowMs,
    input.expectedSessionSigner
  );
  let eventEnqueued = false;
  try {
    input.enqueueEvent();
    eventEnqueued = true;
    if (!input.recordReceipt()) {
      throw new Error("replay receipt did not advance operator custody");
    }
    input.noteServed();
    if (input.settleServed() !== input.expectedCheckpoint) {
      throw new Error("replay served checkpoint changed before receipt commit");
    }
    input.store.acknowledge(input.delivery.requestId);
  } catch (error) {
    if (!eventEnqueued) {
      input.store.releaseReceiptClaim(input.delivery);
    }
    throw error;
  }
}

export function validateReplayReceiptCheckpoint(
  state: OperatorVaultReplayState,
  delivery: VaultSseReplayReceiptDelivery,
  snapshot: {
    cycle: bigint;
    served: bigint;
    held: bigint;
  }
): bigint {
  if (!state.settlement) {
    throw new OperatorVaultReplayError("invalid_receipt");
  }
  let pairCycle: bigint;
  let prior: bigint;
  let target: bigint;
  try {
    pairCycle = BigInt(state.pair.cycle);
    prior = BigInt(delivery.priorCumulative);
    target = BigInt(delivery.targetCumulative);
  } catch {
    throw new OperatorVaultReplayError("invalid_receipt");
  }
  const expectedTarget = snapshot.served + state.settlement.amount;
  if (
    snapshot.cycle !== pairCycle ||
    prior !== snapshot.served ||
    target !== expectedTarget ||
    target <= snapshot.held
  ) {
    throw new OperatorVaultReplayError("invalid_receipt");
  }
  return expectedTarget;
}

export class OperatorVaultReplayError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "duplicate_request"
      | "pair_busy"
      | "not_found"
      | "terminal"
      | "invalid_frame"
      | "invalid_receipt"
  ) {
    super(code);
  }
}

export class OperatorVaultReplayStore {
  private readonly states = new Map<string, OperatorVaultReplayState>();
  private readonly pairOwners = new Map<string, string>();

  constructor(
    private readonly expected: {
      chainId: string;
      vault: string;
      operator: string;
    }
  ) {}

  begin(input: BeginOperatorVaultReplay): {
    state: OperatorVaultReplayState;
    dispatch: boolean;
  } {
    const existing = this.states.get(input.requestId);
    if (existing) {
      if (
        existing.pairKey !== this.safePairKey(input.pair) ||
        existing.requestDigest !== input.requestDigest
      ) {
        throw new OperatorVaultReplayError("duplicate_request");
      }
      return { state: existing, dispatch: false };
    }

    const pair = canonicalVaultSseReplayPair(input.pair);
    const expectedVault = canonicalVaultSseReplayAddress(this.expected.vault);
    const expectedOperator = canonicalVaultSseReplayAddress(this.expected.operator);
    const expectedChain = canonicalVaultSseReplayUint(
      this.expected.chainId,
      64,
      false
    );
    if (
      !isCanonicalVaultSseReplayRequestId(input.requestId) ||
      !pair ||
      !expectedVault ||
      !expectedOperator ||
      !expectedChain ||
      pair.chainId !== expectedChain ||
      pair.vault !== expectedVault ||
      pair.operator !== expectedOperator ||
      !DIGEST.test(input.requestDigest)
    ) {
      throw new OperatorVaultReplayError("invalid_request");
    }

    const pairKey = vaultSseReplayPairKey(pair);
    if (this.pairOwners.has(pairKey)) {
      throw new OperatorVaultReplayError("pair_busy");
    }
    const state: OperatorVaultReplayState = {
      requestId: input.requestId,
      pair,
      pairKey,
      requestDigest: input.requestDigest,
      responseDigest: EMPTY_VAULT_SSE_REPLAY_DIGEST,
      frameCount: 0,
      phase: "running",
      settlement: null,
      manifest: null,
      acceptedDelivery: null,
    };
    this.states.set(input.requestId, state);
    this.pairOwners.set(pairKey, input.requestId);
    return { state, dispatch: true };
  }

  get(requestId: string): OperatorVaultReplayState | undefined {
    return this.states.get(requestId);
  }

  active(): OperatorVaultReplayState[] {
    return [...this.states.values()];
  }

  appendFrame(requestId: string, data: string): {
    index: number;
    responseDigest: string;
  } {
    const state = this.states.get(requestId);
    if (!state) throw new OperatorVaultReplayError("not_found");
    if (state.phase !== "running") {
      throw new OperatorVaultReplayError("terminal");
    }
    if (
      typeof data !== "string" ||
      data.length === 0 ||
      state.frameCount >= OPERATOR_VAULT_REPLAY_MAX_FRAMES
    ) {
      throw new OperatorVaultReplayError("invalid_frame");
    }
    const index = state.frameCount;
    state.responseDigest = advanceVaultSseReplayDigest(
      state.responseDigest,
      data
    );
    state.frameCount += 1;
    return { index, responseDigest: state.responseDigest };
  }

  completeSuccess(
    requestId: string,
    settlement: OperatorVaultReplaySettlement
  ): VaultSseReplayUnsignedManifest {
    const state = this.running(requestId);
    if (
      settlement.ceiling <= 0n ||
      settlement.amount <= 0n ||
      settlement.amount > settlement.ceiling ||
      !Number.isSafeInteger(settlement.tokens) ||
      settlement.tokens < 0 ||
      !Number.isSafeInteger(settlement.durationMs) ||
      settlement.durationMs < 0 ||
      state.frameCount === 0
    ) {
      throw new OperatorVaultReplayError("invalid_request");
    }
    const manifest = this.manifest(state, settlement.amount, "success");
    state.settlement = settlement;
    state.manifest = manifest;
    state.phase = "complete";
    return manifest;
  }

  completeFailure(requestId: string): VaultSseReplayUnsignedManifest {
    const state = this.running(requestId);
    const manifest = this.manifest(state, 0n, "failed-unserved");
    state.manifest = manifest;
    state.phase = "complete";
    return manifest;
  }

  validateReceipt(
    delivery: VaultSseReplayReceiptDelivery,
    nowMs: number,
    expectedSessionSigner: string
  ): OperatorVaultReplayState {
    const state = this.states.get(delivery.requestId);
    if (
      !state ||
      (state.phase !== "complete" &&
        state.phase !== "acknowledged") ||
      !state.manifest ||
      !state.settlement ||
      !Number.isSafeInteger(nowMs) ||
      delivery.expiresAtMs <= nowMs ||
      recoverVaultSseReplayReceiptSigner(delivery) !==
        canonicalVaultSseReplayAddress(expectedSessionSigner)
    ) {
      throw new OperatorVaultReplayError("invalid_receipt");
    }
    let deliveryPairKey: string;
    try {
      deliveryPairKey = vaultSseReplayPairKey(delivery.pair);
    } catch {
      throw new OperatorVaultReplayError("invalid_receipt");
    }
    if (
      deliveryPairKey !== state.pairKey ||
      delivery.responseDigest !== state.responseDigest ||
      BigInt(delivery.targetCumulative) - BigInt(delivery.priorCumulative) !==
        state.settlement.amount
    ) {
      throw new OperatorVaultReplayError("invalid_receipt");
    }
    if (
      state.phase === "acknowledged" &&
      JSON.stringify(state.acceptedDelivery) !== JSON.stringify(delivery)
    ) {
      throw new OperatorVaultReplayError("invalid_receipt");
    }
    return state;
  }

  claimReceipt(
    delivery: VaultSseReplayReceiptDelivery,
    nowMs: number,
    expectedSessionSigner: string
  ): OperatorVaultReplayState {
    const state = this.validateReceipt(delivery, nowMs, expectedSessionSigner);
    if (state.phase === "acknowledged") return state;
    state.acceptedDelivery = delivery;
    state.phase = "committing";
    return state;
  }

  acknowledge(requestId: string): void {
    const state = this.states.get(requestId);
    if (!state || state.phase !== "committing") {
      throw new OperatorVaultReplayError("terminal");
    }
    state.phase = "acknowledged";
    if (this.pairOwners.get(state.pairKey) === state.requestId) {
      this.pairOwners.delete(state.pairKey);
    }
  }

  releaseReceiptClaim(delivery: VaultSseReplayReceiptDelivery): void {
    const state = this.states.get(delivery.requestId);
    if (
      !state ||
      state.phase !== "committing" ||
      JSON.stringify(state.acceptedDelivery) !== JSON.stringify(delivery)
    ) {
      throw new OperatorVaultReplayError("invalid_receipt");
    }
    state.acceptedDelivery = null;
    state.phase = "complete";
  }

  forgetAcknowledged(requestId: string): boolean {
    const state = this.states.get(requestId);
    if (!state || state.phase !== "acknowledged") return false;
    this.states.delete(requestId);
    return true;
  }
  cancel(requestId: string): OperatorVaultReplayState | null {
    const state = this.states.get(requestId);
    if (!state || state.phase !== "running") return null;
    state.phase = "cancelled";
    this.remove(state);
    return state;
  }

  expire(requestId: string): OperatorVaultReplayState | null {
    const state = this.states.get(requestId);
    if (
      !state ||
      (state.phase !== "running" && state.phase !== "complete")
    ) {
      return null;
    }
    state.phase = "expired";
    this.remove(state);
    return state;
  }

  private running(requestId: string): OperatorVaultReplayState {
    const state = this.states.get(requestId);
    if (!state) throw new OperatorVaultReplayError("not_found");
    if (state.phase !== "running") {
      throw new OperatorVaultReplayError("terminal");
    }
    return state;
  }

  private manifest(
    state: OperatorVaultReplayState,
    amount: bigint,
    outcome: "success" | "failed-unserved"
  ): VaultSseReplayUnsignedManifest {
    return {
      protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
      requestId: state.requestId,
      requestDigest: state.requestDigest,
      responseDigest: state.responseDigest,
      vault: state.pair.vault,
      consumer: state.pair.consumer,
      operator: state.pair.operator,
      cycle: state.pair.cycle,
      keyEpoch: state.pair.keyEpoch,
      amountUsdc: amount.toString(),
      frameCount: state.frameCount,
      outcome,
    };
  }

  private safePairKey(pair: VaultSseReplayPair): string {
    try {
      return vaultSseReplayPairKey(pair);
    } catch {
      return "";
    }
  }

  private remove(state: OperatorVaultReplayState): void {
    this.states.delete(state.requestId);
    if (this.pairOwners.get(state.pairKey) === state.requestId) {
      this.pairOwners.delete(state.pairKey);
    }
  }
}
