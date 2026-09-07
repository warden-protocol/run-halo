import { getAddress } from "ethers";
import {
  buildSponsoredVaultDepositBundle,
  DirectVaultFundingError,
  type DirectVaultFundingActionV1,
  type DirectVaultFundingReconciliation,
  type SponsoredVaultDepositBundleV1,
  type VaultFundingPreparationV1,
} from "halo-sdk";
import { setFacilitatorCliVersionHeader } from "../../versionHeader";
import type { WalletCatalogV1 } from "../domain/walletCatalog";
import {
  WalletAccessError,
  type PrivyWalletAccessSession,
  type WalletAccessAuthorization,
} from "../domain/walletAccess";
import type { ConsumeSessionKeyStore } from "../infrastructure/fileConsumeSessionKeyStore";
import type { DirectVaultFundingStore } from "../infrastructure/fileDirectVaultFundingStore";
import type {
  SponsoredVaultFundingRecordV1,
  SponsoredVaultFundingResponseV1,
  SponsoredVaultFundingStore,
} from "../infrastructure/fileSponsoredVaultFundingStore";
import type { PrivySessionRefreshStore } from "./refresh";

const MAX_RESPONSE_BYTES = 64 * 1024;
const HASH = /^0x[0-9a-f]{64}$/;
const RESPONSE_PHASES = new Set([
  "validation",
  "approval-funding",
  "approval",
  "deposit-funding",
  "deposit",
  "complete",
]);

interface SponsoredFundingClient {
  prepareRoute(input: {
    consumerAddress: string;
    sessionAddress: string;
    targetBalanceBase: bigint;
  }): Promise<VaultFundingPreparationV1>;
  revalidateSponsored(action: DirectVaultFundingActionV1): Promise<boolean>;
  reconcileSponsored(
    action: DirectVaultFundingActionV1,
    transactionHashes: { approval: string | null; deposit: string }
  ): Promise<{
    approval: DirectVaultFundingReconciliation | null;
    deposit: DirectVaultFundingReconciliation;
  }>;
}

interface FacilitatorResponse {
  status: "confirmed" | "pending" | "rejected" | "reverted";
  phase: string;
  operationId: string | null;
  consumer: string | null;
  approvalTransaction: string | null;
  depositTransaction: string | null;
  error: { code: string; retryable: boolean } | null;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export type PrivyVaultFundingRouteResult =
  | { mode: "direct"; transactionHashes: string[] }
  | { mode: "satisfied"; transactionHashes: string[] }
  | { mode: "sponsored"; transactionHashes: string[] };

function failure(
  code:
    | "privy_sponsored_funding_ambiguous"
    | "privy_sponsored_funding_pending"
    | "privy_sponsored_funding_rejected"
    | "privy_sponsored_funding_reverted"
    | "privy_sponsored_funding_state_ambiguous"
    | "privy_sponsored_funding_unavailable",
  message: string
): WalletAccessError {
  return new WalletAccessError(code, message);
}

function pending(): WalletAccessError {
  return failure(
    "privy_sponsored_funding_pending",
    "The sponsored Privy Vault deposit is not final yet. Wait for Base confirmation, then run halo consume again."
  );
}

function ambiguous(): WalletAccessError {
  return failure(
    "privy_sponsored_funding_ambiguous",
    "The sponsored Privy Vault-deposit send outcome is ambiguous. Its exact signed request was retained; inspect the scoped state before any manual transaction or retry."
  );
}

function preflight(error: unknown): WalletAccessError {
  if (error instanceof WalletAccessError) return error;
  if (error instanceof DirectVaultFundingError) {
    if (error.code === "session_key_mismatch") {
      return new WalletAccessError("privy_session_key_mismatch", error.message);
    }
    return new WalletAccessError("privy_direct_funding_insufficient", error.message);
  }
  return failure(
    "privy_sponsored_funding_unavailable",
    "Sponsored Privy Vault-funding preflight could not prove a complete current Base snapshot. No new request was sent."
  );
}

function sameCatalog(expected: WalletCatalogV1, current: WalletCatalogV1): boolean {
  try {
    return expected.selector === "privy" &&
      current.selector === "privy" &&
      expected.generation === current.generation &&
      expected.privyAppId !== null &&
      current.privyAppId === expected.privyAppId &&
      expected.privyIdentity !== null &&
      current.privyIdentity !== null &&
      expected.privyIdentity.walletId === current.privyIdentity.walletId &&
      getAddress(expected.privyIdentity.address) === getAddress(current.privyIdentity.address);
  } catch {
    return false;
  }
}

function currentSessionMatches(input: {
  sessionStore: PrivySessionRefreshStore;
  sessionGeneration: string;
  catalog: WalletCatalogV1;
  now: Date;
}): boolean {
  const state = input.sessionStore.readState();
  const identity = input.catalog.privyIdentity;
  try {
    return state.kind === "active" &&
      state.record.refreshedAt === input.sessionGeneration &&
      identity !== null &&
      state.record.session.appId === input.catalog.privyAppId &&
      state.record.session.walletId === identity.walletId &&
      getAddress(state.record.session.identity.address) === getAddress(identity.address) &&
      Date.parse(state.record.session.expiresAt) > input.now.getTime();
  } catch {
    return false;
  }
}

function updated(
  record: SponsoredVaultFundingRecordV1,
  changes: Partial<SponsoredVaultFundingRecordV1>,
  now: () => Date
): SponsoredVaultFundingRecordV1 {
  return { ...record, ...changes, updatedAt: now().toISOString() };
}

function safeResponse(response: FacilitatorResponse): SponsoredVaultFundingResponseV1 {
  return {
    status: response.status,
    phase: response.phase,
    operationId: response.operationId,
    errorCode: response.error?.code ?? null,
    retryable: response.error?.retryable ?? false,
  };
}

function nullableHash(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !HASH.test(value.toLowerCase())) {
    throw new Error("facilitator hash is malformed");
  }
  return value.toLowerCase();
}

