import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { verifyMessage } from "ethers";

export const ENCRYPTION_ALG = "x25519-aes256gcm";
export const ENCRYPTION_VERSION = 1;
export const ENCRYPTION_BYTES_VERSION = 2;
const HKDF_INFO = new TextEncoder().encode("halo/v1/x25519-aes256gcm");
const V2_AAD = new TextEncoder().encode(`${ENCRYPTION_BYTES_VERSION}:${ENCRYPTION_ALG}`);

export interface OperatorKeyPair {
  /** 32-byte X25519 public key, hex-encoded (no 0x prefix). */
  publicKeyHex: string;
  /** 32-byte X25519 private key. Held only in process memory. */
  privateKey: Uint8Array;
}

export interface TextEncryptedEnvelope {
  v: 1;
  alg: typeof ENCRYPTION_ALG;
  epk: string;
  nonce: string;
  ct: string;
}

export interface BytesEncryptedEnvelope {
  v: 2;
  alg: typeof ENCRYPTION_ALG;
  epk: string;
  nonce: string;
  ct: string;
}

export type EncryptedEnvelope = TextEncryptedEnvelope | BytesEncryptedEnvelope;

/** True if `value` looks like a known encrypted envelope. */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.v === ENCRYPTION_VERSION || v.v === ENCRYPTION_BYTES_VERSION) &&
    v.alg === ENCRYPTION_ALG &&
    typeof v.epk === "string" &&
    typeof v.nonce === "string" &&
    typeof v.ct === "string"
  );
}

/** Generate a fresh X25519 keypair. Called once at operator startup. */
export function generateOperatorKeypair(): OperatorKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    publicKeyHex: bufToHex(publicKey),
    privateKey,
  };
}

/** Return the normalized key only when the operator wallet signed its binding. */
export function authenticatedOperatorPubkey(
  operator: string,
  pubkeyHex: string | null | undefined,
  attestation: string | null | undefined
): string | null {
  if (!pubkeyHex || !attestation) return null;
  const normalized = pubkeyHex.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null;
  try {
    const recovered = verifyMessage(
      `halo-pubkey:${operator.toLowerCase()}:${normalized}`,
      attestation
    );
    return recovered.toLowerCase() === operator.toLowerCase() ? normalized : null;
  } catch {
    return null;
  }
}

/** Derive the shared AES-256-GCM key. The fixed, versioned HKDF context separates protocol versions. */
function deriveSessionKey(
  ourPrivateKey: Uint8Array,
  peerPublicKey: Uint8Array
): Uint8Array {
  const shared = x25519.getSharedSecret(ourPrivateKey, peerPublicKey);
  // HKDF with no salt (RFC 5869 says omit-salt is fine when input is uniform,
  // and an X25519 shared secret is). 32 bytes out = AES-256 key.
  return hkdf(sha256, shared, undefined, HKDF_INFO, 32);
}

/** Decrypt and parse an `_enc` envelope; malformed, unsupported, or unauthenticated input throws. */
export function decryptRequest(
  envelope: EncryptedEnvelope,
  operatorPrivateKey: Uint8Array
): { plaintext: unknown; consumerPublicKey: Uint8Array } {
  if (envelope.v !== ENCRYPTION_VERSION || envelope.alg !== ENCRYPTION_ALG) {
    throw new Error(`unsupported envelope: v=${envelope.v} alg=${envelope.alg}`);
  }
  const consumerPublicKey = hexToBuf(envelope.epk);
  if (consumerPublicKey.length !== 32) {
    throw new Error(`epk must be 32 bytes, got ${consumerPublicKey.length}`);
  }
  const nonce = hexToBuf(envelope.nonce);
  if (nonce.length !== 12) {
    throw new Error(`nonce must be 12 bytes, got ${nonce.length}`);
  }
  const sealed = hexToBuf(envelope.ct);
  if (sealed.length < 16) {
    throw new Error(`ct too short to contain GCM tag`);
  }
  const sessionKey = deriveSessionKey(operatorPrivateKey, consumerPublicKey);

  // Node's createDecipheriv splits ciphertext from tag (last 16 bytes).
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", sessionKey, nonce);
  decipher.setAuthTag(tag);
  let plaintextBytes: Buffer;
  try {
    plaintextBytes = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("decryption failed (wrong key or tampered ciphertext)");
  }
  return {
    plaintext: JSON.parse(plaintextBytes.toString("utf8")),
    consumerPublicKey,
  };
}

/** Decrypt a v2 raw-bytes envelope; returns exact plaintext bytes with no JSON parsing. */
export function decryptBytes(
  envelope: EncryptedEnvelope,
  receiverPrivateKey: Uint8Array,
  expectedSenderPublicKey?: Uint8Array
): { plaintext: Buffer; senderPublicKey: Uint8Array } {
  if (envelope.v !== ENCRYPTION_BYTES_VERSION || envelope.alg !== ENCRYPTION_ALG) {
    throw new Error(`unsupported bytes envelope: v=${envelope.v} alg=${envelope.alg}`);
  }
  const senderPublicKey = hexToBuf(envelope.epk);
  if (senderPublicKey.length !== 32) {
    throw new Error(`epk must be 32 bytes, got ${senderPublicKey.length}`);
  }
  if (
    expectedSenderPublicKey &&
    Buffer.compare(Buffer.from(senderPublicKey), Buffer.from(expectedSenderPublicKey)) !== 0
  ) {
    throw new Error("unexpected bytes envelope sender public key");
  }
  const nonce = hexToBuf(envelope.nonce);
  if (nonce.length !== 12) {
    throw new Error(`nonce must be 12 bytes, got ${nonce.length}`);
  }
  const sealed = base64ToBuf(envelope.ct);
  if (sealed.length < 16) {
    throw new Error(`ct too short to contain GCM tag`);
  }
  const sessionKey = deriveSessionKey(receiverPrivateKey, senderPublicKey);

  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", sessionKey, nonce);
  decipher.setAAD(V2_AAD);
  decipher.setAuthTag(tag);
  let plaintextBytes: Buffer;
  try {
    plaintextBytes = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("bytes decryption failed (wrong key or tampered ciphertext)");
  }
  return { plaintext: plaintextBytes, senderPublicKey };
}

