import { Contract, JsonRpcProvider, verifyTypedData } from "ethers";
import {
  RECEIPT_TYPES,
  VAULT_ABI,
  VAULT_ADDRESS,
  vaultDomain,
} from "@halo/vault-core";
import { resolveVaultAddress } from "./vault-address";

// Re-export so existing `import { VAULT_ADDRESS } from "../vault"` keeps working.
export { VAULT_ADDRESS } from "@halo/vault-core";
const RPC_URL = (process.env.BASE_RPC_URL || "https://mainnet.base.org").trim();

// Process-wide vault defaults to consensus and accepts one validated config override at startup.
let activeVault: string = VAULT_ADDRESS;

/** The vault address this process reads and verifies receipts against. */
export function getVaultAddress(): string {
  return activeVault;
}

/** Apply a non-empty config override, throwing on malformed addresses. */
export function setActiveVaultAddress(addr?: string | null): void {
  activeVault = resolveVaultAddress(addr);
  gateCache.clear();
  latestGateKey.clear();
  keyCache.clear();
}

let provider: JsonRpcProvider | null = null;
function rpc(): JsonRpcProvider {
  // staticNetwork: the chain never changes under us, so skip the per-call
  // eth_chainId round-trip — one fewer RPC call per read to fail or hang on the
  // (often throttled) public endpoint.
  if (!provider) provider = new JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  return provider;
}

