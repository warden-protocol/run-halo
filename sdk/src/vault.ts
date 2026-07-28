import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  Signer,
  getAddress,
  isAddress,
  parseUnits,
} from "ethers";
import { readFileSync } from "node:fs";
import {
  ERC20_ABI,
  MAX_VAULT_RESERVATION_ATTEMPTS,
  RECEIPT_TYPES,
  RESERVE_TYPES,
  VAULT_ABI,
  VAULT_ADDRESS,
  advanceCumulativeReceipt,
  classifyRedeemError,
  classifyReservationRevival,
  classifySessionKey,
  computeReserveAmount,
  estimateReservationTokens,
  formatUsdcBase,
  meterVaultResponse,
  parseVaultRedeemResponse,
  priceTokens,
  requiredVaultReservationBase,
  selectVaultOperatorFromList,
  vaultRedeemDisposition,
  vaultDomain,
  withReservationMargin,
  type OpsState,
  type SessionKeyStatus,
  type VaultRedeemRequest,
  type VaultRedeemResponse,
  type VaultState,
} from "@halo/vault-core";
import { getChain } from "./chains";
import {
  INTERNAL_CLI_VERSION_PROVIDER,
  SDK_CLI_VERSION,
  cliVersionHeader,
  type InternalVersionConfig,
  type VersionHeaderProvider,
  type VersionHeaderTarget,
} from "./versionHeader";
import {
  MAX_DEAD_LETTER_ENTRIES,
  acquireRedeemEvidenceOwnership,
  parseDeadLetterStore,
  resolveRedeemEvidencePath,
  serializeDeadLetterStore,
  writeDurableFile,
  writeDurableJson,
  type PersistedDeadLetterRedeem,
  type PersistedDeadLetterStore,
  type RedeemEvidenceOwnership,
  type RedeemTerminalReason,
} from "./redeemEvidenceStore";

export {
  VAULT_ADDRESS,
  classifyRedeemError,
  classifySessionKey,
  completionCeilingTokens,
  computeReserveAmount,
  estimateRequestPromptTokens,
  estimateReservationTokens,
  estimateTokens,
  isReasoningModel,
  parseVaultSettlement,
  priceTokens,
  reportedUsageTokens,
  requiredVaultReservationBase,
  usageTokensFromSseBody,
} from "@halo/vault-core";
export type {
  OpsState,
  ParsedVaultSettlement,
  SessionKeyStatus,
  VaultState,
} from "@halo/vault-core";

const USDC_DECIMALS = 6;

const READ_TIMEOUT_MS = 8_000;
const REDEEM_RETRY_INTERVAL_MS = 20_000;
const RELEASE_RETRY_COOLDOWN_MS = 60_000;
const MAX_RELEASE_ATTEMPTS = 3;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return withAbort(Promise.race([promise, timeout]), signal).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function signalWithTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}


export interface VaultConfig {
  facilitatorUrl: string;
  rpcUrl: string;
  chainId: number;
  /** HaloVault address. Defaults to the repository consensus deployment. */
  vaultAddress?: string;
  /** Optional relay URL for best-effort operator receipt delivery. */
  relayUrl?: string;
  /** Reservation lifetime (s). Default 3600. */
  reserveTtlSec?: number;
  /** Reserve this many estimated-requests worth at once (batch). Default 5. */
  reserveMultiple?: bigint;
  /** Approximate free-liquidity slices to preserve. Default 8. */
  reserveLiquiditySlots?: bigint;
  /** Auto-top-up target in USD. Zero or unset disables auto-deposit. */
  autoTopUpUsd?: number;
  /**
   * Node-only pending store. When deadLetterStorePath is omitted, a paired
   * `${pendingStorePath}.dead-letter` target is derived. .lock and
   * .lock.recovery suffixes are case-insensitively reserved.
   */
  pendingStorePath?: string;
  /** Node-only terminal store. .lock and .lock.recovery suffixes are case-insensitively reserved. */
  deadLetterStorePath?: string;
  /** Programmatic notification after a redeem becomes terminal. */
  onTerminalRedeem?: (error: VaultRedeemTerminalError) => void;
  /** Optional diagnostic sink. Defaults to no-op. */
  log?: (msg: string) => void;
}

export type VaultRedeemTerminalReason = RedeemTerminalReason;

/** Safe programmatic signal for a receipt that automatic redeem must not retry. */
export class VaultRedeemTerminalError extends Error {
  readonly reason: VaultRedeemTerminalReason;
  readonly retryable = false;

  constructor(reason: VaultRedeemTerminalReason) {
    super(
      reason === "cli-outdated"
        ? "Halo client compatibility is outdated"
        : "Vault redeem request was structurally rejected"
    );
    this.name = "VaultRedeemTerminalError";
    this.reason = reason;
  }
}

function fmtUsd(base: bigint): string {
  return formatUsdcBase(base);
}
function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

interface PersistedPendingRedeem {
  key: string;
  vaultAddress?: string;
  chainId?: number;
  consumer?: string;
  operator: string;
  cumulative: string;
  signature: string;
  cycle: string;
  terminalReason?: VaultRedeemTerminalReason;
}

interface PendingRedeem {
  operator: string;
  consumer: string;
  cumulative: bigint;
  signature: string;
  cycle: bigint;
  inFlight: boolean;
  terminalError?: VaultRedeemTerminalError;
}

function samePendingRedeemReceipt(
  left: PendingRedeem,
  right: PendingRedeem
): boolean {
  return (
    left.operator === right.operator &&
    left.consumer === right.consumer &&
    left.cumulative === right.cumulative &&
    left.signature === right.signature &&
    left.cycle === right.cycle
  );
}

function isVaultRedeemTerminalReason(
  value: unknown
): value is VaultRedeemTerminalReason {
  return value === "cli-outdated" || value === "invalid-request";
}

/** Stateful vault client; reuse it to serialize reservations and retain receipts. */
export class HaloVaultClient {
  private readonly signer: Signer;
  // Must match the consumer's registered on-chain session key.
  private readonly sessionSigner: Signer;
  private readonly cfg: Required<
    Omit<VaultConfig, "log" | "onTerminalRedeem">
  > & {
    log: (m: string) => void;
    onTerminalRedeem: (error: VaultRedeemTerminalError) => void;
  };
  private readonly provider: JsonRpcProvider;
  private readonly vault: Contract;
  private readonly versionHeaderProvider: VersionHeaderProvider;
  private readonly cumulative = new Map<string, bigint>();
  // Prevent stale concurrent snapshots from lowering a cycle's receipt ceiling.
  private readonly ceilingByKey = new Map<string, bigint>();
  private ensureQueue: Promise<unknown> = Promise.resolve();
  private redeemQueue: Promise<void> = Promise.resolve();
  private readonly pendingRedeems = new Map<string, PendingRedeem>();
  private readonly activeRedeemAttempts = new Set<Promise<void>>();
  // Entries signed for another configured vault stay on disk but are never
  // loaded into this client's retry queue.
  private readonly preservedForeignPending: PersistedPendingRedeem[] = [];
  private readonly deadLetters = new Map<string, PersistedDeadLetterRedeem>();
  private readonly terminalReasons = new Map<string, VaultRedeemTerminalReason>();
  private deadLettersLoaded = false;
  private deadLetterStoreReadable = true;
  private deadLetterPersistenceFault: Error | null = null;
  private redeemEvidenceOwnership: RedeemEvidenceOwnership | null = null;
  private redeemEvidenceClosing = false;
  private redeemEvidenceClosed = false;
  private redeemEvidenceClosePromise: Promise<void> | null = null;
  private redeemRetryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reservedOperators = new Set<string>();
  private readonly releaseAttempts = new Map<
    string,
    {
      operator: string;
      cycle: bigint;
      attempts: number;
      lastAttemptAt: number;
      terminal: boolean;
    }
  >();
  private redeemGraceCache: bigint | null = null;
  private maxReserveTtlCache: bigint | null = null;
  private readonly autoTopUpBase: bigint;
  private addr: string | undefined;
  private sessionAddr: string | undefined;

