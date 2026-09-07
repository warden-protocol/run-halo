import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import {
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { Transaction, Wallet, verifyMessage } from "ethers";
import {
  PrivyWalletAccessGateway,
} from "./privy";
import type { PrivyWalletAccessSession } from "./privy";
import { WalletAccessError } from "../domain/walletAccess";
import type { WalletAccessChallenge } from "../domain/walletAccess";

const APP_ID = "halo_test_app_123";
const BASE_URL = "https://privy.test";
const NOW = Date.parse("2026-08-31T12:00:00.000Z");

function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeFakePrivy(options: {
  authenticatedWalletAddress?: string;
  rpcResponse?: () => Response | Promise<Response>;
} = {}) {
  const wallet = Wallet.createRandom();
  const authorizationKey = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  }).privateKey.toString("base64");
  const calls: Array<{
    path: string;
    headers: Headers;
    body: RequestInit["body"];
  }> = [];

  async function encryptAuthorizationKey(recipientSpkiBase64: string) {
    const recipientJwk = createPublicKey({
      key: Buffer.from(recipientSpkiBase64, "base64"),
      format: "der",
      type: "spki",
    }).export({ format: "jwk" });
    const suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const recipientPublicKey = await suite.kem.importKey(
      "jwk",
      recipientJwk,
      true
    );
    const sender = await suite.createSenderContext({ recipientPublicKey });
    const plaintext = new TextEncoder().encode(authorizationKey);
    const ciphertext = await sender.seal(plaintext.buffer as ArrayBuffer);
    return {
      encapsulated_key: Buffer.from(sender.enc).toString("base64"),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
    };
  }

  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(url instanceof Request ? url.url : url);
    const headers = new Headers(init?.headers);
    calls.push({ path: parsed.pathname, headers, body: init?.body });
    assert.equal(headers.get("privy-app-id"), APP_ID);

    if (parsed.pathname === "/api/oauth/v2/device_authorization") {
      return json({
        device_code: "device-code",
        user_code: "HALO-CODE",
        verification_uri_complete: "https://privy.test/activate?code=HALO-CODE",
        expires_in: 600,
        interval: 5,
      });
    }
    if (parsed.pathname === "/api/oauth/v2/token") {
      return json({
        access_token: "access-token-secret",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-token-secret",
      });
    }
    if (parsed.pathname === "/api/oauth/v2/wallets/authenticate") {
      assert.equal(headers.get("authorization"), "Bearer access-token-secret");
      const requestBody = init?.body;
      if (typeof requestBody !== "string") throw new Error("expected JSON request body");
      const request = JSON.parse(requestBody) as { recipient_public_key: string };
      return json({
        encrypted_authorization_key: await encryptAuthorizationKey(
          request.recipient_public_key
        ),
        wallets: [
          {
            id: "wallet-1",
            address: options.authenticatedWalletAddress ?? wallet.address,
            chain_type: "ethereum",
          },
        ],
      });
    }
    if (parsed.pathname === "/api/oauth/v2/wallets/wallet-1/rpc") {
      assert.equal(headers.get("authorization"), "Bearer access-token-secret");
      assert.ok(headers.get("privy-authorization-signature"));
      if (options.rpcResponse) return options.rpcResponse();
      const requestBody = init?.body;
      if (typeof requestBody !== "string") throw new Error("expected JSON request body");
      const request = JSON.parse(requestBody) as {
        method: string;
        reference_id?: string;
        params: { message?: string; transaction?: Record<string, string | number> };
      };
      if (request.method === "eth_signTransaction") {
        const transaction = request.params.transaction;
        if (!transaction) throw new Error("expected transaction to sign");
        const signed = await wallet.signTransaction({
          type: Number(transaction.type),
          chainId: BigInt(String(transaction.chain_id)),
          nonce: Number(transaction.nonce),
          to: String(transaction.to),
          gasLimit: BigInt(String(transaction.gas_limit)),
          maxFeePerGas: BigInt(String(transaction.max_fee_per_gas)),
          maxPriorityFeePerGas: BigInt(String(transaction.max_priority_fee_per_gas)),
          value: BigInt(String(transaction.value)),
          data: String(transaction.data),
          accessList: [],
        });
        return json({
          method: "eth_signTransaction",
          data: { signed_transaction: signed, encoding: "rlp" },
        });
      }
      if (request.method === "eth_sendTransaction") {
        return json({
          method: "eth_sendTransaction",
          data: {
            hash: `0x${"ab".repeat(32)}`,
            caip2: "eip155:8453",
            transaction_id: "privy-transaction-1",
            reference_id: request.reference_id,
          },
        });
      }
      if (typeof request.params.message !== "string") {
        throw new Error("expected personal_sign message");
      }
      return json({
        method: "personal_sign",
        data: {
          signature: await wallet.signMessage(request.params.message),
          encoding: "hex",
        },
      });
    }
    return json({ error: "unexpected_path" }, 404);
  };

  return { authorizationKey, calls, fetch: fetchImpl, wallet };
}