function parseFacilitatorResponse(
  value: unknown,
  record: SponsoredVaultFundingRecordV1
): FacilitatorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("facilitator response is malformed");
  }
  const entry = value as Record<string, unknown>;
  const expectedKeys = [
    "approvalTransaction",
    "consumer",
    "depositTransaction",
    "fundingTransactions",
    "operationId",
    "phase",
    "status",
    "version",
  ];
  if (entry.error !== undefined) expectedKeys.push("error");
  if (entry.receipts !== undefined) expectedKeys.push("receipts");
  if (
    !exactKeys(entry, expectedKeys) ||
    entry.version !== 1 ||
    !["confirmed", "pending", "rejected", "reverted"].includes(String(entry.status)) ||
    !RESPONSE_PHASES.has(String(entry.phase))
  ) throw new Error("facilitator response is malformed");
  const operationId = nullableHash(entry.operationId);
  const approvalTransaction = nullableHash(entry.approvalTransaction);
  const depositTransaction = nullableHash(entry.depositTransaction);
  let consumer: string | null = null;
  if (entry.consumer !== null) {
    if (typeof entry.consumer !== "string") throw new Error("facilitator consumer is malformed");
    consumer = getAddress(entry.consumer);
  }
  let responseError: FacilitatorResponse["error"] = null;
  if (entry.error !== undefined) {
    if (typeof entry.error !== "object" || entry.error === null || Array.isArray(entry.error)) {
      throw new Error("facilitator error is malformed");
    }
    const candidate = entry.error as Record<string, unknown>;
    if (
      typeof candidate.code !== "string" || candidate.code.length < 1 || candidate.code.length > 128 ||
      typeof candidate.message !== "string" || candidate.message.length < 1 || candidate.message.length > 1_024 ||
      typeof candidate.retryable !== "boolean"
    ) throw new Error("facilitator error is malformed");
    responseError = { code: candidate.code, retryable: candidate.retryable };
  }
  const status = entry.status as FacilitatorResponse["status"];
  if (
    (status === "confirmed" && responseError !== null) ||
    ((status === "rejected" || status === "reverted") && responseError === null)
  ) {
    throw new Error("facilitator error disposition is malformed");
  }
  if (
    !Array.isArray(entry.fundingTransactions) ||
    entry.fundingTransactions.length > 8 ||
    !entry.fundingTransactions.every((hash) =>
      typeof hash === "string" && HASH.test(hash.toLowerCase())) ||
    (entry.receipts !== undefined &&
      (typeof entry.receipts !== "object" || entry.receipts === null || Array.isArray(entry.receipts)))
  ) throw new Error("facilitator transaction evidence is malformed");
  const expectedOperationId = record.activeRequest === "initial"
    ? record.bundle.initialOperationId
    : record.bundle.depositOnlyOperationId;
  const expectedApproval = record.activeRequest === "initial"
    ? record.bundle.approvalHash
    : null;
  if (operationId === null) {
    if (status !== "rejected" || consumer !== null || approvalTransaction !== null || depositTransaction !== null) {
      throw new Error("facilitator unbound response is malformed");
    }
  } else if (
    operationId !== expectedOperationId ||
    consumer !== record.action.consumerAddress ||
    approvalTransaction !== expectedApproval ||
    depositTransaction !== record.bundle.depositHash
  ) {
    throw new Error("facilitator response does not match the durable request");
  }
  return {
    status,
    phase: String(entry.phase),
    operationId,
    consumer,
    approvalTransaction,
    depositTransaction,
    error: responseError,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("facilitator returned an empty response");
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("facilitator response exceeds its byte limit");
    }
    body += decoder.decode(next.value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body) as unknown;
}

