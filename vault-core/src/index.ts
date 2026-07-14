import { getBytes, keccak256, parseUnits, type TypedDataDomain } from "ethers";
import {
  EIP712_NAME,
  EIP712_VERSION,
  VAULT_ADDRESS,
} from "./consensus.generated.js";

export * from "./consensus.generated.js";

export const VAULT_ABI = [
  "function deposit(uint256 amount, address sessionKey)",
  "function requestWithdraw()",
  "function withdraw(uint256 amount)",
  "function balance(address) view returns (uint256)",
  "function lockedTotal(address) view returns (uint256)",
  "function withdrawable(address) view returns (uint256)",
  "function sessionKey(address) view returns (address)",
  "function reserveNonce(address) view returns (uint256)",
  "function keyEpoch(address) view returns (uint256)",
  "function withdrawRequestedAt(address) view returns (uint64)",
  "function withdrawAuthorized(address) view returns (uint256)",
  "function withdrawTimelock() view returns (uint64)",
  "function redeemGrace() view returns (uint64)",
  "function ops(address,address) view returns (uint256 locked,uint256 redeemed,uint64 expiry,uint64 created,uint64 cycle)",
];

export const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * EIP-712 domain for HaloVault Reserve/Receipt signatures. `verifyingContract`
 * defaults to the consensus-pinned `VAULT_ADDRESS` — the single pinned deployment
 * the SDK and CLI always target. It is a parameter (not hardcoded) so a frontend
 * build pointed at a different deployment (`HALO_VAULT_ADDRESS`) signs against the
 * SAME vault its deposits/reserves/reads use; a mismatch would revert on-chain as
 * `BadSignature` (invariant #5/#7). The domain NAME/VERSION and the typed structs
 * stay consensus-pinned regardless of address.
 */
export function vaultDomain(
  chainId: number | bigint,
  verifyingContract: string = VAULT_ADDRESS
): TypedDataDomain {
  return {
    name: EIP712_NAME,
    version: EIP712_VERSION,
    chainId,
    verifyingContract,
  };
}

/**
 * Canonical display formatter for a USDC base-unit amount (6-dp). The single
 * definition every money-path surface must use instead of re-deriving
 * `(Number(base) / 1e6).toFixed(4)` — the "import, do not fork" rule applies to
 * amount display too, so logs and UI can't render the same amount two ways.
 */
export function formatUsdcBase(
  base: bigint,
  opts: { withDollarSign?: boolean } = {}
): string {
  const formatted = (Number(base) / 1_000_000).toFixed(4);
  return opts.withDollarSign ? `$${formatted}` : formatted;
}

export interface OpsState {
  locked: bigint;
  redeemed: bigint;
  expiry: bigint;
  created: bigint;
  cycle: bigint;
}

export interface VaultState {
  balance: bigint;
  lockedTotal: bigint;
  withdrawable: bigint;
  sessionKey: string;
  reserveNonce: bigint;
  keyEpoch: bigint;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Registration status of a consumer's on-chain session key relative to the
 * address that will actually sign reserves + receipts (#426).
 *  - "unregistered": no session key set yet (zero) — the next deposit registers
 *    one, so this is not (yet) a problem.
 *  - "match": the registered key IS the signing address — receipts will redeem.
 *  - "mismatch": a DIFFERENT key is registered, so every receipt the signer
 *    produces recovers to the wrong address and redeems revert BadSignature
 *    forever. The operator can still be made to SERVE (the relay is
 *    payment-blind), so it does real work it can never collect.
 */
export type SessionKeyStatus = "unregistered" | "match" | "mismatch";

/**
 * Classify an on-chain `sessionKey[consumer]` against the address that signs
 * reserves + receipts for that consumer (#426). The headless CLI/SDK signs
 * DIRECTLY with the wallet key (signer == session key == consumer), so `expected`
 * is the wallet address; the browser signs with its derived in-browser sub-wallet,
 * so `expected` is that sub-wallet address. `deposit` registers a session key only
 * ONCE (HaloVault.sol), so a surface that used a different key first strands every
 * later receipt. Case-insensitive — addresses arrive checksummed or lowercased.
 */
export function classifySessionKey(
  registered: string,
  expected: string
): SessionKeyStatus {
  const r = (registered || "").toLowerCase();
  const e = (expected || "").toLowerCase();
  if (r === "" || r === ZERO_ADDRESS) return "unregistered";
  return r === e ? "match" : "mismatch";
}

/**
 * The canonical message a main wallet EIP-191 personal_signs to derive its Halo
 * session sub-wallet (v2). This is a CROSS-SURFACE CONTRACT: the browser
 * (`frontend/src/lib/subKey.ts`) and the CLI (`halo consume --vault --session-key
 * browser`) both derive from THIS exact message, so one wallet reproduces the SAME
 * session key on both surfaces. Changing a single byte derives a DIFFERENT address
 * and strands any funds/registration under the current key — never edit it without
 * a detect-and-migrate plan (see the note in subKey.ts).
 */
export const SUBKEY_DERIVATION_MESSAGE =
  "Halo — create in-browser agent sub-wallet (v2).\n" +
  "Signing derives a wallet the agent uses to pay for tools autonomously.\n" +
  "The agent can ONLY spend USDC you load into this sub-wallet.";

/** The exact bytes to personal_sign to derive the session sub-wallet: the
 *  canonical message, then the lowercased owner (main wallet) address. */
export function subKeyDerivationMessage(owner: string): string {
  return `${SUBKEY_DERIVATION_MESSAGE}\n${owner.toLowerCase()}`;
}

/** Derive the session sub-wallet's 32-byte private key from the owner's
 *  personal_sign signature over `subKeyDerivationMessage(owner)`. Deterministic —
 *  the same wallet always reproduces the same key. Feed the result to `new
 *  Wallet(pk)`. */
export function deriveSubKeyPrivateKey(signature: string): string {
  return keccak256(getBytes(signature));
}

export const PRICE_DP = 12;
export const RESERVATION_PRICE_MARGIN_BPS = 2_000n;

/** USD-per-1M-tokens to USDC base-unit cost, rounded up. */
export function priceTokens(usdPerMtok: number, tokens: number): bigint {
  if (!Number.isFinite(usdPerMtok) || usdPerMtok < 0) {
    throw new Error(`priceTokens: price must be a finite non-negative number (got ${usdPerMtok})`);
  }
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`priceTokens: tokens must be a finite non-negative number (got ${tokens})`);
  }
  const priceBase = parseUnits(usdPerMtok.toFixed(PRICE_DP), PRICE_DP);
  if (usdPerMtok > 0 && priceBase === 0n) {
    throw new Error(
      `priceTokens: price ${usdPerMtok} USD/Mtok is positive but rounds to 0 at ${PRICE_DP} decimals — refusing to serve unpriced`
    );
  }
  const microUsd = BigInt(Math.max(0, Math.ceil(tokens))) * priceBase;
  const denom = 10n ** BigInt(PRICE_DP);
  return (microUsd + denom - 1n) / denom;
}

/** Add headroom for announce-cache staleness and consumer/operator token-estimate
 * differences. Reservations lock (rather than spend) this margin, and unused
 * headroom is reclaimable after expiry. Rounded up so tiny estimates still gain
 * at least one base unit of protection. */
export function withReservationMargin(
  estimatedCost: bigint,
  marginBps: bigint = RESERVATION_PRICE_MARGIN_BPS
): bigint {
  if (estimatedCost < 0n || marginBps < 0n) {
    throw new Error("withReservationMargin: cost and margin must be non-negative");
  }
  if (estimatedCost === 0n || marginBps === 0n) return estimatedCost;
  const bps = 10_000n;
  return (estimatedCost * (bps + marginBps) + bps - 1n) / bps;
}

/** Read the operator gate's exact reservation requirement from a 402 body.
 * Accepts either decoded JSON or raw response text, and rejects malformed,
 * non-decimal, zero, or unrelated error envelopes. */
export function requiredVaultReservationBase(payload: unknown): bigint | null {
  let decoded = payload;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  if (!decoded || typeof decoded !== "object") return null;
  const error = (decoded as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const value = error as { type?: unknown; requiredUsdcBase?: unknown };
  if (
    value.type !== "vault_reservation_insufficient" ||
    typeof value.requiredUsdcBase !== "string" ||
    !/^\d+$/.test(value.requiredUsdcBase)
  ) {
    return null;
  }
  const required = BigInt(value.requiredUsdcBase);
  return required > 0n ? required : null;
}

export function estimateTokens(messages: unknown, maxTokens: number): number {
  let chars = 0;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = (message as { content?: unknown })?.content;
      if (typeof content === "string") chars += content.length;
      else if (Array.isArray(content)) {
        for (const part of content) chars += JSON.stringify(part).length;
      }
    }
  }
  return Math.ceil(chars / 4) + maxTokens;
}