test("Privy session survives a gateway restart without a second device flow", async () => {
  const fake = makeFakePrivy();
  const challenges: WalletAccessChallenge[] = [];
  const firstGateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const first = await firstGateway.authorize((challenge) => {
    challenges.push(challenge);
  });
  const firstSignature = await first.signPersonalMessage("first proof");
  assert.equal(verifyMessage("first proof", firstSignature), fake.wallet.address);
  const persisted = { ...first.session };
  first.dispose();

  const restartedGateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    now: () => NOW + 1,
  });
  const resumed = await restartedGateway.resume(persisted);
  const resumedSignature = await resumed.signPersonalMessage("restart proof");
  assert.equal(
    verifyMessage("restart proof", resumedSignature),
    fake.wallet.address
  );
  resumed.dispose();

  assert.equal(challenges.length, 1);
  assert.equal(
    fake.calls.filter((call) => call.path.endsWith("device_authorization")).length,
    1
  );
  assert.equal(
    fake.calls.filter((call) => call.path.endsWith("wallets/authenticate")).length,
    2
  );
  assert.deepEqual(persisted, {
    version: 1,
    identity: { backend: "privy", address: fake.wallet.address },
    expiresAt: "2026-08-31T12:15:00.000Z",
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
  });
  assert.equal(JSON.stringify(persisted).includes(fake.authorizationKey), false);
});

test("Privy session restore fails before network use when expired or app-scoped differently", async () => {
  let fetchCalls = 0;
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("network must not be used");
    },
    now: () => NOW,
  });
  const session: PrivyWalletAccessSession = {
    version: 1,
    identity: { backend: "privy", address: Wallet.createRandom().address },
    expiresAt: "2026-08-31T11:59:59.000Z",
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
  };
  await assert.rejects(
    gateway.resume(session),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_login_required"
  );
  await assert.rejects(
    gateway.resume({
      ...session,
      appId: "different_app_123",
      expiresAt: "2026-08-31T12:15:00.000Z",
    }),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_tenant_mismatch"
  );
  assert.equal(fetchCalls, 0);
});

test("Privy device denial has a stable secret-safe failure", async () => {
  const fetchImpl: typeof fetch = async (url) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    if (path.endsWith("device_authorization")) {
      return json({
        device_code: "device-secret-that-must-not-leak",
        user_code: "HALO-CODE",
        verification_uri: "https://privy.test/activate",
        expires_in: 600,
        interval: 5,
      });
    }
    return json({ error: "access_denied", detail: "provider-secret" }, 400);
  };
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => NOW,
  });
  await assert.rejects(
    gateway.authorize(() => {}),
    (error: unknown) => {
      assert.ok(error instanceof WalletAccessError);
      assert.equal(error.code, "privy_access_denied");
      assert.equal(error.message.includes("device-secret"), false);
      assert.equal(error.message.includes("provider-secret"), false);
      return true;
    }
  );
});

