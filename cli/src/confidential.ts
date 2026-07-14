import * as crypto from "crypto";
import { ethers } from "ethers";

// Bound and retry external attestation/collateral fetches so transient failures do not hang requests.
const ATTEST_TIMEOUT_MS = 20_000;
const ATTEST_RETRIES = 2;
const ATTEST_RETRY_BASE_DELAY_MS = 600;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Transient enough to retry: network faults, timeouts, 5xx, and the DCAP
 *  collateral fetch failing (Intel PCS blip). NOT a genuine verification
 *  failure (a forged/invalid quote) — that should fail closed immediately. */
function isTransientAttestErr(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/invalid|mismatch|forged|does not|not verified|tcb|expired certificate|signature/.test(msg)) {
    // Looks like a real verification verdict — don't paper over it with retries.
    return /collateral|timeout|timed out|network|fetch failed/.test(msg);
  }
  return /collateral|timeout|timed out|econn|enotfound|eai_again|fetch failed|socket hang up|network|502|503|504|temporarily/.test(
    msg
  );
}

/** Run an attestation step with bounded retries + backoff on transient faults. */
async function withAttestRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= ATTEST_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= ATTEST_RETRIES || !isTransientAttestErr(err)) break;
      await sleep(ATTEST_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed: ${String(lastErr)}`);
}

export interface ModelAttestation {
  signingPublicKey: string; // 64-byte secp256k1 hex (no 0x04 prefix)
  signingAddress: string;
}

/** HKDF-SHA256 with a zero salt (matches NEAR's vllm-proxy). */
function hkdf(ikm: Buffer, info: string, length: number): Buffer {
  const prk = crypto.createHmac("sha256", Buffer.alloc(32)).update(ikm).digest();
  const h = crypto.createHmac("sha256", prk).update(Buffer.from(info)).update(Buffer.from([1]));
  return h.digest().slice(0, length);
}

function sharedSecret(privKeyHex: string, peerPubPoint: Buffer): Buffer {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privKeyHex.replace(/^0x/, ""), "hex"));
  return ecdh.computeSecret(peerPubPoint);
}

/** Uncompressed secp256k1 public key (0x04 + 128 hex) from a private key. */
function uncompressedPub(privKey: string): string {
  return ethers.SigningKey.computePublicKey(privKey, false);
}

/** Encrypt `plaintext` to the model's 64-byte secp256k1 pubkey (ECIES). */
export function encryptToTee(plaintext: string, modelPub64: string): string {
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(modelPub64, "hex")]);
  const eph = ethers.Wallet.createRandom();
  const aesKey = hkdf(sharedSecret(eph.privateKey, point), "ecdsa_encryption", 32);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
  const enc = Buffer.concat([c.update(Buffer.from(plaintext, "utf-8")), c.final()]);
  const ephPub = Buffer.from(uncompressedPub(eph.privateKey).slice(2), "hex"); // 65 bytes
  return Buffer.concat([ephPub, nonce, enc, c.getAuthTag()]).toString("hex");
}

/** Decrypt a TEE response (encrypted to our ephemeral key). */
export function decryptFromTee(encHex: string, clientPrivKey: string): string {
  const buf = Buffer.from(encHex, "hex");
  const ephPub = buf.slice(0, 65),
    nonce = buf.slice(65, 77),
    ctTag = buf.slice(77);
  const aesKey = hkdf(sharedSecret(clientPrivKey, ephPub), "ecdsa_encryption", 32);
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  d.setAuthTag(ctTag.slice(-16));
  return Buffer.concat([d.update(ctTag.slice(0, -16)), d.final()]).toString("utf-8");
}

/** A fresh client keypair for one confidential request. `pubHex` is the 64-byte
 *  uncompressed key (no 0x04) sent as X-Client-Pub-Key. */
export function newClientKey(): { privateKey: string; pubHex: string } {
  const w = ethers.Wallet.createRandom();
  return { privateKey: w.privateKey, pubHex: uncompressedPub(w.privateKey).slice(4) };
}

/** Fetch the model's attestation (PUBLIC endpoint — no operator key required). */
export async function fetchModelAttestation(
  baseUrl: string,
  model: string
): Promise<ModelAttestation> {
  const url =
    `${baseUrl.replace(/\/+$/, "")}/attestation/report` +
    `?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  return withAttestRetry("attestation report", async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`attestation report ${res.status}`);
    const rep = (await res.json()) as {
      model_attestations?: Array<{ signing_public_key?: string; signing_address?: string }>;
    };
    const m = (rep.model_attestations || []).find((a) => a.signing_public_key && a.signing_address);
    if (!m) throw new Error("no model attestation with a signing key");
    return { signingPublicKey: m.signing_public_key!, signingAddress: m.signing_address! };
  });
}

/** Verify available hardware evidence and its binding to the signing address. */
export async function verifyAttestationHardware(baseUrl: string, model: string): Promise<string> {
  const url =
    `${baseUrl.replace(/\/+$/, "")}/attestation/report` +
    `?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  // The DCAP verify fetches the Intel quote's collateral from Intel's PCS, which
  // has transient blips — retry the whole report-fetch + verify on transient
  // faults (a genuine quote-verification failure is NOT retried; it fails closed).
  return withAttestRetry("hardware attestation", async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`attestation report ${res.status}`);
    const rep = (await res.json()) as {
      model_attestations?: Array<{
        signing_address?: string;
        intel_quote?: string;
        nvidia_payload?: string;
        request_nonce?: string;
      }>;
    };
    const ma = (rep.model_attestations || []).find((a) => a.signing_address && a.intel_quote);
    if (!ma) throw new Error("attestation report missing intel_quote / signing_address");
    // Lazy import: the verifier pulls in the DCAP WASM — keep it off the cold path
    // for non-confidential serve/consume.
    const { verifyModelAttestation, assertModelAttestationVerified } = await import(
      "nearai-cloud-verifier"
    );
    const v = await verifyModelAttestation(ma as Parameters<typeof verifyModelAttestation>[0]);
    // Throws if the TDX quote / NVIDIA evidence / report_data binding don't verify.
    assertModelAttestationVerified(
      v as Parameters<typeof assertModelAttestationVerified>[0],
      ma.request_nonce || "",
      ma.signing_address || ""
    );
    return ma.signing_address!.toLowerCase();
  });
}

// Cache configured-verifier signer results for a bounded interval.
const verifiedSignerCache = new Map<string, { signer: string; at: number }>();
const ATTEST_VERIFY_TTL_MS = 10 * 60 * 1000;

/** Return the configured verifier's accepted signer, cached with fail-closed refresh. */
export async function verifiedSignerForModel(baseUrl: string, model: string): Promise<string> {
  const key = `${baseUrl.replace(/\/+$/, "")}::${model}`;
  const hit = verifiedSignerCache.get(key);
  if (hit && Date.now() - hit.at < ATTEST_VERIFY_TTL_MS) return hit.signer;
  const signer = await verifyAttestationHardware(baseUrl, model);
  verifiedSignerCache.set(key, { signer, at: Date.now() });
  return signer;
}

/** Verify the base64 response-proof signature against the reported attested signer. */
export function verifyTeeSignature(sigB64: string, attestedSigner: string): boolean {
  try {
    const p = JSON.parse(Buffer.from(sigB64, "base64").toString("utf-8")) as {
      text: string;
      signature: string;
      signing_address: string;
    };
    const recovered = ethers.verifyMessage(p.text, p.signature);
    return (
      recovered.toLowerCase() === p.signing_address.toLowerCase() &&
      recovered.toLowerCase() === attestedSigner.toLowerCase()
    );
  } catch {
    return false;
  }
}