/**
 * Heuristic detection of reasoning/thinking models. No model-catalog flag exists —
 * providers' `/models` endpoints report pricing + context length only, not whether a
 * model reasons — so this is name-matched (case-insensitive). Reasoning families emit
 * reasoning/thinking tokens that a small `max_tokens` does NOT bound, so their
 * billable completion routinely exceeds a `max_tokens`-sized ceiling (issue #421).
 *
 * Only models that reason BY DEFAULT need to match here. Opt-in reasoning params
 * (`reasoning_effort`, `reasoning`, `thinking`) are NOT in the operator's outbound
 * sanitizer allowlist (`cli/src/sanitize.ts`), so a model that reasons only when
 * asked never receives the flag through Halo → never emits reasoning tokens → no
 * over-serve to size for (that's why e.g. Claude extended-thinking is intentionally
 * absent here). Deliberately errs toward NOT flagging: a false negative just falls
 * back to the post-serve cap (`collectibleServeAmount`), and a false positive only
 * over-reserves a little headroom (reclaimable) — both safe. The o-series digit range
 * is open-ended so new numbers (o6, o7…) keep matching as OpenAI ships them.
 */
export function isReasoningModel(model: string): boolean {
  const m = (model || "").toLowerCase();
  if (!m) return false;
  return (
    /(^|[/:._-])o[1-9]\d*([._:\-]|$)/.test(m) || // OpenAI o-series (o1, o3-mini, o4-mini, o5, o6…, :latest, _mini)
    m.includes("gpt-5") || // GPT-5 family reasons by default
    m.includes("gemini-2.5") || // Gemini 2.5 Flash/Pro think by default
    m.includes("grok-4") || // xAI Grok 4 reasons by default
    m.includes("grok-3-mini") || // xAI Grok 3 Mini reasons by default
    m.includes("reasoner") ||
    m.includes("reasoning") ||
    m.includes("deepseek-r") || // DeepSeek R1 / R1-distill
    m.includes("magistral") || // Mistral reasoning
    m.includes("qwq") || // Qwen QwQ
    m.includes("thinking") // explicit "…-thinking" model-id variants
  );
}