test("Privy refresh sends one exact grant and returns the rotated token pair", async () => {
  const calls: unknown[] = [];
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        headers: init?.headers,
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return json({
        access_token: "rotated-access-token",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "rotated-refresh-token",
      });
    },
  });
  const wallet = Wallet.createRandom();
  const refreshed = await gateway.refresh({
    version: 1,
    identity: { backend: "privy", address: wallet.address },
    expiresAt: "2026-08-31T11:59:59.000Z",
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "expired-access-token",
    refreshToken: "old-refresh-token",
  });

  assert.deepEqual(calls, [
    {
      url: `${BASE_URL}/api/oauth/v2/token`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "privy-app-id": APP_ID,
      },
      body: {
        grant_type: "refresh_token",
        refresh_token: "old-refresh-token",
      },
    },
  ]);
  assert.equal(refreshed.accessToken, "rotated-access-token");
  assert.equal(refreshed.refreshToken, "rotated-refresh-token");
  assert.equal(refreshed.expiresAt, "2026-08-31T12:15:00.000Z");
});

test("Privy refresh classifies rejected and malformed results without exposing tokens", async () => {
  const wallet = Wallet.createRandom();
  const session: PrivyWalletAccessSession = {
    version: 1,
    identity: { backend: "privy", address: wallet.address },
    expiresAt: "2026-08-31T11:59:59.000Z",
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "expired-access-token",
    refreshToken: "old-refresh-token",
  };
  const rejected = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    fetch: async () => json({ error: "access_denied" }, 400),
  });
  await assert.rejects(
    rejected.refresh(session),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_login_required" &&
      !error.message.includes("old-refresh-token")
  );

  const malformed = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    fetch: async () =>
      json({
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 900,
      }),
  });
  await assert.rejects(
    malformed.refresh(session),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_refresh_ambiguous"
  );

  const notRotated = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    fetch: async () =>
      json({
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "old-refresh-token",
      }),
  });
  await assert.rejects(
    notRotated.refresh(session),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_refresh_ambiguous"
  );

  const unknownCompleteFailure = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    fetch: async () => json({ error: "future_error" }, 400),
  });
  await assert.rejects(
    unknownCompleteFailure.refresh(session),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_protocol_error"
  );
});

test("Privy refresh retries a complete rate limit but not ambiguous outcomes", async () => {
  const wallet = Wallet.createRandom();
  const session: PrivyWalletAccessSession = {
    version: 1,
    identity: { backend: "privy", address: wallet.address },
    expiresAt: "2026-08-31T11:59:59.000Z",
    appId: APP_ID,
    walletId: "wallet-1",
    accessToken: "expired-access-token",
    refreshToken: "old-refresh-token",
  };
  let rateLimitedCalls = 0;
  const sleeps: number[] = [];
  const rateLimited = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    fetch: async () => {
      rateLimitedCalls += 1;
      if (rateLimitedCalls === 1) {
        return json({ error: "rate_limited" }, 429, { "Retry-After": "2" });
      }
      return json({
        access_token: "rotated-access-token",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "rotated-refresh-token",
      });
    },
  });
  const refreshed = await rateLimited.refresh(session);
  assert.equal(rateLimitedCalls, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(refreshed.refreshToken, "rotated-refresh-token");

  let exhaustedCalls = 0;
  const exhaustedSleeps: number[] = [];
  const exhausted = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    now: () => NOW,
    sleep: async (milliseconds) => {
      exhaustedSleeps.push(milliseconds);
    },
    fetch: async () => {
      exhaustedCalls += 1;
      return json({ error: "rate_limited" }, 429);
    },
  });
  await assert.rejects(
    exhausted.refresh(session),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_refresh_unavailable"
  );
  assert.equal(exhaustedCalls, 3);
  assert.deepEqual(exhaustedSleeps, [500, 1_000]);

  const ambiguousCases = [
    async (): Promise<Response> => {
      throw new Error("response lost after possible send");
    },
    async (): Promise<Response> => json({ error: "server_error" }, 408),
    async (): Promise<Response> => json({ error: "server_error" }, 503),
  ];
  for (const fetchImpl of ambiguousCases) {
    let calls = 0;
    const gateway = new PrivyWalletAccessGateway({
      appId: APP_ID,
      baseUrl: BASE_URL,
      now: () => NOW,
      sleep: async () => {
        assert.fail("ambiguous refresh must not wait for a retry");
      },
      fetch: async () => {
        calls += 1;
        return fetchImpl();
      },
    });
    await assert.rejects(
      gateway.refresh(session),
      (error: unknown) =>
        error instanceof WalletAccessError &&
        error.code === "privy_refresh_ambiguous"
    );
    assert.equal(calls, 1);
  }
});