function evidenceFrom(
  record: SponsoredVaultFundingRecordV1,
  outcome: Awaited<ReturnType<SponsoredFundingClient["reconcileSponsored"]>>
): SponsoredVaultFundingRecordV1["evidence"] {
  const evidence = { ...record.evidence };
  if (outcome.approval?.status === "succeeded" && outcome.approval.blockNumber !== null) {
    evidence.approvalBlock = String(outcome.approval.blockNumber);
    evidence.approvalStatus = "success";
  } else if (outcome.approval?.status === "reverted") {
    evidence.approvalBlock = String(outcome.approval.blockNumber);
    evidence.approvalStatus = "reverted";
  }
  if (outcome.deposit.status === "succeeded" && outcome.deposit.blockNumber !== null) {
    evidence.depositBlock = String(outcome.deposit.blockNumber);
    evidence.depositStatus = "success";
  } else if (outcome.deposit.status === "reverted") {
    evidence.depositBlock = String(outcome.deposit.blockNumber);
    evidence.depositStatus = "reverted";
  }
  return evidence;
}

async function reconcile(input: {
  client: SponsoredFundingClient;
  store: SponsoredVaultFundingStore;
  record: SponsoredVaultFundingRecordV1;
  now: () => Date;
}): Promise<{ record: SponsoredVaultFundingRecordV1; complete: boolean }> {
  let outcome: Awaited<ReturnType<SponsoredFundingClient["reconcileSponsored"]>>;
  try {
    outcome = await input.client.reconcileSponsored(input.record.action, {
      approval: input.record.bundle.approvalHash,
      deposit: input.record.bundle.depositHash,
    });
  } catch (error) {
    throw preflight(error);
  }
  const evidence = evidenceFrom(input.record, outcome);
  if (outcome.deposit.status === "succeeded") {
    input.store.clear();
    return { record: { ...input.record, evidence }, complete: true };
  }
  if (outcome.deposit.status === "reverted" || outcome.approval?.status === "reverted") {
    if (input.record.state !== "reverted" ||
      JSON.stringify(input.record.evidence) !== JSON.stringify(evidence)) {
      input.store.write(updated(input.record, {
        state: "reverted",
        disposition: "terminal",
        evidence,
      }, input.now));
    }
    throw failure(
      "privy_sponsored_funding_reverted",
      "The sponsored Privy Vault deposit reverted on Base. Its signed action was retained for inspection."
    );
  }
  const approvalSucceeded = outcome.approval?.status === "succeeded";
  const deterministicStaleApproval = input.record.activeRequest === "initial" &&
    input.record.lastResponse?.status === "rejected" &&
    input.record.lastResponse.phase === "validation" &&
    (input.record.lastResponse.errorCode === "approval_not_required" ||
      input.record.lastResponse.errorCode === "state_changed") &&
    input.record.provenUnsentThroughGeneration === input.record.sendGeneration;
  if (approvalSucceeded && deterministicStaleApproval) {
    const next = updated(input.record, {
      state: "ready",
      disposition: "ready",
      activeRequest: "deposit-only",
      evidence,
    }, input.now);
    input.store.write(next);
    return { record: next, complete: false };
  }
  if (input.record.state === "ready") return { record: input.record, complete: false };
  if (input.record.state !== "ambiguous") {
    input.store.write(updated(input.record, {
      state: input.record.state === "pending" ? "pending" : "ambiguous",
      disposition: input.record.state === "pending" ? "pending" : "ambiguous",
      evidence,
    }, input.now));
  } else if (JSON.stringify(input.record.evidence) !== JSON.stringify(evidence)) {
    input.store.write(updated(input.record, { evidence }, input.now));
  }
  if (input.record.state === "pending") throw pending();
  throw ambiguous();
}

