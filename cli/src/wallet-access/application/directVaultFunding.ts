import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import type {
  DirectVaultFundingActionV1,
  DirectVaultFundingClient,
  DirectVaultFundingReconciliation,
} from "halo-sdk";
import { DirectVaultFundingError } from "halo-sdk";
import type { WalletCatalogV1 } from "../domain/walletCatalog";
import {
  WalletAccessError,
  type WalletAccessAuthorization,
  type PrivyWalletAccessSession,
} from "../domain/walletAccess";
import type { ConsumeSessionKeyStore } from "../infrastructure/fileConsumeSessionKeyStore";
import type {
  DirectVaultFundingRecordV1,
  DirectVaultFundingStore,
} from "../infrastructure/fileDirectVaultFundingStore";
import type { PrivySessionRefreshStore } from "./refresh";

interface DirectFundingClient {
  prepare(input: {
    consumerAddress: string;
    sessionAddress: string;
    targetBalanceBase: bigint;
  }): Promise<DirectVaultFundingActionV1 | null>;
  revalidate(action: DirectVaultFundingActionV1): Promise<boolean>;
  reconcile(
    action: DirectVaultFundingActionV1,
    transactionHash: string | null
  ): Promise<DirectVaultFundingReconciliation>;
}

export interface DirectVaultFundingResult {
  funded: boolean;
  transactionHashes: string[];
}

function pending(): WalletAccessError {
  return new WalletAccessError(
    "privy_direct_funding_pending",
    "A submitted Privy Vault-funding transaction is not final yet. Wait for Base confirmation, then run halo consume again."
  );
}

function ambiguous(): WalletAccessError {
  return new WalletAccessError(
    "privy_direct_funding_ambiguous",
    "Privy Vault-funding submission is ambiguous. The durable scoped action was retained; inspect it before any manual transaction or retry."
  );
}

function preflight(error: unknown): WalletAccessError {
  if (error instanceof DirectVaultFundingError) {
    if (error.code === "session_key_mismatch") {
      return new WalletAccessError("privy_session_key_mismatch", error.message);
    }
    return new WalletAccessError("privy_direct_funding_insufficient", error.message);
  }
  return new WalletAccessError(
    "privy_direct_funding_preflight_unavailable",
    "Direct Privy Vault-funding preflight could not prove a complete current Base snapshot. No transaction was sent."
  );
}

