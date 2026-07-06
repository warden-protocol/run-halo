/**
 * x402 Bazaar discovery — find payable resources, then call them with the
 * existing x402 client.
 *
 * The Bazaar is Coinbase CDP's read-only catalog of x402-enabled endpoints
 * (https://docs.cdp.coinbase.com/x402/bazaar). Discovery is unauthenticated;
 * paying a discovered resource uses the same `fetchWithX402` path as any other
 * 402-gated service — same chains, same USDC, same signer. That symmetry is the
 * whole point: "real-time data" for Halo is just more x402 endpoints the
 * operator/consumer wallet already knows how to pay.
 *
 * Catalog amounts use the field `amount`; the live 402 handshake uses
 * `maxAmountRequired`. The catalog value is for ranking/preview only — the
 * actual charge comes from the resource's own 402 response at call time.
 */
import { ethers } from "ethers";
import { fetchWithX402, type X402PayOptions } from "./x402-client";

export const DEFAULT_BAZAAR_BASE_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery";

/** CAIP-2 network IDs for the chains Halo supports. */
export const BASE_MAINNET_CAIP2 = "eip155:8453";
export const BASE_SEPOLIA_CAIP2 = "eip155:84532";

export interface BazaarAccept {
  /** "exact" (sign = charge) or "upto" (sign a ceiling). */
  scheme: string;
  /** CAIP-2 network ID, e.g. "eip155:8453". */
  network: string;
  /** Price in asset base units (USDC = 6 decimals). Preview only. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

export interface BazaarResource {
  /** The monetized URL to call (pay via fetchWithX402). */
  resource: string;
  /** Resource type, currently always "http". */
  type: string;
  x402Version: number;
  description?: string;
  lastUpdated?: string;
  accepts: BazaarAccept[];
  metadata?: {
    description?: string;
    input?: unknown;
    output?: unknown;
  };
}

export interface BazaarSearchOptions {
  /** Free-text query (truncated to 400 chars per the Bazaar spec). */
  query?: string;
  /** CAIP-2 network filter. Defaults to Base mainnet. */
  network?: string;
  /** Asset filter, e.g. "USDC" (case-insensitive). */
  asset?: string;
  /** Payment scheme filter, e.g. "exact" or "upto". */
  scheme?: string;
  /** Recipient address filter. */
  payTo?: string;
  /** Max USD price (float). */
  maxUsdPrice?: number;
  /** Result cap; Bazaar hard-caps this at 20. */
  limit?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface BazaarSearchResult {
  resources: BazaarResource[];
  /** True when results were truncated at `limit`. */
  partialResults: boolean;
  /** "hybrid" | "vector" | "text". */
  searchMethod: string;
}

/**
 * Semantic search over the Bazaar catalog. Defaults to Base mainnet so results
 * are payable with the same chain config the rest of Halo uses.
 */
export async function searchBazaar(
  opts: BazaarSearchOptions = {}
): Promise<BazaarSearchResult> {
  const base = opts.baseUrl ?? DEFAULT_BAZAAR_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams();
  if (opts.query) params.set("query", opts.query.slice(0, 400));
  params.set("network", opts.network ?? BASE_MAINNET_CAIP2);
  if (opts.asset) params.set("asset", opts.asset);
  if (opts.scheme) params.set("scheme", opts.scheme);
  if (opts.payTo) params.set("payTo", opts.payTo);
  if (opts.maxUsdPrice !== undefined) {
    params.set("maxUsdPrice", String(opts.maxUsdPrice));
  }
  params.set("limit", String(Math.min(opts.limit ?? 20, 20)));

  const res = await doFetch(`${base}/search?${params.toString()}`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(
      `Bazaar search failed: ${res.status} ${res.statusText}`
    );
  }

  const body = (await res.json()) as {
    resources?: BazaarResource[];
    partialResults?: boolean;
    searchMethod?: string;
  };
  return {
    resources: body.resources ?? [],
    partialResults: body.partialResults ?? false,
    searchMethod: body.searchMethod ?? "unknown",
  };
}

export interface BazaarListOptions {
  /** Protocol type filter, e.g. "http". */
  type?: string;
  /** Page size: Bazaar allows 20–1000 (default 100). */
  limit?: number;
  offset?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface BazaarListResult {
  resources: BazaarResource[];
  total: number;
  limit: number;
  offset: number;
}

/** Paginated browse of the full catalog (no relevance ranking). */
export async function listBazaarResources(
  opts: BazaarListOptions = {}
): Promise<BazaarListResult> {
  const base = opts.baseUrl ?? DEFAULT_BAZAAR_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));

