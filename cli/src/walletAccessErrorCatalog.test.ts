import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cmdLogin } from "./commands/login";
import {
  WALLET_ACCESS_FAILURE_CATALOG,
  WalletAccessError,
  isWalletAccessFailureCode,
  walletAccessIncident,
} from "./wallet-access/domain/walletAccess";

const EXPECTED_CODES = [
  "consumer_redeem_pending",
  "consumer_redeem_state_ambiguous",
  "halo_setup_required",
  "keystore_identity_replacement_unsupported",
  "keystore_missing",
  "keystore_override_identity_unsupported",
  "legacy_config_migration_ambiguous",
  "legacy_config_migration_persistence_failed",
  "legacy_wallet_process_quiescence_required",
  "operator_outbox_pending",
  "operator_outbox_state_ambiguous",
  "operator_receipt_pending",
  "operator_receipt_state_ambiguous",
  "privy_access_denied",
  "privy_consume_key_lock_ambiguous",
  "privy_consume_key_lock_unavailable",
  "privy_consume_key_state_ambiguous",
  "privy_consume_signature_incompatible",
  "privy_device_authorization_ambiguous",
  "privy_device_authorization_rejected",
  "privy_device_authorization_unavailable",
  "privy_device_code_expired",
  "privy_device_code_invalid",
  "privy_device_verify_ambiguous",
  "privy_device_verify_forbidden",
  "privy_device_verify_unavailable",
  "privy_direct_funding_ambiguous",
  "privy_direct_funding_insufficient",
  "privy_direct_funding_pending",
  "privy_direct_funding_preflight_unavailable",
  "privy_direct_funding_reverted",
  "privy_direct_funding_state_ambiguous",
  "privy_generation_exhausted",
  "privy_identity_unavailable",
  "privy_login_required",
  "privy_operation_cancelled",
  "privy_protocol_error",
  "privy_refresh_ambiguous",
  "privy_refresh_unavailable",
  "privy_rpc_ambiguous",
  "privy_rpc_error",
  "privy_rpc_forbidden",
  "privy_session_key_mismatch",
  "privy_session_key_read_unavailable",
  "privy_session_lock_ambiguous",
  "privy_session_lock_unavailable",
  "privy_session_persistence_ambiguous",
  "privy_sponsored_funding_ambiguous",
  "privy_sponsored_funding_pending",
  "privy_sponsored_funding_rejected",
  "privy_sponsored_funding_reverted",
  "privy_sponsored_funding_state_ambiguous",
  "privy_sponsored_funding_unavailable",
  "privy_tenant_mismatch",
  "privy_token_ambiguous",
  "privy_token_rejected",
  "privy_token_unavailable",
  "privy_wallet_ambiguous",
  "privy_wallet_auth_ambiguous",
  "privy_wallet_auth_unavailable",
  "privy_wallet_identity_changed",
  "privy_wallet_not_found",
  "transition_state_lock_ambiguous",
  "transition_state_persistence_ambiguous",
  "wallet_backend_transition",
  "wallet_backend_transition_ambiguous",
  "wallet_backend_transition_persistence_failed",
  "wallet_backend_transition_restored",
  "wallet_backend_transition_timed_out",
  "wallet_backend_unsupported_for_command",
  "wallet_process_lease_active",
  "wallet_process_lease_ambiguous",
  "wallet_process_lease_capacity",
  "wallet_schema_compatibility_ambiguous",
  "wallet_schema_downgrade_unsupported",
  "wallet_selector_generation_exhausted",
  "wallet_transition_acknowledgement_capacity",
] as const;

test("Wallet Access publishes the exhaustive stable RFC error catalog", () => {
  assert.deepEqual(Object.keys(WALLET_ACCESS_FAILURE_CATALOG).sort(), EXPECTED_CODES);
  assert.equal(Object.isFrozen(WALLET_ACCESS_FAILURE_CATALOG), true);
  for (const code of EXPECTED_CODES) {
    const definition = WALLET_ACCESS_FAILURE_CATALOG[code];
    assert.equal(Object.isFrozen(definition), true, code);
    assert.ok(["retryable", "terminal"].includes(definition.disposition), code);
    assert.equal(isWalletAccessFailureCode(code), true, code);
  }
});

test("unknown incident codes fail closed as a versioned protocol error", () => {
  assert.equal(isWalletAccessFailureCode("future_provider_result"), false);
  assert.deepEqual(walletAccessIncident("future_provider_result"), {
    version: 1,
    code: "privy_protocol_error",
    lifecycle: "provider",
    disposition: "terminal",
    action: "none",
  });
  const error = new WalletAccessError("privy_token_ambiguous", "secret-value");
  assert.deepEqual(error.incident, {
    version: 1,
    code: "privy_token_ambiguous",
    lifecycle: "provider",
    disposition: "terminal",
    action: "reauthenticate",
  });
  assert.equal(JSON.stringify(error.incident).includes("secret-value"), false);
});

async function withTemporaryHome(operation: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "halo-wallet-catalog-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await operation(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test("login maps missing and contradictory config to stable CLI incidents", async () => {
  await withTemporaryHome(async (home) => {
    await assert.rejects(
      cmdLogin(),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "halo_setup_required" &&
        error.incident.action === "repair_configuration"
    );

    const directory = path.join(home, ".halo");
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, "config.json"), "{not-json", {
      mode: 0o600,
    });
    await assert.rejects(
      cmdLogin(),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "wallet_backend_transition_ambiguous" &&
        error.incident.disposition === "terminal"
    );
  });
});
