import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import {
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import canonicalize from "canonicalize";
import {
  createPrivateKey,
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import { getAddress } from "ethers";
import {
  WalletAccessError,
} from "../domain/walletAccess";
import type {
  PrivyWalletAccessSession,
  WalletAccessAuthorization,
  WalletAccessChallenge,
  WalletAccessEvmTransaction,
  WalletAccessGateway,
  WalletAccessTransactionSubmission,
} from "../domain/walletAccess";
import {
  PrivyHttpTransport,
  PrivyHttpTransportError,
} from "./privyHttp";

export type { PrivyWalletAccessSession } from "../domain/walletAccess";

const DEFAULT_PRIVY_AUTH_BASE_URL = "https://auth.privy.io";
const MAX_JSON_BYTES = 64 * 1024;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT_TYPE = "refresh_token";

type FetchLike = typeof fetch;

export interface PrivyWalletAccessOptions {
  appId: string;
  fetch?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  signal?: AbortSignal;
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface AccessToken {
  value: string;
  expiresAt: string;
  refreshToken: string;
}

interface AuthenticatedWallet {
  id: string;
  address: string;
}

interface WalletAuthentication {
  authorizationKey: string;
  wallet: AuthenticatedWallet;
}

type PrivyProviderOperation =
  | "device_authorization"
  | "device_token"
  | "refresh"
  | "wallet_auth"
  | "personal_sign"
  | "eth_sign_transaction"
  | "eth_send_transaction";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function positiveInteger(value: unknown, max: number): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max
    ? Number(value)
    : null;
}

function canonicalIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WalletAccessError(
      "privy_protocol_error",
      "Privy returned an invalid response. Run halo login again."
    );
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new WalletAccessError(
      "privy_protocol_error",
      "Privy returned an invalid response. Run halo login again."
    );
  }
  return text;
}

function protocolFailure(): WalletAccessError {
  return new WalletAccessError(
    "privy_protocol_error",
    "Privy returned a response outside the supported Wallet Access protocol. Run halo login again."
  );
}

function providerFailure(
  code:
    | "privy_device_authorization_ambiguous"
    | "privy_device_authorization_rejected"
    | "privy_device_authorization_unavailable"
    | "privy_token_ambiguous"
    | "privy_token_rejected"
    | "privy_token_unavailable"
    | "privy_refresh_ambiguous"
    | "privy_refresh_unavailable"
    | "privy_wallet_auth_ambiguous"
    | "privy_wallet_auth_unavailable"
    | "privy_rpc_ambiguous"
    | "privy_rpc_error"
    | "privy_rpc_forbidden",
  message: string
): WalletAccessError {
  return new WalletAccessError(code, message);
}

function transportFailure(
  operation: PrivyProviderOperation,
  error: PrivyHttpTransportError
): WalletAccessError {
  if (error.failure === "response_invalid") return protocolFailure();
  switch (operation) {
    case "device_authorization":
      return providerFailure(
        "privy_device_authorization_ambiguous",
        "Privy device authorization did not complete unambiguously. Run halo login again."
      );
    case "device_token":
      return providerFailure(
        "privy_token_ambiguous",
        "Privy token issuance did not complete unambiguously. Run halo login again."
      );
    case "refresh":
      return providerFailure(
        "privy_refresh_ambiguous",
        "Privy session refresh did not complete unambiguously. Run halo login to authenticate again."
      );
    case "wallet_auth":
      return providerFailure(
        "privy_wallet_auth_ambiguous",
        "Privy wallet authentication did not complete unambiguously. Run halo login again."
      );
    case "personal_sign":
      return providerFailure(
        "privy_rpc_ambiguous",
        "Privy personal_sign did not complete unambiguously. Inspect the operation before trying again."
      );
    case "eth_sign_transaction":
      return providerFailure(
        "privy_rpc_error",
        "Privy could not complete transaction signing. No sponsored request was sent."
      );
    case "eth_send_transaction":
      return providerFailure(
        "privy_rpc_ambiguous",
        "Privy transaction submission did not complete unambiguously. Inspect the persisted funding action before trying again."
      );
  }
}

