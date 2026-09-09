import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";
import { selectVaultImageOperatorFromList } from "@halo/vault-core";
import { validateConfig, type HaloConfigV1 } from "./config";
import {
  createConsumeHttpServer,
  dispatchConsumeInferenceRoute,
  selectVaultOperatorForRequestFromList,
  type ConsumeRequestHandler,
  type VaultDirectoryOperator,
} from "./commands/consume";
import { cmdSetup, resolveConsumeConfig } from "./commands/setup";
import { selectPrivyWallet } from "./wallet-access/application/catalog";

const OPERATOR = "0x000000000000000000000000000000000000abCD";
const OTHER = "0x0000000000000000000000000000000000001234";
const MODEL = "test/model";

function config(): HaloConfigV1 {
  return {
    version: 1,
    relayUrl: "http://127.0.0.1:8787",
    indexerUrl: "http://127.0.0.1:8789",
    operator: { address: OTHER, keystorePath: "/unused/keystore.json" },
    provider: { slug: "ollama", baseUrl: "http://127.0.0.1:11434/v1", models: [MODEL] },
    pricing: { mode: "flat", flatUsdcPer1KTokens: 0.001, fallbackPerRequestUsdc: 1000 },
    facilitator: { url: "http://127.0.0.1:8788" },
  };
}

test("consume operator restriction is optional and accepts hex addresses in any letter case", () => {
  const cfg = config();
  assert.equal(validateConfig(cfg).consume, undefined);
  cfg.consume = { maxUsdc: 0.1 };
  assert.deepEqual(validateConfig(cfg).consume, { maxUsdc: 0.1 });
  for (const address of [OPERATOR, OPERATOR.toLowerCase(), `0x${OPERATOR.slice(2).toUpperCase()}`]) {
    cfg.consume.operatorAddress = address;
    assert.equal(validateConfig(cfg).consume?.operatorAddress, address);
  }
});

test("consume operator restriction rejects invalid configuration instead of disabling the restriction", () => {
  for (const address of [null, false, 42, [], {}, "", " ", "alice.eth", "0x1234", `0x${"0".repeat(40)}`, `0x${"g".repeat(40)}`, `${OPERATOR}0`, ` ${OPERATOR}`]) {
    const cfg = config();
    cfg.consume = { maxUsdc: 0.1, operatorAddress: address as string };
    assert.throws(() => validateConfig(cfg), /consume\.operatorAddress must be a non-zero/);
  }
});

test("setup preserves the config-only operator while retaining or reconfiguring consumption", async () => {
  const cfg = config();
  cfg.consume = { maxUsdc: 0.1, operatorAddress: OPERATOR };
  const cancel = { onCancel: (): never => { throw new Error("unexpected prompt cancellation"); } };
  assert.equal((await resolveConsumeConfig({ noWalletPassphrase: true }, [MODEL], cfg, cancel))?.operatorAddress, OPERATOR);
  const flagged = await resolveConsumeConfig({ consume: true, consumeMaxUsdc: 0.2 }, [MODEL], cfg, cancel);
  assert.equal(flagged?.operatorAddress, OPERATOR);
  assert.equal(flagged?.maxUsdc, 0.2);
  prompts.inject([true, MODEL, MODEL, 0.3, 8799]);
  try {
    const interactive = await resolveConsumeConfig({}, [MODEL], cfg, cancel);
    assert.equal(interactive?.operatorAddress, OPERATOR);
    assert.equal(interactive?.maxUsdc, 0.3);
  } finally {
    prompts.inject([]);
  }
  assert.equal(await resolveConsumeConfig({ consume: false }, [MODEL], cfg, cancel), undefined);
  assert.equal((await resolveConsumeConfig({ consume: true }, [MODEL], config(), cancel))?.operatorAddress, undefined);
});

