/**
 * HaloVault (RFC v2) read helpers — operator side.
 *
 * In vault mode the operator does NOT collect payment via x402. Instead the
 * consumer has locked funds on-chain reserved exclusively to this operator, and
 * settles them afterward with a session-key-signed receipt (submitted by the
 * facilitator). Before serving, a gated operator reads the on-chain reservation
 * and refuses unless the remaining collectible (`locked`, which the contract
 * already keeps net of redemptions) covers the request's cost ceiling and the
 * reservation hasn't expired — so it never serves value it can't collect.
 *
 * Read-only: the operator never writes to the vault (the facilitator submits the
 * consumer's receipt). Vault address is a PINNED constant (see vault-address.ts —
 * it must match the consumer + facilitator); RPC from BASE_RPC_URL (falls back to
 * the public Base endpoint).
 */
import { Contract, JsonRpcProvider, TypedDataDomain, verifyTypedData } from "ethers";
import { VAULT_ADDRESS } from "./vault-address";

// Re-export so existing `import { VAULT_ADDRESS } from "../vault"` keeps working.
export { VAULT_ADDRESS };
const RPC_URL = (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim();

const VAULT_ABI = [
  "function ops(address,address) view returns (uint256 locked,uint256 redeemed,uint64 expiry,uint64 created,uint64 cycle)",
  "function sessionKey(address) view returns (address)",
  "function keyEpoch(address) view returns (uint256)",
];

// EIP-712 (MUST match HaloVault.sol + the consumer's vault-consume.ts byte for
// byte, or a valid receipt fails to recover and the operator drops real money).
const RECEIPT_TYPES = {
  Receipt: [
    { name: "consumer", type: "address" },
    { name: "operator", type: "address" },
    { name: "cumulative", type: "uint256" },
    { name: "keyEpoch", type: "uint256" },
    { name: "cycle", type: "uint64" },
  ],
};

let provider: JsonRpcProvider | null = null;
function rpc(): JsonRpcProvider {
  // staticNetwork: the chain never changes under us, so skip the per-call
  // eth_chainId round-trip — one fewer RPC call per read to fail or hang on the
  // (often throttled) public endpoint.
  if (!provider) provider = new JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  return provider;
}

// The public Base RPC is slow and rate-limits; a single blip must not reject a
// request the consumer actually funded. Retry the read a few times with short
// backoff and a hard per-attempt timeout (a hung socket otherwise stalls the
// consumer indefinitely — the gate read is on the serving hot path).
const READ_TIMEOUT_MS = 8_000;
const READ_ATTEMPTS = 3;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export interface Reservation {
  locked: bigint;
  redeemed: bigint;
  expiry: bigint; // unix seconds
  cycle: bigint;
  /** Collectible headroom = `locked` (already net of redemptions; base units). */
  remaining: bigint;
}

async function readReservationOnce(consumer: string, operator: string): Promise<Reservation> {
  const c = new Contract(VAULT_ADDRESS, VAULT_ABI, rpc());
  const r = await c.ops(consumer, operator);
  const locked = BigInt(r.locked ?? r[0]);
  const redeemed = BigInt(r.redeemed ?? r[1]);
  return {
    locked,
    redeemed,
    expiry: BigInt(r.expiry ?? r[2]),
    cycle: BigInt(r.cycle ?? r[4]),
    // `locked` is ALREADY net of redemptions — the contract does `locked -= pay`
    // on every redeem (and the struct doc calls it "reserved-and-unredeemed
    // funds"). So the collectible remaining is `locked` itself; subtracting
    // `redeemed` again double-counts and drains the reservation twice as fast,
    // wrongly rejecting requests after ~half the reservation is used.
    remaining: locked,
  };
}

/** Read the consumer's reservation FOR THIS operator, retrying transient RPC
 *  failures. Throws only if every attempt fails. */
export async function readReservation(consumer: string, operator: string): Promise<Reservation> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(
        readReservationOnce(consumer, operator),
        READ_TIMEOUT_MS,
        "vault ops() read"
      );
    } catch (err) {
      lastErr = err;
      // A timeout/transport error can leave the socket wedged — drop the provider
      // so the next attempt rebuilds it (re-detecting the network once).
      provider = null;
      if (attempt < READ_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export interface ReservationCheck {
  ok: boolean;
  reason?: string;
  remaining: bigint;
  /** Current reservation cycle (for credit-window accounting). 0 when there is
   *  no reservation. */
  cycle: bigint;
  /** On-chain cumulative already redeemed in this cycle. Used to seed the
   * operator's process-local credit ledger safely after a restart. */
  redeemed: bigint;
}

function evaluate(r: Reservation, requiredBase: bigint, nowSec: number): ReservationCheck {
  if (r.locked === 0n) {
    return { ok: false, reason: "no active reservation for this operator", remaining: 0n, cycle: r.cycle, redeemed: r.redeemed };
  }
  if (r.expiry !== 0n && BigInt(nowSec) >= r.expiry) {
    return { ok: false, reason: "reservation expired", remaining: r.remaining, cycle: r.cycle, redeemed: r.redeemed };
  }
  if (r.remaining < requiredBase) {
    return {
      ok: false,
      reason: "reservation does not cover this request's cost",
      remaining: r.remaining,
      cycle: r.cycle,
      redeemed: r.redeemed,
    };
  }
  return { ok: true, remaining: r.remaining, cycle: r.cycle, redeemed: r.redeemed };
}

/**
 * Verify the reservation covers `requiredBase` and is live. `nowSec` is passed in
 * so the caller controls the clock (testability); defaults to wall clock.
 */
export async function checkReservation(
  consumer: string,
  operator: string,
  requiredBase: bigint,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<ReservationCheck> {
  const r = await readReservation(consumer, operator);
  return evaluate(r, requiredBase, nowSec);
}

// ── Gate cache ───────────────────────────────────────────────────────────────
// The per-request chain read is the gate's whole cost (the public Base RPC can
// take seconds). Cache the last read per consumer and APPROVE from it while it
// is fresh and the locally-accounted headroom (last-read remaining minus what
// we've served since, via noteServed) still covers the request — strictly MORE
// conservative than the uncached gate, which never discounted unredeemed
// serving at all. Rejections are never made from cache: any miss falls through
// to a fresh read, so a consumer who just topped up is never refused on stale
// data.

const GATE_CACHE_TTL_MS = 30_000;

interface GateEntry {
  r: Reservation;
  at: number;
  servedSinceRead: bigint;
}

const gateCache = new Map<string, GateEntry>(); // key `${consumer}:${operator}`

/** Record value served against a reservation (call after a successful upstream). */
export function noteServed(consumer: string, operator: string, amountBase: bigint): void {
  const e = gateCache.get(`${consumer.toLowerCase()}:${operator.toLowerCase()}`);
  if (e) e.servedSinceRead += amountBase;
}

/** Drop the cached reservation read for a pair, forcing the next
 *  `checkReservationCached` to re-read on-chain. Used when the credit ledger
 *  detects the cached cycle has fallen behind a generation bump (a receipt for
 *  the new cycle advanced the ledger via the uncached verify path), so the gate
 *  re-evaluates against the current cycle instead of stale coverage. */
export function invalidateGate(consumer: string, operator: string): void {
  gateCache.delete(`${consumer.toLowerCase()}:${operator.toLowerCase()}`);
}

/**
 * checkReservation with a serve-approvals-only cache. Fast-path approves when
 * the cached read is fresh, live, and its remaining minus value served since
 * the read covers the request; everything else re-reads the chain.
 */
export async function checkReservationCached(
  consumer: string,
  operator: string,
  requiredBase: bigint,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<ReservationCheck> {
  const key = `${consumer.toLowerCase()}:${operator.toLowerCase()}`;
  const cached = gateCache.get(key);
  // Verdict from a cached read, discounting what we've served since (so the gate
  // never approves past confirmed coverage).
  const fromCache = (e: GateEntry): ReservationCheck =>
    evaluate(
      {
        ...e.r,
        remaining: e.r.remaining > e.servedSinceRead ? e.r.remaining - e.servedSinceRead : 0n,
      },
      requiredBase,
      nowSec
    );
  if (cached && Date.now() - cached.at < GATE_CACHE_TTL_MS) {
    const verdict = fromCache(cached);
    if (verdict.ok) return verdict;
    // Fall through: a cached "no" may just be stale (top-up since the read).
  }
  let r: Reservation;
  try {
    r = await readReservation(consumer, operator);
  } catch (err) {
    // The chain read failed even after retries (RPC down/throttled). Rather than
    // reject a request the consumer may well have funded, fall back to the last
    // CONFIRMED reservation if it still covers this request. This is strictly
    // conservative: we only ever APPROVE from on-chain data we previously read,
    // discounted by what we've served since, and evaluate() still enforces the
    // real on-chain expiry. A consumer with no prior confirmed reservation is
    // still rejected — the error propagates.
    if (cached) {
      const verdict = fromCache(cached);
      if (verdict.ok) return verdict;
    }
    throw err;
  }
  gateCache.set(key, { r, at: Date.now(), servedSinceRead: 0n });
  return evaluate(r, requiredBase, nowSec);
}

// ── Receipt verification (operator-driven redeem, issue #369) ────────────────
// Before the operator trusts a consumer-pushed cumulative receipt — recording it
// frees credit-window headroom and lets the operator collect — it MUST confirm
// the signature recovers to the consumer's registered session key, over the
// CURRENT on-chain cycle + keyEpoch. Skipping this would let a consumer forge a
// high-cumulative "receipt", inflate `held`, and pull free service (the receipt
// would simply never redeem). Verify against on-chain state, never client claims.

let chainIdCache: bigint | null = null;
async function chainId(): Promise<bigint> {
  if (chainIdCache !== null) return chainIdCache;
  const net = await withTimeout(rpc().getNetwork(), READ_TIMEOUT_MS, "getNetwork");
  chainIdCache = net.chainId;
  return chainIdCache;
}

function vaultDomain(id: bigint): TypedDataDomain {
  return { name: "Halo", version: "2", chainId: id, verifyingContract: VAULT_ADDRESS };
}

// Session key + keyEpoch change only on an explicit rotation, so a short cache
// keeps receipt verification off the per-receipt RPC path without trusting stale
// data across a rotation.
const KEY_CACHE_TTL_MS = 60_000;
interface KeyEntry { sessionKey: string; keyEpoch: bigint; at: number }
const keyCache = new Map<string, KeyEntry>();

async function readConsumerKey(consumer: string): Promise<KeyEntry> {
  const k = consumer.toLowerCase();
  const cached = keyCache.get(k);
  if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached;
  const c = new Contract(VAULT_ADDRESS, VAULT_ABI, rpc());
  const [sk, ep] = await withTimeout(
    Promise.all([c.sessionKey(consumer), c.keyEpoch(consumer)]),
    READ_TIMEOUT_MS,
    "sessionKey/keyEpoch read"
  );
  const entry: KeyEntry = { sessionKey: String(sk).toLowerCase(), keyEpoch: BigInt(ep), at: Date.now() };
  keyCache.set(k, entry);
  return entry;
}

export interface ReceiptVerification {
  ok: boolean;
  reason?: string;
  /** On-chain cycle the receipt was verified against (for ledger recording). */
  cycle: bigint;
}

/**
 * Pure EIP-712 recovery for a vault Receipt — the anti-forgery core, split out
 * from the chain reads so it's testable in isolation. Returns the recovered
 * signer address (lower-case), or null when the signature is malformed. The
 * caller must compare this to the consumer's on-chain session key; a forged or
 * tampered receipt recovers to a different (or random) address and is rejected.
 */
export function recoverReceiptSigner(
  chainIdValue: bigint,
  p: { consumer: string; operator: string; cumulative: bigint; keyEpoch: bigint; cycle: bigint },
  signature: string
): string | null {
  try {
    return verifyTypedData(
      vaultDomain(chainIdValue),
      RECEIPT_TYPES,
      {
        consumer: p.consumer,
        operator: p.operator,
        cumulative: p.cumulative,
        keyEpoch: p.keyEpoch,
        cycle: p.cycle,
      },
      signature
    ).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Verify a consumer-pushed cumulative receipt against on-chain state. Recovers
 * the EIP-712 signer using the CURRENT on-chain `cycle` + `keyEpoch` for this
 * pair and confirms it equals the consumer's registered session key. Returns the
 * cycle it verified against so the caller records the receipt under the right
 * generation. Fails closed on any RPC error (operator simply doesn't free the
 * window — never serves on an unverified receipt).
 */
export async function verifyReceipt(p: {
  consumer: string;
  operator: string;
  cumulative: bigint;
  signature: string;
}): Promise<ReceiptVerification> {
  let id: bigint, key: KeyEntry, reservation: Reservation;
  try {
    [id, key, reservation] = await Promise.all([
      chainId(),
      readConsumerKey(p.consumer),
      readReservation(p.consumer, p.operator),
    ]);
  } catch (err) {
    return { ok: false, reason: `could not read on-chain state: ${(err as Error).message}`, cycle: 0n };
  }
  if (key.sessionKey === "0x0000000000000000000000000000000000000000") {
    return { ok: false, reason: "consumer has no registered session key", cycle: reservation.cycle };
  }
  const recovered = recoverReceiptSigner(
    id,
    {
      consumer: p.consumer,
      operator: p.operator,
      cumulative: p.cumulative,
      keyEpoch: key.keyEpoch,
      cycle: reservation.cycle,
    },
    p.signature
  );
  if (recovered === null) {
    return { ok: false, reason: "malformed receipt signature", cycle: reservation.cycle };
  }
  if (recovered !== key.sessionKey) {
    return { ok: false, reason: "signature does not recover to the consumer's session key", cycle: reservation.cycle };
  }
  return { ok: true, cycle: reservation.cycle };
}
