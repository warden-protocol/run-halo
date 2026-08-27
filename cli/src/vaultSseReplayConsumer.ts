import type { Wallet } from "ethers";
import {
  EMPTY_VAULT_SSE_REPLAY_DIGEST,
  VAULT_SSE_REPLAY_COMMAND_TYPES,
  VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
  VAULT_SSE_REPLAY_RECEIPT_TYPES,
  advanceVaultSseReplayDigest,
  digestVaultSseReplayRequest,
  isVaultSseReplayResultExpiry,
  isVaultSseReplayPricingQuoteUsable,
  parseVaultSseReplayManifest,
  parseVaultSseReplayPrepareResponse,
  recoverVaultSseReplayManifestSigner,
  vaultSseReplayRequestChargeCeiling,
  vaultSseReplayCommandValue,
  vaultSseReplayDomain,
  vaultSseReplayReceiptValue,
  type VaultSseReplayCommand,
  type VaultSseReplayManifest,
  type VaultSseReplayPair,
  type VaultSseReplayPricingQuoteV1,
  type VaultSseReplayPrepareResponse,
  type VaultSseReplayReceiptDelivery,
} from "@halo/vault-core";

const RUNNING_DEADLINE_MS = 120_000;
const COMMAND_TTL_MS = 8_000;
const PREPARE_REQUEST_TIMEOUT_MS = 10_000;
const CANCEL_REQUEST_TIMEOUT_MS = 2_000;
const RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000] as const;

export interface CliVaultSseReplayResult {
  body: unknown;
  manifest: VaultSseReplayManifest;
  resultExpiresAtMs: number;
  requestId: string;
  resumeToken: string;
  pair: VaultSseReplayPair;
}