/**
 * Minimum completion-token ceiling assumed for a reasoning model when the caller's
 * `max_tokens` is smaller. Reasoning tokens routinely reach several thousand
 * regardless of a tiny `max_tokens`, so sizing the reservation/gate to just
 * `max_tokens` systematically undercollects (issue #421). A fixed constant (not env)
 * so the consumer's reserve sizing and the operator's serve gate always derive the
 * SAME ceiling — a divergence would let the gate exceed the reserve (invariant #5/#7).
 */
export const REASONING_COMPLETION_FLOOR = 8192;

/**
 * Completion-token ceiling used to SIZE the vault reservation (consumer) and the
 * operator's serve gate (issue #421). For a reasoning model it floors the caller's
 * output budget to `REASONING_COMPLETION_FLOOR` so the reserve/gate cover the
 * reasoning tokens `max_tokens` never bounds; for any other model it is the caller's
 * own budget unchanged. Honors an explicit `max_completion_tokens` (the
 * reasoning-inclusive limit) when it is larger than `max_tokens`. SHARED so the
 * consumer and operator derive the identical ceiling — `reserve ≥ gate` then holds
 * without a reserve-and-replay round trip (invariant #5/#7).
 *
 * This sizes the ceiling only; it does NOT enforce it at the upstream provider call
 * (that would need per-provider `max_completion_tokens` / thinking-budget handling and
 * risks truncating output). The post-serve cap (`collectibleServeAmount`, operator
 * side) remains the backstop when a reasoning model still exceeds this headroom.
 */
export function completionCeilingTokens(
  model: string,
  maxTokens: number,
  maxCompletionTokens?: number
): number {
  const budget = Math.max(
    Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0,
    typeof maxCompletionTokens === "number" &&
      Number.isFinite(maxCompletionTokens) &&
      maxCompletionTokens > 0
      ? Math.floor(maxCompletionTokens)
      : 0
  );
  if (!isReasoningModel(model)) return budget;
  return Math.max(budget, REASONING_COMPLETION_FLOOR);
}

export interface ComputeReserveAmountParams {
  estCost: bigint;
  locked: bigint;
  withdrawable: bigint;
  reserveMultiple: bigint;
  liquiditySlots: bigint;
  live: boolean;
}