async function authorizeFailureCode(fetchImpl: typeof fetch): Promise<string> {
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => NOW,
  });
  try {
    await gateway.authorize(() => {});
  } catch (error) {
    assert.ok(error instanceof WalletAccessError);
    return error.code;
  }
  assert.fail("expected Wallet Access failure");
}

test("device authorization exhaustively classifies completed and ambiguous failures", async () => {
  for (const [status, expected, calls] of [
    [408, "privy_device_authorization_unavailable", 3],
    [429, "privy_device_authorization_unavailable", 3],
    [503, "privy_device_authorization_unavailable", 3],
    [400, "privy_device_authorization_rejected", 1],
    [401, "privy_device_authorization_rejected", 1],
    [302, "privy_protocol_error", 1],
  ] as const) {
    let observedCalls = 0;
    const code = await authorizeFailureCode(async () => {
      observedCalls += 1;
      return json({ error: "bounded-provider-detail" }, status);
    });
    assert.equal(code, expected, String(status));
    assert.equal(observedCalls, calls, String(status));
  }

  assert.equal(
    await authorizeFailureCode(async () => {
      throw new Error("response may have been lost");
    }),
    "privy_device_authorization_ambiguous"
  );
  assert.equal(
    await authorizeFailureCode(async () => json({ device_code: "incomplete" })),
    "privy_protocol_error"
  );
});

function validDeviceAuthorization(): Response {
  return json({
    device_code: "device-code",
    user_code: "HALO-CODE",
    verification_uri: "https://privy.test/activate",
    expires_in: 600,
    interval: 5,
  });
}

test("device-token polling exhaustively classifies provider outcomes", async () => {
  for (const [tokenResponse, expected] of [
    [() => json({ error: "rate_limited" }, 429), "privy_token_unavailable"],
    [() => json({ error: "timeout" }, 408), "privy_token_ambiguous"],
    [() => json({ error: "server_error" }, 503), "privy_token_ambiguous"],
    [() => json({ error: "expired_token" }, 400), "privy_device_code_expired"],
    [() => json({ error: "invalid_request" }, 400), "privy_token_rejected"],
    [() => json({ unexpected: true }, 400), "privy_protocol_error"],
    [() => json({ access_token: "incomplete" }), "privy_protocol_error"],
  ] as const) {
    const code = await authorizeFailureCode(async (url) => {
      const pathname = new URL(url instanceof Request ? url.url : url).pathname;
      return pathname.endsWith("device_authorization")
        ? validDeviceAuthorization()
        : tokenResponse();
    });
    assert.equal(code, expected);
  }

  let deviceAuthorized = false;
  assert.equal(
    await authorizeFailureCode(async () => {
      if (!deviceAuthorized) {
        deviceAuthorized = true;
        return validDeviceAuthorization();
      }
      throw new Error("token response may have been lost");
    }),
    "privy_token_ambiguous"
  );
});

test("device-token slow_down increases the bounded polling interval", async () => {
  const sleeps: number[] = [];
  let tokenCalls = 0;
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => NOW,
    fetch: async (url) => {
      const pathname = new URL(url instanceof Request ? url.url : url).pathname;
      if (pathname.endsWith("device_authorization")) {
        return validDeviceAuthorization();
      }
      tokenCalls += 1;
      return tokenCalls === 1
        ? json({ error: "slow_down" }, 400)
        : json({ error: "access_denied" }, 400);
    },
  });

  await assert.rejects(
    gateway.authorize(() => {}),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_access_denied"
  );
  assert.deepEqual(sleeps, [5_000, 10_000]);
});

