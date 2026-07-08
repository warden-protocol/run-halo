/**
 * Consumer-side x402 payment flow, shared by `halo pay` (one-shot) and
 * `halo consume` (local server).
 *
 * Given a wallet, this does the consumer half of x402 in "exact" mode:
 *   1. POST the request unpaid → expect 402 + PAYMENT-REQUIRED
 *   2. sign an EIP-3009 TransferWithAuthorization for exactly the required amount
 *   3. retry with PAYMENT-SIGNATURE → return the operator's response
 *
 * Unlike the original inline flow in pay.ts, this NEVER calls process.exit: it
 * throws X402Error on a guard failure so a long-lived server can reject a single
 * request without dying. The CLI `pay` command catches and prints; the consume
 * server maps it to an HTTP error.
 */
import { ethers } from "ethers";
import { setCliVersionHeader } from "./versionHeader";
import { BASE_CHAIN_ID } from "./config";

export class X402Error extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "X402Error";
  }
}

const USDC_BY_CHAIN: Record<number, string> = {
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

/** Default per-request ceiling we'll sign for. $1 in USDC base units. */
export const DEFAULT_MAX_USDC_BASE = 1_000_000n;

// Upstream-call ceiling. The exact scheme runs inference AFTER the request and
// the relay allows slow (large-output) models up to ~120s, with settlement on
// top — so a single relay call can legitimately take minutes. Bound it anyway so
// a wedged relay/operator can never hang an agent's request forever: it fails
// with an actionable timeout instead. Covers both the unpaid probe (an operator
// may serve free, doing inference there) and the paid retry.
const RELAY_CALL_TIMEOUT_MS = 300_000;
// How many times to re-try the UNPAID probe on a connection-level failure
// (relay restarting, transient reset). Only the probe is retried — never a call
// that has already signed/sent a payment, which must not be duplicated.
const PROBE_RETRIES = 2;
const PROBE_RETRY_BASE_DELAY_MS = 300;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `fetch` with a hard timeout, composable with a caller's cancel signal (client
 * disconnect). Aborts on whichever fires first. The timeout reason is a plain
 * Error so callers can tell "relay too slow" from "client went away".
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    // Normalise the abort into a legible error. A caller-driven abort (client
    // disconnect) is surfaced distinctly from a timeout so we don't waste a
    // retry on a request nobody is waiting for anymore.
    if (externalSignal?.aborted) throw new X402Error("client disconnected", "client_aborted");
    if (timeout.aborted) {
      throw new X402Error(`relay did not respond within ${Math.round(timeoutMs / 1000)}s`, "upstream_timeout");
    }
    throw err;
  }
}

/**
 * Is this error worth retrying the UNPAID probe for? Only transient
 * connection-level faults (relay bouncing, socket reset) — never a timeout
 * (could mean a slow free-serve we'd duplicate) and never a client disconnect.
 */
function isConnRetryable(err: unknown): boolean {
  if (err instanceof X402Error) return false; // timeouts/aborts/guard failures
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const cause = err instanceof Error && err.cause ? String((err.cause as { code?: string }).code || err.cause).toLowerCase() : "";
  return /econnrefused|econnreset|enotfound|eai_again|epipe|fetch failed|socket hang up|terminated|network/.test(
    `${msg} ${cause}`
  );
}

export interface PayContext {
  /** Wallet that signs and pays — the consumer identity. */
  wallet: ethers.Signer & { address: string };
}

export interface PayAndFetchOptions {
  /** Max USDC base units to sign for a single request. Defaults to $1. */
  maxAmountBase?: bigint;
  /** Extra headers forwarded on BOTH the probe and the paid retry (e.g. x-halo-* routing hints). */
  forwardHeaders?: Record<string, string>;
  /** Invoked once a 402 is about to be paid, for logging. */
  onPaying?: (info: { amountBase: string; payTo: string }) => void;
  /** Cancel signal — aborts the upstream call when the client disconnects so we
   *  don't keep paying for a response nobody is waiting for. */
  signal?: AbortSignal;
}