  constructor(signer: Signer, cfg: VaultConfig, sessionSigner?: Signer) {
    this.signer = signer;
    this.sessionSigner = sessionSigner ?? signer;
    getChain(cfg.chainId);
    const vaultAddress =
      cfg.vaultAddress === undefined ? VAULT_ADDRESS : cfg.vaultAddress.trim();
    if (!isAddress(vaultAddress)) {
      throw new Error(
        `invalid vaultAddress ${JSON.stringify(vaultAddress)} (must be a 20-byte 0x hex address)`
      );
    }
    const pendingStorePath = cfg.pendingStorePath
      ? resolveRedeemEvidencePath(cfg.pendingStorePath)
      : "";
    const deadLetterStorePath = cfg.deadLetterStorePath
      ? resolveRedeemEvidencePath(cfg.deadLetterStorePath)
      : pendingStorePath
        ? resolveRedeemEvidencePath(`${pendingStorePath}.dead-letter`)
        : "";
    this.cfg = {
      ...cfg,
      vaultAddress: getAddress(vaultAddress),
      relayUrl: cfg.relayUrl ?? "",
      reserveTtlSec: cfg.reserveTtlSec ?? 3600,
      reserveMultiple: cfg.reserveMultiple ?? 5n,
      reserveLiquiditySlots:
        cfg.reserveLiquiditySlots && cfg.reserveLiquiditySlots > 0n
          ? cfg.reserveLiquiditySlots
          : 8n,
      autoTopUpUsd: cfg.autoTopUpUsd ?? 0,
      pendingStorePath,
      deadLetterStorePath,
      log: cfg.log ?? (() => {}),
      onTerminalRedeem: cfg.onTerminalRedeem ?? (() => {}),
    };
    this.autoTopUpBase = BigInt(Math.round((cfg.autoTopUpUsd ?? 0) * 1_000_000));
    this.versionHeaderProvider =
      (cfg as VaultConfig & InternalVersionConfig)[INTERNAL_CLI_VERSION_PROVIDER] ??
      (() => SDK_CLI_VERSION);
    this.provider = new JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
    this.vault = new Contract(this.cfg.vaultAddress, VAULT_ABI, this.provider);
    if (this.cfg.pendingStorePath || this.cfg.deadLetterStorePath) {
      this.redeemEvidenceOwnership = acquireRedeemEvidenceOwnership([
        this.cfg.pendingStorePath,
        this.cfg.deadLetterStorePath,
      ]);
    }
  }

  /** Memoized consumer address used by the vault's balance and key mappings. */
  async consumer(): Promise<string> {
    if (!this.addr) this.addr = await this.signer.getAddress();
    return this.addr;
  }

  /** Memoized address that signs reservations and receipts. */
  async sessionAddress(): Promise<string> {
    if (!this.sessionAddr) this.sessionAddr = await this.sessionSigner.getAddress();
    return this.sessionAddr;
  }

  private facBase(): string {
    return this.cfg.facilitatorUrl.replace(/\/+$/, "");
  }

  private protocolHeaders(target: VersionHeaderTarget): Record<string, string> {
    return cliVersionHeader(this.versionHeaderProvider(target));
  }

  private async cycleKey(
    operator: string,
    cycle: bigint,
    knownConsumer?: string
  ): Promise<string> {
    const consumer = getAddress(knownConsumer ?? (await this.consumer())).toLowerCase();
    return JSON.stringify([
      this.cfg.chainId,
      this.cfg.vaultAddress.toLowerCase(),
      consumer,
      getAddress(operator).toLowerCase(),
      cycle.toString(),
    ]);
  }

