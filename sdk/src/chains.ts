export interface ChainConfig {
  name: string;
  chainId: number;
  usdcToken: string;
}

export const CHAINS: Record<number, ChainConfig> = {
  8453: {
    name: "Base",
    chainId: 8453,
    usdcToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

export function getChain(chainId: number): ChainConfig {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`Unsupported chainId ${chainId} for Halo`);
  return c;
}