export function computeReserveAmount(p: ComputeReserveAmountParams): bigint {
  const target = p.estCost * p.reserveMultiple;
  let amount = target > p.locked ? target - p.locked : 0n;
  const needed = p.locked >= p.estCost ? 0n : p.estCost - p.locked;
  const cap = p.liquiditySlots > 0n ? p.withdrawable / p.liquiditySlots : p.withdrawable;
  if (amount > cap) amount = cap;
  if (amount < needed) amount = needed;
  if (amount > p.withdrawable) amount = p.withdrawable;
  if (amount === 0n && !p.live && p.withdrawable > 0n) amount = 1n;
  return amount;
}

export interface AdvanceCumulativeReceiptParams {
  previous: bigint;
  cost: bigint;
  locked: bigint;
  redeemed: bigint;
  priorCeiling?: bigint;
}

/** Advance a cumulative receipt without ever decreasing it or exceeding the
 * highest reservation ceiling observed for the cycle. Shared by headless and
 * browser consumers so concurrent top-ups have identical accounting. */
export function advanceCumulativeReceipt(
  p: AdvanceCumulativeReceiptParams
): { cumulative: bigint; ceiling: bigint } {
  if (p.previous < 0n || p.cost < 0n || p.locked < 0n || p.redeemed < 0n) {
    throw new Error("advanceCumulativeReceipt: amounts must be non-negative");
  }
  const observed = p.locked + p.redeemed;
  let ceiling = p.priorCeiling ?? 0n;
  if (observed > ceiling) ceiling = observed;
  if (p.previous > ceiling) ceiling = p.previous;
  const next = p.previous + p.cost;
  return { cumulative: next > ceiling ? ceiling : next, ceiling };
}

export type RedeemErrorClass = "collected" | "uncollectable" | "transient";

export function classifyRedeemError(error: string): RedeemErrorClass {
  if (/StaleReceipt|ExceedsReservation|already\s+(redeemed|collected|settled)/i.test(error))
    return "collected";
  // `superseded` covers a receipt dropped for a cycle the chain has moved past
  // (see VaultConsumeClient.attemptRedeem) — it can never redeem, so don't retry.
  if (/BadSignature|NoSessionKey|does not recover|superseded/i.test(error))
    return "uncollectable";
  return "transient";
}

export function matchesModel(advertised: string, requested: string): boolean {
  if (advertised === "" || requested === "") return advertised === requested;
  return (
    advertised === requested ||
    advertised.includes(requested) ||
    requested.includes(advertised)
  );
}

export function resolveModelPriceUsdPerMtok(
  models: string[],
  pricing: Record<string, number> | undefined,
  requested: string
): number | null {
  const exact = pricing?.[requested];
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0) return exact * 1000;
  const match = models.find(
    (model) =>
      matchesModel(model, requested) &&
      typeof pricing?.[model] === "number" &&
      Number.isFinite(pricing[model]) &&
      pricing[model] >= 0
  );
  return match && pricing ? pricing[match] * 1000 : null;
}

export interface VaultOperatorAdvertisement {
  address: string;
  models: string[];
  pricing?: Record<string, number>;
  tee?: boolean;
  teeModels?: string[];
  vaultPayments?: boolean;
  encryptionPubkey?: string | null;
}

export interface VaultOperatorCandidate<T extends VaultOperatorAdvertisement> {
  operator: T;
  priceUsdPerMtok: number;
}

export type VaultOperatorSelectionReason =
  | "selected"
  | "no_operator"
  | "no_vault_operator"
  | "no_tee_operator"
  | "unpriced"
  | "free_model"
  | "out_of_range"
  | "pinned_not_found"
  | "pinned_not_vault_capable"
  | "pinned_not_tee_capable"
  | "pinned_unpriced"
  | "pinned_free_model"
  | "pinned_out_of_range";

export interface VaultOperatorSelection<T extends VaultOperatorAdvertisement> {
  selected: VaultOperatorCandidate<T> | null;
  candidates: Array<VaultOperatorCandidate<T>>;
  reason: VaultOperatorSelectionReason;
}

/**
 * Canonical vault-operator selector shared by browser, SDK, and CLI consumers.
 * A vault request must pin a positively-priced operator that advertises the
 * on-chain reservation gate. The reason code preserves why selection failed so
 * callers can surface an actionable diagnostic instead of flattening every
 * failure into "no priced operator".
 */