export interface RunCliVaultSseReplayInput {
  relayUrl: string;
  path: "/v1/chat/completions";
  requestBody: string;
  maxAmountUsdc: bigint;
  pair: VaultSseReplayPair;
  sessionWallet: Pick<Wallet, "signTypedData">;
  decryptFrame: (envelope: unknown) => Promise<unknown>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export function cliOperatorSupportsVaultSseReplayModel(
  operator: {
    vaultSseReplayV1Models?: string[];
    vaultSseReplayPricingV1Models?: string[];
    vaultSseReplayPricingV1?: Record<string, VaultSseReplayPricingQuoteV1>;
    vaultProtocols?: string[];
  },
  model: string
): boolean {
  if (cliOperatorVaultSseReplayPricingQuote(operator, model)) return true;
  return (
    Array.isArray(operator.vaultSseReplayV1Models) &&
    operator.vaultSseReplayV1Models.includes(model)
  );
}

export function cliOperatorVaultSseReplayPricingQuote(
  operator: {
    vaultSseReplayPricingV1Models?: string[];
    vaultSseReplayPricingV1?: Record<string, VaultSseReplayPricingQuoteV1>;
  },
  model: string,
  nowMs: number = Date.now()
): VaultSseReplayPricingQuoteV1 | null {
  const quote = operator.vaultSseReplayPricingV1?.[model];
  return operator.vaultSseReplayPricingV1Models?.includes(model) &&
    quote &&
    isVaultSseReplayPricingQuoteUsable(quote, model, nowMs)
    ? quote
    : null;
}

export function buildCliVaultSseReplayRequestBody(
  model: unknown,
  encryptedEnvelope: unknown,
  maxAmountUsdc: bigint,
  pricingQuoteId?: string
): Record<string, unknown> {
  return {
    model,
    stream: true,
    _enc: encryptedEnvelope,
    maxAmountUsdc: maxAmountUsdc.toString(),
    ...(pricingQuoteId ? { pricingQuoteId } : {}),
  };
}

interface ReplayToolCall {
  id?: string;
  type?: string;
  function: {
    name?: string;
    arguments: string;
  };
}

interface ReplayAccumulator {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  systemFingerprint?: string;
  usage?: unknown;
  role?: string;
  content: string;
  finishReason?: string;
  toolCalls: Map<number, ReplayToolCall>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  const candidate = record(value);
  if (!candidate) return false;
  const actual = Object.keys(candidate).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function stableString(
  current: string | undefined,
  next: unknown,
  field: string
): string | undefined {
  if (next === undefined || next === null) return current;
  if (typeof next !== "string" || (current !== undefined && current !== next)) {
    throw new Error(`vault replay response changed ${field}`);
  }
  return next;
}

function mergeToolCall(
  accumulator: ReplayAccumulator,
  value: unknown
): void {
  const call = record(value);
  const index = call?.index;
  if (
    !call ||
    !Number.isSafeInteger(index) ||
    (index as number) < 0
  ) {
    throw new Error("vault replay response contained an invalid tool call");
  }
  const existing = accumulator.toolCalls.get(index as number) ?? {
    function: { arguments: "" },
  };
  existing.id = stableString(existing.id, call.id, "tool-call id");
  existing.type = stableString(existing.type, call.type, "tool-call type");
  if (call.function !== undefined) {
    const fn = record(call.function);
    if (!fn) {
      throw new Error("vault replay response contained an invalid tool function");
    }
    existing.function.name = stableString(
      existing.function.name,
      fn.name,
      "tool-call function name"
    );
    if (fn.arguments !== undefined) {
      if (typeof fn.arguments !== "string") {
        throw new Error("vault replay response contained invalid tool arguments");
      }
      existing.function.arguments += fn.arguments;
    }
  }
  accumulator.toolCalls.set(index as number, existing);
}

function applyDelta(accumulator: ReplayAccumulator, value: unknown): void {
  const chunk = record(value);
  if (!chunk) {
    throw new Error("vault replay frame decrypted to an invalid response chunk");
  }
  accumulator.id = stableString(accumulator.id, chunk.id, "completion id");
  accumulator.object = stableString(accumulator.object, chunk.object, "completion object");
  accumulator.model = stableString(accumulator.model, chunk.model, "model");
  accumulator.systemFingerprint = stableString(
    accumulator.systemFingerprint,
    chunk.system_fingerprint,
    "system fingerprint"
  );
  if (chunk.created !== undefined) {
    if (
      !Number.isSafeInteger(chunk.created) ||
      (accumulator.created !== undefined && accumulator.created !== chunk.created)
    ) {
      throw new Error("vault replay response changed completion timestamp");
    }
    accumulator.created = chunk.created as number;
  }
  if (chunk.usage !== undefined) accumulator.usage = chunk.usage;
  if (!Array.isArray(chunk.choices)) {
    throw new Error("vault replay response contained an invalid choice set");
  }
  if (chunk.choices.length === 0 && chunk.usage !== undefined) return;
  if (chunk.choices.length !== 1) {
    throw new Error("vault replay response contained an invalid choice set");
  }
  const choice = record(chunk.choices[0]);
  if (!choice || (choice.index !== undefined && choice.index !== 0)) {
    throw new Error("vault replay response contained an invalid choice");
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    accumulator.finishReason = stableString(
      accumulator.finishReason,
      choice.finish_reason,
      "finish reason"
    );
  }
  const delta = record(choice.delta);
  if (!delta) {
    throw new Error("vault replay response contained an invalid delta");
  }
  accumulator.role = stableString(accumulator.role, delta.role, "message role");
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string") {
      throw new Error("vault replay response chunk has invalid content");
    }
    accumulator.content += delta.content;
  }
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) {
      throw new Error("vault replay response contained invalid tool calls");
    }
    for (const call of delta.tool_calls) mergeToolCall(accumulator, call);
  }
}

