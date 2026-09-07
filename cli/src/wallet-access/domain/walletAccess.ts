export type WalletAccessBackend = "keystore" | "privy";

export interface WalletAccessIdentity {
  backend: WalletAccessBackend;
  address: string;
}

export interface WalletAccessChallenge {
  verificationUri: string;
  userCode: string;
}

export interface WalletAccessSession {
  version: 1;
  identity: WalletAccessIdentity;
  expiresAt: string;
}

export interface PrivyWalletAccessSession extends WalletAccessSession {
  version: 1;
  identity: { backend: "privy"; address: string };
  appId: string;
  walletId: string;
  accessToken: string;
  refreshToken: string;
}

export interface WalletAccessEvmTransaction {
  from: string;
  to: string;
  chainId: "8453";
  type: 2;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  value: "0";
  data: string;
}

export interface WalletAccessTransactionSubmission {
  transactionHash: string;
  providerTransactionId: string | null;
  referenceId: string;
}

export interface WalletAccessAuthorization<Session extends WalletAccessSession = WalletAccessSession> {
  identity: WalletAccessIdentity;
  session: Session;
  signPersonalMessage(message: string): Promise<string>;
  signEvmTransaction?(transaction: WalletAccessEvmTransaction): Promise<string>;
  sendEvmTransaction?(
    transaction: WalletAccessEvmTransaction,
    referenceId: string
  ): Promise<WalletAccessTransactionSubmission>;
  dispose(): void;
}

export interface WalletAccessGateway<Session extends WalletAccessSession = WalletAccessSession> {
  authorize(
    onChallenge: (challenge: WalletAccessChallenge) => void | Promise<void>
  ): Promise<WalletAccessAuthorization<Session>>;
  resume(session: Session): Promise<WalletAccessAuthorization<Session>>;
}

export type WalletAccessFailureLifecycle =
  | "provider"
  | "session"
  | "identity"
  | "persistence"
  | "concurrency"
  | "compatibility";

export type WalletAccessFailureDisposition = "retryable" | "terminal";

export type WalletAccessFailureAction =
  | "retry"
  | "reauthenticate"
  | "repair_configuration"
  | "inspect_state"
  | "drain_pending_work"
  | "use_supported_backend"
  | "none";

export interface WalletAccessFailureDefinition {
  lifecycle: WalletAccessFailureLifecycle;
  disposition: WalletAccessFailureDisposition;
  action: WalletAccessFailureAction;
}