async function postExact(input: {
  record: SponsoredVaultFundingRecordV1;
  store: SponsoredVaultFundingStore;
  facilitatorUrl: string;
  fetchFn: typeof fetch;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<{ response: FacilitatorResponse; record: SponsoredVaultFundingRecordV1 }> {
  let record = input.record;
  const body = record.activeRequest === "initial"
    ? record.bundle.initialRequestBody
    : record.bundle.depositOnlyRequestBody;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    record = updated(record, {
      state: "sending",
      disposition: "ambiguous",
      sendGeneration: record.sendGeneration + 1,
      lastResponse: null,
    }, input.now);
    input.store.write(record);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    setFacilitatorCliVersionHeader(headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const httpResponse = await input.fetchFn(
        `${input.facilitatorUrl.replace(/\/+$/, "")}/vault/sponsor-deposit`,
        {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        }
      );
      let parsed: FacilitatorResponse;
      try {
        parsed = parseFacilitatorResponse(await boundedJson(httpResponse), record);
        const statusMatches =
          (parsed.status === "confirmed" && httpResponse.status === 200) ||
          (parsed.status === "pending" &&
            (httpResponse.status === 202 || httpResponse.status === 503)) ||
          ((parsed.status === "rejected" || parsed.status === "reverted") &&
            [400, 409, 426, 429, 503].includes(httpResponse.status));
        if (!statusMatches) throw new Error("facilitator HTTP status is inconsistent");
      } catch (error) {
        if ((httpResponse.status === 408 || httpResponse.status >= 500) && attempt < 2) {
          await input.sleep(attempt === 0 ? 500 : 1_000);
          continue;
        }
        const retained = updated(record, {
          state: "ambiguous",
          disposition: "ambiguous",
        }, input.now);
        input.store.write(retained);
        throw ambiguous();
      }
      const metadata = safeResponse(parsed);
      if (
        parsed.status === "rejected" &&
        parsed.operationId === null &&
        parsed.error?.retryable === true &&
        (httpResponse.status === 408 || httpResponse.status >= 500) &&
        attempt < 2
      ) {
        record = updated(record, {
          state: "ready",
          disposition: "retryable",
          provenUnsentThroughGeneration: record.sendGeneration,
          lastResponse: metadata,
        }, input.now);
        input.store.write(record);
        await input.sleep(attempt === 0 ? 500 : 1_000);
        continue;
      }
      return { response: parsed, record };
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      if (attempt < 2) {
        await input.sleep(attempt === 0 ? 500 : 1_000);
        continue;
      }
      const retained = updated(record, {
        state: "ambiguous",
        disposition: "ambiguous",
      }, input.now);
      input.store.write(retained);
      throw ambiguous();
    } finally {
      clearTimeout(timer);
    }
  }
  throw ambiguous();
}

function freshRecord(input: {
  catalog: WalletCatalogV1;
  sessionGeneration: string;
  action: DirectVaultFundingActionV1;
  bundle: SponsoredVaultDepositBundleV1;
  now: () => Date;
}): SponsoredVaultFundingRecordV1 {
  const timestamp = input.now().toISOString();
  return {
    version: 1,
    catalogGeneration: input.catalog.generation,
    sessionGeneration: input.sessionGeneration,
    sendGeneration: 0,
    provenUnsentThroughGeneration: 0,
    state: "ready",
    disposition: "ready",
    activeRequest: "initial",
    createdAt: timestamp,
    updatedAt: timestamp,
    action: input.action,
    bundle: input.bundle,
    evidence: {
      approvalBlock: null,
      approvalStatus: null,
      depositBlock: null,
      depositStatus: null,
    },
    lastResponse: null,
  };
}

export async function routePrivyVaultFunding(input: {
  initialCatalog: WalletCatalogV1;
  readCurrentCatalog: () => WalletCatalogV1;
  consumerAddress: string;
  sessionAddress: string;
  targetBalanceBase: bigint | null;
  facilitatorUrl: string;
  keyStore: ConsumeSessionKeyStore;
  directFundingStore?: DirectVaultFundingStore;
  fundingStore: SponsoredVaultFundingStore;
  sessionStore: PrivySessionRefreshStore;
  client: SponsoredFundingClient;
  authorize: () => Promise<{
    authorization: WalletAccessAuthorization<PrivyWalletAccessSession>;
    sessionGeneration: string;
  }>;
  fetchFn?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<PrivyVaultFundingRouteResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return input.keyStore.withScopeLock(async () => {
    const transactionHashes: string[] = [];
    let record = input.fundingStore.read();
    const directRecord = input.directFundingStore?.read() ?? null;
    if (directRecord !== null && record !== null) {
      throw failure(
        "privy_sponsored_funding_state_ambiguous",
        "Direct and sponsored Privy Vault-funding records overlap. Inspect the scoped state before retrying."
      );
    }
    if (directRecord !== null) {
      throw new WalletAccessError(
        "privy_direct_funding_pending",
        "A durable direct Privy Vault-funding action appeared before sponsorship began. Run halo consume again to reconcile it."
      );
    }
    if (record !== null) {
      try {
        if (
          getAddress(record.action.consumerAddress) !== getAddress(input.consumerAddress) ||
          getAddress(record.action.sessionAddress) !== getAddress(input.sessionAddress)
        ) throw new Error("scope changed");
      } catch {
        throw failure(
          "privy_sponsored_funding_state_ambiguous",
          "The durable sponsored-deposit action no longer matches the selected Privy consumer and session. Inspect the scoped state before retrying."
        );
      }
      const reconciled = await reconcile({
        client: input.client,
        store: input.fundingStore,
        record,
        now,
      });
      if (reconciled.complete) {
        transactionHashes.push(record.bundle.depositHash);
        if (input.targetBalanceBase === null) {
          return { mode: "sponsored", transactionHashes };
        }
        record = null;
      } else {
        record = reconciled.record;
      }
    }

    if (record === null) {
      if (input.targetBalanceBase === null) {
        return transactionHashes.length > 0
          ? { mode: "sponsored", transactionHashes }
          : { mode: "satisfied", transactionHashes: [] };
      }
      let route: VaultFundingPreparationV1 | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          route = await input.client.prepareRoute({
            consumerAddress: input.consumerAddress,
            sessionAddress: input.sessionAddress,
            targetBalanceBase: input.targetBalanceBase,
          });
          break;
        } catch (error) {
          if (error instanceof DirectVaultFundingError) throw preflight(error);
          lastError = error;
          if (attempt < 2) await sleep(attempt === 0 ? 500 : 1_000);
        }
      }
      if (route === undefined) throw preflight(lastError);
      if (route.mode === "satisfied") {
        return transactionHashes.length > 0
          ? { mode: "sponsored", transactionHashes }
          : { mode: "satisfied", transactionHashes: [] };
      }
      if (route.mode === "direct") return { mode: "direct", transactionHashes };

      const resolved = await input.authorize();
      try {
        record = await input.sessionStore.withRefreshLock(async () => {
          const currentCatalog = input.readCurrentCatalog();
          let valid = false;
          try {
            valid = await input.client.revalidateSponsored(route.action);
          } catch {}
          if (
            !sameCatalog(input.initialCatalog, currentCatalog) ||
            !currentSessionMatches({
              sessionStore: input.sessionStore,
              sessionGeneration: resolved.sessionGeneration,
              catalog: currentCatalog,
              now: now(),
            }) ||
            !valid
          ) throw preflight(new Error("wallet or chain state changed during signing"));
          const sign = resolved.authorization.signEvmTransaction;
          if (sign === undefined) {
            throw new WalletAccessError(
              "wallet_backend_unsupported_for_command",
              "The selected Wallet Access backend cannot sign sponsored Base transactions."
            );
          }
          const signedApproval = route.action.kind === "approval"
            ? await sign.call(resolved.authorization, route.action.transaction)
            : undefined;
          const depositTransaction = route.action.kind === "approval"
            ? route.action.followingDepositTransaction
            : route.action.transaction;
          if (depositTransaction === undefined) throw preflight(new Error("missing deposit"));
          const signedDeposit = await sign.call(resolved.authorization, depositTransaction);
          const bundle = buildSponsoredVaultDepositBundle({
            action: route.action,
            ...(signedApproval === undefined ? {} : { signedApprovalTransaction: signedApproval }),
            signedDepositTransaction: signedDeposit,
          });
          const created = freshRecord({
            catalog: currentCatalog,
            sessionGeneration: resolved.sessionGeneration,
            action: route.action,
            bundle,
            now,
          });
          input.fundingStore.write(created);
          return created;
        });
      } finally {
        resolved.authorization.dispose();
      }
    }

    for (;;) {
      if (record.state !== "ready") {
        if (record.state === "pending") throw pending();
        if (record.state === "reverted") {
          throw failure(
            "privy_sponsored_funding_reverted",
            "The sponsored Privy Vault deposit reverted on Base. Its signed action was retained for inspection."
          );
        }
        throw ambiguous();
      }
      if (record.disposition === "terminal") {
        throw failure(
          "privy_sponsored_funding_rejected",
          "The facilitator previously rejected the sponsored Vault deposit. Its exact request was retained for inspection."
        );
      }
      if (
        record.catalogGeneration !== input.initialCatalog.generation ||
        !sameCatalog(input.initialCatalog, input.readCurrentCatalog()) ||
        !currentSessionMatches({
          sessionStore: input.sessionStore,
          sessionGeneration: record.sessionGeneration,
          catalog: input.initialCatalog,
          now: now(),
        })
      ) {
        throw failure(
          "privy_sponsored_funding_state_ambiguous",
          "Wallet Access changed before the sponsored request could be sent. The exact signed request was retained for inspection."
        );
      }
      const posted = await postExact({
        record,
        store: input.fundingStore,
        facilitatorUrl: input.facilitatorUrl,
        fetchFn,
        now,
        sleep,
      });
      record = posted.record;
      const metadata = safeResponse(posted.response);
      if (posted.response.status === "rejected" && posted.response.operationId === null) {
        const retryable = posted.response.error?.retryable === true;
        const next = updated(record, {
          state: "ready",
          disposition: retryable ? "retryable" : "terminal",
          provenUnsentThroughGeneration: record.sendGeneration,
          lastResponse: metadata,
        }, now);
        input.fundingStore.write(next);
        throw failure(
          retryable ? "privy_sponsored_funding_unavailable" : "privy_sponsored_funding_rejected",
          retryable
            ? "The facilitator did not accept the sponsored Vault deposit. Its exact unsent request was retained for a later retry."
            : "The facilitator rejected the sponsored Vault deposit before accepting any transaction. Its exact request was retained for inspection."
        );
      }
      if (posted.response.status === "rejected") {
        const deterministicStale = posted.response.phase === "validation" &&
          (posted.response.error?.code === "approval_not_required" ||
            posted.response.error?.code === "state_changed");
        const next = updated(record, {
          state: deterministicStale ? "ready" : "ambiguous",
          disposition: deterministicStale ? "retryable" : "terminal",
          provenUnsentThroughGeneration: deterministicStale
            ? record.sendGeneration
            : record.provenUnsentThroughGeneration,
          lastResponse: metadata,
        }, now);
        input.fundingStore.write(next);
        if (deterministicStale) {
          const reconciled = await reconcile({
            client: input.client,
            store: input.fundingStore,
            record: next,
            now,
          });
          record = reconciled.record;
          if (record.activeRequest === "deposit-only") continue;
        }
        throw failure(
          "privy_sponsored_funding_rejected",
          "The facilitator rejected the sponsored Vault deposit. Its exact signed request was retained for inspection."
        );
      }
      const responseState = posted.response.status === "pending" ? "pending" :
        posted.response.status === "reverted" ? "reverted" : "pending";
      const next = updated(record, {
        state: responseState,
        disposition: responseState === "reverted" ? "terminal" : "pending",
        lastResponse: metadata,
      }, now);
      input.fundingStore.write(next);
      const reconciled = await reconcile({
        client: input.client,
        store: input.fundingStore,
        record: next,
        now,
      });
      if (reconciled.complete) {
        transactionHashes.push(record.bundle.depositHash);
        return { mode: "sponsored", transactionHashes };
      }
      throw pending();
    }
  });
}
