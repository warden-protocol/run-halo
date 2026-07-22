import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  MAX_VAULT_EVENT_ACK_BYTES,
  MAX_VAULT_EVENT_AMOUNT_BASE,
  MAX_VAULT_EVENT_CHECKPOINT_BASE,
  MAX_VAULT_EVENT_CYCLE,
  MAX_VAULT_EVENT_DURATION_MS,
  MAX_VAULT_EVENT_TIMESTAMP_MS,
  MAX_VAULT_EVENT_TOKENS,
  VAULT_EVENT_VERSION,
  canonicalVaultEventMessage,
  validateVaultEventV2,
  type VaultEventV2,
} from "@halo/vault-core";

export const DEFAULT_EVENT_OUTBOX_MAX_ENTRIES = 1_000;
export const DEFAULT_EVENT_OUTBOX_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_EVENT_OUTBOX_CONCURRENCY = 4;
export const DEFAULT_EVENT_OUTBOX_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_EVENT_OUTBOX_RETRY_BASE_MS = 1_000;
export const DEFAULT_EVENT_OUTBOX_RETRY_CAP_MS = 5 * 60_000;
export const DEFAULT_EVENT_OUTBOX_SHUTDOWN_DRAIN_MS = 5_000;

export interface EventOutboxRuntimeOptions {
  maxEntries: number;
  maxBytes: number;
  concurrency: number;
  requestTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  shutdownDrainMs: number;
}

function boundedEnvInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function eventOutboxRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env
): EventOutboxRuntimeOptions {
  const retryBaseMs = boundedEnvInteger(
    env,
    "HALO_EVENT_OUTBOX_RETRY_BASE_MS",
    DEFAULT_EVENT_OUTBOX_RETRY_BASE_MS,
    100,
    60_000
  );
  const retryCapMs = boundedEnvInteger(
    env,
    "HALO_EVENT_OUTBOX_RETRY_CAP_MS",
    DEFAULT_EVENT_OUTBOX_RETRY_CAP_MS,
    retryBaseMs,
    86_400_000
  );
  return {
    maxEntries: boundedEnvInteger(
      env,
      "HALO_EVENT_OUTBOX_MAX_ENTRIES",
      DEFAULT_EVENT_OUTBOX_MAX_ENTRIES,
      1,
      100_000
    ),
    maxBytes: boundedEnvInteger(
      env,
      "HALO_EVENT_OUTBOX_MAX_BYTES",
      DEFAULT_EVENT_OUTBOX_MAX_BYTES,
      65_536,
      1_073_741_824
    ),
    concurrency: boundedEnvInteger(
      env,
      "HALO_EVENT_OUTBOX_CONCURRENCY",
      DEFAULT_EVENT_OUTBOX_CONCURRENCY,
      1,
      32
    ),
    requestTimeoutMs: boundedEnvInteger(
      env,
      "HALO_EVENT_OUTBOX_REQUEST_TIMEOUT_MS",
      DEFAULT_EVENT_OUTBOX_REQUEST_TIMEOUT_MS,
      100,
      60_000
    ),
    retryBaseMs,
    retryCapMs,
    shutdownDrainMs: boundedEnvInteger(
      env,
      "HALO_EVENT_OUTBOX_SHUTDOWN_DRAIN_MS",
      DEFAULT_EVENT_OUTBOX_SHUTDOWN_DRAIN_MS,
      0,
      60_000
    ),
  };
}

type EntryState = "pending" | "acknowledged" | "dead_letter";

interface PendingEntry {
  id: string;
  identity: string;
  state: EntryState;
  payload?: VaultEventV2;
  attempts: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
}

export interface EventOutboxScope {
  chainId: number;
  vaultAddress: string;
  operator: string;
}

interface ServedCheckpoint {
  consumer: string;
  vaultCycle: number;
  cumulativeCheckpoint: string;
}

interface OutboxFile {
  version: 2;
  scope: EventOutboxScope;
  entries: PendingEntry[];
  servedCheckpoints: ServedCheckpoint[];
}

export interface EventOutboxStatus {
  id: string;
  state: EntryState;
  attempts: number;
  lastErrorCode: string | null;
}

interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

interface OutboxResponse {
  status: number;
  body: { getReader(): Reader } | null;
}

export type EventOutboxFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<OutboxResponse>;

export interface EventOutboxOptions {
  filePath: string;
  indexerUrl: string;
  scope: EventOutboxScope;
  maxEntries?: number;
  maxBytes?: number;
  concurrency?: number;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  retryCapMs?: number;
  fetch?: EventOutboxFetch;
  now?: () => number;
  random?: () => number;
  onPersistStep?: (step: EventOutboxPersistStep) => void;
  onLockStep?: (step: EventOutboxLockStep) => void;
}

export type EventOutboxPersistStep =
  | "before_rename"
  | "after_rename"
  | "after_directory_fsync";

export type EventOutboxLockStep = "recovery_linked" | "stale_unlinked";

export interface EventOutboxServedCheckpoint extends ServedCheckpoint, EventOutboxScope {}

export interface EventOutboxReservation {
  id: string;
  operator: string;
  consumer: string;
  model: string | null;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function normalizeEndpoint(indexerUrl: string): string {
  const parsed = new URL(indexerUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("event outbox indexer URL must use http or https");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/events`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function defaultFetch(
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
): Promise<OutboxResponse> {
  return fetch(url, { ...init, redirect: "error" }) as unknown as Promise<OutboxResponse>;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function normalizeAddress(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} must be a 20-byte hex address`);
  }
  return value.toLowerCase();
}

function normalizeScope(value: unknown): EventOutboxScope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event outbox scope is not an object");
  }
  const scope = value as Record<string, unknown>;
  if (
    !hasExactKeys(scope, ["chainId", "vaultAddress", "operator"]) ||
    !Number.isSafeInteger(scope.chainId) ||
    (scope.chainId as number) <= 0
  ) {
    throw new Error("event outbox scope is invalid");
  }
  return {
    chainId: scope.chainId as number,
    vaultAddress: normalizeAddress(scope.vaultAddress, "event outbox vaultAddress"),
    operator: normalizeAddress(scope.operator, "event outbox operator"),
  };
}

function sameScope(left: EventOutboxScope, right: EventOutboxScope): boolean {
  return (
    left.chainId === right.chainId &&
    left.vaultAddress === right.vaultAddress &&
    left.operator === right.operator
  );
}

function validateServedCheckpoint(value: unknown): ServedCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event outbox served checkpoint is not an object");
  }
  const checkpoint = value as Record<string, unknown>;
  if (
    !hasExactKeys(checkpoint, ["consumer", "vaultCycle", "cumulativeCheckpoint"]) ||
    !Number.isSafeInteger(checkpoint.vaultCycle) ||
    (checkpoint.vaultCycle as number) <= 0 ||
    (checkpoint.vaultCycle as number) > MAX_VAULT_EVENT_CYCLE ||
    typeof checkpoint.cumulativeCheckpoint !== "string" ||
    !/^[0-9]+$/.test(checkpoint.cumulativeCheckpoint)
  ) {
    throw new Error("event outbox served checkpoint is invalid");
  }
  const cumulative = BigInt(checkpoint.cumulativeCheckpoint);
  if (cumulative <= 0n || cumulative > MAX_VAULT_EVENT_CHECKPOINT_BASE) {
    throw new Error("event outbox served checkpoint is outside the event domain");
  }
  return {
    consumer: normalizeAddress(checkpoint.consumer, "event outbox checkpoint consumer"),
    vaultCycle: checkpoint.vaultCycle as number,
    cumulativeCheckpoint: cumulative.toString(),
  };
}