export const WALLET_ACCESS_FAILURE_CATALOG = Object.freeze({
  halo_setup_required: definition("compatibility", "terminal", "repair_configuration"),
  privy_access_denied: definition("provider", "terminal", "reauthenticate"),
  privy_consume_key_lock_ambiguous: definition("concurrency", "terminal", "inspect_state"),
  privy_consume_key_lock_unavailable: definition("concurrency", "retryable", "retry"),
  privy_consume_key_state_ambiguous: definition("persistence", "terminal", "inspect_state"),
  privy_consume_signature_incompatible: definition("compatibility", "terminal", "use_supported_backend"),
  privy_direct_funding_ambiguous: definition("provider", "terminal", "inspect_state"),
  privy_direct_funding_insufficient: definition("compatibility", "terminal", "none"),
  privy_direct_funding_pending: definition("concurrency", "retryable", "drain_pending_work"),
  privy_direct_funding_preflight_unavailable: definition("provider", "retryable", "retry"),
  privy_direct_funding_reverted: definition("provider", "terminal", "none"),
  privy_direct_funding_state_ambiguous: definition("persistence", "terminal", "inspect_state"),
  privy_sponsored_funding_ambiguous: definition("provider", "terminal", "inspect_state"),
  privy_sponsored_funding_pending: definition("concurrency", "retryable", "drain_pending_work"),
  privy_sponsored_funding_rejected: definition("provider", "terminal", "none"),
  privy_sponsored_funding_reverted: definition("provider", "terminal", "none"),
  privy_sponsored_funding_state_ambiguous: definition("persistence", "terminal", "inspect_state"),
  privy_sponsored_funding_unavailable: definition("provider", "retryable", "retry"),
  privy_device_authorization_ambiguous: definition("provider", "terminal", "inspect_state"),
  privy_device_authorization_rejected: definition("provider", "terminal", "reauthenticate"),
  privy_device_authorization_unavailable: definition("provider", "retryable", "retry"),
  privy_device_code_expired: definition("provider", "terminal", "reauthenticate"),
  privy_device_code_invalid: definition("provider", "terminal", "reauthenticate"),
  privy_device_verify_ambiguous: definition("provider", "terminal", "inspect_state"),
  privy_device_verify_forbidden: definition("provider", "terminal", "reauthenticate"),
  privy_device_verify_unavailable: definition("provider", "retryable", "retry"),
  privy_generation_exhausted: definition("session", "terminal", "inspect_state"),
  privy_identity_unavailable: definition("identity", "retryable", "retry"),
  privy_login_required: definition("session", "terminal", "reauthenticate"),
  privy_operation_cancelled: definition("provider", "retryable", "retry"),
  privy_protocol_error: definition("provider", "terminal", "none"),
  privy_refresh_ambiguous: definition("session", "terminal", "reauthenticate"),
  privy_refresh_unavailable: definition("provider", "retryable", "retry"),
  privy_rpc_ambiguous: definition("provider", "terminal", "inspect_state"),
  privy_rpc_error: definition("provider", "retryable", "retry"),
  privy_rpc_forbidden: definition("provider", "terminal", "reauthenticate"),
  privy_session_lock_ambiguous: definition("concurrency", "terminal", "inspect_state"),
  privy_session_lock_unavailable: definition("concurrency", "retryable", "retry"),
  privy_session_persistence_ambiguous: definition("persistence", "terminal", "inspect_state"),
  privy_session_key_mismatch: definition("compatibility", "terminal", "inspect_state"),
  privy_session_key_read_unavailable: definition("provider", "retryable", "retry"),
  privy_tenant_mismatch: definition("compatibility", "terminal", "repair_configuration"),
  privy_token_ambiguous: definition("provider", "terminal", "reauthenticate"),
  privy_token_rejected: definition("provider", "terminal", "reauthenticate"),
  privy_token_unavailable: definition("provider", "retryable", "retry"),
  privy_wallet_ambiguous: definition("identity", "terminal", "inspect_state"),
  privy_wallet_auth_ambiguous: definition("provider", "terminal", "inspect_state"),
  privy_wallet_auth_unavailable: definition("provider", "retryable", "retry"),
  privy_wallet_identity_changed: definition("identity", "terminal", "inspect_state"),
  privy_wallet_not_found: definition("identity", "terminal", "reauthenticate"),
  keystore_identity_replacement_unsupported: definition("compatibility", "terminal", "none"),
  keystore_missing: definition("persistence", "terminal", "repair_configuration"),
  keystore_override_identity_unsupported: definition("compatibility", "terminal", "none"),
  legacy_config_migration_ambiguous: definition("compatibility", "terminal", "inspect_state"),
  legacy_config_migration_persistence_failed: definition("persistence", "terminal", "inspect_state"),
  legacy_wallet_process_quiescence_required: definition("concurrency", "retryable", "retry"),
  wallet_backend_transition: definition("concurrency", "retryable", "retry"),
  wallet_backend_transition_ambiguous: definition("persistence", "terminal", "inspect_state"),
  wallet_backend_transition_persistence_failed: definition("persistence", "terminal", "inspect_state"),
  wallet_backend_transition_restored: definition("identity", "retryable", "retry"),
  wallet_backend_transition_timed_out: definition("concurrency", "retryable", "retry"),
  wallet_backend_unsupported_for_command: definition("compatibility", "terminal", "use_supported_backend"),
  wallet_process_lease_active: definition("concurrency", "retryable", "drain_pending_work"),
  wallet_process_lease_ambiguous: definition("concurrency", "terminal", "inspect_state"),
  wallet_process_lease_capacity: definition("concurrency", "retryable", "retry"),
  wallet_schema_compatibility_ambiguous: definition("compatibility", "terminal", "inspect_state"),
  wallet_schema_downgrade_unsupported: definition("compatibility", "terminal", "use_supported_backend"),
  wallet_selector_generation_exhausted: definition("identity", "terminal", "inspect_state"),
  wallet_transition_acknowledgement_capacity: definition("concurrency", "retryable", "retry"),
  consumer_redeem_pending: definition("concurrency", "retryable", "drain_pending_work"),
  consumer_redeem_state_ambiguous: definition("persistence", "terminal", "inspect_state"),
  operator_outbox_pending: definition("concurrency", "retryable", "drain_pending_work"),
  operator_outbox_state_ambiguous: definition("persistence", "terminal", "inspect_state"),
  operator_receipt_pending: definition("concurrency", "retryable", "drain_pending_work"),
  operator_receipt_state_ambiguous: definition("persistence", "terminal", "inspect_state"),
  transition_state_lock_ambiguous: definition("concurrency", "terminal", "inspect_state"),
  transition_state_persistence_ambiguous: definition("persistence", "terminal", "inspect_state"),
} as const satisfies Record<string, WalletAccessFailureDefinition>);

export type WalletAccessFailureCode = keyof typeof WALLET_ACCESS_FAILURE_CATALOG;

export interface WalletAccessIncidentV1 extends WalletAccessFailureDefinition {
  version: 1;
  code: WalletAccessFailureCode;
}

function definition(
  lifecycle: WalletAccessFailureLifecycle,
  disposition: WalletAccessFailureDisposition,
  action: WalletAccessFailureAction
): WalletAccessFailureDefinition {
  return Object.freeze({ lifecycle, disposition, action });
}

export function isWalletAccessFailureCode(
  value: unknown
): value is WalletAccessFailureCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WALLET_ACCESS_FAILURE_CATALOG, value)
  );
}

export function walletAccessIncident(value: unknown): WalletAccessIncidentV1 {
  const code = isWalletAccessFailureCode(value) ? value : "privy_protocol_error";
  return Object.freeze({
    version: 1,
    code,
    ...WALLET_ACCESS_FAILURE_CATALOG[code],
  });
}

export class WalletAccessError extends Error {
  readonly name: string = "WalletAccessError";
  readonly code: WalletAccessFailureCode;
  readonly incident: WalletAccessIncidentV1;

  constructor(code: WalletAccessFailureCode, message: string) {
    super(message);
    this.incident = walletAccessIncident(code);
    this.code = this.incident.code;
  }
}