  async readVaultState(signal?: AbortSignal): Promise<VaultState> {
    throwIfAborted(signal);
    const consumer = await withAbort(this.consumer(), signal);
    try {
      const identity = await fetch(`${this.facBase()}/vault/info`, {
        signal: signalWithTimeout(signal, 6000),
      });
      const identityBody = identity.ok
        ? ((await identity.json()) as { vault?: unknown })
        : null;
      if (
        !identityBody ||
        typeof identityBody.vault !== "string" ||
        !isAddress(identityBody.vault) ||
        getAddress(identityBody.vault) !== this.cfg.vaultAddress
      ) {
        throw new Error("facilitator vault identity does not match the selected vault");
      }
      const res = await fetch(`${this.facBase()}/vault/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ consumer }),
        signal: signalWithTimeout(signal, 6000),
      });
      if (res.ok) {
        const s = (await res.json()) as Record<string, string>;
        // Missing key data must fall back on-chain rather than appear unregistered.
        if (isAddress(s.sessionKey)) {
          return {
            balance: BigInt(s.balance ?? "0"),
            lockedTotal: BigInt(s.lockedTotal ?? "0"),
            withdrawable: BigInt(s.withdrawable ?? "0"),
            sessionKey: s.sessionKey,
            reserveNonce: BigInt(s.reserveNonce ?? "0"),
            keyEpoch: BigInt(s.keyEpoch ?? "0"),
          };
        }
      }
    } catch {
      throwIfAborted(signal);
    }
    const [balance, lockedTotal, withdrawable, sessionKey, reserveNonce, keyEpoch] =
      await withTimeout(
        Promise.all([
          this.vault.balance(consumer),
          this.vault.lockedTotal(consumer),
          this.vault.withdrawable(consumer),
          this.vault.sessionKey(consumer),
          this.vault.reserveNonce(consumer),
          this.vault.keyEpoch(consumer),
        ]),
        READ_TIMEOUT_MS,
        "vault state read",
        signal
      );
    return {
      balance: BigInt(balance),
      lockedTotal: BigInt(lockedTotal),
      withdrawable: BigInt(withdrawable),
      sessionKey: String(sessionKey),
      reserveNonce: BigInt(reserveNonce),
      keyEpoch: BigInt(keyEpoch),
    };
  }

  async readOps(operator: string, signal?: AbortSignal): Promise<OpsState> {
    throwIfAborted(signal);
    const consumer = await withAbort(this.consumer(), signal);
    const r = await withTimeout(
      this.vault.ops(consumer, operator),
      READ_TIMEOUT_MS,
      "ops() read",
      signal
    );
    return {
      locked: BigInt(r.locked ?? r[0]),
      redeemed: BigInt(r.redeemed ?? r[1]),
      expiry: BigInt(r.expiry ?? r[2]),
      created: BigInt(r.created ?? r[3]),
      cycle: BigInt(r.cycle ?? r[4]),
    };
  }

  /** Report whether the intended signer matches the registered session key. */
  async checkSessionKey(): Promise<{
    status: SessionKeyStatus;
    registered: string;
    expected: string;
  }> {
    const expected = await this.sessionAddress();
    const { sessionKey } = await this.readVaultState();
    return {
      status: classifySessionKey(sessionKey, expected),
      registered: sessionKey,
      expected,
    };
  }

  private sessionKeyMismatchError(registered: string, expected: string, consumer: string): Error {
    return new Error(
      `Vault session-key mismatch — refusing to serve unpayable work. This wallet ` +
        `(${consumer}) has session key ${registered} registered on-chain, but this client ` +
        `signs receipts with ${expected}. Every receipt would revert on-chain as BadSignature ` +
        `and the operator could never be paid for what it serves. Usual causes: using the SAME ` +
        `wallet across the Halo browser app and the CLI, or switching --session-key modes. Fix: ` +
        `match the surface/mode (browser ⇄ CLI \`--session-key browser\`), use a DEDICATED ` +
        `wallet, or rotate the on-chain key via setSessionKey(${expected}) (needs lockedTotal == 0).`
    );
  }

  private async signReserve(p: {
    operator: string;
    amount: bigint;
    expiry: bigint;
    nonce: bigint;
    keyEpoch: bigint;
  }): Promise<string> {
    return this.sessionSigner.signTypedData(
      vaultDomain(this.cfg.chainId, this.cfg.vaultAddress),
      RESERVE_TYPES,
      {
        consumer: await this.consumer(),
        operator: p.operator,
        amount: p.amount,
        expiry: p.expiry,
        nonce: p.nonce,
        keyEpoch: p.keyEpoch,
      }
    );
  }
  private async signReceipt(p: {
    operator: string;
    cumulative: bigint;
    keyEpoch: bigint;
    cycle: bigint;
  }): Promise<string> {
    return this.sessionSigner.signTypedData(
      vaultDomain(this.cfg.chainId, this.cfg.vaultAddress),
      RECEIPT_TYPES,
      {
        consumer: await this.consumer(),
        operator: p.operator,
        cumulative: p.cumulative,
        keyEpoch: p.keyEpoch,
        cycle: p.cycle,
      }
    );
  }

  private async postReserve(
    p: { operator: string; amount: bigint; expiry: bigint; nonce: bigint },
    signature: string,
    signal?: AbortSignal
  ): Promise<string> {
    throwIfAborted(signal);
    const res = await fetch(`${this.facBase()}/vault/reserve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.protocolHeaders("facilitator"),
      },
      body: JSON.stringify({
        consumer: await this.consumer(),
        operator: p.operator,
        amount: p.amount.toString(),
        expiry: p.expiry.toString(),
        nonce: p.nonce.toString(),
        signature,
      }),
      signal: signalWithTimeout(signal, 60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `reserve failed (HTTP ${res.status})`);
    return body.hash;
  }
  private async postRedeem(
    operator: string,
    cumulative: bigint,
    cycle: bigint,
    signature: string
  ): Promise<VaultRedeemResponse> {
    if (!this.loadDeadLetters()) {
      throw new Error("vault redeem dead-letter state is unavailable");
    }
    const request: VaultRedeemRequest = {
      consumer: await this.consumer(),
      operator,
      cumulative: cumulative.toString(),
      cycle: cycle.toString(),
      signature,
    };
    const res = await fetch(`${this.facBase()}/vault/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.protocolHeaders("facilitator"),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await res.json().catch(() => null);
    if (res.status === 426) {
      throw new VaultRedeemTerminalError("cli-outdated");
    }
    const outcome = parseVaultRedeemResponse(raw);
    if (outcome) return outcome;
    const error =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as { error?: unknown }).error ?? "")
        : "";
    throw new Error(error || `invalid redeem response (HTTP ${res.status})`);
  }

  private async pushReceipt(
    operator: string,
    cumulative: bigint,
    signature: string
  ): Promise<boolean> {
    if (!this.loadDeadLetters()) return false;
    const relay = this.cfg.relayUrl.replace(/\/+$/, "");
    if (!relay) return false;
    try {
      const res = await fetch(`${relay}/v1/receipt`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-halo-operator": operator,
          ...this.protocolHeaders("relay"),
        },
        body: JSON.stringify({
          consumer: await this.consumer(),
          operator,
          cumulative: cumulative.toString(),
          signature,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 426) {
        throw new VaultRedeemTerminalError("cli-outdated");
      }
      return res.status === 202;
    } catch (error) {
      if (error instanceof VaultRedeemTerminalError) throw error;
      return false;
    }
  }

  private async redeemGrace(signal?: AbortSignal): Promise<bigint> {
    if (this.redeemGraceCache !== null) return this.redeemGraceCache;
    this.redeemGraceCache = BigInt(
      await withTimeout(
        this.vault.redeemGrace(),
        READ_TIMEOUT_MS,
        "redeemGrace read",
        signal
      )
    );
    return this.redeemGraceCache;
  }

  private async maxReserveTtl(signal?: AbortSignal): Promise<bigint> {
    if (this.maxReserveTtlCache !== null) return this.maxReserveTtlCache;
    this.maxReserveTtlCache = BigInt(
      await withTimeout(
        this.vault.maxReserveTtl(),
        READ_TIMEOUT_MS,
        "maxReserveTtl read",
        signal
      )
    );
    return this.maxReserveTtlCache;
  }

  private async postRelease(operator: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const res = await fetch(`${this.facBase()}/vault/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.protocolHeaders("facilitator"),
      },
      body: JSON.stringify({ consumer: await this.consumer(), operator }),
      signal: signalWithTimeout(signal, 60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { hash?: string; error?: string };
    if (!res.ok || !body.hash) throw new Error(body.error || `release failed (HTTP ${res.status})`);
    return body.hash;
  }

  private clearReleaseAttempts(operator: string, keepCycle?: bigint): void {
    const normalized = operator.toLowerCase();
    for (const [key, state] of this.releaseAttempts) {
      if (state.operator === normalized && (keepCycle === undefined || state.cycle !== keepCycle)) {
        this.releaseAttempts.delete(key);
      }
    }
  }

  private async submitBoundedRelease(
    operator: string,
    ops: OpsState,
    signal?: AbortSignal
  ): Promise<boolean> {
    const normalized = getAddress(operator).toLowerCase();
    this.clearReleaseAttempts(normalized, ops.cycle);
    const key = await this.cycleKey(normalized, ops.cycle);
    const state = this.releaseAttempts.get(key) ?? {
      operator: normalized,
      cycle: ops.cycle,
      attempts: 0,
      lastAttemptAt: 0,
      terminal: false,
    };
    this.releaseAttempts.set(key, state);
    if (state.terminal) {
      throw new Error(
        `automatic release exhausted ${MAX_RELEASE_ATTEMPTS} attempts for vault cycle ${ops.cycle}`
      );
    }
    const nowMs = Date.now();
    if (state.lastAttemptAt > nowMs - RELEASE_RETRY_COOLDOWN_MS) return false;
    state.attempts += 1;
    state.lastAttemptAt = nowMs;
    state.terminal = state.attempts >= MAX_RELEASE_ATTEMPTS;
    try {
      await this.postRelease(normalized, signal);
      return true;
    } catch (error) {
      if (state.terminal) {
        this.cfg.log(
          `automatic vault release reached its terminal retry limit for cycle ${ops.cycle}; chain state or an explicit operator action must change before retry`
        );
      }
      throw error;
    }
  }

  /** Reclaim tracked reservations after expiry and grace with bounded automatic retries. */
  async releaseExpiredReservations(
    skipOperator?: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    throwIfAborted(signal);
    let grace: bigint;
    try {
      grace = await this.redeemGrace(signal);
    } catch {
      throwIfAborted(signal);
      return false;
    }
    const now = BigInt(nowSec());
    const skip = skipOperator?.toLowerCase();
    let released = false;
    for (const operator of this.reservedOperators) {
      throwIfAborted(signal);
      if (operator === skip) continue;
      try {
        const ops = await this.readOps(operator, signal);
        if (ops.locked === 0n) {
          this.reservedOperators.delete(operator);
          this.clearReleaseAttempts(operator);
          continue;
        }
        const eligible = ops.expiry !== 0n && now > ops.expiry + grace;
        if (eligible && (await this.submitBoundedRelease(operator, ops, signal))) {
          this.cfg.log(
            `releasing expired vault reservation to ${operator.slice(0, 8)}… ($${fmtUsd(ops.locked)}; frees on confirmation)`
          );
          released = true;
        }
      } catch {
        throwIfAborted(signal);
      }
    }
    return released;
  }

  /** Ensure serialized, live coverage; an optional signal cancels queued and in-flight work. */
  ensureReservation(
    operator: string,
    estCost: bigint,
    signal?: AbortSignal
  ): Promise<{ ops: OpsState; keyEpoch: bigint }> {
    throwIfAborted(signal);
    const job = this.ensureQueue.catch(() => {}).then(() => {
      throwIfAborted(signal);
      return this.ensureColdReservation(operator, estCost, signal);
    });
    this.ensureQueue = job.then(
      () => {},
      () => {}
    );
    return withAbort(job, signal);
  }

  private async ensureColdReservation(
    operator: string,
    estCost: bigint,
    signal?: AbortSignal
  ): Promise<{ ops: OpsState; keyEpoch: bigint }> {
    throwIfAborted(signal);
    const REFRESH_MARGIN = 120;
    const target = estCost * this.cfg.reserveMultiple;
    let [state, ops] = await Promise.all([
      this.readVaultState(signal),
      this.readOps(operator, signal),
    ]);
    // Fail closed before work is sent with a signer that cannot redeem receipts.
    const consumerAddr = await withAbort(this.consumer(), signal);
    const sessionAddr = await withAbort(this.sessionAddress(), signal);
    if (classifySessionKey(state.sessionKey, sessionAddr) === "mismatch") {
      throw this.sessionKeyMismatchError(state.sessionKey, sessionAddr, consumerAddr);
    }
    const sec = nowSec();
    const live = () => ops.expiry === 0n || BigInt(sec + REFRESH_MARGIN) < ops.expiry;
    const isExpired = () => ops.locked > 0n && ops.expiry !== 0n && BigInt(sec) >= ops.expiry;

    // The vault cannot enumerate operators, so retain every observed reservation.
    if (ops.locked > 0n) this.reservedOperators.add(operator.toLowerCase());

    if (ops.locked < estCost || !live()) {
      if (ops.locked > 0n && !live()) {
        // Fail closed: an uncertain lifetime cap must never receive more funds.
        const [maxTtl, grace] = await Promise.all([
          this.maxReserveTtl(signal),
          this.redeemGrace(signal),
        ]);
        const verdict = classifyReservationRevival(
          ops,
          maxTtl,
          grace,
          BigInt(sec),
          BigInt(REFRESH_MARGIN)
        );
        if (verdict === "reclaimable") {
          this.cfg.log(
            `vault reservation to ${operator.slice(0, 8)}… hit its on-chain lifetime cap; reclaiming $${fmtUsd(ops.locked)} and re-reserving fresh`
          );
          await this.submitBoundedRelease(operator, ops, signal);
          // Re-reserving before release confirmation would top up the dead cycle.
          await this.waitForRelease(operator, signal);
          [state, ops] = await Promise.all([
            this.readVaultState(signal),
            this.readOps(operator, signal),
          ]);
        } else if (verdict === "wedged") {
          const until = new Date(Number(ops.expiry + grace) * 1000).toISOString();
          throw new Error(
            `Vault reservation to ${operator.slice(0, 8)}… expired at its on-chain lifetime cap, ` +
              `so its remaining $${fmtUsd(ops.locked)} is stranded until ${until} (a top-up can't ` +
              `revive it). Reclaim it after that time and retry.`
          );
        } else if (verdict === "serve_as_is") {
          if (ops.locked >= estCost) {
            this.reservedOperators.add(operator.toLowerCase());
            return { ops, keyEpoch: state.keyEpoch };
          }
          const reclaimAt = new Date(Number(ops.expiry + grace) * 1000).toISOString();
          throw new Error(
            `Vault reservation to ${operator.slice(0, 8)}… is at its on-chain lifetime cap and about ` +
              `to expire, so it can't be extended, and its remaining $${fmtUsd(ops.locked)} doesn't ` +
              `cover this request ($${fmtUsd(estCost)}). It becomes reclaimable at ${reclaimAt}; ` +
              `reclaim it then and retry.`
          );
        }
      }
      if (ops.locked + state.withdrawable < estCost) {
        if (await this.releaseExpiredReservations(operator, signal)) {
          [state, ops] = await Promise.all([
            this.readVaultState(signal),
            this.readOps(operator, signal),
          ]);
        }
      }
      if (ops.locked + state.withdrawable < estCost && this.autoTopUpBase > 0n) {
        await this.autoTopUp(target, signal);
        [state, ops] = await Promise.all([
          this.readVaultState(signal),
          this.readOps(operator, signal),
        ]);
      }
      if (isExpired() && state.withdrawable === 0n && this.autoTopUpBase > 0n) {
        await this.autoTopUp(target, signal);
        [state, ops] = await Promise.all([
          this.readVaultState(signal),
          this.readOps(operator, signal),
        ]);
      }
      const amount = computeReserveAmount({
        estCost,
        locked: ops.locked,
        withdrawable: state.withdrawable,
        reserveMultiple: this.cfg.reserveMultiple,
        liquiditySlots: this.cfg.reserveLiquiditySlots,
        live: live(),
      });
      if (ops.locked + amount < estCost) {
        throw new Error(this.insufficientMsg(state.withdrawable, estCost));
      }
      // Locked coverage is unusable once expired unless a refresh can be funded.
      if (isExpired() && amount === 0n) {
        throw new Error(
          `Your vault reservation for this operator has expired and there's no free balance ` +
            `to refresh it. Deposit more to your vault${
              this.autoTopUpBase > 0n ? "" : " (or set autoTopUpUsd to refill automatically)"
            }, or wait until it becomes reclaimable after its grace period, then retry.`
        );
      }
      if (amount > 0n) {
        throwIfAborted(signal);
        const expiry = BigInt(sec + this.cfg.reserveTtlSec);
        const sig = await withAbort(
          this.signReserve({
            operator,
            amount,
            expiry,
            nonce: state.reserveNonce,
            keyEpoch: state.keyEpoch,
          }),
          signal
        );
        throwIfAborted(signal);
        await this.postReserve(
          { operator, amount, expiry, nonce: state.reserveNonce },
          sig,
          signal
        );
        ops = await this.waitForReservation(operator, ops, signal);
      }
    }
    this.reservedOperators.add(operator.toLowerCase());
    return { ops, keyEpoch: state.keyEpoch };
  }