function validateStoredEntry(value: unknown): PendingEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("event outbox entry is not an object");
  }
  const e = value as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.identity !== "string" ||
    !["pending", "acknowledged", "dead_letter"].includes(String(e.state)) ||
    !Number.isSafeInteger(e.attempts) ||
    (e.attempts as number) < 0 ||
    !Number.isSafeInteger(e.nextAttemptAt) ||
    (e.nextAttemptAt as number) < 0 ||
    (e.lastErrorCode !== null &&
      (typeof e.lastErrorCode !== "string" || !/^[a-z0-9_]{1,64}$/.test(e.lastErrorCode)))
  ) {
    throw new Error("event outbox entry has invalid metadata");
  }
  const state = e.state as EntryState;
  const retainsPayload = state !== "acknowledged";
  if (
    !hasExactKeys(
      e,
      retainsPayload
        ? [
            "id",
            "identity",
            "state",
            "payload",
            "attempts",
            "nextAttemptAt",
            "lastErrorCode",
          ]
        : ["id", "identity", "state", "attempts", "nextAttemptAt", "lastErrorCode"]
    )
  ) {
    throw new Error("event outbox entry has unknown or missing fields");
  }
  let payload: VaultEventV2 | undefined;
  if (retainsPayload) {
    const parsed = validateVaultEventV2(e.payload);
    if (!parsed.ok) throw new Error(`event outbox payload is invalid: ${parsed.errorCode}`);
    payload = parsed.value;
    if (payload.id !== e.id || canonicalVaultEventMessage(payload) !== e.identity) {
      throw new Error("event outbox payload identity does not match metadata");
    }
  } else if (e.payload !== undefined) {
    throw new Error("terminal event outbox entry retained its payload");
  }
  return {
    id: e.id,
    identity: e.identity,
    state,
    ...(payload ? { payload } : {}),
    attempts: e.attempts as number,
    nextAttemptAt: e.nextAttemptAt as number,
    lastErrorCode: e.lastErrorCode as string | null,
  };
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function loadOutboxFile(
  filePath: string,
  maxBytes: number,
  maxEntries: number
): OutboxFile | null {
  if (!existsSync(filePath)) return null;
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error("event outbox file is not a bounded regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("event outbox file is corrupt");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("event outbox file has invalid schema");
  }
  const raw = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(raw, ["version", "scope", "entries", "servedCheckpoints"]) ||
    raw.version !== 2 ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > maxEntries ||
    !Array.isArray(raw.servedCheckpoints) ||
    raw.servedCheckpoints.length > maxEntries
  ) {
    throw new Error("event outbox file has invalid schema");
  }
  const scope = normalizeScope(raw.scope);
  const entries = raw.entries.map(validateStoredEntry);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("event outbox contains duplicate ids");
  }
  for (const entry of entries) {
    if (entry.payload && entry.payload.operator.toLowerCase() !== scope.operator) {
      throw new Error("event outbox payload is outside the stored operator scope");
    }
  }
  const servedCheckpoints = raw.servedCheckpoints.map(validateServedCheckpoint);
  if (
    new Set(servedCheckpoints.map((checkpoint) => checkpoint.consumer)).size !==
    servedCheckpoints.length
  ) {
    throw new Error("event outbox contains duplicate served checkpoint consumers");
  }
  return { version: 2, scope, entries, servedCheckpoints };
}

export function readEventOutboxStatus(
  filePath: string,
  limits: Pick<EventOutboxRuntimeOptions, "maxBytes" | "maxEntries"> =
    eventOutboxRuntimeOptions()
): EventOutboxStatus[] {
  return (loadOutboxFile(
    path.resolve(filePath),
    limits.maxBytes,
    limits.maxEntries
  )?.entries ?? []).map(({ id, state, attempts, lastErrorCode }) => ({
    id,
    state,
    attempts,
    lastErrorCode,
  }));
}

export class EventOutbox {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockRecoveryPath: string;
  private readonly endpoint: string;
  private readonly scope: EventOutboxScope;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly concurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly fetcher: EventOutboxFetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onPersistStep?: (step: EventOutboxPersistStep) => void;
  private readonly onLockStep?: (step: EventOutboxLockStep) => void;
  private state: OutboxFile;
  private readonly reservations = new Map<string, PendingEntry>();
  private lockFd: number | null = null;
  private running = false;
  private stopping = false;
  private active = 0;
  private readonly activeControllers = new Set<AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private tempSequence = 0;
  private persistenceFault: Error | null = null;