test("setup rejects invalid existing configuration before writing or adopting an orphaned keystore", async (t) => {
  for (const invalid of ["operator", "json"] as const) {
    for (const rotateWallet of [false, true]) {
      await t.test(`${invalid}, rotateWallet=${rotateWallet}`, async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "halo-setup-invalid-"));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        t.mock.method(os, "homedir", () => directory);
        const haloDirectory = path.join(directory, ".halo");
        fs.mkdirSync(haloDirectory);
        const keystorePath = path.join(haloDirectory, "keystore.json");
        const cfg = config();
        cfg.operator.keystorePath = keystorePath;
        const privy = selectPrivyWallet(cfg, {
          address: "0x0000000000000000000000000000000000005678",
          walletId: "synthetic-wallet",
          appId: "synthetic-app",
        });
        privy.consume = { maxUsdc: 0.1, operatorAddress: "0x1234" };
        const contents: Record<string, string> = {
          "config.json": invalid === "operator"
            ? JSON.stringify(privy)
            : '{"synthetic-private-marker": invalid-json}',
          "keystore.json": JSON.stringify({ address: OTHER.slice(2) }),
          "wallet-access-session.json": '{"synthetic-session-marker":true}',
        };
        for (const [name, content] of Object.entries(contents)) {
          fs.writeFileSync(path.join(haloDirectory, name), content, { mode: 0o600 });
        }
        let writes = 0;
        t.mock.method(fs, "writeFileSync", () => {
          writes += 1;
          throw new Error("Unexpected setup write");
        });
        t.mock.method(globalThis, "fetch", async () => {
          throw new Error("Unexpected setup network request");
        });
        await assert.rejects(
          cmdSetup({
            provider: "custom", baseUrl: "http://127.0.0.1:11434/v1",
            models: MODEL, flat: 0.001, consume: true,
            noWalletPassphrase: true, rotateWallet,
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /Cannot load existing Halo configuration/);
            assert.match(error.message, /Repair it before rerunning halo setup/);
            assert.doesNotMatch(error.message, /synthetic-private-marker|synthetic-session-marker/);
            return true;
          }
        );
        assert.equal(writes, 0);
        assert.deepEqual(fs.readdirSync(haloDirectory).sort(), Object.keys(contents).sort());
        for (const [name, content] of Object.entries(contents)) {
          assert.equal(fs.readFileSync(path.join(haloDirectory, name), "utf8"), content);
        }
      });
    }
  }
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP admission enforces the configured operator across every inference path only when specified", async (t) => {
  let calls = 0;
  let configured: string | undefined;
  const handler: ConsumeRequestHandler = async (req, res) => {
    calls += 1;
    let body = "";
    for await (const chunk of req) body += chunk;
    const stream = body.includes('"stream":true');
    const output = JSON.stringify({ operator: req.headers["x-halo-operator"] ?? null });
    res.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" });
    res.end(stream ? `data: ${output}\n\ndata: [DONE]\n\n` : output);
  };
  const server = createConsumeHttpServer(async (req, res) => {
    const routed = dispatchConsumeInferenceRoute(req, res, {
      completion: handler, imageGeneration: handler, imageEdit: handler,
    }, configured);
    if (routed) return routed;
    res.writeHead(204).end();
  });
  const base = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  for (const route of [
    { path: "/v1/chat/completions", body: '{"stream":false}' },
    { path: "/v1/chat/completions?test=stream", body: '{"stream":true}' },
    { path: "/v1/images/generations", body: "{}" },
    { path: "/v1/images/edits", body: "multipart payload" },
  ]) {
    for (const scenario of [
      { configured: undefined, header: undefined, expected: null },
      { configured: undefined, header: OTHER, expected: OTHER },
      { configured: OPERATOR, header: undefined, expected: OPERATOR },
      { configured: OPERATOR, header: OPERATOR.toLowerCase(), expected: OPERATOR },
      { configured: OPERATOR, header: OTHER, expected: null },
      { configured: OPERATOR, header: `${OPERATOR}, ${OTHER}`, expected: null },
    ]) {
      configured = scenario.configured;
      const before = calls;
      const response = await fetch(`${base}${route.path}`, {
        method: "POST",
        headers: scenario.header === undefined ? {} : { "X-Halo-Operator": scenario.header },
        body: route.body,
      });
      const rejected = configured !== undefined && scenario.expected === null;
      assert.equal(response.status, rejected ? 400 : 200);
      assert.equal(calls, before + (rejected ? 0 : 1));
      if (rejected) {
        const body = await response.json() as { error: { code: string; message: string } };
        assert.equal(body.error.code, "consumer_operator_conflict");
        assert.match(body.error.message, /consume\.operatorAddress/);
      } else {
        assert.ok((await response.text()).includes(JSON.stringify({ operator: scenario.expected })));
      }
    }
  }
  for (const path of ["/health", "/v1/models", "/v1/account", "/v1/budget"]) {
    const response = await fetch(`${base}${path}`, { headers: { "X-Halo-Operator": OTHER } });
    assert.equal(response.status, 204);
  }
  const response = await fetch(`${base}/v1/budget`, { method: "POST", headers: { "X-Halo-Operator": OTHER } });
  assert.equal(response.status, 204);
});