  /** Refill the vault until the requested free amount is collectible. */
  private async autoTopUp(
    neededFreeBase: bigint,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (this.autoTopUpBase <= 0n) return false;
    throwIfAborted(signal);
    try {
      const s = await this.readVaultState(signal);
      if (s.withdrawable >= neededFreeBase) return true;
      const targetBalance =
        s.lockedTotal + (neededFreeBase > this.autoTopUpBase ? neededFreeBase : this.autoTopUpBase);
      const tx = await this.ensureDeposit(targetBalance, signal);
      const after = await this.readVaultState(signal);
      const covered = after.withdrawable >= neededFreeBase;
      if (tx && covered) {
        this.cfg.log(`vault auto-topped-up (deposit ${tx.slice(0, 10)}…) — staying on the Halo rail`);
      }
      return covered;
    } catch (e) {
      throwIfAborted(signal);
      this.cfg.log(`vault auto-top-up failed (signer likely out of USDC/ETH): ${errStr(e)}`);
      return false;
    }
  }

  private insufficientMsg(freeBase: bigint, estCost: bigint): string {
    const base = `Vault can't cover this request (needs ~$${fmtUsd(estCost)} reserved, $${fmtUsd(freeBase)} free in the vault).`;
    return this.autoTopUpBase > 0n
      ? `${base} Auto-top-up couldn't refill it — the signer is likely out of USDC (it also needs a little ETH on Base for the deposit tx).`
      : `${base} Deposit more with HaloVaultClient.deposit(usd), or set autoTopUpUsd to refill from the signer automatically.`;
  }

