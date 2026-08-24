import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { Wallet, type TypedDataDomain } from "ethers";
import { WebSocketServer } from "ws";
import { gateVaultPaymentMode } from "./commands/serve";
import type { HaloConfig } from "./config";
import {
  evaluateReservation,
  recoverReceiptSigner,
  VAULT_ADDRESS,
} from "./vault";
import { generateAndEncrypt, writeKeystore } from "./wallet";

test("vault-only payment admission rejects every non-vault mode", () => {
  for (const mode of [undefined, "", "direct", " BUDGET ", 42]) {
    const gate = gateVaultPaymentMode(mode);
    assert.equal(gate.accepted, false);
    if (!gate.accepted) {
      assert.equal(gate.response.status, 400);
      assert.equal(gate.response.body.error.type, "unsupported_payment_mode");
    }
  }
});

test("vault-only payment admission accepts normalized Vault mode", () => {
  for (const mode of ["vault", " VAULT "]) {
    assert.deepEqual(gateVaultPaymentMode(mode), { accepted: true });
  }
});

test("an open provider breaker rejects a retired payment mode before paid work", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "halo-serve-precedence-"));
  const haloDir = join(home, ".halo");
  mkdirSync(haloDir);
  const wallet = await generateAndEncrypt("");
  const keystorePath = join(haloDir, "keystore.json");
  writeKeystore(keystorePath, wallet.encryptedJson);

  let child: ChildProcess | undefined;
  let upstreamRequests = 0;
  let requestSent = false;
  const server = createServer((req, res) => {
    if (req.url === "/chat/completions") {
      upstreamRequests += 1;
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "out of credits" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const relay = new WebSocketServer({ server });
  const response = new Promise<Record<string, unknown>>((resolve) => {
    relay.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", peerId: "precedence-test" }));
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (message.type === "announce" && !requestSent) {
          requestSent = true;
          ws.send(
            JSON.stringify({
              type: "inference-request",
              requestId: "open-breaker-rejects-before-payment",
              method: "POST",
              path: "/v1/chat/completions",
              headers: { "x-halo-payment-mode": "budget" },
              body: { model: "precedence-model", messages: [{ role: "user", content: "test" }] },
            })
          );
          return;
        }
        if (message.type === "inference-response") resolve(message as Record<string, unknown>);
      });
    });
  });

  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
    for (const client of relay.clients) client.terminate();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config: HaloConfig = {
    version: 1,
    relayUrl: baseUrl,
    indexerUrl: baseUrl,
    operator: { address: wallet.address, keystorePath, noPassphrase: true },
    provider: {
      slug: "openrouter",
      baseUrl,
      apiKey: "test-key",
      models: ["precedence-model"],
    },
    pricing: { mode: "flat", flatUsdcPer1KTokens: 1, fallbackPerRequestUsdc: 1 },
    facilitator: { url: baseUrl },
  };
  writeFileSync(join(haloDir, "config.json"), JSON.stringify(config));

  child = spawn(
    process.execPath,
    ["--require", "ts-node/register", "-e", "require('./src/commands/serve').cmdServe()"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "127.0.0.1,localhost",
      },
      stdio: "ignore",
    }
  );

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for the breaker response")),
      15_000
    );
    void response.then((message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: {
      message: "The selected operator's upstream provider account cannot serve this request right now.",
      type: "upstream_provider_error",
      code: "credit_exhausted",
    },
  });
  assert.equal(upstreamRequests, 1);
});

test("a request ceiling above live operator credit is rejected before work", () => {
  const result = evaluateReservation(
    {
      locked: 100n,
      redeemed: 20n,
      expiry: 0n,
      cycle: 3n,
      remaining: 100n,
    },
    101n,
    1_000
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "reservation does not cover this request's cost");
});

test("a receipt signed for another operator cannot authorize this operator", async () => {
  const sessionKey = Wallet.createRandom();
  const otherOperator = "0x2222222222222222222222222222222222222222";
  const selectedOperator = "0x3333333333333333333333333333333333333333";
  const value = {
    consumer: sessionKey.address,
    operator: otherOperator,
    cumulative: 500n,
    keyEpoch: 0n,
    cycle: 1n,
  };
  const domain: TypedDataDomain = {
    name: "Halo",
    version: "2",
    chainId: 8453,
    verifyingContract: VAULT_ADDRESS,
  };
  const types = {
    Receipt: [
      { name: "consumer", type: "address" },
      { name: "operator", type: "address" },
      { name: "cumulative", type: "uint256" },
      { name: "keyEpoch", type: "uint256" },
      { name: "cycle", type: "uint64" },
    ],
  };
  const signature = await sessionKey.signTypedData(domain, types, value);
  const recovered = recoverReceiptSigner(
    8453n,
    { ...value, operator: selectedOperator },
    signature
  );

  assert.notEqual(recovered, sessionKey.address.toLowerCase());
});