export interface PayAndFetchResult {
  status: number;
  headers: Headers;
  body: string;
  /** True if a 402 was encountered and a payment was signed + retried. */
  paid: boolean;
  /** Decoded PAYMENT-RESPONSE settlement, if the operator returned one. */
  settlement?: unknown;
  /** USDC base units actually charged (the signed amount = exact-scheme charge),
   *  set only when `paid`. Used by the consume sidecar's cumulative spend cap. */
  chargedBase?: string;
}

interface PaymentRequired {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  extra?: { chainId?: number; domainName?: string; domainVersion?: string };
}

/**
 * Run the x402 exact flow for one request. Returns the final operator response
 * (the paid retry if a 402 was hit, otherwise the original response untouched).
 */
export async function payAndFetch(
  url: string,
  body: unknown,
  ctx: PayContext,
  opts: PayAndFetchOptions = {}
): Promise<PayAndFetchResult> {
  const maxAmountBase = opts.maxAmountBase ?? DEFAULT_MAX_USDC_BASE;
  const bodyStr = JSON.stringify(body);
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.forwardHeaders ?? {}),
  };
  setCliVersionHeader(baseHeaders);

  // 1) Unpaid probe — bounded timeout, with a few retries on transient
  // connection faults (a relay mid-restart is the common cause of the
  // "Connection error" an agent sees). Safe to retry: no payment has been signed.
  let first: Response;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new X402Error("client disconnected", "client_aborted");
    try {
      first = await fetchWithTimeout(
        url,
        { method: "POST", headers: baseHeaders, body: bodyStr },
        RELAY_CALL_TIMEOUT_MS,
        opts.signal
      );
      break;
    } catch (err) {
      if (attempt >= PROBE_RETRIES || !isConnRetryable(err)) {
        throw err instanceof X402Error
          ? err
          : new X402Error(`relay unreachable: ${err instanceof Error ? err.message : String(err)}`, "relay_unreachable");
      }
      await delay(PROBE_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  // Not a payment challenge: the operator served free, or returned an error.
  // Pass it straight back — the caller decides what a non-200 means.
  if (first.status !== 402) {
    return {
      status: first.status,
      headers: first.headers,
      body: await first.text(),
      paid: false,
    };
  }

  const header = first.headers.get("PAYMENT-REQUIRED");
  // Pin the paid retry to the SAME operator that issued this 402. The relay
  // selects an operator per request (default routing is "balanced"), so without
  // the pin the retry can land on a DIFFERENT operator whose payTo doesn't match
  // the EIP-3009 signature → "payTo mismatch", payment rejected. The signature is
  // bound to this operator's payTo, so the retry must go back to it.
  const pinnedOperator = first.headers.get("X-Halo-Operator");
  await first.text(); // drain the 402 body
  if (!header) {
    throw new X402Error("402 response missing PAYMENT-REQUIRED header", "no_payment_header");
  }

  let pr: PaymentRequired;
  try {
    pr = JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as PaymentRequired;
  } catch {
    throw new X402Error("PAYMENT-REQUIRED header is not valid base64 JSON", "bad_payment_header");
  }

  const paymentSignatureHeader = await signExactPayment(pr, ctx, maxAmountBase);
  opts.onPaying?.({ amountBase: pr.maxAmountRequired, payTo: pr.payTo });

  // 2) Paid retry — pinned to the probe's operator (see above).
  const retryHeaders: Record<string, string> = {
    ...baseHeaders,
    "PAYMENT-SIGNATURE": paymentSignatureHeader,
  };
  if (pinnedOperator) retryHeaders["X-Halo-Operator"] = pinnedOperator;
  // Single attempt — the payment is signed with a one-time nonce, so a retry
  // would either replay-fail or risk a double-serve. A bounded timeout still
  // protects against a wedged operator hanging the request forever.
  const retry = await fetchWithTimeout(
    url,
    { method: "POST", headers: retryHeaders, body: bodyStr },
    RELAY_CALL_TIMEOUT_MS,
    opts.signal
  );

  let settlement: unknown;
  const settleHeader = retry.headers.get("PAYMENT-RESPONSE");
  if (settleHeader) {
    try {
      settlement = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf-8"));
    } catch {
      settlement = settleHeader;
    }
  }

  // `paid` reflects ACTUAL settlement, not merely "the retry returned content".
  // When on-chain settlement fails (e.g. the consumer wallet is unfunded, so
  // `transferWithAuthorization` reverts), the operator serves the inference but
  // returns NO PAYMENT-RESPONSE header — the request was effectively free, no USDC
  // moved. Reporting paid:true there is a lie that masks an unfunded wallet and a
  // free-serve hole. Tie paid to the presence of a settlement confirmation.
  const paid = retry.ok && !!settleHeader;
  // Exact scheme charges exactly the signed amount (= the 402 quote). Prefer the
  // operator's reported settled amount when present, else the signed value.
  let chargedBase: string | undefined;
  if (paid) {
    const settledAmt = (settlement as { amount?: string } | undefined)?.amount;
    chargedBase = settledAmt && /^\d+$/.test(settledAmt) ? settledAmt : pr.maxAmountRequired;
  }
  return {
    status: retry.status,
    headers: retry.headers,
    body: await retry.text(),
    paid,
    settlement,
    chargedBase,
  };
}

/**
 * Validate a PAYMENT-REQUIRED challenge and sign an EIP-3009
 * TransferWithAuthorization for exactly the required amount. Returns the
 * base64 PAYMENT-SIGNATURE header value. Throws X402Error on any guard failure.
 */
async function signExactPayment(
  pr: PaymentRequired,
  ctx: PayContext,
  maxAmountBase: bigint
): Promise<string> {
  const chainId = pr.extra?.chainId ?? BASE_CHAIN_ID;
  const expectedChain = BASE_CHAIN_ID;
  if (chainId !== expectedChain) {
    throw new X402Error(`chainId mismatch: server ${chainId}, config ${expectedChain}`, "chain_mismatch");
  }

  const expectedUsdc = USDC_BY_CHAIN[chainId]?.toLowerCase();
  if (!expectedUsdc || pr.asset.toLowerCase() !== expectedUsdc) {
    throw new X402Error(`unexpected asset ${pr.asset} — only USDC is signed`, "bad_asset");
  }

  const signedValue = BigInt(pr.maxAmountRequired);
  if (signedValue > maxAmountBase) {
    throw new X402Error(
      `server requested ${signedValue} base units (> ${maxAmountBase} cap)`,
      "over_cap"
    );
  }

  const domainName = pr.extra?.domainName ?? "USD Coin";
  const domainVersion = pr.extra?.domainVersion ?? "2";
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  // Honor the operator's requested window (up to 300s). Settlement happens AFTER
  // inference in the exact scheme, so the authorization must stay valid for the
  // whole sign→inference→settle→mine span. Slow (large-output) models run close
  // to the relay's 120s inference ceiling, and settlement lands on top of that —
  // a 120s cap expired mid-flight and the settle failed "authorization expired"
  // (operator then served free, no points). 300s matches the operator's
  // x402-server window with margin; still bounded so a stale sig can't linger.
  const validBefore = now + Math.min(pr.maxTimeoutSeconds || 60, 300);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const domain: ethers.TypedDataDomain = {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract: pr.asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const message = {
    from: ctx.wallet.address,
    to: pr.payTo,
    value: pr.maxAmountRequired,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await ctx.wallet.signTypedData(domain, types, message);
  const paymentPayload = {
    signature,
    authType: "TransferWithAuthorization",
    payload: message,
  };
  return Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
}
