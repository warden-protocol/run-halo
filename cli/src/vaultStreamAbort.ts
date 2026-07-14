import { VaultCreditLedger } from "./vaultCredit";

export interface ReleaseAbortedVaultServeParams {
  abortedRequestIds: ReadonlySet<string>;
  requestId: string;
  creditLedger: VaultCreditLedger;
  consumer: string;
  operator: string;
  cycle: bigint;
  ceiling: bigint;
}

export function releaseAbortedVaultServe(
  params: ReleaseAbortedVaultServeParams
): boolean {
  if (!params.abortedRequestIds.has(params.requestId)) return false;
  params.creditLedger.releaseInflight(
    params.consumer,
    params.operator,
    params.cycle,
    params.ceiling
  );
  return true;
}

export async function withAbortedStreamCleanup<T>(
  abortedRequestIds: Set<string>,
  requestId: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } finally {
    abortedRequestIds.delete(requestId);
  }
}