function bufferedCompletion(accumulator: ReplayAccumulator): unknown {
  const toolCalls = [...accumulator.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  return {
    id: accumulator.id,
    object:
      accumulator.object === "chat.completion.chunk"
        ? "chat.completion"
        : accumulator.object ?? "chat.completion",
    created: accumulator.created,
    model: accumulator.model,
    choices: [
      {
        index: 0,
        message: {
          role: accumulator.role ?? "assistant",
          content:
            toolCalls.length > 0 && accumulator.content.length === 0
              ? null
              : accumulator.content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          accumulator.finishReason ??
          (toolCalls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    ...(accumulator.systemFingerprint !== undefined
      ? { system_fingerprint: accumulator.systemFingerprint }
      : {}),
    ...(accumulator.usage !== undefined ? { usage: accumulator.usage } : {}),
  };
}

interface ReplayDeadlineBoundary {
  signal: AbortSignal;
  wait<T>(promise: Promise<T>): Promise<T>;
  timedOut(): boolean;
  dispose(): void;
}

function replayDeadlineError(): Error {
  return new Error("vault replay exceeded the inference deadline");
}

function createReplayDeadlineBoundary(
  deadlineMs: number,
  now: () => number,
  callerSignal?: AbortSignal
): ReplayDeadlineBoundary {
  const controller = new AbortController();
  let timedOut = false;
  let settled = false;
  let rejectBoundary: (error: unknown) => void = () => {};
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  void boundary.catch(() => {});
  const fail = (error: unknown, deadline: boolean) => {
    if (settled) return;
    settled = true;
    timedOut = deadline;
    controller.abort(error);
    rejectBoundary(error);
  };
  const onAbort = () =>
    fail(
      callerSignal?.reason instanceof Error
        ? callerSignal.reason
        : new Error("vault replay aborted"),
      false
    );
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  const remainingMs = deadlineMs - now();
  const timeout =
    remainingMs <= 0
      ? undefined
      : setTimeout(() => fail(replayDeadlineError(), true), remainingMs);
  if (remainingMs <= 0) fail(replayDeadlineError(), true);
  return {
    signal: controller.signal,
    wait: <T>(promise: Promise<T>) => Promise.race([promise, boundary]),
    timedOut: () => timedOut,
    dispose: () => {
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

async function waitForRetryDelay(
  delayMs: number,
  deadlineMs: number,
  now: () => number,
  sleep: (delayMs: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (delayMs <= 0) return;
  const boundary = createReplayDeadlineBoundary(deadlineMs, now, signal);
  try {
    await boundary.wait(sleep(delayMs));
  } finally {
    boundary.dispose();
  }
}

async function responseError(
  res: Response,
  boundary: ReplayDeadlineBoundary
): Promise<Error> {
  const body = await boundary.wait(res.clone().json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const message =
    typeof body?.error?.message === "string"
      ? body.error.message
      : `vault replay request failed (HTTP ${res.status})`;
  return new Error(message);
}

async function signCommand(
  sessionWallet: Pick<Wallet, "signTypedData">,
  command: Omit<VaultSseReplayCommand, "signature">
): Promise<VaultSseReplayCommand> {
  const signature = await sessionWallet.signTypedData(
    vaultSseReplayDomain(command.pair.chainId, command.pair.vault),
    VAULT_SSE_REPLAY_COMMAND_TYPES,
    vaultSseReplayCommandValue(command)
  );
  return { ...command, signature };
}

function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function* readSseEvents(
  res: Response,
  boundary: ReplayDeadlineBoundary
): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("vault replay response has no stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await boundary.wait(reader.read());
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) {
            data.push(line.slice(5).trimStart());
          }
        }
        if (data.length === 0) continue;
        try {
          yield { event, data: JSON.parse(data.join("\n")) };
        } catch {
          throw new Error("vault replay returned malformed SSE data");
        }
      }
      if (done) {
        completed = true;
        break;
      }
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => {});
  }
}

async function cancelReplay(
  input: RunCliVaultSseReplayInput,
  prepared: VaultSseReplayPrepareResponse
): Promise<void> {
  const now = input.now ?? Date.now;
  const requestDeadline = now() + CANCEL_REQUEST_TIMEOUT_MS;
  const command = await signCommand(input.sessionWallet, {
    protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    command: "cancel",
    requestId: prepared.requestId,
    resumeToken: prepared.resumeToken,
    pair: input.pair,
    expiresAtMs: now() + COMMAND_TTL_MS,
  });
  const boundary = createReplayDeadlineBoundary(requestDeadline, now);
  try {
    await boundary.wait(
      (input.fetchImpl ?? fetch)(
        `${input.relayUrl.replace(/\/+$/, "")}/v1/vault-sse-replay/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command),
          signal: boundary.signal,
        }
      )
    );
  } finally {
    boundary.dispose();
  }
}

export async function runCliVaultSseReplay(
  input: RunCliVaultSseReplayInput
): Promise<CliVaultSseReplayResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  const boundCharge = vaultSseReplayRequestChargeCeiling(input.requestBody);
  if (!boundCharge || BigInt(boundCharge) !== input.maxAmountUsdc) {
    throw new Error("vault replay request has an invalid charge ceiling");
  }
  input.signal?.throwIfAborted();
  const prepareBoundary = createReplayDeadlineBoundary(
    now() + PREPARE_REQUEST_TIMEOUT_MS,
    now,
    input.signal
  );
  let prepared: VaultSseReplayPrepareResponse | null;
  try {
    const prepareResponse = await prepareBoundary.wait(
      fetchImpl(`${relayUrl}/v1/vault-sse-replay/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
          path: input.path,
          requestBody: input.requestBody,
          pair: input.pair,
        }),
        signal: prepareBoundary.signal,
      })
    );
    if (!prepareResponse.ok) {
      throw await responseError(prepareResponse, prepareBoundary);
    }
    prepared = parseVaultSseReplayPrepareResponse(
      await prepareBoundary.wait(prepareResponse.json())
    );
  } finally {
    prepareBoundary.dispose();
  }
  if (!prepared) {
    throw new Error("relay returned an invalid vault replay preparation");
  }
  const requestDigest = digestVaultSseReplayRequest(input.requestBody);
  const runningDeadline = now() + RUNNING_DEADLINE_MS;
  const frames: string[] = [];
  let responseDigest = EMPTY_VAULT_SSE_REPLAY_DIGEST;
  const accumulator: ReplayAccumulator = {
    content: "",
    toolCalls: new Map(),
  };
  let attached = false;
  let retry = 0;
  let terminal = false;

  try {
    while (now() < runningDeadline) {
      input.signal?.throwIfAborted();
      const delay = retryDelay(retry++);
      await waitForRetryDelay(
        delay,
        runningDeadline,
        now,
        sleep,
        input.signal
      );
      input.signal?.throwIfAborted();
      if (now() >= runningDeadline) break;
      const commandName = attached ? "resume" : "attach";
      const command = await signCommand(input.sessionWallet, {
        protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
        command: commandName,
        requestId: prepared.requestId,
        resumeToken: prepared.resumeToken,
        pair: input.pair,
        expiresAtMs: now() + COMMAND_TTL_MS,
      });
      const attemptBoundary = createReplayDeadlineBoundary(
        runningDeadline,
        now,
        input.signal
      );
      try {
        let response: Response;
        try {
          response = await attemptBoundary.wait(
            fetchImpl(`${relayUrl}/v1/vault-sse-replay/${commandName}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                commandName === "attach"
                  ? { ...command, requestBody: input.requestBody }
                  : command
              ),
              signal: attemptBoundary.signal,
            })
          );
        } catch (error) {
          if (input.signal?.aborted) throw error;
          if (attemptBoundary.timedOut()) throw replayDeadlineError();
          continue;
        }
        if (!response.ok) {
          if ([401, 404, 410].includes(response.status)) {
            throw await responseError(response, attemptBoundary);
          }
          continue;
        }
        attached = true;
        let connectionIndex = 0;
        try {
          for await (const message of readSseEvents(response, attemptBoundary)) {
            if (message.event === "halo-replay-attached") {
              if (
                !exactRecord(message.data, [
                  "protocol",
                  "requestId",
                  "state",
                  "resultExpiresAtMs",
                ]) ||
                message.data.protocol !== VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL ||
                message.data.requestId !== prepared.requestId ||
                (message.data.state !== "authorizing" &&
                  message.data.state !== "running" &&
                  message.data.state !== "complete") ||
                (message.data.resultExpiresAtMs !== null &&
                  !Number.isSafeInteger(message.data.resultExpiresAtMs))
              ) {
                throw new Error("vault replay returned an invalid attachment");
              }
              continue;
            }
            if (message.event === "halo-replay-frame") {
              if (
                !exactRecord(message.data, [
                  "requestId",
                  "index",
                  "data",
                  "encrypted",
                ]) ||
                message.data.requestId !== prepared.requestId ||
                message.data.index !== connectionIndex ||
                typeof message.data.data !== "string" ||
                message.data.encrypted !== true
              ) {
                throw new Error(
                  "vault replay returned an invalid or non-contiguous frame"
                );
              }
              const frameData = message.data.data;
              if (connectionIndex < frames.length) {
                if (frames[connectionIndex] !== frameData) {
                  throw new Error(
                    "vault replay changed a previously delivered frame"
                  );
                }
              } else {
                let envelope: unknown;
                try {
                  envelope = JSON.parse(frameData);
                } catch {
                  throw new Error("vault replay returned an invalid encrypted frame");
                }
                let decrypted: unknown;
                try {
                  decrypted = await input.decryptFrame(envelope);
                } catch {
                  throw new Error(
                    "vault replay returned an invalid encrypted response"
                  );
                }
                applyDelta(accumulator, decrypted);
                frames.push(frameData);
                responseDigest = advanceVaultSseReplayDigest(
                  responseDigest,
                  frameData
                );
              }
              connectionIndex += 1;
              continue;
            }
            if (message.event === "halo-replay-result") {
              if (
                !exactRecord(message.data, ["manifest", "resultExpiresAtMs"])
              ) {
                throw new Error("vault replay returned an invalid terminal result");
              }
              const manifest = parseVaultSseReplayManifest(message.data.manifest);
              const resultExpiresAtMs = message.data.resultExpiresAtMs as number;
              const resultReceivedAtMs = now();
              if (
                !manifest ||
                recoverVaultSseReplayManifestSigner(
                  manifest,
                  input.pair.chainId
                ) !== input.pair.operator ||
                manifest.requestId !== prepared.requestId ||
                manifest.requestDigest !== requestDigest ||
                manifest.responseDigest !== responseDigest ||
                manifest.vault !== input.pair.vault ||
                manifest.consumer !== input.pair.consumer ||
                manifest.operator !== input.pair.operator ||
                manifest.cycle !== input.pair.cycle ||
                manifest.keyEpoch !== input.pair.keyEpoch ||
                BigInt(manifest.amountUsdc) > input.maxAmountUsdc ||
                manifest.frameCount !== frames.length ||
                !isVaultSseReplayResultExpiry(
                  resultExpiresAtMs,
                  resultReceivedAtMs
                )
              ) {
                throw new Error(
                  "vault replay terminal manifest failed verification"
                );
              }
              terminal = true;
              return {
                body: bufferedCompletion(accumulator),
                manifest,
                resultExpiresAtMs,
                requestId: prepared.requestId,
                resumeToken: prepared.resumeToken,
                pair: input.pair,
              };
            }
            if (
              message.event === "halo-replay-cancelled" ||
              message.event === "halo-replay-expired"
            ) {
              throw new Error("vault replay ended before receipt custody");
            }
            if (message.event === "halo-replay-invalid") {
              throw new Error("vault replay authorization failed verification");
            }
          }
        } catch (error) {
          if (input.signal?.aborted) throw error;
          if (
            /invalid|changed|verification|deadline/.test(
              error instanceof Error ? error.message : ""
            )
          ) {
            throw error;
          }
        }
      } finally {
        attemptBoundary.dispose();
      }
    }
    throw new Error("vault replay exceeded the inference deadline");
  } finally {
    if (!terminal) await cancelReplay(input, prepared).catch(() => {});
  }
}

export async function deliverCliVaultSseReplayReceipt(
  result: CliVaultSseReplayResult,
  sessionWallet: Pick<Wallet, "signTypedData">,
  receipt: {
    priorCumulative: string;
    targetCumulative: string;
    receiptSignature: string;
  },
  options: {
    relayUrl: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
  }
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  options.signal?.throwIfAborted();
  const unsigned: Omit<VaultSseReplayReceiptDelivery, "signature"> = {
    protocol: VAULT_SSE_REPLAY_EPHEMERAL_PROTOCOL,
    requestId: result.requestId,
    responseDigest: result.manifest.responseDigest,
    pair: result.pair,
    priorCumulative: receipt.priorCumulative,
    targetCumulative: receipt.targetCumulative,
    receiptSignature: receipt.receiptSignature,
    expiresAtMs: result.resultExpiresAtMs,
  };
  const signature = await sessionWallet.signTypedData(
    vaultSseReplayDomain(result.pair.chainId, result.pair.vault),
    VAULT_SSE_REPLAY_RECEIPT_TYPES,
    vaultSseReplayReceiptValue(unsigned)
  );
  const delivery: VaultSseReplayReceiptDelivery = {
    ...unsigned,
    signature,
  };
  let retry = 0;
  while (now() < result.resultExpiresAtMs) {
    options.signal?.throwIfAborted();
    const delay = retryDelay(retry++);
    await waitForRetryDelay(
      delay,
      result.resultExpiresAtMs,
      now,
      sleep,
      options.signal
    );
    options.signal?.throwIfAborted();
    if (now() >= result.resultExpiresAtMs) break;
    const attemptBoundary = createReplayDeadlineBoundary(
      result.resultExpiresAtMs,
      now,
      options.signal
    );
    try {
      let response: Response;
      try {
        response = await attemptBoundary.wait(
          fetchImpl(`${options.relayUrl.replace(/\/+$/, "")}/v1/vault-sse-replay/receipt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(delivery),
            signal: attemptBoundary.signal,
          })
        );
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (attemptBoundary.timedOut()) break;
        continue;
      }
      if (response.status === 202) return;
      if ([400, 401, 404, 410].includes(response.status)) {
        throw await responseError(response, attemptBoundary);
      }
    } finally {
      attemptBoundary.dispose();
    }
  }
  throw new Error("operator did not acknowledge replay receipt before expiry");
}