async function providerOperation<Result>(
  operation: PrivyProviderOperation,
  run: () => Promise<Result>
): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WalletAccessError) throw error;
    if (error instanceof PrivyHttpTransportError) {
      throw transportFailure(operation, error);
    }
    throw protocolFailure();
  }
}

function generateHpkeRecipient(): { privateKeyPem: string; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    privateKeyPem: privateKey,
    publicKeyBase64: publicKey.toString("base64"),
  };
}

async function decryptAuthorizationKey(input: {
  privateKeyPem: string;
  encapsulatedKeyBase64: string;
  ciphertextBase64: string;
}): Promise<string> {
  const jwk = createPrivateKey(input.privateKeyPem).export({ format: "jwk" });
  if (typeof jwk.d !== "string") throw protocolFailure();
  const privateScalar = Buffer.from(jwk.d, "base64url");
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(
      new Uint8Array(privateScalar).buffer
    );
    const context = await suite.createRecipientContext({
      recipientKey,
      enc: new Uint8Array(Buffer.from(input.encapsulatedKeyBase64, "base64")).buffer,
    });
    const plaintext = await context.open(
      new Uint8Array(Buffer.from(input.ciphertextBase64, "base64")).buffer
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw protocolFailure();
  } finally {
    privateScalar.fill(0);
  }
}

function signAuthorizationPayload(privateKey: string, payload: unknown): string {
  const serialized = canonicalize(payload);
  if (serialized === undefined) throw protocolFailure();
  try {
    const key = privateKey.startsWith("-----BEGIN")
      ? createPrivateKey(privateKey)
      : createPrivateKey({
          key: Buffer.from(privateKey, "base64"),
          format: "der",
          type: "pkcs8",
        });
    const signer = createSign("SHA256");
    signer.update(serialized);
    signer.end();
    return signer.sign(key, "base64");
  } catch {
    throw protocolFailure();
  }
}

export function validatePrivyAppId(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new WalletAccessError(
      "privy_tenant_mismatch",
      "Set HALO_PRIVY_APP_ID to the public Privy app ID before running halo login."
    );
  }
  return value;
}

export class PrivyWalletAccessGateway implements WalletAccessGateway<PrivyWalletAccessSession> {
  private readonly appId: string;
  private readonly http: PrivyHttpTransport;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(options: PrivyWalletAccessOptions) {
    this.appId = validatePrivyAppId(options.appId);
    this.now = options.now ?? Date.now;
    this.http = new PrivyHttpTransport({
      fetch: options.fetch ?? fetch,
      sleep:
        options.sleep ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      now: this.now,
      signal: options.signal,
    });
    try {
      const baseUrl = new URL(options.baseUrl ?? DEFAULT_PRIVY_AUTH_BASE_URL);
      if (baseUrl.protocol !== "https:") throw new TypeError();
      this.baseUrl = baseUrl.toString().replace(/\/+$/, "");
    } catch {
      throw new WalletAccessError(
        "privy_tenant_mismatch",
        "Privy Wallet Access requires a valid HTTPS authentication endpoint."
      );
    }
  }

  async authorize(
    onChallenge: (challenge: WalletAccessChallenge) => void | Promise<void>
  ): Promise<WalletAccessAuthorization<PrivyWalletAccessSession>> {
    try {
      const device = await this.requestDeviceAuthorization();
      await onChallenge({
        verificationUri: device.verificationUri,
        userCode: device.userCode,
      });
      const token = await this.pollForAccessToken(device);
      const authenticated = await this.authenticateWallet(token);
      return this.createAuthorization({
        version: 1,
        identity: { backend: "privy", address: authenticated.wallet.address },
        expiresAt: token.expiresAt,
        appId: this.appId,
        walletId: authenticated.wallet.id,
        accessToken: token.value,
        refreshToken: token.refreshToken,
      }, authenticated.authorizationKey);
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      throw protocolFailure();
    }
  }

