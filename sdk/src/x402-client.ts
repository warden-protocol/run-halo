/**
 * x402 client — pay-side helper.
 *
 * Wraps fetch() so any ethers.Signer can pay 402-gated services. Targets the
 * standard "exact" EVM scheme (USDC.transferWithAuthorization), which is what
 * Coinbase's CDP facilitator submits onchain.
 *
 * Wire format:
 *   - 402 response carries PAYMENT-REQUIRED header, base64(JSON) of X402PaymentRequired
 *   - Client signs an EIP-3009 TransferWithAuthorization
 *   - Retry request with PAYMENT-SIGNATURE header, base64(JSON) of X402PaymentPayload
 */
import { ethers } from "ethers";
import { getChain, resolveChainId } from "./chains";
import type {
  X402PaymentRequired,
  X402PaymentPayload,
} from "./types";

export interface X402PayOptions {
  /** Hard cap in USDC base units (6 decimals). Aborts if server requires more. */
  maxAmount?: bigint;
  chainIdOverride?: number;
  domainNameOverride?: string;
  domainVersionOverride?: string;
  /** Called before signing; return false to abort. */
  onPaymentRequired?: (
    details: X402PaymentRequired
  ) => Promise<boolean> | boolean;
}

export interface X402FetchResult {
  response: Response;
  paid: boolean;
  paymentAmount?: bigint;
  settlement?: unknown;
}

function b64encode(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "utf-8").toString("base64");
  return btoa(s);
}

function b64decode(s: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
  return atob(s);
}

export function parsePaymentRequired(header: string): X402PaymentRequired {
  const trimmed = header.trim();
  const json = trimmed.startsWith("{") ? trimmed : b64decode(trimmed);
  return JSON.parse(json) as X402PaymentRequired;
}

export async function signX402Payment(
  signer: ethers.Signer,
  paymentRequired: X402PaymentRequired,
  options: X402PayOptions = {}
): Promise<X402PaymentPayload> {
  const value = BigInt(paymentRequired.maxAmountRequired);
  if (options.maxAmount !== undefined && value > options.maxAmount) {
    throw new Error(
      `x402 server requires ${value} base units, exceeds maxAmount ${options.maxAmount}`
    );
  }

  const chainId = resolveChainId(
    paymentRequired.network,
    options.chainIdOverride ?? paymentRequired.extra?.chainId
  );
  const chain = getChain(chainId);
  const domainName =
    options.domainNameOverride ??
    paymentRequired.extra?.domainName ??
    chain.usdcDomainName;
  const domainVersion =
    options.domainVersionOverride ??
    paymentRequired.extra?.domainVersion ??
    chain.usdcDomainVersion;

  const from = await signer.getAddress();
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + (paymentRequired.maxTimeoutSeconds || 60);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const domain: ethers.TypedDataDomain = {
    name: domainName,
    version: domainVersion,
    chainId,
    verifyingContract: paymentRequired.asset,
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
    from,
    to: paymentRequired.payTo,
    value: value.toString(),
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await signer.signTypedData(domain, types, message);

  return {
    signature,
    authType: "TransferWithAuthorization",
    payload: {
      from,
      to: paymentRequired.payTo,
      value: value.toString(),
      validAfter,
      validBefore,
      nonce,
    },
  };
}

export function encodePaymentSignature(payload: X402PaymentPayload): string {
  return b64encode(JSON.stringify(payload));
}

/**
 * fetch() that handles 402 Payment Required.
 *
 * Returns paid=true only when the retry succeeds. HTTP errors from the retry
 * are surfaced as a normal Response so the caller can inspect them.
 *
 * CONTRACT (changed in #384 — breaking for callers written against the older
 * behavior): a `402` WITHOUT a `PAYMENT-REQUIRED` header — e.g. the relay's
 * `vault_payment_required` gate — is NOT an x402 challenge this client can pay, so it
 * now RESOLVES as `{ response, paid: false }` instead of throwing. Callers MUST inspect
 * `response.ok` / `response.status` (and `paid`) and must not assume a resolved result
 * means success; the resolved `response.body` may be a payment-gate error envelope.
 * (An `onPaymentRequired` that returns false still throws "Payment declined by caller".)
 */
export async function fetchWithX402(
  input: string | URL,
  init: RequestInit,
  signer: ethers.Signer,
  options: X402PayOptions = {}
): Promise<X402FetchResult> {
  const first = await fetch(input, init);
  if (first.status !== 402) {
    return { response: first, paid: false };
  }

  const header = first.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    // A 402 without a PAYMENT-REQUIRED header isn't an x402 challenge we can pay
    // (e.g. a relay vault gate's `vault_payment_required`). Per this function's
    // contract, surface it as a normal Response — paid=false, body intact — so
    // the caller can inspect the status/body instead of getting an opaque throw.
    return { response: first, paid: false };
  }

  // Drain so the underlying connection can be reused.
  try { await first.text(); } catch { /* ignore */ }

  const paymentRequired = parsePaymentRequired(header);

  if (options.onPaymentRequired) {
    const ok = await options.onPaymentRequired(paymentRequired);
    if (!ok) throw new Error("Payment declined by caller");
  }

  const signed = await signX402Payment(signer, paymentRequired, options);
  const headerValue = encodePaymentSignature(signed);

  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("PAYMENT-SIGNATURE", headerValue);

  const retry = await fetch(input, { ...init, headers: retryHeaders });

  let settlement: unknown;
  const settlementHeader = retry.headers.get("PAYMENT-RESPONSE");
  if (settlementHeader) {
    try {
      settlement = JSON.parse(b64decode(settlementHeader));
    } catch {
      settlement = settlementHeader;
    }
  }

  return {
    response: retry,
    paid: retry.ok,
    paymentAmount: BigInt(paymentRequired.maxAmountRequired),
    settlement,
  };
}
