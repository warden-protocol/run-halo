import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HaloConfigV1 } from "./config";
import { configDir, saveConfig } from "./config";
import { cmdDoctor } from "./commands/doctor";
import { cmdStatus } from "./commands/status";
import { selectPrivyWallet } from "./wallet-access/application/catalog";
import { FileWalletAccessSessionStore } from "./wallet-access/infrastructure/fileSessionStore";

const KEYSTORE_ADDRESS = "0x0000000000000000000000000000000000000001";
const PRIVY_ADDRESS = "0x0000000000000000000000000000000000000002";
const APP_ID = "command_diagnostic_app";
const WALLET_ID = "command-diagnostic-wallet-id";
const ACCESS_TOKEN = "command-diagnostic-access-token";
const REFRESH_TOKEN = "command-diagnostic-refresh-token";
const RAW_PROVIDER_BODY = "raw-provider-body-must-not-appear";

function configV1(directory: string): HaloConfigV1 {
  return {
    version: 1,
    relayUrl: "https://relay.test",
    indexerUrl: "https://indexer.test",
    operator: {
      address: KEYSTORE_ADDRESS,
      keystorePath: path.join(directory, "keystore.json"),
    },
    provider: {
      slug: "test",
      baseUrl: "https://provider.test/v1",
      models: ["test/model"],
    },
    pricing: {
      mode: "flat",
      flatUsdcPer1KTokens: 0.001,
      fallbackPerRequestUsdc: 0.01,
    },
    facilitator: { url: "https://facilitator.test" },
  };
}

async function captureOutput(operation: () => Promise<void>): Promise<string> {
  const original = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]) => {
    output.push(values.map(String).join(" "));
  };
  try {
    await operation();
  } finally {
    console.log = original;
  }
  return output.join("\n");
}

test("status and doctor expose the same secret-safe Wallet Access projection", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "halo-wallet-diagnostics-command-"));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  process.env.HOME = home;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const config = selectPrivyWallet(configV1(configDir()), {
      address: PRIVY_ADDRESS,
      walletId: WALLET_ID,
      appId: APP_ID,
    });
    saveConfig(config);
    new FileWalletAccessSessionStore().write({
      version: 1,
      state: "active",
      session: {
        version: 1,
        identity: { backend: "privy", address: PRIVY_ADDRESS },
        expiresAt: "2099-09-03T12:00:00.000Z",
        appId: APP_ID,
        walletId: WALLET_ID,
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
      },
      verifiedAt: "2026-09-03T10:00:00.000Z",
      refreshedAt: "2026-09-03T10:05:00.000Z",
    });
    writeFileSync(path.join(configDir(), "serve.log"), RAW_PROVIDER_BODY, "utf8");

    const jsonOutput = await captureOutput(() => cmdDoctor({ json: true }));
    const report = JSON.parse(jsonOutput) as Record<string, unknown>;
    assert.deepEqual(report.walletAccess, {
      backend: "privy",
      boundAddress: PRIVY_ADDRESS,
      sessionState: "active",
      sessionFreshness: "fresh",
      lastSuccessfulRefreshAt: "2026-09-03T10:05:00.000Z",
      remediation: "none",
    });
    assert.equal(
      "recentLogLines" in (report.serve as Record<string, unknown>),
      false
    );

    const textOutput = await captureOutput(() => cmdDoctor());
    assert.match(textOutput, /Wallet Access/);
    assert.match(textOutput, /session freshness: fresh/);
    assert.match(textOutput, /remediation: none/);

    const statusOutput = await captureOutput(() => cmdStatus());
    assert.match(statusOutput, /Backend:\s+privy/);
    assert.match(statusOutput, /Freshness:\s+fresh/);
    assert.match(statusOutput, /Remediate:\s+none/);

    for (const output of [jsonOutput, textOutput, statusOutput]) {
      for (const forbidden of [
        APP_ID,
        WALLET_ID,
        ACCESS_TOKEN,
        REFRESH_TOKEN,
        RAW_PROVIDER_BODY,
      ]) {
        assert.equal(output.includes(forbidden), false);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