  async resume(
    session: PrivyWalletAccessSession
  ): Promise<WalletAccessAuthorization<PrivyWalletAccessSession>> {
    const validated = this.validateSession(session);
    try {
      const authenticated = await this.authenticateWallet(
        { value: validated.accessToken, expiresAt: validated.expiresAt },
        { id: validated.walletId, address: validated.identity.address }
      );
      return this.createAuthorization(validated, authenticated.authorizationKey);
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      throw protocolFailure();
    }
  }

  async refresh(
    session: PrivyWalletAccessSession
  ): Promise<PrivyWalletAccessSession> {
    const validated = this.validateSession(session, false);

    const body = await providerOperation("refresh", () =>
      this.http.request(
        `${this.baseUrl}/api/oauth/v2/token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "privy-app-id": this.appId,
          },
          body: JSON.stringify({
            grant_type: REFRESH_GRANT_TYPE,
            refresh_token: validated.refreshToken,
          }),
        },
        "rate-limit-only",
        async (response) => {
          if (response.status === 429) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_refresh_unavailable",
              "Privy is temporarily unavailable. Existing local-key work can continue; try halo login again later."
            );
          }
          if (response.status === 408 || response.status >= 500) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_refresh_ambiguous",
              "Privy session refresh did not complete unambiguously. Run halo login to authenticate again."
            );
          }
          if (response.status === 401 || response.status === 403) {
            throw new WalletAccessError(
              "privy_login_required",
              "The Privy authorization expired or was revoked. Run halo login to authenticate again."
            );
          }
          if (!response.ok) {
            const failureBody = await readBoundedJson(response);
            const code = isRecord(failureBody) ? failureBody.error : null;
            if (code === "access_denied" || code === "invalid_grant") {
              throw new WalletAccessError(
                "privy_login_required",
                "The Privy authorization expired or was revoked. Run halo login to authenticate again."
              );
            }
            throw protocolFailure();
          }
          try {
            return await readBoundedJson(response);
          } catch (error) {
            if (!(error instanceof WalletAccessError)) throw error;
            throw providerFailure(
              "privy_refresh_ambiguous",
              "Privy returned an invalid refresh response. Run halo login to authenticate again."
            );
          }
        }
      )
    );

    const token = this.parseAccessToken(body, "privy_refresh_ambiguous");
    if (token.refreshToken === validated.refreshToken) {
      throw providerFailure(
        "privy_refresh_ambiguous",
        "Privy did not rotate the refresh token. Run halo login to authenticate again."
      );
    }
    return {
      ...validated,
      expiresAt: token.expiresAt,
      accessToken: token.value,
      refreshToken: token.refreshToken,
    };
  }

  private validateSession(
    session: PrivyWalletAccessSession,
    requireActive = true
  ): PrivyWalletAccessSession {
    const expiresAt = canonicalIsoDate(session.expiresAt);
    let address: string;
    try {
      address = getAddress(session.identity.address);
    } catch {
      throw new WalletAccessError(
        "privy_session_persistence_ambiguous",
        "The local Privy session is invalid. Run halo logout before trying again."
      );
    }
    if (
      session.version !== 1 ||
      session.identity.backend !== "privy" ||
      session.appId !== this.appId ||
      !boundedString(session.walletId, 256) ||
      !boundedString(session.accessToken, 16 * 1024) ||
      !boundedString(session.refreshToken, 16 * 1024) ||
      !expiresAt
    ) {
      const mismatch = session.appId !== this.appId;
      throw new WalletAccessError(
        mismatch ? "privy_tenant_mismatch" : "privy_session_persistence_ambiguous",
        mismatch
          ? "The saved Privy session belongs to another app. Run halo logout before changing HALO_PRIVY_APP_ID."
          : "The local Privy session is invalid. Run halo logout before trying again."
      );
    }
    if (requireActive && new Date(expiresAt).getTime() <= this.now()) {
      throw new WalletAccessError(
        "privy_login_required",
        "The Privy session expired. Run halo login to authenticate again."
      );
    }
    return {
      ...session,
      identity: { backend: "privy", address },
      expiresAt,
    };
  }

  private createAuthorization(
    session: PrivyWalletAccessSession,
    initialAuthorizationKey: string
  ): WalletAccessAuthorization<PrivyWalletAccessSession> {
    let authorizationKey: string | null = initialAuthorizationKey;
    return {
      identity: { ...session.identity },
      session: { ...session, identity: { ...session.identity } },
      signPersonalMessage: async (message: string): Promise<string> => {
        if (authorizationKey === null) throw protocolFailure();
        if (new Date(session.expiresAt).getTime() <= this.now()) {
          throw new WalletAccessError(
            "privy_login_required",
            "The Privy session expired. Run halo login to authenticate again."
          );
        }
        return this.personalSign(
          session.walletId,
          session.accessToken,
          authorizationKey,
          message
        );
      },
      signEvmTransaction: async (
        transaction: WalletAccessEvmTransaction
      ): Promise<string> => {
        if (authorizationKey === null) throw protocolFailure();
        if (new Date(session.expiresAt).getTime() <= this.now()) {
          throw new WalletAccessError(
            "privy_login_required",
            "The Privy session expired. Run halo login to authenticate again."
          );
        }
        return this.signTransaction(
          session.walletId,
          session.accessToken,
          authorizationKey,
          session.identity.address,
          transaction
        );
      },
      sendEvmTransaction: async (
        transaction: WalletAccessEvmTransaction,
        referenceId: string
      ): Promise<WalletAccessTransactionSubmission> => {
        if (authorizationKey === null) throw protocolFailure();
        if (new Date(session.expiresAt).getTime() <= this.now()) {
          throw new WalletAccessError(
            "privy_login_required",
            "The Privy session expired. Run halo login to authenticate again."
          );
        }
        return this.sendTransaction(
          session.walletId,
          session.accessToken,
          authorizationKey,
          session.identity.address,
          transaction,
          referenceId
        );
      },
      dispose: () => {
        authorizationKey = null;
      },
    };
  }

  private async requestDeviceAuthorization(): Promise<DeviceAuthorization> {
    const body = await providerOperation("device_authorization", () =>
      this.http.request(
        `${this.baseUrl}/api/oauth/v2/device_authorization`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "privy-app-id": this.appId,
          },
          body: "{}",
        },
        "complete-response-only",
        async (response) => {
          if (response.status === 408 || response.status === 429 || response.status >= 500) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_device_authorization_unavailable",
              "Privy device authorization is temporarily unavailable. Try halo login again later."
            );
          }
          if (response.status >= 400 && response.status < 500) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_device_authorization_rejected",
              "Privy rejected device authorization. Check the app configuration and run halo login again."
            );
          }
          if (!response.ok) throw protocolFailure();
          return readBoundedJson(response);
        }
      )
    );
    if (!isRecord(body)) throw protocolFailure();
    const deviceCode = boundedString(body.device_code, 4096);
    const userCode = boundedString(body.user_code, 128);
    const verification = boundedString(
      body.verification_uri_complete ?? body.verification_uri,
      2048
    );
    const expiresInSeconds = positiveInteger(body.expires_in, 600);
    const intervalSeconds = positiveInteger(body.interval, 60);
    if (!deviceCode || !userCode || !verification || !expiresInSeconds || !intervalSeconds) {
      throw protocolFailure();
    }
    let verificationUri: URL;
    try {
      verificationUri = new URL(verification);
    } catch {
      throw protocolFailure();
    }
    if (verificationUri.protocol !== "https:") throw protocolFailure();
    return {
      deviceCode,
      userCode,
      verificationUri: verificationUri.toString(),
      expiresInSeconds,
      intervalSeconds: Math.max(intervalSeconds, 5),
    };
  }

  private async pollForAccessToken(device: DeviceAuthorization): Promise<AccessToken> {
    const deadline = this.now() + device.expiresInSeconds * 1000;
    let intervalSeconds = device.intervalSeconds;
    while (this.now() < deadline) {
      await this.http.wait(intervalSeconds * 1000);
      const result = await providerOperation("device_token", () =>
        this.http.request(
          `${this.baseUrl}/api/oauth/v2/token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "privy-app-id": this.appId,
            },
            body: JSON.stringify({
              grant_type: DEVICE_GRANT_TYPE,
              device_code: device.deviceCode,
            }),
          },
          "rate-limit-only",
          async (response) => {
            if (response.status === 429) {
              await readBoundedText(response);
              throw providerFailure(
                "privy_token_unavailable",
                "Privy token issuance is temporarily unavailable. Run halo login again later."
              );
            }
            if (response.status === 408 || response.status >= 500) {
              await readBoundedText(response);
              throw providerFailure(
                "privy_token_ambiguous",
                "Privy token issuance did not complete unambiguously. Run halo login again."
              );
            }
            if (!response.ok && (response.status < 400 || response.status >= 500)) {
              throw protocolFailure();
            }
            return {
              ok: response.ok,
              status: response.status,
              body: await readBoundedJson(response),
            };
          }
        )
      );
      if (result.ok) {
        return this.parseAccessToken(result.body, "privy_protocol_error");
      }
      const code = isRecord(result.body) ? result.body.error : null;
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        intervalSeconds = Math.min(60, intervalSeconds + 5);
        continue;
      }
      if (code === "access_denied") {
        throw new WalletAccessError(
          "privy_access_denied",
          "Privy wallet access was denied. Run halo login to try again."
        );
      }
      if (code === "expired_token") {
        throw new WalletAccessError(
          "privy_device_code_expired",
          "The Privy login code expired. Run halo login to start again."
        );
      }
      if (
        result.status >= 400 &&
        result.status < 500 &&
        typeof code === "string" &&
        code.length > 0
      ) {
        throw providerFailure(
          "privy_token_rejected",
          "Privy rejected token issuance. Run halo login again."
        );
      }
      throw protocolFailure();
    }
    throw new WalletAccessError(
      "privy_device_code_expired",
      "The Privy login code expired. Run halo login to start again."
    );
  }

  private parseAccessToken(
    body: unknown,
    invalidCode: "privy_protocol_error" | "privy_refresh_ambiguous"
  ): AccessToken {
    const invalid = (): WalletAccessError =>
      invalidCode === "privy_refresh_ambiguous"
        ? providerFailure(
            invalidCode,
            "Privy returned an invalid refresh response. Run halo login to authenticate again."
          )
        : protocolFailure();
    if (!isRecord(body)) throw invalid();
    const accessToken = boundedString(body.access_token, 16 * 1024);
    const refreshToken = boundedString(body.refresh_token, 16 * 1024);
    const expiresInSeconds = positiveInteger(body.expires_in, 24 * 60 * 60);
    if (
      !accessToken ||
      !refreshToken ||
      body.token_type !== "Bearer" ||
      !expiresInSeconds
    ) {
      throw invalid();
    }
    const expiresAtMilliseconds = this.now() + expiresInSeconds * 1000;
    if (!Number.isSafeInteger(expiresAtMilliseconds)) throw invalid();
    return {
      value: accessToken,
      expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      refreshToken,
    };
  }

  private async authenticateWallet(
    token: Pick<AccessToken, "value" | "expiresAt">,
    expectedWallet?: AuthenticatedWallet
  ): Promise<WalletAuthentication> {
    const recipient = generateHpkeRecipient();
    const body = await providerOperation("wallet_auth", () =>
      this.http.request(
        `${this.baseUrl}/api/oauth/v2/wallets/authenticate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.value}`,
            "Content-Type": "application/json",
            "privy-app-id": this.appId,
            "privy-grant-type": "device_code",
          },
          body: JSON.stringify({
            encryption_type: "HPKE",
            recipient_public_key: recipient.publicKeyBase64,
          }),
        },
        "complete-response-only",
        async (response) => {
          if (response.status === 408 || response.status === 429 || response.status >= 500) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_wallet_auth_unavailable",
              "Privy wallet authentication is temporarily unavailable. Try halo login again later."
            );
          }
          if (response.status === 401 || response.status === 403) {
            await readBoundedText(response);
            throw new WalletAccessError(
              "privy_login_required",
              "The Privy authorization expired or was revoked. Run halo login again."
            );
          }
          if (!response.ok) throw protocolFailure();
          return readBoundedJson(response);
        }
      )
    );
    if (!isRecord(body) || !isRecord(body.encrypted_authorization_key)) {
      throw protocolFailure();
    }
    const encrypted = body.encrypted_authorization_key;
    const encapsulatedKeyBase64 = boundedString(encrypted.encapsulated_key, 4096);
    const ciphertextBase64 = boundedString(encrypted.ciphertext, 16 * 1024);
    if (!Array.isArray(body.wallets)) throw protocolFailure();
    const ethereumWallets: AuthenticatedWallet[] = [];
    for (const candidate of body.wallets) {
      if (!isRecord(candidate)) throw protocolFailure();
      if (candidate.chain_type !== "ethereum") continue;
      const id = boundedString(candidate.id, 256);
      const address = boundedString(candidate.address, 128);
      if (!id || !address) throw protocolFailure();
      try {
        ethereumWallets.push({ id, address: getAddress(address) });
      } catch {
        throw protocolFailure();
      }
    }
    if (!encapsulatedKeyBase64 || !ciphertextBase64) throw protocolFailure();
    if (ethereumWallets.length === 0) {
      throw new WalletAccessError(
        "privy_wallet_not_found",
        "Privy did not return an Ethereum wallet. Run halo login again."
      );
    }
    if (ethereumWallets.length > 1) {
      throw new WalletAccessError(
        "privy_wallet_ambiguous",
        "Privy returned more than one Ethereum wallet. Inspect the account before trying again."
      );
    }
    if (
      expectedWallet &&
      (ethereumWallets[0].id !== expectedWallet.id ||
        ethereumWallets[0].address !== expectedWallet.address)
    ) {
      throw new WalletAccessError(
        "privy_wallet_identity_changed",
        "Privy returned a different wallet for the saved session. Run halo logout before trying again."
      );
    }
    const authorizationKey = await decryptAuthorizationKey({
      privateKeyPem: recipient.privateKeyPem,
      encapsulatedKeyBase64,
      ciphertextBase64,
    });
    return { authorizationKey, wallet: ethereumWallets[0] };
  }

  private async personalSign(
    walletId: string,
    accessToken: string,
    authorizationKey: string,
    message: string
  ): Promise<string> {
    const url = `${this.baseUrl}/api/oauth/v2/wallets/${encodeURIComponent(walletId)}/rpc`;
    const body = {
      method: "personal_sign",
      params: { message, encoding: "utf-8" },
    };
    const authorizationSignature = signAuthorizationPayload(authorizationKey, {
      version: 1,
      method: "POST",
      url,
      body,
      headers: { "privy-app-id": this.appId },
    });
    const result = await providerOperation("personal_sign", () =>
      this.http.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "privy-app-id": this.appId,
            "privy-grant-type": "device_code",
            "privy-authorization-signature": authorizationSignature,
          },
          body: JSON.stringify(body),
        },
        "replay-safe",
        async (response) => {
          if (response.status === 401) {
            await readBoundedText(response);
            throw new WalletAccessError(
              "privy_login_required",
              "The Privy authorization expired or was revoked. Run halo login again."
            );
          }
          if (response.status === 403) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_forbidden",
              "Privy refused personal_sign for this wallet. Run halo login again."
            );
          }
          if (
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_error",
              "Privy could not complete personal_sign. Try the operation again."
            );
          }
          if (!response.ok) throw protocolFailure();
          return readBoundedJson(response);
        }
      )
    );
    if (!isRecord(result)) throw protocolFailure();
    if (isRecord(result.error)) {
      throw providerFailure(
        "privy_rpc_error",
        "Privy could not complete personal_sign. Try the operation again."
      );
    }
    const data = isRecord(result.data) ? result.data : null;
    const signature = boundedString(data?.signature, 1024);
    if (result.method !== "personal_sign" || !signature || data?.encoding !== "hex") {
      throw protocolFailure();
    }
    return signature;
  }

  private validateTransaction(
    transaction: WalletAccessEvmTransaction,
    expectedAddress: string
  ): void {
    const decimal = /^(?:0|[1-9]\d{0,77})$/;
    if (
      transaction.chainId !== "8453" ||
      transaction.type !== 2 ||
      transaction.value !== "0" ||
      !decimal.test(transaction.nonce) ||
      !decimal.test(transaction.gasLimit) ||
      !decimal.test(transaction.maxFeePerGas) ||
      !decimal.test(transaction.maxPriorityFeePerGas) ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data)
    ) {
      throw protocolFailure();
    }
    try {
      if (
        getAddress(transaction.from) !== getAddress(expectedAddress) ||
        getAddress(transaction.to) === "0x0000000000000000000000000000000000000000"
      ) {
        throw protocolFailure();
      }
    } catch (error) {
      if (error instanceof WalletAccessError) throw error;
      throw protocolFailure();
    }
  }

  private transactionParams(transaction: WalletAccessEvmTransaction) {
    return {
      from: transaction.from,
      to: transaction.to,
      chain_id: transaction.chainId,
      type: transaction.type,
      nonce: transaction.nonce,
      gas_limit: transaction.gasLimit,
      max_fee_per_gas: transaction.maxFeePerGas,
      max_priority_fee_per_gas: transaction.maxPriorityFeePerGas,
      value: "0x0",
      data: transaction.data,
    };
  }

  private async signTransaction(
    walletId: string,
    accessToken: string,
    authorizationKey: string,
    expectedAddress: string,
    transaction: WalletAccessEvmTransaction
  ): Promise<string> {
    this.validateTransaction(transaction, expectedAddress);
    const url = `${this.baseUrl}/api/oauth/v2/wallets/${encodeURIComponent(walletId)}/rpc`;
    const body = {
      method: "eth_signTransaction",
      params: { transaction: this.transactionParams(transaction) },
    };
    const authorizationSignature = signAuthorizationPayload(authorizationKey, {
      version: 1,
      method: "POST",
      url,
      body,
      headers: { "privy-app-id": this.appId },
    });
    const result = await providerOperation("eth_sign_transaction", () =>
      this.http.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "privy-app-id": this.appId,
            "privy-grant-type": "device_code",
            "privy-authorization-signature": authorizationSignature,
          },
          body: JSON.stringify(body),
        },
        "replay-safe",
        async (response) => {
          if (response.status === 401) {
            await readBoundedText(response);
            throw new WalletAccessError(
              "privy_login_required",
              "The Privy authorization expired or was revoked. Run halo login again."
            );
          }
          if (response.status === 403) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_forbidden",
              "Privy refused transaction signing for the selected wallet. Run halo login again."
            );
          }
          if (
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_error",
              "Privy could not complete transaction signing. No sponsored request was sent."
            );
          }
          if (!response.ok) throw protocolFailure();
          return readBoundedJson(response);
        }
      )
    );
    if (!isRecord(result) || isRecord(result.error)) {
      if (isRecord(result) && isRecord(result.error)) {
        throw providerFailure(
          "privy_rpc_error",
          "Privy rejected transaction signing. No sponsored request was sent."
        );
      }
      throw protocolFailure();
    }
    const data = isRecord(result.data) ? result.data : null;
    const signedTransaction = boundedString(data?.signed_transaction, 4_098);
    if (
      result.method !== "eth_signTransaction" ||
      data?.encoding !== "rlp" ||
      !signedTransaction ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(signedTransaction)
    ) {
      throw protocolFailure();
    }
    return signedTransaction;
  }

  private async sendTransaction(
    walletId: string,
    accessToken: string,
    authorizationKey: string,
    expectedAddress: string,
    transaction: WalletAccessEvmTransaction,
    referenceId: string
  ): Promise<WalletAccessTransactionSubmission> {
    this.validateTransaction(transaction, expectedAddress);
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(referenceId)
    ) {
      throw protocolFailure();
    }
    const url = `${this.baseUrl}/api/oauth/v2/wallets/${encodeURIComponent(walletId)}/rpc`;
    const body = {
      method: "eth_sendTransaction",
      caip2: "eip155:8453",
      chain_type: "ethereum",
      reference_id: referenceId,
      params: {
        transaction: this.transactionParams(transaction),
      },
    };
    const authorizationSignature = signAuthorizationPayload(authorizationKey, {
      version: 1,
      method: "POST",
      url,
      body,
      headers: {
        "privy-app-id": this.appId,
        "privy-idempotency-key": referenceId,
      },
    });
    const result = await providerOperation("eth_send_transaction", () =>
      this.http.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "privy-app-id": this.appId,
            "privy-idempotency-key": referenceId,
            "privy-grant-type": "device_code",
            "privy-authorization-signature": authorizationSignature,
          },
          body: JSON.stringify(body),
        },
        "rate-limit-only",
        async (response) => {
          if (response.status === 401) {
            await readBoundedText(response);
            throw new WalletAccessError(
              "privy_login_required",
              "The Privy authorization expired or was revoked. Run halo login again."
            );
          }
          if (response.status === 403) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_forbidden",
              "Privy refused this transaction for the selected wallet. Run halo login again."
            );
          }
          if (response.status === 408 || response.status >= 500) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_ambiguous",
              "Privy transaction submission did not complete unambiguously. Inspect the persisted funding action before trying again."
            );
          }
          if (response.status === 429) {
            await readBoundedText(response);
            throw providerFailure(
              "privy_rpc_error",
              "Privy is rate limiting transaction submission. Try again later."
            );
          }
          if (!response.ok) throw protocolFailure();
          return readBoundedJson(response);
        }
      )
    );
    if (!isRecord(result) || isRecord(result.error)) {
      if (isRecord(result) && isRecord(result.error)) {
        throw providerFailure(
          "privy_rpc_error",
          "Privy rejected the transaction before broadcast. Inspect wallet funds and policy before retrying."
        );
      }
      throw protocolFailure();
    }
    const data = isRecord(result.data) ? result.data : null;
    const transactionHash = boundedString(data?.hash, 66);
    const providerTransactionId =
      data?.transaction_id === undefined
        ? null
        : boundedString(data.transaction_id, 256);
    const returnedReferenceId = boundedString(data?.reference_id, 64);
    if (
      result.method !== "eth_sendTransaction" ||
      data?.caip2 !== "eip155:8453" ||
      !transactionHash ||
      !/^0x[0-9a-fA-F]{64}$/.test(transactionHash) ||
      (data?.transaction_id !== undefined && providerTransactionId === null) ||
      returnedReferenceId !== referenceId
    ) {
      throw protocolFailure();
    }
    return {
      transactionHash: transactionHash.toLowerCase(),
      providerTransactionId,
      referenceId,
    };
  }
}
