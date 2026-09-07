import { WalletAccessError } from "../domain/walletAccess";

export const PRIVY_HTTP_REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [500, 1_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RETRY_AFTER_LENGTH = 128;
const MAX_RETRY_RESPONSE_BYTES = 64 * 1_024;
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

type FetchLike = typeof fetch;

export type PrivyHttpRetryPolicy =
  | "replay-safe"
  | "complete-response-only"
  | "rate-limit-only";

export interface PrivyHttpTransportOptions {
  fetch: FetchLike;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export type PrivyHttpTransportFailure =
  | "response_invalid"
  | "transport_ambiguous";

export class PrivyHttpTransportError extends Error {
  readonly name = "PrivyHttpTransportError";

  constructor(readonly failure: PrivyHttpTransportFailure) {
    super("Privy HTTP transport failed");
  }
}

function operationCancelled(): WalletAccessError {
  return new WalletAccessError(
    "privy_operation_cancelled",
    "The Privy operation was cancelled. Try again when ready."
  );
}

function parseBoundedDelaySeconds(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return null;
  let seconds = 0;
  for (const character of value) {
    seconds = seconds * 10 + (character.charCodeAt(0) - 48);
    if (seconds * 1_000 >= MAX_RETRY_AFTER_MS) return MAX_RETRY_AFTER_MS;
  }
  return seconds * 1_000;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.length > MAX_RETRY_AFTER_LENGTH) return null;
  const delaySeconds = parseBoundedDelaySeconds(value);
  if (delaySeconds !== null) return delaySeconds;
  if (!IMF_FIXDATE.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) {
    return null;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - now));
}

function retriesStatus(policy: PrivyHttpRetryPolicy, status: number): boolean {
  if (status === 429) return true;
  if (policy === "rate-limit-only") return false;
  return status === 408 || (status >= 500 && status <= 599);
}

async function consumeRetryResponse(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      bytes += next.value.byteLength;
      if (bytes > MAX_RETRY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PrivyHttpTransportError("response_invalid");
      }
    }
  } catch (error) {
    if (error instanceof PrivyHttpTransportError) throw error;
    throw new PrivyHttpTransportError("transport_ambiguous");
  } finally {
    reader.releaseLock();
  }
}

export class PrivyHttpTransport {
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly signal?: AbortSignal;
  private readonly requestTimeoutMs: number;

  constructor(options: PrivyHttpTransportOptions) {
    if (
      !Number.isSafeInteger(options.requestTimeoutMs ?? PRIVY_HTTP_REQUEST_TIMEOUT_MS) ||
      (options.requestTimeoutMs ?? PRIVY_HTTP_REQUEST_TIMEOUT_MS) <= 0 ||
      (options.requestTimeoutMs ?? PRIVY_HTTP_REQUEST_TIMEOUT_MS) > MAX_TIMER_DELAY_MS
    ) {
      throw new TypeError("requestTimeoutMs must be a positive timer-safe integer");
    }
    this.fetchImpl = options.fetch;
    this.sleepImpl = options.sleep;
    this.now = options.now;
    this.signal = options.signal;
    this.requestTimeoutMs = options.requestTimeoutMs ?? PRIVY_HTTP_REQUEST_TIMEOUT_MS;
  }

  async request<Result>(
    url: string,
    init: Omit<RequestInit, "signal">,
    policy: PrivyHttpRetryPolicy,
    handleResponse: (response: Response) => Promise<Result>
  ): Promise<Result> {
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt += 1) {
      let outcome:
        | { kind: "complete"; value: Result }
        | { kind: "retry"; delayMs: number };
      try {
        outcome = await this.runAttempt(url, init, async (response) => {
          if (
            !retriesStatus(policy, response.status) ||
            attempt >= RETRY_DELAYS_MS.length
          ) {
            return { kind: "complete", value: await handleResponse(response) };
          }
          const delayMs =
            response.status === 429
              ? parseRetryAfter(response.headers.get("retry-after"), this.now()) ??
                RETRY_DELAYS_MS[attempt]
              : RETRY_DELAYS_MS[attempt];
          await consumeRetryResponse(response);
          return { kind: "retry", delayMs };
        }, policy);
      } catch (error) {
        if (error instanceof WalletAccessError) throw error;
        if (
          !(error instanceof PrivyHttpTransportError) ||
          policy !== "replay-safe" ||
          attempt >= RETRY_DELAYS_MS.length
        ) {
          throw error;
        }
        await this.wait(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (outcome.kind === "complete") return outcome.value;
      await this.wait(outcome.delayMs);
    }
    throw new PrivyHttpTransportError("transport_ambiguous");
  }

  async wait(milliseconds: number): Promise<void> {
    this.throwIfCancelled();
    if (!this.signal) {
      await this.sleepImpl(milliseconds);
      return;
    }
    let removeAbortListener = (): void => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(operationCancelled());
      this.signal?.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => this.signal?.removeEventListener("abort", onAbort);
      if (this.signal?.aborted) onAbort();
    });
    try {
      await Promise.race([this.sleepImpl(milliseconds), cancelled]);
      this.throwIfCancelled();
    } finally {
      removeAbortListener();
    }
  }

  private async runAttempt<Result>(
    url: string,
    init: Omit<RequestInit, "signal">,
    handleResponse: (response: Response) => Promise<Result>,
    policy: PrivyHttpRetryPolicy
  ): Promise<Result> {
    this.throwIfCancelled();
    const controller = new AbortController();
    let cancelledByCaller = false;
    const cancelFromCaller = () => {
      cancelledByCaller = true;
      controller.abort();
    };
    this.signal?.addEventListener("abort", cancelFromCaller, { once: true });
    if (this.signal?.aborted) cancelFromCaller();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let removeInterruptListener = (): void => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const onInterrupt = () =>
        reject(
          (cancelledByCaller || this.signal?.aborted) && policy === "replay-safe"
            ? operationCancelled()
            : new PrivyHttpTransportError("transport_ambiguous")
        );
      controller.signal.addEventListener("abort", onInterrupt, { once: true });
      removeInterruptListener = () =>
        controller.signal.removeEventListener("abort", onInterrupt);
      if (controller.signal.aborted) onInterrupt();
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(url, {
            ...init,
            redirect: "manual",
            signal: controller.signal,
          }),
          interrupted,
        ]);
      } catch (error) {
        if (
          error instanceof WalletAccessError ||
          error instanceof PrivyHttpTransportError
        ) {
          throw error;
        }
        if (cancelledByCaller || this.signal?.aborted) {
          if (policy === "replay-safe") throw operationCancelled();
          throw new PrivyHttpTransportError("transport_ambiguous");
        }
        throw new PrivyHttpTransportError("transport_ambiguous");
      }
      try {
        return await Promise.race([handleResponse(response), interrupted]);
      } catch (error) {
        if (
          error instanceof WalletAccessError ||
          error instanceof PrivyHttpTransportError
        ) {
          throw error;
        }
        if (cancelledByCaller || this.signal?.aborted) {
          if (policy === "replay-safe") throw operationCancelled();
          throw new PrivyHttpTransportError("transport_ambiguous");
        }
        if (controller.signal.aborted) {
          throw new PrivyHttpTransportError("transport_ambiguous");
        }
        throw error;
      }
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", cancelFromCaller);
      removeInterruptListener();
    }
  }

  private throwIfCancelled(): void {
    if (this.signal?.aborted) throw operationCancelled();
  }
}