  /** Wait until release confirmation makes a fresh reservation cycle possible. */
  private async waitForRelease(operator: string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 30_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      throwIfAborted(signal);
      try {
        if ((await this.readOps(operator, signal)).locked === 0n) return;
      } catch {
        throwIfAborted(signal);
        // Keep polling after transient RPC failures.
      }
      if (Date.now() > deadline) {
        throw new Error("Reclaim didn't confirm on-chain in time — retry shortly.");
      }
      await abortableDelay(600, signal);
    }
  }

  private async waitForReservation(
    operator: string,
    before: OpsState,
    signal?: AbortSignal
  ): Promise<OpsState> {
    const deadline = Date.now() + 30_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      throwIfAborted(signal);
      try {
        const now = await this.readOps(operator, signal);
        if (now.cycle > before.cycle || now.locked > before.locked) return now;
      } catch {
        throwIfAborted(signal);
        // Keep polling after transient RPC failures.
      }
      if (Date.now() > deadline) throw new Error("Reservation didn't confirm on-chain in time — retry shortly.");
      await abortableDelay(600, signal);
    }
  }

  private loadDeadLetters(): boolean {
    if (this.deadLetterPersistenceFault) return false;
    if (this.deadLettersLoaded) return this.deadLetterStoreReadable;
    this.deadLettersLoaded = true;
    const target = this.cfg.deadLetterStorePath;
    if (!target) return true;
    let raw: string;
    try {
      raw = readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      this.deadLetterStoreReadable = false;
      this.cfg.log(`vault redeem dead-letter file cannot be read; automatic redeem is fenced`);
      return false;
    }
    try {
      const store = parseDeadLetterStore(raw);
      for (const entry of store.entries) {
        this.deadLetters.set(entry.key, entry);
        this.terminalReasons.set(entry.key, entry.reason);
      }
      return true;
    } catch {
      this.deadLetterStoreReadable = false;
      this.cfg.log(`vault redeem dead-letter file is invalid; automatic redeem is fenced`);
      return false;
    }
  }

  private reconcileDeadLettersAfterPersistenceFailure(): void {
    const target = this.cfg.deadLetterStorePath;
    if (!target) return;
    try {
      const store = parseDeadLetterStore(readFileSync(target, "utf8"));
      this.deadLetters.clear();
      for (const entry of store.entries) {
        this.deadLetters.set(entry.key, entry);
        this.terminalReasons.set(entry.key, entry.reason);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.deadLetters.clear();
      }
    }
  }

  private failDeadLetterPersistence(error: unknown): never {
    if (!this.deadLetterPersistenceFault) {
      this.reconcileDeadLettersAfterPersistenceFailure();
      this.deadLetterStoreReadable = false;
      this.deadLetterPersistenceFault = new Error(
        `vault redeem dead-letter persistence became ambiguous; restart is required (${errStr(error)})`
      );
    }
    throw this.deadLetterPersistenceFault;
  }

  private persistDeadLetters(): void {
    if (this.deadLetterPersistenceFault) throw this.deadLetterPersistenceFault;
    if (!this.cfg.deadLetterStorePath) {
      throw new Error("dead-letter store path is not configured");
    }
    try {
      if (this.deadLetters.size > MAX_DEAD_LETTER_ENTRIES) {
        throw new Error("dead-letter store entry limit reached");
      }
      const serialized = serializeDeadLetterStore({
        version: 1,
        entries: [...this.deadLetters.values()],
      } satisfies PersistedDeadLetterStore);
      writeDurableFile(this.cfg.deadLetterStorePath, serialized);
    } catch (error) {
      this.failDeadLetterPersistence(error);
    }
  }

  private notifyTerminalRedeem(error: VaultRedeemTerminalError): void {
    try {
      this.cfg.onTerminalRedeem(error);
    } catch {
      this.cfg.log(`terminal vault redeem notification failed`);
    }
  }

  private deadLetterEntry(
    key: string,
    pending: PendingRedeem,
    reason: VaultRedeemTerminalReason
  ): PersistedDeadLetterRedeem {
    return {
      key,
      version: 1,
      vaultAddress: this.cfg.vaultAddress,
      chainId: this.cfg.chainId,
      consumer: pending.consumer,
      operator: pending.operator,
      cumulative: pending.cumulative.toString(),
      signature: pending.signature,
      cycle: pending.cycle.toString(),
      reason,
      recordedAt: new Date().toISOString(),
    };
  }

  private terminalDeadLetterHighWater(
    key: string,
    pending: PendingRedeem,
    error: VaultRedeemTerminalError
  ): PersistedDeadLetterRedeem | null {
    const current = this.pendingRedeems.get(key);
    const existing = this.deadLetters.get(key);
    if (error.reason === "invalid-request") {
      if (!current || !samePendingRedeemReceipt(current, pending)) return null;
      pending.terminalError = error;
      current.terminalError = error;
      if (existing && BigInt(existing.cumulative) >= current.cumulative) {
        return existing;
      }
      return this.deadLetterEntry(key, current, error.reason);
    }

    pending.terminalError = error;
    if (current) current.terminalError = error;
    const activeHighWater =
      current && current.cumulative >= pending.cumulative ? current : pending;
    if (existing && BigInt(existing.cumulative) >= activeHighWater.cumulative) {
      return { ...existing, reason: error.reason };
    }
    return this.deadLetterEntry(key, activeHighWater, error.reason);
  }

  private quarantineTerminalRedeem(
    key: string,
    pending: PendingRedeem,
    error: VaultRedeemTerminalError
  ): void {
    const entry = this.terminalDeadLetterHighWater(key, pending, error);
    if (!entry) return;
    this.terminalReasons.set(key, entry.reason);
    const current = this.pendingRedeems.get(key);
    if (current?.terminalError) {
      current.terminalError = new VaultRedeemTerminalError(entry.reason);
    }
    try {
      this.persistPending(true);
    } catch {
      this.cfg.log(
        `terminal vault receipt active fence could not be persisted; attempting the terminal store`
      );
    }
    this.deadLetters.set(key, entry);
    try {
      this.persistDeadLetters();
    } catch {
      this.cfg.log(
        `terminal vault receipt persistence is ambiguous; retained behind the active terminal fence without automatic retry`
      );
      this.notifyTerminalRedeem(error);
      return;
    }

    this.pendingRedeems.delete(key);
    try {
      this.persistPending(true);
    } catch {
      this.cfg.log(
        `terminal vault receipt is durable but active-store cleanup failed; restart reconciliation will suppress the duplicate`
      );
    }
    this.notifyTerminalRedeem(error);
  }

  /** Record actual cost and enqueue a monotonic cumulative receipt for redemption. */
  recordAndRedeem(
    operator: string,
    ops: OpsState,
    keyEpoch: bigint,
    cost: bigint
  ): void {
    if (cost <= 0n) return;
    if (this.redeemEvidenceClosing || this.redeemEvidenceClosed) {
      throw new Error("vault redeem evidence ownership is closing or closed");
    }
    if (!this.loadDeadLetters()) return;
    this.redeemQueue = this.redeemQueue.then(async () => {
      try {
        if (!this.loadDeadLetters()) return;
        const consumer = getAddress(await this.consumer()).toLowerCase();
        const normalizedOperator = getAddress(operator).toLowerCase();
        const key = await this.cycleKey(normalizedOperator, ops.cycle, consumer);
        const held = this.pendingRedeems.get(key);
        const terminal = this.deadLetters.get(key);
        const terminalReason = terminal?.reason ?? this.terminalReasons.get(key);
        let prev = this.cumulative.get(key) ?? ops.redeemed;
        if (ops.redeemed > prev) prev = ops.redeemed;
        if (held && held.cumulative > prev) prev = held.cumulative;
        if (terminal && BigInt(terminal.cumulative) > prev) {
          prev = BigInt(terminal.cumulative);
        }
        let priorCeiling = this.ceilingByKey.get(key);
        if (held && (priorCeiling === undefined || held.cumulative > priorCeiling)) {
          priorCeiling = held.cumulative;
        }
        const { cumulative, ceiling } = advanceCumulativeReceipt({
          previous: prev,
          cost,
          locked: ops.locked,
          redeemed: ops.redeemed,
          priorCeiling,
        });
        this.ceilingByKey.set(key, ceiling);
        this.cumulative.set(key, cumulative);
        if (cumulative <= ops.redeemed) return;
        const signature = await this.signReceipt({
          operator: normalizedOperator,
          cumulative,
          keyEpoch,
          cycle: ops.cycle,
        });
        // The highest cumulative receipt supersedes earlier receipts in its cycle.
        const terminalError = terminalReason
          ? new VaultRedeemTerminalError(terminalReason)
          : undefined;
        const nextPending: PendingRedeem = {
          operator: normalizedOperator,
          consumer,
          cumulative,
          signature,
          cycle: ops.cycle,
          inFlight: false,
          terminalError,
        };
        this.pendingRedeems.set(key, nextPending);
        try {
          this.persistPending(true);
        } catch (error) {
          if (held) {
            this.pendingRedeems.set(key, held);
          } else {
            this.pendingRedeems.delete(key);
          }
          throw error;
        }
        if (terminalError) {
          this.quarantineTerminalRedeem(key, nextPending, terminalError);
          return;
        }
        try {
          await this.pushReceipt(normalizedOperator, cumulative, signature);
        } catch (error) {
          if (error instanceof VaultRedeemTerminalError) {
            this.quarantineTerminalRedeem(
              key,
              this.pendingRedeems.get(key)!,
              error
            );
            return;
          }
        }
        await this.attemptRedeem(key);
      } catch (e) {
        // A later cumulative receipt can cover a failed signing attempt.
        this.cfg.log(`vault receipt recording failed (next receipt covers it): ${errStr(e)}`);
        if (this.pendingRedeems.size === 0 && this.redeemRetryTimer) {
          clearInterval(this.redeemRetryTimer);
          this.redeemRetryTimer = null;
        }
      }
    });
    this.startRedeemRetry();
  }

  private attemptRedeem(key: string): Promise<void> {
    let tracked: Promise<void>;
    tracked = this.runRedeemAttempt(key).finally(() => {
      this.activeRedeemAttempts.delete(tracked);
    });
    this.activeRedeemAttempts.add(tracked);
    return tracked;
  }

  private async runRedeemAttempt(key: string): Promise<void> {
    const pending = this.pendingRedeems.get(key);
    if (
      !pending ||
      pending.inFlight ||
      pending.terminalError ||
      !this.loadDeadLetters()
    ) {
      return;
    }
    pending.inFlight = true;
    const clearIfCurrent = () => {
      const current = this.pendingRedeems.get(key);
      if (current && samePendingRedeemReceipt(current, pending)) {
        this.pendingRedeems.delete(key);
        this.persistPending();
      }
    };
    try {
      // Old-cycle receipts can never redeem; same-cycle receipts may already be collected.
      try {
        const onchain = await this.readOps(pending.operator);
        if (onchain.cycle > pending.cycle) {
          clearIfCurrent();
          this.cfg.log(
            `vault receipt for cycle ${pending.cycle} superseded on-chain by cycle ${onchain.cycle}; abandoning (uncollectable)`
          );
          return;
        }
        if (onchain.cycle === pending.cycle && pending.cumulative <= onchain.redeemed) {
          clearIfCurrent();
          return;
        }
      } catch {}

      const outcome = await this.postRedeem(
        pending.operator,
        pending.cumulative,
        pending.cycle,
        pending.signature
      );
      const disposition = vaultRedeemDisposition(outcome, {
        cumulative: pending.cumulative.toString(),
        cycle: pending.cycle.toString(),
      });
      if (disposition === "collected") {
        clearIfCurrent();
        return;
      }
      if (disposition === "uncollectable") {
        clearIfCurrent();
        this.cfg.log(
          `vault receipt is uncollectable; abandoning: ${outcome.status === "rejected" ? outcome.error : outcome.status}`
        );
        return;
      }
      if (disposition === "terminal") {
        this.quarantineTerminalRedeem(
          key,
          pending,
          new VaultRedeemTerminalError("invalid-request")
        );
        return;
      }
      switch (outcome.status) {
        case "confirmed":
        case "already-redeemed":
          this.cfg.log("vault redeem returned mismatched canonical coverage; retained for retry");
          break;
        case "pending":
          this.cfg.log(
            `vault redeem pending at ${outcome.transaction}; retained cycle ${pending.cycle} receipt for recheck`
          );
          break;
        case "reverted":
          this.cfg.log(
            `vault redeem ${outcome.transaction} reverted; retained cycle ${pending.cycle} receipt for retry`
          );
          break;
        case "rejected":
          this.cfg.log(`vault redeem rejected transiently; retained for retry: ${outcome.error}`);
          break;
      }
    } catch (e) {
      if (e instanceof VaultRedeemTerminalError) {
        this.quarantineTerminalRedeem(key, pending, e);
        return;
      }
      const cls = classifyRedeemError(errStr(e));
      if (cls === "collected") {
        clearIfCurrent();
      } else if (cls === "uncollectable") {
        clearIfCurrent();
        this.cfg.log(`vault receipt is uncollectable; abandoning: ${errStr(e)}`);
      } else {
        this.cfg.log(`vault redeem failed; retained for retry: ${errStr(e)}`);
      }
    } finally {
      pending.inFlight = false;
      if (this.pendingRedeems.size === 0 && this.redeemRetryTimer) {
        clearInterval(this.redeemRetryTimer);
        this.redeemRetryTimer = null;
      }
    }
  }

  private startRedeemRetry(): void {
    if (this.redeemRetryTimer || this.redeemEvidenceClosing || this.redeemEvidenceClosed) {
      return;
    }
    this.redeemRetryTimer = setInterval(() => {
      if (this.redeemEvidenceClosing || this.redeemEvidenceClosed) return;
      for (const key of [...this.pendingRedeems.keys()]) void this.attemptRedeem(key);
    }, REDEEM_RETRY_INTERVAL_MS);
    this.redeemRetryTimer.unref?.();
  }

  private async drainRedeems(): Promise<void> {
    if (this.redeemRetryTimer) {
      clearInterval(this.redeemRetryTimer);
      this.redeemRetryTimer = null;
    }
    await this.redeemQueue.catch(() => {});
    if (this.redeemRetryTimer) {
      clearInterval(this.redeemRetryTimer);
      this.redeemRetryTimer = null;
    }
    await Promise.allSettled([...this.pendingRedeems.keys()].map((key) => this.attemptRedeem(key)));
    while (this.activeRedeemAttempts.size > 0) {
      await Promise.allSettled([...this.activeRedeemAttempts]);
    }
    if (this.redeemRetryTimer) {
      clearInterval(this.redeemRetryTimer);
      this.redeemRetryTimer = null;
    }
  }

  /** Make a final redemption attempt and stop the retry timer. */
  async flushRedeems(): Promise<void> {
    if (this.redeemEvidenceClosing || this.redeemEvidenceClosed) {
      throw new Error("vault redeem evidence ownership is closing or closed");
    }
    await this.drainRedeems();
  }

  /**
   * Quiesce redeem work, then release exclusive ownership of configured evidence.
   * Call only after admission and every caller that can record a receipt have stopped.
   */
  closeRedeemEvidenceStore(): Promise<void> {
    if (this.redeemEvidenceClosePromise) return this.redeemEvidenceClosePromise;
    this.redeemEvidenceClosing = true;
    const ownership = this.redeemEvidenceOwnership;
    this.redeemEvidenceClosePromise = (async () => {
      await this.drainRedeems();
      ownership?.release();
      if (this.redeemEvidenceOwnership === ownership) {
        this.redeemEvidenceOwnership = null;
      }
      this.redeemEvidenceClosed = true;
    })();
    return this.redeemEvidenceClosePromise;
  }

  get pendingRedeemCount(): number {
    return this.pendingRedeems.size;
  }

  get deadLetterRedeemCount(): number {
    this.loadDeadLetters();
    return this.deadLetters.size;
  }

  /** Persist pending receipts through a durable replacement. */
  private persistPending(required = false): boolean {
    const f = this.cfg.pendingStorePath;
    if (!f) return true;
    try {
      const arr = [
        ...this.preservedForeignPending,
        ...[...this.pendingRedeems.entries()].map(([key, v]) => ({
          key,
          vaultAddress: this.cfg.vaultAddress,
          chainId: this.cfg.chainId,
          consumer: v.consumer,
          operator: v.operator,
          cumulative: v.cumulative.toString(),
          signature: v.signature,
          cycle: v.cycle.toString(),
          terminalReason: v.terminalError?.reason,
        })),
      ];
      writeDurableJson(f, arr);
      return true;
    } catch (error) {
      if (required) throw error;
      return false;
    }
  }

  /** Reload persisted pending receipts and resume settlement. */
  resumePendingRedeems(): Promise<void> {
    if (this.redeemEvidenceClosing || this.redeemEvidenceClosed) {
      return Promise.reject(new Error("vault redeem evidence ownership is closing or closed"));
    }
    const f = this.cfg.pendingStorePath;
    if (!f) return Promise.resolve();
    if (!this.loadDeadLetters()) return Promise.resolve();
    let raw: string;
    try {
      raw = readFileSync(f, "utf-8");
    } catch {
      return Promise.resolve();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Surface corruption because the file may represent unpaid work.
      this.cfg.log(`pending vault-redeem file unreadable, cannot resume (${errStr(e)}): ${f}`);
      return Promise.resolve();
    }
    if (!Array.isArray(parsed)) {
      this.cfg.log(`pending vault-redeem file has an invalid shape, cannot resume: ${f}`);
      return Promise.resolve();
    }
    const arr = parsed as PersistedPendingRedeem[];
    if (
      arr.some(
        (entry) =>
          entry &&
          entry.terminalReason !== undefined &&
          !isVaultRedeemTerminalReason(entry.terminalReason)
      )
    ) {
      this.cfg.log(`pending vault-redeem file has an invalid terminal fence, cannot resume: ${f}`);
      return Promise.resolve();
    }
    this.redeemQueue = this.redeemQueue.then(async () => {
      if (arr.length === 0) return;
      const consumer = getAddress(await this.consumer()).toLowerCase();
      const nextPendingRedeems = new Map(this.pendingRedeems);
      const nextForeignPending: PersistedPendingRedeem[] = [];
      const quarantinedKeys = new Set<string>();
      let skippedForeignIdentity = 0;
      let suppressedDeadLetterDuplicates = 0;
      let promotedDeadLetterHighWater = 0;
      let recoveredTerminalFences = 0;
      let reconciledTerminalReasons = 0;
      for (const e of arr) {
        try {
          const persistedVault =
            e.vaultAddress === undefined ? VAULT_ADDRESS : getAddress(e.vaultAddress);
          const persistedChain = e.chainId ?? 8453;
          const persistedConsumer =
            e.consumer === undefined ? null : getAddress(e.consumer).toLowerCase();
          if (
            persistedVault !== this.cfg.vaultAddress ||
            persistedChain !== this.cfg.chainId ||
            persistedConsumer !== consumer
          ) {
            skippedForeignIdentity++;
            nextForeignPending.push(e);
            continue;
          }
          const operator = getAddress(e.operator).toLowerCase();
          const cumulative = BigInt(e.cumulative);
          const cycle = BigInt(e.cycle);
          if (cumulative <= 0n || cycle <= 0n || typeof e.signature !== "string" || !e.signature) {
            continue;
          }
          const key = await this.cycleKey(operator, cycle, consumer);
          const terminalError = e.terminalReason
            ? new VaultRedeemTerminalError(e.terminalReason)
            : undefined;
          const candidate: PendingRedeem = {
            operator,
            consumer,
            cumulative,
            signature: e.signature,
            cycle,
            inFlight: false,
            terminalError,
          };
          const deadLetter = this.deadLetters.get(key);
          if (deadLetter) {
            suppressedDeadLetterDuplicates++;
            quarantinedKeys.add(key);
            nextPendingRedeems.delete(key);
            if (cumulative > BigInt(deadLetter.cumulative)) {
              this.deadLetters.set(
                key,
                this.deadLetterEntry(key, candidate, terminalError?.reason ?? deadLetter.reason)
              );
              promotedDeadLetterHighWater++;
            } else if (terminalError && terminalError.reason !== deadLetter.reason) {
              this.deadLetters.set(key, {
                ...deadLetter,
                reason: terminalError.reason,
              });
              reconciledTerminalReasons++;
            }
            continue;
          }
          const existing = nextPendingRedeems.get(key);
          if (terminalError) {
            const terminalHighWater =
              existing && existing.cumulative >= cumulative ? existing : candidate;
            terminalHighWater.terminalError = terminalError;
            nextPendingRedeems.set(key, terminalHighWater);
            this.deadLetters.set(
              key,
              this.deadLetterEntry(key, terminalHighWater, terminalError.reason)
            );
            quarantinedKeys.add(key);
            recoveredTerminalFences++;
            continue;
          }
          if (existing && existing.cumulative >= cumulative) continue;
          nextPendingRedeems.set(key, candidate);
          const priorCumulative = this.cumulative.get(key) ?? 0n;
          if (cumulative > priorCumulative) this.cumulative.set(key, cumulative);
          const priorCeiling = this.ceilingByKey.get(key) ?? 0n;
          if (cumulative > priorCeiling) this.ceilingByKey.set(key, cumulative);
        } catch {}
      }
      if (
        promotedDeadLetterHighWater > 0 ||
        recoveredTerminalFences > 0 ||
        reconciledTerminalReasons > 0
      ) {
        try {
          this.persistDeadLetters();
        } catch {
          this.pendingRedeems.clear();
          for (const [key, pending] of nextPendingRedeems) {
            this.pendingRedeems.set(key, pending);
          }
          this.cfg.log(
            `active terminal receipt promotion is unavailable; its durable pending fence prevents automatic replay`
          );
          return;
        }
      }
      for (const key of quarantinedKeys) nextPendingRedeems.delete(key);
      this.pendingRedeems.clear();
      for (const [key, pending] of nextPendingRedeems) {
        this.pendingRedeems.set(key, pending);
      }
      this.preservedForeignPending.length = 0;
      this.preservedForeignPending.push(...nextForeignPending);
      if (skippedForeignIdentity > 0) {
        this.cfg.log(
          `ignored ${skippedForeignIdentity} pending vault redeem(s) lacking the current chain, vault, and consumer identity`
        );
      }
      if (suppressedDeadLetterDuplicates > 0) {
        this.cfg.log(
          `suppressed ${suppressedDeadLetterDuplicates} active vault redeem duplicate(s) already held in the dead-letter store`
        );
      }
      if (promotedDeadLetterHighWater > 0) {
        this.cfg.log(
          `promoted ${promotedDeadLetterHighWater} newer active terminal receipt(s) into the dead-letter store`
        );
      }
      if (recoveredTerminalFences > 0) {
        this.cfg.log(
          `recovered ${recoveredTerminalFences} active terminal receipt fence(s) into the dead-letter store`
        );
      }
      if (reconciledTerminalReasons > 0) {
        this.cfg.log(
          `reconciled ${reconciledTerminalReasons} active terminal receipt reason(s) into the dead-letter store`
        );
      }
      if (!this.persistPending()) {
        this.cfg.log(
          `pending vault-redeem cleanup could not be persisted; in-memory reconciliation remains fenced from duplicate replay`
        );
      }
      if (this.pendingRedeems.size === 0) return;
      this.cfg.log(`resuming ${this.pendingRedeems.size} pending vault redeem(s) from a prior session`);
      this.startRedeemRetry();
      await Promise.allSettled(
        [...this.pendingRedeems.keys()].map((key) => this.attemptRedeem(key))
      );
    });
    return this.redeemQueue;
  }

  /** Deposit a shortfall and register the session signer; an optional signal stops pending work. */
  async ensureDeposit(targetBase: bigint, signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal);
    const consumer = await withAbort(this.consumer(), signal);
    const state = await this.readVaultState(signal);
    if (state.balance >= targetBase) return null;
    const shortfall = targetBase - state.balance;
    const w = this.signer.connect(this.provider);
    const usdcAddr = getChain(this.cfg.chainId).usdcToken;
    const usdc = new Contract(usdcAddr, ERC20_ABI, w);
    const bal: bigint = await withAbort(usdc.balanceOf(consumer), signal);
    if (bal < shortfall) {
      throw new Error(
        `signer USDC ($${fmtUsd(bal)}) is less than the vault top-up needed ($${fmtUsd(shortfall)}). Fund ${consumer} with USDC on Base.`
      );
    }
    const allowance: bigint = await withAbort(
      usdc.allowance(consumer, this.cfg.vaultAddress),
      signal
    );
    if (allowance < shortfall) {
      throwIfAborted(signal);
      const aTx = await withAbort(usdc.approve(this.cfg.vaultAddress, MaxUint256), signal);
      await withAbort(aTx.wait(), signal);
    }
    throwIfAborted(signal);
    const vault = new Contract(this.cfg.vaultAddress, VAULT_ABI, w);
    const sessionAddress = await withAbort(this.sessionAddress(), signal);
    throwIfAborted(signal);
    const tx = await withAbort(vault.deposit(shortfall, sessionAddress), signal);
    await withAbort(tx.wait(), signal);
    return tx.hash as string;
  }

  /** Deposit an explicit USD amount. */
  async deposit(amountUsd: number): Promise<string> {
    const consumer = await this.consumer();
    const amount = parseUnits(amountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
    const w = this.signer.connect(this.provider);
    const usdcAddr = getChain(this.cfg.chainId).usdcToken;
    const usdc = new Contract(usdcAddr, ERC20_ABI, w);
    const allowance: bigint = await usdc.allowance(consumer, this.cfg.vaultAddress);
    if (allowance < amount) {
      const aTx = await usdc.approve(this.cfg.vaultAddress, MaxUint256);
      await aTx.wait();
    }
    const vault = new Contract(this.cfg.vaultAddress, VAULT_ABI, w);
    const tx = await vault.deposit(amount, await this.sessionAddress());
    await tx.wait();
    return tx.hash as string;
  }
}