export function selectVaultOperatorFromList<T extends VaultOperatorAdvertisement>(
  operators: T[],
  model: string,
  opts: {
    teeOnly?: boolean;
    maxPriceUsdPerMtok?: number;
    requireAddress?: string;
    randomizeCheapestTies?: boolean;
  } = {}
): VaultOperatorSelection<T> {
  const teeOnly = opts.teeOnly === true;
  const want = opts.requireAddress?.toLowerCase();
  const addressPool = want
    ? operators.filter((operator) => operator.address.toLowerCase() === want)
    : operators;
  if (want && addressPool.length === 0) {
    return { selected: null, candidates: [], reason: "pinned_not_found" };
  }

  const modelPool = addressPool.filter((operator) =>
    operator.models.some((advertised) => matchesModel(advertised, model))
  );
  if (modelPool.length === 0) {
    return { selected: null, candidates: [], reason: "no_operator" };
  }

  const vaultPool = modelPool.filter((operator) => operator.vaultPayments === true);
  if (vaultPool.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_not_vault_capable" : "no_vault_operator",
    };
  }

  const servesTee = (operator: T): boolean =>
    operator.teeModels && operator.teeModels.length > 0
      ? operator.teeModels.some((advertised) => matchesModel(advertised, model))
      : operator.tee === true;
  const capabilityPool = teeOnly ? vaultPool.filter(servesTee) : vaultPool;
  if (capabilityPool.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_not_tee_capable" : "no_tee_operator",
    };
  }

  const resolved = capabilityPool.map((operator) => ({
    operator,
    priceUsdPerMtok: resolveModelPriceUsdPerMtok(operator.models, operator.pricing, model),
  }));
  const positivelyPriced = resolved.filter(
    (candidate): candidate is VaultOperatorCandidate<T> =>
      candidate.priceUsdPerMtok !== null && candidate.priceUsdPerMtok > 0
  );
  if (positivelyPriced.length === 0) {
    const free = resolved.some((candidate) => candidate.priceUsdPerMtok === 0);
    return {
      selected: null,
      candidates: [],
      reason: free
        ? want
          ? "pinned_free_model"
          : "free_model"
        : want
          ? "pinned_unpriced"
          : "unpriced",
    };
  }

  const withinPrice = positivelyPriced
    .filter(
      (candidate) =>
        opts.maxPriceUsdPerMtok === undefined ||
        candidate.priceUsdPerMtok <= opts.maxPriceUsdPerMtok
    )
    .sort((a, b) => a.priceUsdPerMtok - b.priceUsdPerMtok);
  if (withinPrice.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: want ? "pinned_out_of_range" : "out_of_range",
    };
  }

  const best = withinPrice[0].priceUsdPerMtok;
  const cheapest = withinPrice.filter(
    (candidate) => candidate.priceUsdPerMtok <= best + 1e-9
  );
  const selected = opts.randomizeCheapestTies
    ? cheapest[Math.floor(Math.random() * cheapest.length)]
    : cheapest[0];
  return { selected, candidates: withinPrice, reason: "selected" };
}

export function decodeBase64(value: string): string {
  const buffer = (
    globalThis as typeof globalThis & {
      Buffer?: { from(input: string, encoding: "base64"): { toString(encoding: "utf-8"): string } };
    }
  ).Buffer;
  return buffer ? buffer.from(value, "base64").toString("utf-8") : atob(value);
}

export function settlementAmount(paymentResponse: string): bigint | null {
  try {
    const decoded = JSON.parse(decodeBase64(paymentResponse)) as { amountUsdc?: unknown };
    return typeof decoded.amountUsdc === "string" && /^\d+$/.test(decoded.amountUsdc)
      ? BigInt(decoded.amountUsdc)
      : null;
  } catch {
    return null;
  }
}

export interface SseDataFrame {
  event: string;
  data: string[];
}

export function parseSseDataFrames(body: string): SseDataFrame[] {
  const frames: SseDataFrame[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    frames.push({ event, data });
  }
  return frames;
}

export interface ParsedVaultSettlement {
  present: boolean;
  amount: bigint;
}