function sameCatalog(expected: WalletCatalogV1, current: WalletCatalogV1): boolean {
  const expectedIdentity = expected.privyIdentity;
  const currentIdentity = current.privyIdentity;
  try {
    return (
      expected.selector === "privy" &&
      current.selector === "privy" &&
      expected.generation === current.generation &&
      expected.privyAppId !== null &&
      current.privyAppId === expected.privyAppId &&
      expectedIdentity !== null &&
      currentIdentity !== null &&
      expectedIdentity.walletId === currentIdentity.walletId &&
      getAddress(expectedIdentity.address) === getAddress(currentIdentity.address)
    );
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
  if (state.kind !== "active" || state.record.refreshedAt !== input.sessionGeneration) {
    return false;
  }
  const identity = input.catalog.privyIdentity;
  try {
    return (
      identity !== null &&
      state.record.session.appId === input.catalog.privyAppId &&
      state.record.session.walletId === identity.walletId &&
      getAddress(state.record.session.identity.address) === getAddress(identity.address) &&
      Date.parse(state.record.session.expiresAt) > input.now.getTime()
    );
  } catch {
    return false;
  }
}

function updatedRecord(
  record: DirectVaultFundingRecordV1,
  update: Partial<DirectVaultFundingRecordV1>,
  now: () => Date
): DirectVaultFundingRecordV1 {
  return { ...record, ...update, updatedAt: now().toISOString() };
}

async function reconcilePersisted(input: {
  client: DirectFundingClient;
  store: DirectVaultFundingStore;
  record: DirectVaultFundingRecordV1;
  now: () => Date;
}): Promise<{ completedKind: "approval" | "deposit"; hash: string | null } | null> {
  let outcome: DirectVaultFundingReconciliation;
  try {
    outcome = await input.client.reconcile(
      input.record.action,
      input.record.transactionHash
    );
  } catch (error) {
    throw preflight(error);
  }
  if (outcome.status === "succeeded") {
    input.store.clear();
    return {
      completedKind: input.record.action.kind,
      hash: input.record.transactionHash,
    };
  }
  if (outcome.status === "reverted") {
    input.store.clear();
    throw new WalletAccessError(
      "privy_direct_funding_reverted",
      "The Privy Vault-funding transaction reverted on Base. Its durable action was cleared; inspect the transaction before a new explicit attempt."
    );
  }
  if (outcome.status === "pending" || outcome.status === "state-pending") {
    throw pending();
  }
  if (input.record.sendState !== "ambiguous") {
    input.store.write(
      updatedRecord(input.record, { sendState: "ambiguous" }, input.now)
    );
  }
  throw ambiguous();
}

export async function fundPrivyVaultDirect(input: {
  initialCatalog: WalletCatalogV1;
  readCurrentCatalog: () => WalletCatalogV1;
  consumerAddress: string;
  sessionAddress: string;
  targetBalanceBase: bigint | null;
  keyStore: ConsumeSessionKeyStore;
  fundingStore: DirectVaultFundingStore;
  sessionStore: PrivySessionRefreshStore;
  client: DirectFundingClient | DirectVaultFundingClient;
  authorize: () => Promise<{
    authorization: WalletAccessAuthorization<PrivyWalletAccessSession>;
    sessionGeneration: string;
  }>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  referenceId?: () => string;
}): Promise<DirectVaultFundingResult> {
  const now = input.now ?? (() => new Date());
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const makeReferenceId =
    input.referenceId ?? (() => `halo_${randomBytes(16).toString("hex")}`);
  return input.keyStore.withScopeLock(async () => {
    const hashes: string[] = [];
    const existing = input.fundingStore.read();
    if (existing !== null) {
      try {
        if (
          getAddress(existing.action.consumerAddress) !== getAddress(input.consumerAddress) ||
          getAddress(existing.action.sessionAddress) !== getAddress(input.sessionAddress)
        ) {
          throw new Error("scope mismatch");
        }
      } catch {
        throw new WalletAccessError(
          "privy_direct_funding_state_ambiguous",
          "The durable Privy funding action does not match the current consumer authority. Inspect the scoped state before retrying."
        );
      }
      const reconciled = await reconcilePersisted({
        client: input.client,
        store: input.fundingStore,
        record: existing,
        now,
      });
      if (reconciled?.hash) hashes.push(reconciled.hash);
      if (reconciled?.completedKind === "deposit") {
        return { funded: true, transactionHashes: hashes };
      }
      if (input.targetBalanceBase === null) {
        return { funded: false, transactionHashes: hashes };
      }
    }

    if (input.targetBalanceBase === null) {
      return { funded: false, transactionHashes: hashes };
    }
    const targetBalanceBase = input.targetBalanceBase;

    for (let leg = 0; leg < 2; leg += 1) {
      let lastReadError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let action: DirectVaultFundingActionV1 | null;
        try {
          action = await input.client.prepare({
            consumerAddress: input.consumerAddress,
            sessionAddress: input.sessionAddress,
            targetBalanceBase,
          });
        } catch (error) {
          if (error instanceof DirectVaultFundingError) throw preflight(error);
          lastReadError = error;
          if (attempt < 2) await sleep(attempt === 0 ? 500 : 1_000);
          continue;
        }
        if (action === null) {
          return { funded: hashes.length > 0, transactionHashes: hashes };
        }
        let resolved: Awaited<ReturnType<typeof input.authorize>>;
        try {
          resolved = await input.authorize();
        } catch (error) {
          throw error;
        }
        let attemptOutcome:
          | "retry"
          | "next-leg"
          | DirectVaultFundingResult;
        try {
          attemptOutcome = await input.sessionStore.withRefreshLock(async () => {
            const currentCatalog = input.readCurrentCatalog();
            let actionStillValid = false;
            try {
              actionStillValid = await input.client.revalidate(action);
            } catch (error) {
              lastReadError = error;
            }
            if (
              !sameCatalog(input.initialCatalog, currentCatalog) ||
              !currentSessionMatches({
                sessionStore: input.sessionStore,
                sessionGeneration: resolved.sessionGeneration,
                catalog: currentCatalog,
                now: now(),
              }) ||
              !actionStillValid
            ) {
              lastReadError = new Error("wallet or chain state changed during preflight");
              return "retry";
            }
            const send = resolved.authorization.sendEvmTransaction;
            if (send === undefined) {
              throw new WalletAccessError(
                "wallet_backend_unsupported_for_command",
                "The selected Wallet Access backend cannot authorize Base transactions."
              );
            }
            const createdAt = now().toISOString();
            const record: DirectVaultFundingRecordV1 = {
              version: 1,
              catalogGeneration: currentCatalog.generation,
              sessionGeneration: resolved.sessionGeneration,
              referenceId: makeReferenceId(),
              sendState: "sending",
              transactionHash: null,
              providerTransactionId: null,
              createdAt,
              updatedAt: createdAt,
              action,
            };
            input.fundingStore.write(record);
            let submission;
            try {
              submission = await send.call(
                resolved.authorization,
                action.transaction,
                record.referenceId
              );
            } catch (error) {
              if (
                !(error instanceof WalletAccessError) ||
                error.code === "privy_rpc_ambiguous" ||
                error.code === "privy_protocol_error"
              ) {
                input.fundingStore.write(
                  updatedRecord(record, { sendState: "ambiguous" }, now)
                );
                throw ambiguous();
              }
              input.fundingStore.clear();
              throw error;
            }
            const submitted = updatedRecord(
              record,
              {
                sendState: "submitted",
                transactionHash: submission.transactionHash,
                providerTransactionId: submission.providerTransactionId,
              },
              now
            );
            input.fundingStore.write(submitted);
            const reconciled = await reconcilePersisted({
              client: input.client,
              store: input.fundingStore,
              record: submitted,
              now,
            });
            if (reconciled?.hash) hashes.push(reconciled.hash);
            if (reconciled?.completedKind === "deposit") {
              return { funded: true, transactionHashes: hashes };
            }
            return "next-leg";
          });
        } finally {
          resolved.authorization.dispose();
        }
        if (typeof attemptOutcome !== "string") return attemptOutcome;
        if (attemptOutcome === "next-leg") break;
        if (attempt < 2) {
          await sleep(attempt === 0 ? 500 : 1_000);
          continue;
        }
        break;
      }
      if (lastReadError !== undefined) throw preflight(lastReadError);
    }
    throw new WalletAccessError(
      "privy_direct_funding_state_ambiguous",
      "Direct Privy Vault funding did not reach the requested target after its bounded transaction sequence. Inspect Base and the scoped funding state."
    );
  });
}