  const res = await doFetch(`${base}/resources?${params.toString()}`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(
      `Bazaar resources failed: ${res.status} ${res.statusText}`
    );
  }

  const body = (await res.json()) as {
    items?: BazaarResource[];
    pagination?: { limit?: number; offset?: number; total?: number };
  };
  const items = body.items ?? [];
  return {
    resources: items,
    total: body.pagination?.total ?? items.length,
    limit: body.pagination?.limit ?? items.length,
    offset: body.pagination?.offset ?? 0,
  };
}

/**
 * Pick the payment option a resource exposes for a given scheme/network,
 * preferring the cheapest by catalog `amount`. Returns null if none match.
 */
export function pickAccept(
  resource: BazaarResource,
  filter: { scheme?: string; network?: string } = {}
): BazaarAccept | null {
  const matches = resource.accepts.filter((a) => {
    if (filter.scheme && a.scheme !== filter.scheme) return false;
    if (filter.network && a.network !== filter.network) return false;
    return true;
  });
  if (matches.length === 0) return null;
  return matches.reduce((cheapest, a) => {
    try {
      return BigInt(a.amount) < BigInt(cheapest.amount) ? a : cheapest;
    } catch {
      return cheapest;
    }
  });
}

export interface X402JsonResult<T> {
  /** Parsed JSON (or raw text cast to T) from the resource on a 2xx, else null.
   *  Deliberately null on any non-2xx so a caller can't mistake a payment-gate/error
   *  body for a successful resource result — inspect `status`/`paid` for those. */
  data: T | null;
  /** Parsed body (JSON, or raw text) of a NON-2xx response, for diagnostics — e.g. a
   *  relay's `vault_payment_required` or a `{error:"unknown model"}`. Kept separate
   *  from `data` (which stays null on errors) so an error body is never read as a
   *  success. undefined on a 2xx or when the body couldn't be parsed. */
  errorBody?: unknown;
  /** True only when a payment was made and the retry succeeded. */
  paid: boolean;
  /** Amount charged, in USDC base units (from the live 402). */
  paymentAmount?: bigint;
  status: number;
  settlement?: unknown;
}

/**
 * Call an x402 resource and parse the result. Thin wrapper over fetchWithX402
 * that returns typed JSON — the "x402.call" tool primitive an agent uses after
 * discovering a resource via searchBazaar.
 */
export async function callX402Json<T = unknown>(
  url: string,
  init: RequestInit,
  signer: ethers.Signer,
  options: X402PayOptions = {}
): Promise<X402JsonResult<T>> {
  const { response, paid, paymentAmount, settlement } = await fetchWithX402(
    url,
    init,
    signer,
    options
  );

  // Only a 2xx body is the resource result. An un-payable 402 (e.g. a relay vault
  // gate's `vault_payment_required`) or any other HTTP error now comes back from
  // fetchWithX402 as a normal Response rather than a throw; surfacing its error
  // body as `data` would let a caller that reads `data` and ignores `status`/`paid`
  // mistake a payment-gate error for a successful result. Leave `data` null on
  // non-2xx — but still parse the body into `errorBody` so a caller CAN explain the
  // failure (an agent tool reporting "unknown model" / "no vault operator") instead
  // of being left with only a bare status code.
  let data: T | null = null;
  let errorBody: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  try {
    const parsed = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (response.ok) data = parsed as T;
    else errorBody = parsed;
  } catch {
    /* unparseable body — leave both unset */
  }

  return {
    data,
    errorBody,
    paid,
    paymentAmount,
    status: response.status,
    settlement,
  };
}