test("wallet authentication classifies availability, ambiguity, identity, and protocol", async () => {
  const token = () =>
    json({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: "refresh-token",
    });
  const encrypted = {
    encrypted_authorization_key: {
      encapsulated_key: "bounded-encapsulation",
      ciphertext: "bounded-ciphertext",
    },
  };
  for (const [authenticate, expected] of [
    [() => json({ error: "timeout" }, 408), "privy_wallet_auth_unavailable"],
    [() => json({ error: "rate_limited" }, 429), "privy_wallet_auth_unavailable"],
    [() => json({ error: "server_error" }, 503), "privy_wallet_auth_unavailable"],
    [() => json({ error: "unauthorized" }, 401), "privy_login_required"],
    [() => json({ error: "forbidden" }, 403), "privy_login_required"],
    [() => json({ error: "unknown" }, 400), "privy_protocol_error"],
    [() => json({ ...encrypted, wallets: [] }), "privy_wallet_not_found"],
    [
      () =>
        json({
          ...encrypted,
          wallets: [
            { id: "wallet-1", address: Wallet.createRandom().address, chain_type: "ethereum" },
            { id: "wallet-2", address: Wallet.createRandom().address, chain_type: "ethereum" },
          ],
        }),
      "privy_wallet_ambiguous",
    ],
    [() => json({ ...encrypted, wallets: "contradictory" }), "privy_protocol_error"],
  ] as const) {
    const code = await authorizeFailureCode(async (url) => {
      const pathname = new URL(url instanceof Request ? url.url : url).pathname;
      if (pathname.endsWith("device_authorization")) return validDeviceAuthorization();
      if (pathname.endsWith("token")) return token();
      return authenticate();
    });
    assert.equal(code, expected);
  }

  assert.equal(
    await authorizeFailureCode(async (url) => {
      const pathname = new URL(url instanceof Request ? url.url : url).pathname;
      if (pathname.endsWith("device_authorization")) return validDeviceAuthorization();
      if (pathname.endsWith("token")) return token();
      throw new Error("authentication response may have been lost");
    }),
    "privy_wallet_auth_ambiguous"
  );

  const changed = makeFakePrivy({
    authenticatedWalletAddress: Wallet.createRandom().address,
  });
  const changedGateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: changed.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  await assert.rejects(
    changedGateway.resume({
      version: 1,
      identity: { backend: "privy", address: changed.wallet.address },
      expiresAt: "2026-08-31T12:15:00.000Z",
      appId: APP_ID,
      walletId: "wallet-1",
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
    }),
    (error: unknown) =>
      error instanceof WalletAccessError &&
      error.code === "privy_wallet_identity_changed"
  );
});

test("personal_sign classifies every completed and ambiguous failure family", async () => {
  for (const [rpcResponse, expected] of [
    [() => json({ error: "unauthorized" }, 401), "privy_login_required"],
    [() => json({ error: "forbidden" }, 403), "privy_rpc_forbidden"],
    [() => json({ error: "timeout" }, 408), "privy_rpc_error"],
    [() => json({ error: "rate_limited" }, 429), "privy_rpc_error"],
    [() => json({ error: "server_error" }, 503), "privy_rpc_error"],
    [() => json({ error: "unlisted_http_failure" }, 400), "privy_protocol_error"],
    [() => json({ error: { code: "user_rejected" } }), "privy_rpc_error"],
    [() => json({ method: "unknown", data: {} }), "privy_protocol_error"],
  ] as const) {
    const fake = makeFakePrivy({ rpcResponse });
    const gateway = new PrivyWalletAccessGateway({
      appId: APP_ID,
      baseUrl: BASE_URL,
      fetch: fake.fetch,
      sleep: async () => {},
      now: () => NOW,
    });
    const authorization = await gateway.authorize(() => {});
    await assert.rejects(
      authorization.signPersonalMessage("classification proof"),
      (error: unknown) =>
        error instanceof WalletAccessError && error.code === expected
    );
    authorization.dispose();
  }

  const ambiguous = makeFakePrivy({
    rpcResponse: () => {
      throw new Error("RPC response may have been lost");
    },
  });
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: ambiguous.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const authorization = await gateway.authorize(() => {});
  await assert.rejects(
    authorization.signPersonalMessage("ambiguous proof"),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_rpc_ambiguous"
  );
  authorization.dispose();
});

