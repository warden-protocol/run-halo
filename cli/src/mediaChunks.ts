import type { BytesEncryptedEnvelope } from "./encryption";

export const MEDIA_BUCKET_BYTES = [
  512 * 1024,
  1024 * 1024,
  2 * 1024 * 1024,
  4 * 1024 * 1024,
  8 * 1024 * 1024,
] as const;
export const MEDIA_GCM_TAG_BYTES = 16;
export const MEDIA_LENGTH_TRAILER_BYTES = 8;
export const MEDIA_RELAY_WS_MAX_MESSAGE_BYTES = 256 * 1024;
/**
 * Bytes reserved per frame so the relay accepts it. The relay does not measure
 * the raw ciphertext — it re-serializes each frame into a JSON envelope
 * (requestId, seq/total, epk, nonce, mime, …) and rejects the stream if that
 * payload exceeds MAX_MEDIA_CHUNK_BYTES = MAX_MESSAGE_BYTES - 4096 (see
 * relay/src/streamGuards.ts). So the headroom MUST cover both the relay's 4096
 * per-message reserve AND the JSON wrapper it adds. The old 1024 left the
 * ciphertext alone (261120) larger than the relay's 258048 cap, so the relay
 * aborted every image on the first frame with reason "byte-cap". 8192 clears
 * the 4096 reserve with ample room for the wrapper.
 */
export const MEDIA_FRAME_JSON_HEADROOM_BYTES = 8192;
export const MEDIA_FRAME_BYTES = MEDIA_RELAY_WS_MAX_MESSAGE_BYTES - MEDIA_FRAME_JSON_HEADROOM_BYTES;
export const MEDIA_FRAME_PAD_CHAR = "A";

const MEDIA_PAYLOAD_MAGIC = Buffer.from("HALOIMG1", "ascii");

export interface MediaChunkFrame {
  type: "media-chunk";
  requestId: string;
  /** Zero-based image ordinal within this request. */
  imageIndex?: number;
  /** Total images delivered for this request. */
  imageCount?: number;
  seq: number;
  total: number;
  eof: boolean;
  ciphertext: string;
  mime?: string;
  v?: number;
  alg?: string;
  epk?: string;
  nonce?: string;
}

/**
 * Private media plaintext layout, before padding/encryption:
 *   8 bytes  magic "HALOIMG1"
 *   2 bytes  unsigned big-endian UTF-8 mime length
 *   N bytes  mime string, e.g. "image/png"
 *   M bytes  media bytes
 *
 * Padding layout, before AES-GCM:
 *   original bytes | zero padding | 8-byte unsigned big-endian original length
 *
 * The padded plaintext length is bucket - 16 so ciphertext||GCM-tag is exactly
 * one bucket on the wire. The trailer is intentionally at the end so trimming
 * does not need to scan padding.
 */
export function packMediaPlaintext(bytes: Uint8Array | Buffer, mime: string): Buffer {
  const mimeBytes = Buffer.from(mime, "utf8");
  if (mimeBytes.length === 0 || mimeBytes.length > 0xffff) {
    throw new Error("media mime must be 1..65535 UTF-8 bytes");
  }
  const out = Buffer.alloc(MEDIA_PAYLOAD_MAGIC.length + 2 + mimeBytes.length + bytes.length);
  MEDIA_PAYLOAD_MAGIC.copy(out, 0);
  out.writeUInt16BE(mimeBytes.length, MEDIA_PAYLOAD_MAGIC.length);
  mimeBytes.copy(out, MEDIA_PAYLOAD_MAGIC.length + 2);
  Buffer.from(bytes).copy(out, MEDIA_PAYLOAD_MAGIC.length + 2 + mimeBytes.length);
  return out;
}

export function unpackMediaPlaintext(plaintext: Uint8Array | Buffer): { mime: string; bytes: Buffer } {
  const buf = Buffer.from(plaintext);
  const minLen = MEDIA_PAYLOAD_MAGIC.length + 2;
  if (buf.length < minLen || !buf.subarray(0, MEDIA_PAYLOAD_MAGIC.length).equals(MEDIA_PAYLOAD_MAGIC)) {
    throw new Error("invalid media plaintext header");
  }
  const mimeLen = buf.readUInt16BE(MEDIA_PAYLOAD_MAGIC.length);
  const bytesOffset = minLen + mimeLen;
  if (mimeLen === 0 || bytesOffset > buf.length) {
    throw new Error("invalid media mime length");
  }
  return {
    mime: buf.subarray(minLen, bytesOffset).toString("utf8"),
    bytes: buf.subarray(bytesOffset),
  };
}

export function mediaBucketForPlaintextLength(length: number): number {
  for (const bucket of MEDIA_BUCKET_BYTES) {
    if (length <= bucket - MEDIA_GCM_TAG_BYTES - MEDIA_LENGTH_TRAILER_BYTES) {
      return bucket;
    }
  }
  throw new Error(`media payload exceeds maximum bucket (${MEDIA_BUCKET_BYTES.at(-1)} bytes)`);
}

export function padToBucket(bytes: Uint8Array | Buffer): Buffer {
  const original = Buffer.from(bytes);
  const bucket = mediaBucketForPlaintextLength(original.length);
  const paddedPlaintextBytes = bucket - MEDIA_GCM_TAG_BYTES;
  const out = Buffer.alloc(paddedPlaintextBytes);
  original.copy(out, 0);
  out.writeBigUInt64BE(BigInt(original.length), paddedPlaintextBytes - MEDIA_LENGTH_TRAILER_BYTES);
  return out;
}