// Bound and retry hot-path RPC reads so transient public-RPC faults do not reject funded requests.
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
  const c = new Contract(activeVault, VAULT_ABI, rpc());
  const r = await c.ops(consumer, operator);
  const locked = BigInt(r.locked ?? r[0]);
  const redeemed = BigInt(r.redeemed ?? r[1]);
  return {
    locked,
    redeemed,
    expiry: BigInt(r.expiry ?? r[2]),
    cycle: BigInt(r.cycle ?? r[4]),
    // `locked` is already net of redeemed value and is therefore the remaining collectible amount.
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

/** Verify live coverage at the supplied clock, defaulting to wall time. */
export async function checkReservation(
  consumer: string,
  operator: string,
  requiredBase: bigint,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<ReservationCheck> {
  const r = await readReservation(consumer, operator);
  return evaluate(r, requiredBase, nowSec);
}

/** Cap served accounting to the amount gated and reserved for this request. */
export function collectibleServeAmount(actualBase: bigint, ceilingBase: bigint): bigint {
  if (actualBase < 0n || ceilingBase < 0n) {
    throw new Error("collectibleServeAmount: amounts must be non-negative");
  }
  return actualBase < ceilingBase ? actualBase : ceilingBase;
}

interface GateEntry {
  r: Reservation;
  servedSinceRead: bigint;
}

const gateCache = new Map<string, GateEntry>();
const latestGateKey = new Map<string, string>();

function pairIdentity(consumer: string, operator: string): string {
  return JSON.stringify([
    activeVault.toLowerCase(),
    consumer.toLowerCase(),
    operator.toLowerCase(),
  ]);
}

/** Full active reservation identity used by all gate accounting. */
export function reservationGateIdentity(
  vaultAddress: string,
  consumer: string,
  operator: string,
  cycle: bigint
): string {
  return JSON.stringify([
    vaultAddress.toLowerCase(),
    consumer.toLowerCase(),
    operator.toLowerCase(),
    cycle.toString(),
  ]);
}

/** Record value served against the exact admitted reservation cycle. */
export function noteServed(
  consumer: string,
  operator: string,
  cycle: bigint,
  amountBase: bigint
): void {
  if (amountBase < 0n) throw new Error("noteServed amount must be non-negative");
  const e = gateCache.get(reservationGateIdentity(activeVault, consumer, operator, cycle));
  if (e) e.servedSinceRead += amountBase;
}

/** Invalidate a pair after a detected cycle advance so the next gate reads chain state. */
export function invalidateGate(consumer: string, operator: string): void {
  const pair = pairIdentity(consumer, operator);
  const key = latestGateKey.get(pair);
  if (key) gateCache.delete(key);
  latestGateKey.delete(pair);
}

/** Re-read the active cycle before every approval; RPC uncertainty fails closed. */
export async function checkReservationCached(
  consumer: string,
  operator: string,
  requiredBase: bigint,
  nowSec: number = Math.floor(Date.now() / 1000)
): Promise<ReservationCheck> {
  const r = await readReservation(consumer, operator);
  const pair = pairIdentity(consumer, operator);
  const key = reservationGateIdentity(activeVault, consumer, operator, r.cycle);
  const priorKey = latestGateKey.get(pair);
  if (priorKey && priorKey !== key) gateCache.delete(priorKey);
  latestGateKey.set(pair, key);
  const prior = gateCache.get(key);
  if (prior && r.redeemed < prior.r.redeemed) {
    throw new Error("vault redeemed checkpoint moved backwards within the active cycle");
  }
  const newlyRedeemed = prior ? r.redeemed - prior.r.redeemed : 0n;
  const servedSinceRead = prior
    ? prior.servedSinceRead > newlyRedeemed
      ? prior.servedSinceRead - newlyRedeemed
      : 0n
    : 0n;
  gateCache.set(key, { r, servedSinceRead });
  return evaluate(
    {
      ...r,
      remaining: r.remaining > servedSinceRead ? r.remaining - servedSinceRead : 0n,
    },
    requiredBase,
    nowSec
  );
}

// Verify pushed receipts against the current on-chain session key, cycle, and epoch before freeing credit.

let chainIdCache: bigint | null = null;
async function chainId(): Promise<bigint> {
  if (chainIdCache !== null) return chainIdCache;
  const net = await withTimeout(rpc().getNetwork(), READ_TIMEOUT_MS, "getNetwork");
  chainIdCache = net.chainId;
  return chainIdCache;
}

// Session key + keyEpoch change only on an explicit rotation, so a short cache
// keeps receipt verification off the per-receipt RPC path without trusting stale
// data across a rotation.
const KEY_CACHE_TTL_MS = 60_000;
interface KeyEntry { sessionKey: string; keyEpoch: bigint; at: number }
const keyCache = new Map<string, KeyEntry>();

async function readConsumerKey(consumer: string): Promise<KeyEntry> {
  const k = JSON.stringify([activeVault.toLowerCase(), consumer.toLowerCase()]);
  const cached = keyCache.get(k);
  if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached;
  const c = new Contract(activeVault, VAULT_ABI, rpc());
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
  /** True only when verification could not obtain authoritative chain state. */
  transient: boolean;
  reason?: string;
  /** On-chain cycle the receipt was verified against (for ledger recording). */
  cycle: bigint;
  /** On-chain cumulative already redeemed this cycle (0 when unread). Seeds the
   *  credit ledger's collectable baseline alongside `locked`. */
  redeemed: bigint;
  /** Fresh reserved-and-unredeemed balance, or zero when unread. */
  locked: bigint;
}

/** Recover a lower-case EIP-712 receipt signer, or `null`; callers compare it to chain state. */
export function recoverReceiptSigner(
  chainIdValue: bigint,
  p: { consumer: string; operator: string; cumulative: bigint; keyEpoch: bigint; cycle: bigint },
  signature: string
): string | null {
  try {
    return verifyTypedData(
      vaultDomain(chainIdValue, activeVault),
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

/** Verify a cumulative receipt against current cycle, epoch, and session key; RPC errors fail closed. */
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
    return { ok: false, transient: true, reason: `could not read on-chain state: ${(err as Error).message}`, cycle: 0n, redeemed: 0n, locked: 0n };
  }
  if (key.sessionKey === "0x0000000000000000000000000000000000000000") {
    return { ok: false, transient: false, reason: "consumer has no registered session key", cycle: reservation.cycle, redeemed: reservation.redeemed, locked: reservation.locked };
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
    return { ok: false, transient: false, reason: "malformed receipt signature", cycle: reservation.cycle, redeemed: reservation.redeemed, locked: reservation.locked };
  }
  if (recovered !== key.sessionKey) {
    return { ok: false, transient: false, reason: "signature does not recover to the consumer's session key", cycle: reservation.cycle, redeemed: reservation.redeemed, locked: reservation.locked };
  }
  return { ok: true, transient: false, cycle: reservation.cycle, redeemed: reservation.redeemed, locked: reservation.locked };
}
