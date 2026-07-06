/**
 * The canonical HaloVault contract address — the single source of truth shared by
 * the operator (`serve`), the consumer (`consume` / `halo vault`), and verified
 * against the facilitator that submits reserve/redeem.
 *
 * INTENTIONALLY a hardcoded constant, NOT env-overridable. The vault custodies
 * real USDC and MUST be identical across the consumer (who deposits), the operator
 * (who gates on the reservation), and the facilitator (who submits the on-chain
 * reserve/redeem). A per-process `HALO_VAULT_ADDRESS` knob is a footgun: it can
 * silently split the network across two vaults (consumer reserves in A, operator
 * checks B → every request rejected) or point a deposit at an attacker-controlled
 * contract. Migrating to a new (e.g. audited) vault is a COORDINATED code release
 * that changes vault-core/consensus.json — alongside the facilitator secret + a frontend
 * rebuild — never a runtime flag flip.
 *
 * Closed-alpha mainnet vault (Base, chain 8453). Update on a vault migration.
 * v2 (protocol-fee) vault — EIP-712 domain name "Halo", version "2".
 */
export { VAULT_ADDRESS } from "@halo/vault-core";