/** Encrypt a response with the request's shared key and a fresh directional GCM nonce. */
export function encryptResponse(
  body: unknown,
  consumerPublicKey: Uint8Array,
  operatorPrivateKey: Uint8Array
): EncryptedEnvelope {
  const sessionKey = deriveSessionKey(operatorPrivateKey, consumerPublicKey);
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(body), "utf8");
  const cipher = createCipheriv("aes-256-gcm", sessionKey, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENCRYPTION_VERSION,
    alg: ENCRYPTION_ALG,
    // Echo the announced operator key for wire symmetry and future per-request ratcheting.
    epk: bufToHex(x25519.getPublicKey(operatorPrivateKey)),
    nonce: bufToHex(nonce),
    ct: bufToHex(Buffer.concat([ct, tag])),
  };
}


export interface EphemeralKeyPair {
  /** 32-byte X25519 public key, hex (no 0x). Sent as the envelope `epk`. */
  publicKeyHex: string;
  /** 32-byte X25519 private key — held in memory for one request. */
  privateKey: Uint8Array;
}

/** Fresh per-request ephemeral X25519 keypair (consumer side). */
export function generateEphemeralKeypair(): EphemeralKeyPair {
  const privateKey = x25519.utils.randomPrivateKey();
  return { publicKeyHex: bufToHex(x25519.getPublicKey(privateKey)), privateKey };
}

/** Parse a 32-byte hex X25519 pubkey (e.g. an operator's announced key). */
export function hexToPubkey(hex: string): Uint8Array {
  const buf = hexToBuf(hex);
  if (buf.length !== 32) throw new Error(`operator pubkey must be 32 bytes, got ${buf.length}`);
  return buf;
}

/** Encrypt to the announced X25519 key while leaving routing fields outside the envelope. */
export function encryptRequest(
  body: unknown,
  operatorPublicKey: Uint8Array,
  ephemeral: EphemeralKeyPair
): EncryptedEnvelope {
  const sessionKey = deriveSessionKey(ephemeral.privateKey, operatorPublicKey);
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(body), "utf8");
  const cipher = createCipheriv("aes-256-gcm", sessionKey, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENCRYPTION_VERSION,
    alg: ENCRYPTION_ALG,
    epk: ephemeral.publicKeyHex,
    nonce: bufToHex(nonce),
    ct: bufToHex(Buffer.concat([ct, tag])),
  };
}

/** Encrypt raw bytes with the same X25519/HKDF/AES-GCM construction as v1, in a v2 base64 wire format. */
export function encryptBytes(
  bytes: Uint8Array | Buffer,
  peerPublicKey: Uint8Array,
  sender: EphemeralKeyPair | OperatorKeyPair
): BytesEncryptedEnvelope {
  const sessionKey = deriveSessionKey(sender.privateKey, peerPublicKey);
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(bytes);
  const cipher = createCipheriv("aes-256-gcm", sessionKey, nonce);
  cipher.setAAD(V2_AAD);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENCRYPTION_BYTES_VERSION,
    alg: ENCRYPTION_ALG,
    epk: sender.publicKeyHex,
    nonce: bufToHex(nonce),
    ct: bufToBase64(Buffer.concat([ct, tag])),
  };
}

/** Decrypt and parse an operator response; authentication failure throws. */
export function decryptResponse(
  envelope: EncryptedEnvelope,
  operatorPublicKey: Uint8Array,
  ephemeralPrivateKey: Uint8Array
): unknown {
  if (envelope.v !== ENCRYPTION_VERSION || envelope.alg !== ENCRYPTION_ALG) {
    throw new Error(`unsupported envelope: v=${envelope.v} alg=${envelope.alg}`);
  }
  const sessionKey = deriveSessionKey(ephemeralPrivateKey, operatorPublicKey);
  const nonce = hexToBuf(envelope.nonce);
  const sealed = hexToBuf(envelope.ct);
  if (sealed.length < 16) throw new Error("ct too short to contain GCM tag");
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", sessionKey, nonce);
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error("response decryption failed (wrong key or tampered ciphertext)");
  }
  return JSON.parse(pt.toString("utf8"));
}

function bufToHex(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString("hex");
}

function hexToBuf(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

function bufToBase64(buf: Uint8Array | Buffer): string {
  return Buffer.from(buf).toString("base64");
}

function base64ToBuf(b64: string): Buffer {
  if (b64.includes("\n") || b64.includes("\r")) {
    throw new Error("base64 ciphertext must be unwrapped");
  }
  if (b64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error("malformed base64 ciphertext");
  }
  return Buffer.from(b64, "base64");
}