  constructor(options: EventOutboxOptions) {
    this.filePath = path.resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.lockRecoveryPath = `${this.lockPath}.recovery`;
    this.endpoint = normalizeEndpoint(options.indexerUrl);
    this.scope = normalizeScope(options.scope);
    this.state = this.emptyState();
    this.maxEntries = positiveInteger(
      options.maxEntries ?? DEFAULT_EVENT_OUTBOX_MAX_ENTRIES,
      "event outbox maxEntries"
    );
    this.maxBytes = positiveInteger(
      options.maxBytes ?? DEFAULT_EVENT_OUTBOX_MAX_BYTES,
      "event outbox maxBytes"
    );
    this.concurrency = positiveInteger(
      options.concurrency ?? DEFAULT_EVENT_OUTBOX_CONCURRENCY,
      "event outbox concurrency"
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_EVENT_OUTBOX_REQUEST_TIMEOUT_MS,
      "event outbox requestTimeoutMs"
    );
    this.retryBaseMs = positiveInteger(
      options.retryBaseMs ?? DEFAULT_EVENT_OUTBOX_RETRY_BASE_MS,
      "event outbox retryBaseMs"
    );
    this.retryCapMs = positiveInteger(
      options.retryCapMs ?? DEFAULT_EVENT_OUTBOX_RETRY_CAP_MS,
      "event outbox retryCapMs"
    );
    if (this.retryBaseMs > this.retryCapMs) {
      throw new Error("event outbox retryBaseMs exceeds retryCapMs");
    }
    this.fetcher = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onPersistStep = options.onPersistStep;
    this.onLockStep = options.onLockStep;

    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.acquireLock();
    try {
      const loaded = this.load();
      if (loaded && !sameScope(loaded.scope, this.scope)) {
        throw new Error("event outbox scope does not match the configured chain, vault, and operator");
      }
      this.state = loaded ?? this.emptyState();
      let recoveredInFlight = false;
      for (const entry of this.state.entries) {
        if (entry.state === "pending" && entry.nextAttemptAt === Number.MAX_SAFE_INTEGER) {
          entry.nextAttemptAt = 0;
          recoveredInFlight = true;
        }
      }
      const hadAcknowledged = this.state.entries.some(
        (entry) => entry.state === "acknowledged"
      );
      if (hadAcknowledged) {
        this.state.entries = this.state.entries.filter(
          (entry) => entry.state !== "acknowledged"
        );
      }
      if (!existsSync(this.filePath) || recoveredInFlight || hadAcknowledged) this.persist();
      else chmodSync(this.filePath, 0o600);
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  start(): void {
    this.assertAcceptingMutations();
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  reserve(candidate: EventOutboxReservation): void {
    this.assertAcceptingMutations();
    if (candidate.operator.toLowerCase() !== this.scope.operator) {
      throw new Error("event outbox reservation is outside the configured operator scope");
    }
    this.compactAcknowledged();
    if (
      this.reservations.has(candidate.id) ||
      this.state.entries.some((entry) => entry.id === candidate.id)
    ) {
      throw new Error(`event id already exists: ${candidate.id}`);
    }
    if (this.state.entries.length + this.reservations.size >= this.maxEntries) {
      throw new Error("event outbox capacity exhausted");
    }
    const payload: VaultEventV2 = {
      eventVersion: VAULT_EVENT_VERSION,
      id: candidate.id,
      operator: candidate.operator,
      consumer: candidate.consumer,
      model: candidate.model,
      tokens: MAX_VAULT_EVENT_TOKENS,
      amountUsdc: MAX_VAULT_EVENT_AMOUNT_BASE.toString(),
      durationMs: MAX_VAULT_EVENT_DURATION_MS,
      timestamp: new Date(MAX_VAULT_EVENT_TIMESTAMP_MS).toISOString(),
      txHash: null,
      mode: "vault",
      vaultCycle: MAX_VAULT_EVENT_CYCLE,
      cumulativeCheckpoint: MAX_VAULT_EVENT_CHECKPOINT_BASE.toString(),
      signature: `0x${"ff".repeat(65)}`,
    };
    const parsed = validateVaultEventV2(payload);
    if (!parsed.ok) throw new Error(`invalid event outbox reservation: ${parsed.errorCode}`);
    const entry: PendingEntry = {
      id: parsed.value.id,
      identity: canonicalVaultEventMessage(parsed.value),
      state: "pending",
      payload: parsed.value,
      attempts: 0,
      nextAttemptAt: this.now(),
      lastErrorCode: null,
    };
    this.assertWorstCaseFits([...this.state.entries, ...this.reservations.values(), entry]);
    this.reservations.set(entry.id, entry);
  }

  releaseReservation(id: string): void {
    this.reservations.delete(id);
  }

  enqueue(payloadValue: VaultEventV2): "queued" | "duplicate" {
    this.assertAcceptingMutations();
    const parsed = validateVaultEventV2(payloadValue);
    if (!parsed.ok) throw new Error(`invalid vault event: ${parsed.errorCode}`);
    const payload = parsed.value;
    if (payload.operator.toLowerCase() !== this.scope.operator) {
      throw new Error("vault event is outside the configured operator scope");
    }
    const identity = canonicalVaultEventMessage(payload);
    const existing = this.state.entries.find((entry) => entry.id === payload.id);
    if (existing) {
      if (existing.identity !== identity) throw new Error(`event id conflict: ${payload.id}`);
      this.reservations.delete(payload.id);
      return "duplicate";
    }
    const reservation = this.reservations.get(payload.id);
    if (!reservation && this.state.entries.length + this.reservations.size >= this.maxEntries) {
      throw new Error("event outbox capacity exhausted");
    }

    const entry: PendingEntry = {
      id: payload.id,
      identity,
      state: "pending",
      payload,
      attempts: 0,
      nextAttemptAt: this.now(),
      lastErrorCode: null,
    };
    const otherReservations = [...this.reservations.entries()]
      .filter(([id]) => id !== payload.id)
      .map(([, reserved]) => reserved);
    const servedCheckpoints = this.withServedCheckpoint(
      this.state.servedCheckpoints,
      payload
    );
    this.assertWorstCaseFits(
      [...this.state.entries, ...otherReservations, entry],
      servedCheckpoints
    );
    this.state = {
      ...this.state,
      entries: [...this.state.entries, entry],
      servedCheckpoints,
    };
    this.persist();
    if (reservation) this.reservations.delete(payload.id);
    if (this.running) this.schedule(0);
    return "queued";
  }

  status(): EventOutboxStatus[] {
    return this.state.entries.map(({ id, state, attempts, lastErrorCode }) => ({
      id,
      state,
      attempts,
      lastErrorCode,
    }));
  }

  servedCheckpoints(): EventOutboxServedCheckpoint[] {
    return this.state.servedCheckpoints.map((checkpoint) => ({
      ...this.scope,
      ...checkpoint,
    }));
  }

  observeOnchain(
    consumerValue: string,
    operatorValue: string,
    cycle: bigint,
    redeemed: bigint
  ): void {
    this.assertAcceptingMutations();
    const consumer = normalizeAddress(consumerValue, "event outbox observed consumer");
    const operator = normalizeAddress(operatorValue, "event outbox observed operator");
    if (operator !== this.scope.operator) {
      throw new Error("event outbox observation is outside the configured operator scope");
    }
    if (cycle <= 0n || cycle > BigInt(MAX_VAULT_EVENT_CYCLE) || redeemed < 0n) {
      throw new Error("event outbox observation is outside the event domain");
    }
    const retained = this.state.servedCheckpoints.filter((checkpoint) => {
      if (checkpoint.consumer !== consumer) return true;
      if (cycle > BigInt(checkpoint.vaultCycle)) return false;
      return !(
        cycle === BigInt(checkpoint.vaultCycle) &&
        redeemed >= BigInt(checkpoint.cumulativeCheckpoint)
      );
    });
    if (retained.length === this.state.servedCheckpoints.length) return;
    this.state = { ...this.state, servedCheckpoints: retained };
    this.persist();
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("event outbox drain timeout must be a non-negative integer");
    }
    this.stopping = true;
    this.running = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.persistenceFault) {
      await this.abortActiveDeliveries();
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    for (const entry of this.state.entries) {
      if (entry.state === "pending") entry.nextAttemptAt = this.now();
    }
    this.persist();
    while (Date.now() < deadline) {
      this.pump(true);
      if (
        this.active === 0 &&
        !this.state.entries.some((entry) => entry.state === "pending")
      ) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
    }
    this.pump(true);
    if (this.active > 0) {
      await this.abortActiveDeliveries();
    }
    return this.active === 0 && !this.state.entries.some((entry) => entry.state === "pending");
  }

  close(): void {
    if (this.active !== 0) throw new Error("cannot close event outbox with active deliveries");
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.stopping = true;
    this.releaseLock();
  }

  private acquireLock(): void {
    try {
      this.createLock();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let recoveryLinked = false;
    try {
      try {
        linkSync(this.lockPath, this.lockRecoveryPath);
        recoveryLinked = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          try {
            this.createLock();
            return;
          } catch (createError) {
            if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
          }
        }
        throw this.alreadyLockedError();
      }
      this.onLockStep?.("recovery_linked");

      const recoveryStat = lstatSync(this.lockRecoveryPath);
      const ownerText = readFileSync(this.lockRecoveryPath, "utf8").trim();
      const ownerPid = Number(ownerText);
      if (
        !recoveryStat.isFile() ||
        !Number.isSafeInteger(ownerPid) ||
        ownerPid <= 0 ||
        isLivePid(ownerPid)
      ) {
        throw this.alreadyLockedError();
      }

      let currentStat;
      try {
        currentStat = lstatSync(this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (currentStat) {
        if (
          currentStat.dev !== recoveryStat.dev ||
          currentStat.ino !== recoveryStat.ino
        ) {
          throw this.alreadyLockedError();
        }
        unlinkSync(this.lockPath);
      }
      this.onLockStep?.("stale_unlinked");

      try {
        this.createLock();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw this.alreadyLockedError();
        }
        throw error;
      }
    } finally {
      if (recoveryLinked) {
        try {
          unlinkSync(this.lockRecoveryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }

  private releaseLock(): void {
    if (this.lockFd === null) return;
    const fd = this.lockFd;
    this.lockFd = null;
    try {
      const owned = fstatSync(fd);
      const current = lstatSync(this.lockPath);
      if (owned.dev !== current.dev || owned.ino !== current.ino) {
        throw new Error("event outbox lock ownership changed before release");
      }
      unlinkSync(this.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("event outbox lock ownership disappeared before release");
      }
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  private createLock(): void {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
    let fd: number | null = null;
    try {
      fd = openSync(this.lockPath, flags, 0o600);
      writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
      fsyncSync(fd);
      this.lockFd = fd;
      fd = null;
    } catch (error) {
      if (fd !== null) {
        const owned = fstatSync(fd);
        try {
          const current = lstatSync(this.lockPath);
          if (owned.dev === current.dev && owned.ino === current.ino) {
            unlinkSync(this.lockPath);
          }
        } catch {
          // Preserve any path that is no longer the inode opened by this attempt.
        }
        closeSync(fd);
      }
      throw error;
    }
  }

  private alreadyLockedError(): Error {
    return new Error(`event outbox is already locked: ${this.lockPath}`);
  }

  private async abortActiveDeliveries(): Promise<void> {
    for (const controller of this.activeControllers) controller.abort();
    const deadline = Date.now() + Math.min(1_000, Math.max(100, this.requestTimeoutMs));
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private emptyState(): OutboxFile {
    return {
      version: 2,
      scope: this.scope,
      entries: [],
      servedCheckpoints: [],
    };
  }

  private load(): OutboxFile | null {
    return loadOutboxFile(this.filePath, this.maxBytes, this.maxEntries);
  }

  private withServedCheckpoint(
    current: ServedCheckpoint[],
    payload: VaultEventV2
  ): ServedCheckpoint[] {
    const consumer = payload.consumer.toLowerCase();
    const candidate: ServedCheckpoint = {
      consumer,
      vaultCycle: payload.vaultCycle,
      cumulativeCheckpoint: payload.cumulativeCheckpoint,
    };
    const index = current.findIndex((checkpoint) => checkpoint.consumer === consumer);
    if (index < 0) {
      if (current.length >= this.maxEntries) {
        throw new Error("event outbox served checkpoint capacity exhausted");
      }
      return [...current, candidate];
    }
    const existing = current[index];
    if (
      candidate.vaultCycle < existing.vaultCycle ||
      (candidate.vaultCycle === existing.vaultCycle &&
        BigInt(candidate.cumulativeCheckpoint) <= BigInt(existing.cumulativeCheckpoint))
    ) {
      return current;
    }
    const updated = [...current];
    updated[index] = candidate;
    return updated;
  }

  private assertWorstCaseFits(
    entries: PendingEntry[],
    startingCheckpoints: ServedCheckpoint[] = this.state.servedCheckpoints
  ): void {
    let servedCheckpoints = startingCheckpoints;
    for (const entry of entries) {
      if (entry.payload) {
        servedCheckpoints = this.withServedCheckpoint(servedCheckpoints, entry.payload);
      }
    }
    const worst = entries.map((entry) => {
      if (entry.state !== "pending") return entry;
      const pending: PendingEntry = {
        ...entry,
        attempts: Number.MAX_SAFE_INTEGER,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        lastErrorCode: "x".repeat(64),
      };
      const deadLetter: PendingEntry = {
        ...pending,
        state: "dead_letter",
        nextAttemptAt: 0,
      };
      return Buffer.byteLength(JSON.stringify(deadLetter)) >
        Buffer.byteLength(JSON.stringify(pending))
        ? deadLetter
        : pending;
    });
    if (
      Buffer.byteLength(
        JSON.stringify({
          version: 2,
          scope: this.scope,
          entries: worst,
          servedCheckpoints,
        })
      ) + 1 >
      this.maxBytes
    ) {
      throw new Error("event outbox byte capacity exhausted");
    }
  }

  private assertWritable(): void {
    if (this.persistenceFault) throw this.persistenceFault;
  }

  private assertAcceptingMutations(): void {
    this.assertWritable();
    if (this.stopping || this.lockFd === null) {
      throw new Error("event outbox is stopping");
    }
  }

  private failPersistence(error: unknown): never {
    if (this.persistenceFault) throw this.persistenceFault;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const detail = error instanceof Error ? error.message : String(error);
    this.persistenceFault = new Error(
      `event outbox persistence became ambiguous; restart is required (${detail})`
    );
    for (const controller of this.activeControllers) controller.abort();
    try {
      this.state = this.load() ?? this.emptyState();
    } catch {
      // Keep the last in-memory candidate when disk cannot be read safely.
    }
    throw this.persistenceFault;
  }

  private persist(): void {
    this.assertWritable();
    const body = `${JSON.stringify(this.state)}\n`;
    if (Buffer.byteLength(body) > this.maxBytes) {
      throw new Error("event outbox byte capacity exhausted");
    }
    const temp = `${this.filePath}.tmp-${process.pid}-${++this.tempSequence}`;
    let fd: number | null = null;
    try {
      fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, body, { encoding: "utf8" });
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      this.onPersistStep?.("before_rename");
      renameSync(temp, this.filePath);
      this.onPersistStep?.("after_rename");
      chmodSync(this.filePath, 0o600);
      const directoryFd = openSync(path.dirname(this.filePath), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
        this.onPersistStep?.("after_directory_fsync");
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // The rename may already have made the durable target authoritative.
      }
      this.failPersistence(error);
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running || this.stopping || this.timer || this.persistenceFault) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delayMs));
    this.timer.unref();
  }

  private pump(allowWhileStopping = false): void {
    if (
      !this.running ||
      this.persistenceFault ||
      (this.stopping && !allowWhileStopping)
    ) return;
    const now = this.now();
    while (!this.persistenceFault && this.active < this.concurrency) {
      const entry = this.state.entries.find(
        (candidate) => candidate.state === "pending" && candidate.nextAttemptAt <= now
      );
      if (!entry) break;
      this.active++;
      entry.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      void this.deliver(entry)
        .catch(() => {})
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
    if (this.stopping) return;
    const next = this.state.entries
      .filter((entry) => entry.state === "pending")
      .reduce((minimum, entry) => Math.min(minimum, entry.nextAttemptAt), Infinity);
    if (Number.isFinite(next) && next < Number.MAX_SAFE_INTEGER) {
      this.schedule(Math.max(0, next - this.now()));
    }
  }

  private async deliver(entry: PendingEntry): Promise<void> {
    this.assertWritable();
    if (!entry.payload) throw new Error("pending event outbox entry has no payload");
    entry.attempts = Math.min(Number.MAX_SAFE_INTEGER, entry.attempts + 1);
    entry.lastErrorCode = null;
    this.persist();

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.payload),
        signal: controller.signal,
      });
      this.assertWritable();
      let responseText: string;
      try {
        responseText = await this.readBounded(response);
        this.assertWritable();
      } catch (error) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          this.assertWritable();
          entry.state = "dead_letter";
          entry.nextAttemptAt = 0;
          entry.lastErrorCode = `http_${response.status}`;
          this.persist();
          return;
        }
        throw error;
      }
      if (response.status >= 200 && response.status < 300) {
        let ack: unknown;
        try {
          ack = JSON.parse(responseText);
        } catch {
          return this.retry(entry, "ambiguous_ack");
        }
        if (
          ack === null ||
          typeof ack !== "object" ||
          Array.isArray(ack) ||
          !hasExactKeys(ack as Record<string, unknown>, ["accepted", "deduped", "eventId"]) ||
          (ack as Record<string, unknown>).accepted !== true ||
          (ack as Record<string, unknown>).eventId !== entry.id ||
          typeof (ack as Record<string, unknown>).deduped !== "boolean"
        ) {
          return this.retry(entry, "ambiguous_ack");
        }
        this.assertWritable();
        entry.state = "acknowledged";
        delete entry.payload;
        entry.nextAttemptAt = 0;
        entry.lastErrorCode = null;
        this.persist();
        try {
          this.compactAcknowledged();
        } catch {
          // The durable acknowledged state is safe; a later admission or restart compacts it.
        }
        return;
      }
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return this.retry(entry, `http_${response.status}`);
      }
      if (response.status >= 400 && response.status < 500) {
        let code = `http_${response.status}`;
        try {
          const body = JSON.parse(responseText) as Record<string, unknown>;
          if (typeof body.errorCode === "string" && /^[a-z0-9_]{1,64}$/.test(body.errorCode)) {
            code = body.errorCode;
          }
        } catch {
          // The status remains a stable terminal code.
        }
        this.assertWritable();
        entry.state = "dead_letter";
        entry.nextAttemptAt = 0;
        entry.lastErrorCode = code;
        this.persist();
        return;
      }
      return this.retry(entry, "ambiguous_status");
    } catch (error) {
      if (this.persistenceFault) return;
      return this.retry(entry, (error as Error).name === "AbortError" ? "request_timeout" : "network_error");
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }

  private async readBounded(response: OutboxResponse): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > MAX_VAULT_EVENT_ACK_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("event acknowledgement is too large");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  private retry(entry: PendingEntry, errorCode: string): void {
    this.assertWritable();
    entry.lastErrorCode = errorCode;
    const exponent = Math.min(30, Math.max(0, entry.attempts - 1));
    const ceiling = Math.min(this.retryCapMs, this.retryBaseMs * 2 ** exponent);
    const random = Math.min(1, Math.max(0, this.random()));
    const delay = Math.max(1, Math.floor(ceiling * (0.75 + 0.25 * random)));
    entry.nextAttemptAt = Math.min(Number.MAX_SAFE_INTEGER, this.now() + delay);
    this.persist();
  }

  private compactAcknowledged(): void {
    this.assertWritable();
    const retained = this.state.entries.filter((entry) => entry.state !== "acknowledged");
    if (retained.length === this.state.entries.length) return;
    this.state = { ...this.state, entries: retained };
    this.persist();
  }
}