export interface VaultOperatorPin {
  address: string;
  priceUsdPerMtok: number;
  encryptionPubkey: string | null;
}

/** Select the cheapest in-range operator that can honor a vault reservation. */
export async function selectVaultOperator(
  relayUrl: string,
  model: string,
  opts: { teeOnly?: boolean; maxPriceUsdPerMtok?: number; signal?: AbortSignal } = {}
): Promise<VaultOperatorPin | null> {
  const relayBase = relayUrl.replace(/\/+$/, "");
  const { teeOnly = false, maxPriceUsdPerMtok, signal } = opts;
  try {
    const url = `${relayBase}/v1/operators` + (teeOnly ? "?tee=1" : "");
    const res = await fetch(url, { signal: signalWithTimeout(signal, 10_000) });
    if (!res.ok) return null;
    const { operators } = (await res.json()) as {
      operators: Array<{
        address: string;
        models: string[];
        encryptionPubkey?: string | null;
        pricing?: Record<string, number>;
        tee?: boolean;
        teeModels?: string[];
        vaultPayments?: boolean;
      }>;
    };
    const selection = selectVaultOperatorFromList(operators, model, {
      teeOnly,
      maxPriceUsdPerMtok,
    });
    if (!selection.selected) return null;
    const { operator, priceUsdPerMtok } = selection.selected;
    return {
      address: operator.address,
      priceUsdPerMtok,
      encryptionPubkey: operator.encryptionPubkey ?? null,
    };
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

export interface InferenceResult {
  status: number;
  /** Raw response body text (OpenAI-compatible JSON, or an error envelope). */
  body: string;
  /** True when a successful response produced a non-zero charge. */
  paid: boolean;
  /** Actual metered charge in USDC base units (6 decimals), when paid. */
  chargedBase?: string;
  /** The operator that served the request. */
  operator?: string;
  headers: Headers;
  /** Await retained redeem attempts before a short-lived process exits. */
  flushRedeems?: () => Promise<void>;
}

export interface PayInferenceOptions {
  signer: Signer;
  relayUrl: string;
  facilitatorUrl: string;
  rpcUrl: string;
  /** HaloVault address. Defaults to the repository consensus deployment. */
  vaultAddress?: string;
  /** OpenAI-compatible chat-completions body. `model` is required. */
  body: Record<string, unknown>;
  chainId?: number;
  teeOnly?: boolean;
  maxPriceUsdPerMtok?: number;
  reserveTtlSec?: number;
  reserveMultiple?: bigint;
  reserveLiquiditySlots?: bigint;
  autoTopUpUsd?: number;
  /** Supply a client for explicit lifecycle control; otherwise one is cached. */
  client?: HaloVaultClient;
  /** Optional receipt signer; reuse its object because the client cache keys by identity. */
  sessionSigner?: Signer;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

const managedVaultClients = new WeakMap<Signer, WeakMap<Signer, Map<string, HaloVaultClient>>>();

function managedVaultClient(opts: PayInferenceOptions, chainId: number): HaloVaultClient {
  const sessionSigner = opts.sessionSigner ?? opts.signer;
  let bySession = managedVaultClients.get(opts.signer);
  if (!bySession) {
    bySession = new WeakMap();
    managedVaultClients.set(opts.signer, bySession);
  }
  let clients = bySession.get(sessionSigner);
  if (!clients) {
    clients = new Map();
    bySession.set(sessionSigner, clients);
  }
  const key = JSON.stringify([
    opts.facilitatorUrl.replace(/\/+$/, ""),
    opts.relayUrl.replace(/\/+$/, ""),
    opts.rpcUrl,
    chainId,
    opts.vaultAddress ?? VAULT_ADDRESS,
    opts.reserveTtlSec ?? 3600,
    String(opts.reserveMultiple ?? 5n),
    String(opts.reserveLiquiditySlots ?? 8n),
    opts.autoTopUpUsd ?? 0,
  ]);
  let client = clients.get(key);
  if (!client) {
    client = new HaloVaultClient(
      opts.signer,
      {
        facilitatorUrl: opts.facilitatorUrl,
        relayUrl: opts.relayUrl,
        rpcUrl: opts.rpcUrl,
        chainId,
        vaultAddress: opts.vaultAddress,
        reserveTtlSec: opts.reserveTtlSec,
        reserveMultiple: opts.reserveMultiple,
        reserveLiquiditySlots: opts.reserveLiquiditySlots,
        autoTopUpUsd: opts.autoTopUpUsd,
        log: opts.log,
      },
      opts.sessionSigner
    );
    clients.set(key, client);
  }
  return client;
}

/** Pay for one inference, defaulting to the fee-compliant HaloVault rail. */
export async function payInference(opts: PayInferenceOptions): Promise<InferenceResult> {
  const chainId = opts.chainId ?? 8453;
  const relayBase = opts.relayUrl.replace(/\/+$/, "");
  const url = `${relayBase}/v1/chat/completions`;
  const model = typeof opts.body.model === "string" ? opts.body.model : "";
  if (!model) throw new Error("payInference: body.model is required");
  if (opts.body.stream === true) {
    throw new Error(
      "payInference: stream:true is not supported; request a buffered response or use a streaming API"
    );
  }

  const pin = await selectVaultOperator(relayBase, model, {
    teeOnly: opts.teeOnly,
    maxPriceUsdPerMtok: opts.maxPriceUsdPerMtok,
    signal: opts.signal,
  });
  if (!pin) {
    throw new Error(
      `No priced operator for model "${model}"${opts.teeOnly ? " (confidential)" : ""} within the price limit — vault routing needs a priced operator.`
    );
  }

  const client = opts.client ?? managedVaultClient(opts, chainId);

  // Shared reasoning headroom keeps reservation and operator gate equal (invariant #7).
  const estTokens = estimateReservationTokens(opts.body);
  const estCost = withReservationMargin(priceTokens(pin.priceUsdPerMtok, estTokens));
  let { ops, keyEpoch } = await client.ensureReservation(pin.address, estCost, opts.signal);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cliVersionHeader(),
    "x-halo-payment-mode": "vault",
    "x-halo-operator": pin.address,
    "x-halo-vault-consumer": await withAbort(client.consumer(), opts.signal),
    "x-halo-max-price": String(pin.priceUsdPerMtok),
  };
  if (opts.teeOnly) headers["x-halo-tee"] = "1";

  const requestBody = JSON.stringify(opts.body);
  const send = () =>
    fetch(url, {
      method: "POST",
      headers,
      body: requestBody,
      signal: opts.signal,
    });
  let res = await send();
  let text = await res.text();

  // A typed pre-serve 402 can safely enlarge the same reservation and replay.
  for (
    let attempt = 1;
    attempt < MAX_VAULT_RESERVATION_ATTEMPTS && res.status === 402;
    attempt++
  ) {
    const required = requiredVaultReservationBase(text);
    if (required === null) break;
    opts.log?.(
      `vault reservation was below the operator ceiling; reserving ${required} base units and retrying (attempt ${attempt + 1}/${MAX_VAULT_RESERVATION_ATTEMPTS})`
    );
    ({ ops, keyEpoch } = await client.ensureReservation(pin.address, required, opts.signal));
    res = await send();
    text = await res.text();
  }

  const meter = meterVaultResponse(res.headers, text, pin.priceUsdPerMtok);
  const cost = meter.cost;
  if (res.ok && !meter.metered) {
    opts.log?.(
      "vault response had no settlement and no readable usage; leaving it unmetered (the operator must report usage or a settlement)"
    );
  }
  if (res.ok && cost > 0n) {
    client.recordAndRedeem(pin.address, ops, keyEpoch, cost);
  }

  return {
    status: res.status,
    body: text,
    paid: res.ok && cost > 0n,
    chargedBase: res.ok && cost > 0n ? cost.toString() : undefined,
    operator: pin.address,
    headers: res.headers,
    flushRedeems: () => client.flushRedeems(),
  };
}