test("eth_sendTransaction binds the full Base transaction and reference id", async () => {
  const fake = makeFakePrivy();
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const authorization = await gateway.authorize(() => {});
  assert.ok(authorization.sendEvmTransaction);
  const result = await authorization.sendEvmTransaction!(
    {
      from: fake.wallet.address,
      to: "0x0000000000000000000000000000000000000003",
      chainId: "8453",
      type: 2,
      nonce: "7",
      gasLimit: "100000",
      maxFeePerGas: "1000000000",
      maxPriorityFeePerGas: "500000000",
      value: "0",
      data: "0x1234",
    },
    "halo_reference_1"
  );
  assert.deepEqual(result, {
    transactionHash: `0x${"ab".repeat(32)}`,
    providerTransactionId: "privy-transaction-1",
    referenceId: "halo_reference_1",
  });
  const rpcCall = fake.calls.find((call) => call.path.endsWith("/rpc"));
  assert.equal(rpcCall?.headers.get("privy-idempotency-key"), "halo_reference_1");
  const body = JSON.parse(String(rpcCall?.body));
  assert.deepEqual(body, {
    method: "eth_sendTransaction",
    caip2: "eip155:8453",
    chain_type: "ethereum",
    reference_id: "halo_reference_1",
    params: {
      transaction: {
        from: fake.wallet.address,
        to: "0x0000000000000000000000000000000000000003",
        chain_id: "8453",
        type: 2,
        nonce: "7",
        gas_limit: "100000",
        max_fee_per_gas: "1000000000",
        max_priority_fee_per_gas: "500000000",
        value: "0x0",
        data: "0x1234",
      },
    },
  });
  authorization.dispose();
});

test("eth_signTransaction returns an exact signed type-2 transaction without broadcasting", async () => {
  const fake = makeFakePrivy();
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const authorization = await gateway.authorize(() => {});
  assert.ok(authorization.signEvmTransaction);
  const signed = await authorization.signEvmTransaction!({
    from: fake.wallet.address,
    to: "0x0000000000000000000000000000000000000003",
    chainId: "8453",
    type: 2,
    nonce: "7",
    gasLimit: "100000",
    maxFeePerGas: "1000000000",
    maxPriorityFeePerGas: "500000000",
    value: "0",
    data: "0x1234",
  });
  assert.match(signed, /^0x[0-9a-f]+$/);
  assert.equal(Transaction.from(signed).from, fake.wallet.address);
  const rpcCall = fake.calls.find((call) =>
    call.path.endsWith("/rpc") && String(call.body).includes("eth_signTransaction")
  );
  assert.ok(rpcCall);
  assert.equal(rpcCall.headers.get("privy-idempotency-key"), null);
  assert.deepEqual(JSON.parse(String(rpcCall.body)), {
    method: "eth_signTransaction",
    params: {
      transaction: {
        from: fake.wallet.address,
        to: "0x0000000000000000000000000000000000000003",
        chain_id: "8453",
        type: 2,
        nonce: "7",
        gas_limit: "100000",
        max_fee_per_gas: "1000000000",
        max_priority_fee_per_gas: "500000000",
        value: "0x0",
        data: "0x1234",
      },
    },
  });
  authorization.dispose();
});

test("eth_sendTransaction never replays an ambiguous transport loss", async () => {
  let attempts = 0;
  const fake = makeFakePrivy({
    rpcResponse: () => {
      attempts += 1;
      throw new Error("response lost after possible broadcast");
    },
  });
  const gateway = new PrivyWalletAccessGateway({
    appId: APP_ID,
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => NOW,
  });
  const authorization = await gateway.authorize(() => {});
  await assert.rejects(
    authorization.sendEvmTransaction!(
      {
        from: fake.wallet.address,
        to: "0x0000000000000000000000000000000000000003",
        chainId: "8453",
        type: 2,
        nonce: "7",
        gasLimit: "100000",
        maxFeePerGas: "1000000000",
        maxPriorityFeePerGas: "500000000",
        value: "0",
        data: "0x",
      },
      "halo_reference_2"
    ),
    (error: unknown) =>
      error instanceof WalletAccessError && error.code === "privy_rpc_ambiguous"
  );
  assert.equal(attempts, 1);
  authorization.dispose();
});
