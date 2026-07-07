import { loadConfig, configProviders, allConfiguredModels } from "../config";

export async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const providers = configProviders(cfg);
  const allModels = allConfiguredModels(cfg);

  console.log(`\n  Halo operator`);
  console.log(`  ──────────────────────`);
  console.log(`  Address:   ${cfg.operator.address}`);
  console.log(`  Network:   Base mainnet`);
  console.log(
    `  Provider${providers.length > 1 ? "s" : " "}: ${providers.map((p) => `${p.slug} (${p.models.length})`).join(", ")}`
  );
  console.log(`  Models:    ${allModels.length} (${allModels.slice(0, 3).join(", ")}${allModels.length > 3 ? "…" : ""})`);
  console.log(`  Pricing:   ${cfg.pricing.mode}${
    cfg.pricing.mode === "margin"
      ? ` (${cfg.pricing.marginPercent}%)`
      : ` ($${cfg.pricing.flatUsdcPer1KTokens}/1K tokens)`
  }`);

  try {
    const res = await fetch(`${cfg.indexerUrl.replace(/\/+$/, "")}/points/${cfg.operator.address}`);
    if (res.ok) {
      const row = (await res.json()) as {
        servePoints: number;
        serveTier: string;
        requestsServed: number;
        tokensServed: number;
        uptimeSeconds: number;
        usdcEarnedBase: string;
      };
      const usdcEarned = Number(BigInt(row.usdcEarnedBase)) / 1_000_000;
      console.log(`\n  League`);
      console.log(`  ──────`);
      console.log(`  Points:     ${row.servePoints.toFixed(1)} (${row.serveTier})`);
      console.log(`  Served:     ${row.requestsServed} requests / ${row.tokensServed} tokens`);
      console.log(`  Uptime:     ${Math.floor(row.uptimeSeconds / 60)} min`);
      console.log(`  Earnings:   $${usdcEarned.toFixed(4)} USDC`);
    }
  } catch {
    console.log(`\n  (indexer unreachable)`);
  }
  console.log();
}