export function parseVaultSettlement(headers: Headers, body: string): ParsedVaultSettlement {
  const header = headers.get("PAYMENT-RESPONSE");
  if (header) {
    const amount = settlementAmount(header);
    if (amount !== null) return { present: true, amount };
  }
  // Scan the body for a halo-settlement frame regardless of `content-type`. An
  // operator streams its settlement in the body when headers were already sent,
  // but `content-type` is operator-controlled — gating the scan on it lets an
  // operator suppress its OWN payment by mislabeling the response (invariant #3),
  // charging the consumer nothing for served work (invariant #4). A non-SSE body
  // simply yields no halo-settlement frame here, so scanning it is harmless.
  for (const { event, data } of parseSseDataFrames(body)) {
    if (event !== "halo-settlement" || data.length === 0) continue;
    try {
      const envelope = JSON.parse(data.join("\n")) as { paymentResponse?: unknown };
      if (typeof envelope.paymentResponse !== "string") continue;
      const amount = settlementAmount(envelope.paymentResponse);
      if (amount !== null) return { present: true, amount };
    } catch {
      // Ignore malformed events and keep looking for a valid settlement.
    }
  }
  return { present: false, amount: 0n };
}

export function reportedUsageTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const finite = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  const total = finite(value.total_tokens);
  if (total !== undefined) return total;
  const prompt = finite(value.prompt_tokens);
  const completion = finite(value.completion_tokens);
  return prompt !== undefined || completion !== undefined
    ? (prompt ?? 0) + (completion ?? 0)
    : undefined;
}

export function usageTokensFromSseBody(body: string): number | undefined {
  let tokens: number | undefined;
  for (const { data } of parseSseDataFrames(body)) {
    if (data.length === 0) continue;
    const payload = data.join("\n");
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { usage?: unknown };
      const reported = reportedUsageTokens(parsed.usage);
      if (reported !== undefined) tokens = reported;
    } catch {
      // Ignore non-JSON frames such as settlement events.
    }
  }
  return tokens;
}

/**
 * Reported usage tokens from a served response body, independent of the
 * operator-controlled `content-type` (invariant #3): read the body as a JSON
 * `usage` object, else as an SSE stream whose trailing frame carries `usage`.
 * Returns undefined when neither is present (an unmeterable response).
 */
export function usageTokensFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { usage?: unknown };
    const reported = reportedUsageTokens(parsed.usage);
    if (reported !== undefined) return reported;
  } catch {
    // Not a JSON body — fall through to SSE frame parsing below.
  }
  return usageTokensFromSseBody(body);
}

export interface VaultMeterResult {
  /** Base-unit amount to redeem for this response; 0n when unmeterable. */
  cost: bigint;
  /** The operator provided an explicit settlement (header or halo-settlement frame). */
  settled: boolean;
  /** cost derived from a settlement OR reported usage (false = unmeterable). */
  metered: boolean;
}

/**
 * Decide the redeemable cost for a served vault response — the ONE metering rule
 * every consumer (SDK `payInference`, CLI `vaultSend`, frontend hook) shares so
 * they can't drift into per-copy over/under-charge bugs. Preference order, none
 * of which trusts an operator-controlled header:
 *   1. explicit settlement — PAYMENT-RESPONSE header, or a halo-settlement frame
 *      anywhere in the body (`parseVaultSettlement` scans regardless of content-type);
 *   2. otherwise reported usage read from the body (`usageTokensFromBody`), priced
 *      at the operator's gate price;
 *   3. otherwise unmeterable → cost 0n, metered:false. The caller must NOT charge
 *      and should log it (invariant #2: never guess the pre-request estimate).
 * Metering is content-type independent by design (invariants #3/#4). The caller
 * still gates recordAndRedeem / `paid` on `res.ok`.
 */
export function meterVaultResponse(
  headers: Headers,
  body: string,
  priceUsdPerMtok: number
): VaultMeterResult {
  const settlement = parseVaultSettlement(headers, body);
  if (settlement.present) return { cost: settlement.amount, settled: true, metered: true };
  const usageTokens = usageTokensFromBody(body);
  if (usageTokens !== undefined) {
    return { cost: priceTokens(priceUsdPerMtok, usageTokens), settled: false, metered: true };
  }
  return { cost: 0n, settled: false, metered: false };
}

/**
 * Total send attempts for one vault inference when the operator gate keeps
 * advancing its required reservation between reserve and replay (invariant #5):
 * the first attempt plus up to N-1 reserve-and-replay retries. Bounded so a gate
 * that advances every round can't loop forever, and shared so the SDK, CLI, and
 * frontend consumer copies retry identically.
 */
export const MAX_VAULT_RESERVATION_ATTEMPTS = 3;
