/**
 * Halo only needs USDC addresses per chain. No protocol contracts —
 * settlement happens directly via the CDP facilitator calling
 * USDC.transferWithAuthorization.
 */

export interface ChainConfig {
  name: string;
  chainId: number;
  usdcToken: string;
  /** USDC's EIP-712 `name` field; differs by deployment. */
  usdcDomainName: string;
  /** USDC's EIP-712 `version` field; "2" for all current deployments. */
  usdcDomainVersion: string;
}

export const CHAINS: Record<number, ChainConfig> = {
  8453: {
    name: "Base",
    chainId: 8453,
    usdcToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDomainName: "USD Coin",
    usdcDomainVersion: "2",
  },
};

export const NETWORK_TO_CHAIN_ID: Record<string, number> = {
  base: 8453,
  "base-mainnet": 8453,
  // CAIP-2 forms, as returned by the x402 Bazaar catalog and some facilitators.
  "eip155:8453": 8453,
};

export function getChain(chainId: number): ChainConfig {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`Unsupported chainId ${chainId} for Halo`);
  return c;
}

export function resolveChainId(network: string, override?: number): number {
  if (override !== undefined) return override;
  const id = NETWORK_TO_CHAIN_ID[network.toLowerCase()];
  if (id === undefined) {
    throw new Error(`Unknown x402 network "${network}"`);
  }
  return id;
}
