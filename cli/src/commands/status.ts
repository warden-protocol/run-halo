import path from "node:path";
import {
  loadConfig,
  configDir,
  configProviders,
  allConfiguredModels,
  imagePriceForModel,
} from "../config";
import { readEventOutboxStatus } from "../eventOutbox";

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
  const imageEntries = providers.flatMap((p) =>
    (p.imageModels ?? []).map((m) => [m, imagePriceForModel(cfg, m)] as const)
  );
  if (imageEntries.length > 0) {
    console.log(
      `  Image:     ${imageEntries.map(([m, price]) => `${m} ($${price}/image)`).join(", ")}`
    );
  }
  const editModels = providers.flatMap((provider) => provider.imageEditModels ?? []);
  if (editModels.length > 0) {
    console.log(`  Edits:     ${[...new Set(editModels)].join(", ")}`);
  }

  try {
    const entries = readEventOutboxStatus(path.join(configDir(), "event-outbox.json"));
    const pending = entries.filter((entry) => entry.state === "pending");
    const dead = entries.filter((entry) => entry.state === "dead_letter");
    console.log(`  Outbox:    ${pending.length} pending / ${dead.length} dead-letter`);
    for (const entry of [...pending, ...dead].slice(0, 20)) {
      console.log(
        `             ${entry.id} ${entry.state} attempts=${entry.attempts}${
          entry.lastErrorCode ? ` error=${entry.lastErrorCode}` : ""
        }`
      );
    }
  } catch (error) {
    console.log(
      `  Outbox:    unreadable (${error instanceof Error ? error.message : String(error)})`
    );
  }

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