export function trimPadding(padded: Uint8Array | Buffer): Buffer {
  const buf = Buffer.from(padded);
  const bucket = MEDIA_BUCKET_BYTES.find((b) => b - MEDIA_GCM_TAG_BYTES === buf.length);
  if (!bucket) {
    throw new Error("padded media length does not match a known bucket");
  }
  const originalLength = Number(buf.readBigUInt64BE(buf.length - MEDIA_LENGTH_TRAILER_BYTES));
  const maxOriginal = buf.length - MEDIA_LENGTH_TRAILER_BYTES;
  if (!Number.isSafeInteger(originalLength) || originalLength > maxOriginal) {
    throw new Error("invalid media padding trailer");
  }
  for (let i = originalLength; i < maxOriginal; i++) {
    if (buf[i] !== 0) throw new Error("non-zero media padding");
  }
  return buf.subarray(0, originalLength);
}

export function chunkMediaEnvelope(
  requestId: string,
  envelope: BytesEncryptedEnvelope,
  options: { frameBytes?: number; mime?: string; imageIndex?: number; imageCount?: number } = {}
): MediaChunkFrame[] {
  const frameBytes = options.frameBytes ?? MEDIA_FRAME_BYTES;
  if (frameBytes <= 0 || !Number.isInteger(frameBytes)) {
    throw new Error("media frame size must be a positive integer");
  }
  const imageIndex = options.imageIndex ?? 0;
  const imageCount = options.imageCount ?? 1;
  if (
    !Number.isInteger(imageIndex) ||
    !Number.isInteger(imageCount) ||
    imageIndex < 0 ||
    imageCount < 1 ||
    imageIndex >= imageCount
  ) {
    throw new Error("media image index/count must identify one image in the request");
  }
  const sealedBytes = decodedBase64Length(envelope.ct);
  if (!MEDIA_BUCKET_BYTES.includes(sealedBytes as (typeof MEDIA_BUCKET_BYTES)[number])) {
    throw new Error("media ciphertext length does not match a padded bucket");
  }
  const expectedCtLength = base64EncodedLength(sealedBytes);
  if (envelope.ct.length !== expectedCtLength) {
    throw new Error("media ciphertext is not canonical bucket base64");
  }
  const total = Math.ceil(expectedCtLength / frameBytes);
  const normalized = envelope.ct.padEnd(total * frameBytes, MEDIA_FRAME_PAD_CHAR);
  const frames: MediaChunkFrame[] = [];
  for (let seq = 0; seq < total; seq++) {
    frames.push({
      type: "media-chunk",
      requestId,
      imageIndex,
      imageCount,
      seq,
      total,
      eof: seq === total - 1,
      ciphertext: normalized.slice(seq * frameBytes, (seq + 1) * frameBytes),
      ...(options.mime !== undefined ? { mime: options.mime } : {}),
      ...(seq === 0
        ? { v: envelope.v, alg: envelope.alg, epk: envelope.epk, nonce: envelope.nonce }
        : {}),
    });
  }
  return frames;
}

export function reassembleMediaEnvelope(frames: MediaChunkFrame[]): BytesEncryptedEnvelope {
  if (frames.length === 0) throw new Error("no media frames to reassemble");
  const sorted = [...frames].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  if (first.seq !== 0 || first.v !== 2 || !first.alg || !first.epk || !first.nonce) {
    throw new Error("media header frame missing crypto fields");
  }
  const firstImageIndex = first.imageIndex ?? 0;
  const firstImageCount = first.imageCount ?? 1;
  if (first.total !== sorted.length) {
    throw new Error("media frame count mismatch");
  }
  const frameBytes = sorted[0].ciphertext.length;
  const bucket = mediaBucketForFrameTotal(first.total, frameBytes);
  const ctLength = base64EncodedLength(bucket);
  for (let i = 0; i < sorted.length; i++) {
    const frame = sorted[i];
    if (
      frame.requestId !== first.requestId ||
      (frame.imageIndex ?? 0) !== firstImageIndex ||
      (frame.imageCount ?? 1) !== firstImageCount ||
      frame.seq !== i ||
      frame.total !== first.total ||
      frame.eof !== (i === sorted.length - 1) ||
      frame.ciphertext.length !== frameBytes ||
      !isFrameCiphertextSafe(frame.ciphertext)
    ) {
      throw new Error("invalid media frame sequence");
    }
  }
  return {
    v: first.v as 2,
    alg: first.alg as BytesEncryptedEnvelope["alg"],
    epk: first.epk,
    nonce: first.nonce,
    ct: sorted.map((f) => f.ciphertext).join("").slice(0, ctLength),
  };
}

function mediaBucketForFrameTotal(total: number, frameBytes: number): number {
  const matches = MEDIA_BUCKET_BYTES.filter(
    (bucket) => Math.ceil(base64EncodedLength(bucket) / frameBytes) === total
  );
  if (matches.length !== 1) {
    throw new Error("media frame total does not identify a known bucket");
  }
  return matches[0];
}

export function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function decodedBase64Length(b64: string): number {
  if (!isUnwrappedBase64ish(b64) || b64.length % 4 !== 0) {
    throw new Error("malformed media base64");
  }
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

function isUnwrappedBase64ish(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && !value.includes("\n") && !value.includes("\r");
}

function isFrameCiphertextSafe(value: string): boolean {
  return /^[A-Za-z0-9+/=]*$/.test(value) && !value.includes("\n") && !value.includes("\r");
}