test("required text operator never falls back for missing models, capabilities, or excessive cost", () => {
  const requested: VaultDirectoryOperator = {
    address: OPERATOR, models: [MODEL], pricing: { [MODEL]: 0.001 }, vaultPayments: true,
  };
  const other = { ...requested, address: OTHER, pricing: { [MODEL]: 0.0001 }, tee: true };
  const pricing = { maxAmountBase: 100_000n, reservationTokens: 1000, promptTokens: 100, completionTokens: 900, allowReplayPricing: false };
  for (const failure of [
    { operator: null, tee: false, reason: "pinned_not_found" },
    { operator: { ...requested, models: [] }, tee: false, reason: "no_operator" },
    { operator: { ...requested, vaultPayments: false }, tee: false, reason: "pinned_not_vault_capable" },
    { operator: requested, tee: true, reason: "pinned_not_tee_capable" },
    { operator: { ...requested, pricing: { [MODEL]: 1000 } }, tee: false, reason: "pinned_out_of_range" },
  ]) {
    const operators = failure.operator ? [failure.operator, other] : [other];
    const pinned = selectVaultOperatorForRequestFromList(operators, MODEL, failure.tee, pricing, OPERATOR.toLowerCase());
    assert.equal(pinned.selected, null);
    assert.equal(pinned.reason, failure.reason);
    assert.equal(selectVaultOperatorForRequestFromList(operators, MODEL, failure.tee, pricing).selected?.operator.address, OTHER);
  }
  assert.equal(selectVaultOperatorForRequestFromList([requested, other], MODEL, false, pricing, OPERATOR.toLowerCase()).selected?.operator.address, OPERATOR);
});

test("required image operator never falls back when image or edit capability is unavailable", () => {
  const requested = {
    address: OPERATOR, models: [MODEL], imageModels: [MODEL], imageEditModels: [MODEL],
    imagePricing: { [MODEL]: 0.02 }, vaultPayments: true,
  };
  const other = { ...requested, address: OTHER, imagePricing: { [MODEL]: 0.01 } };
  for (const operator of [
    null,
    { ...requested, imageModels: [] },
    { ...requested, imageEditModels: [] },
    { ...requested, vaultPayments: false },
    { ...requested, imagePricing: { [MODEL]: 0 } },
  ]) {
    const operators = operator ? [operator, other] : [other];
    assert.equal(selectVaultImageOperatorFromList(operators, MODEL, { requireAddress: OPERATOR, requireEditCapability: true }).selected, null);
    assert.equal(selectVaultImageOperatorFromList(operators, MODEL, { requireEditCapability: true }).selected?.operator.address, OTHER);
  }
});
