import { test } from "node:test";
import assert from "node:assert/strict";
import vector from "../../docs-dev/IMAGE_MODE_A3_TEST_VECTOR.json";
import {
  MEDIA_BUCKET_BYTES,
  MEDIA_FRAME_BYTES,
  MEDIA_RELAY_WS_MAX_MESSAGE_BYTES,
  base64EncodedLength,
  chunkMediaEnvelope,
  packMediaPlaintext,
  padToBucket,
  reassembleMediaEnvelope,
  trimPadding,
  unpackMediaPlaintext,
} from "./mediaChunks";
import {
  decryptBytes,
  encryptBytes,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
} from "./encryption";

function patternedBytes(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < out.length; i++) out[i] = (i * 37 + 23) & 0xff;
  return out;
}

test("shared A3 vector pins private mime header and padding trailer layout", () => {
  const payload = Buffer.from(vector.payloadHex, "hex");
  const packed = packMediaPlaintext(payload, vector.mime);
  assert.equal(packed.toString("hex"), vector.packedPlaintextHex);
  assert.equal(packed.length, vector.packedPlaintextLength);

  const padded = padToBucket(packed);
  assert.equal(padded.length, vector.paddedPlaintextBytes);
  assert.equal(padded.subarray(-8).toString("hex"), vector.trailerHex);
  assert.deepEqual(trimPadding(padded), packed);
  assert.deepEqual(unpackMediaPlaintext(trimPadding(padded)), {
    mime: vector.mime,
    bytes: payload,
  });
  assert.equal(base64EncodedLength(vector.firstBucketBytes), vector.base64CiphertextLength);
  assert.equal(MEDIA_RELAY_WS_MAX_MESSAGE_BYTES, vector.relayWsMaxMessageBytes);
  assert.equal(MEDIA_FRAME_BYTES, vector.mediaFrameBytes);
  assert.equal(Math.ceil(vector.base64CiphertextLength / MEDIA_FRAME_BYTES), vector.normalizedFrameCount);
});

test("padToBucket and trimPadding round-trip across bucket boundaries", () => {
  const sizes = [
    0,
    1,
    MEDIA_BUCKET_BYTES[0] - 16 - 8 - 1,
    MEDIA_BUCKET_BYTES[0] - 16 - 8,
    MEDIA_BUCKET_BYTES[0] - 16 - 8 + 1,
    MEDIA_BUCKET_BYTES[1] - 16 - 8,
  ];
  for (const size of sizes) {
    const bytes = patternedBytes(size);
    const padded = padToBucket(bytes);
    const expectedBucket = MEDIA_BUCKET_BYTES.find((bucket) => size <= bucket - 16 - 8);
    assert.equal(padded.length, expectedBucket! - 16);
    assert.deepEqual(trimPadding(padded), bytes);
  }

  assert.throws(() => padToBucket(Buffer.alloc(MEDIA_BUCKET_BYTES.at(-1)! - 16 - 8 + 1)), /exceeds/);
});

test("media chunk helpers normalize frame count and round-trip encrypted bytes", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const requestId = "req-media-1";
  const raw = patternedBytes(700_000);
  const packed = packMediaPlaintext(raw, "image/webp");
  const padded = padToBucket(packed);
  const envelope = encryptBytes(padded, hexToPubkey(operator.publicKeyHex), consumer);
  const frames = chunkMediaEnvelope(requestId, envelope);

  assert.equal(frames.length, 6, "700KB payload belongs to the 1MiB bucket");
  assert.equal(frames[0].v, 2);
  assert.equal(frames[0].epk, envelope.epk);
  assert.equal(frames.at(-1)!.eof, true);
  for (const frame of frames) {
    assert.equal(frame.type, "media-chunk");
    assert.equal(frame.total, frames.length);
    assert.equal(frame.ciphertext.length, MEDIA_FRAME_BYTES);
    assert.doesNotMatch(frame.ciphertext, /[\r\n]/);
  }
  assert.equal(frames[1].epk, undefined, "crypto header is only carried on seq 0");

  const reassembled = reassembleMediaEnvelope(frames);
  assert.deepEqual(reassembled, envelope);
  const decrypted = decryptBytes(reassembled, operator.privateKey);
  const unpacked = unpackMediaPlaintext(trimPadding(decrypted.plaintext));
  assert.equal(unpacked.mime, "image/webp");
  assert.deepEqual(unpacked.bytes, raw);
});

test("serialized media chunks stay below the relay websocket maxPayload cap", () => {
  const bucket = MEDIA_BUCKET_BYTES.at(-1)!;
  const envelope = {
    v: 2 as const,
    alg: "x25519-aes256gcm" as const,
    epk: "f".repeat(64),
    nonce: "0".repeat(24),
    ct: Buffer.alloc(bucket).toString("base64"),
  };
  const frames = chunkMediaEnvelope("00000000-0000-4000-8000-000000000000", envelope, {
    mime: "application/octet-stream",
  });

  assert.ok(frames.length > 1);
  // The relay does not cap at the raw WS maxPayload — it re-serializes each
  // frame and rejects the stream ("byte-cap") if that payload exceeds
  // MAX_MEDIA_CHUNK_BYTES = MAX_MESSAGE_BYTES - 4096 (relay/src/streamGuards.ts).
  // A frame's own JSON is a conservative upper bound (it also carries `type`,
  // which the relay drops), so assert against the effective relay cap.
  const RELAY_MEDIA_CHUNK_CAP = MEDIA_RELAY_WS_MAX_MESSAGE_BYTES - 4096;
  for (const frame of frames) {
    assert.ok(
      JSON.stringify(frame).length <= RELAY_MEDIA_CHUNK_CAP,
      `serialized frame ${frame.seq} exceeded relay media-chunk cap`
    );
  }
});

test("same bucket inputs produce identical media frame counts and wire bytes", () => {
  const operator = generateOperatorKeypair();
  const operatorPubkey = hexToPubkey(operator.publicKeyHex);
  const first = chunkMediaEnvelope(
    "req-a",
    encryptBytes(padToBucket(packMediaPlaintext(patternedBytes(100_000), "image/png")), operatorPubkey, generateEphemeralKeypair())
  );
  const second = chunkMediaEnvelope(
    "req-b",
    encryptBytes(padToBucket(packMediaPlaintext(patternedBytes(400_000), "image/png")), operatorPubkey, generateEphemeralKeypair())
  );
  assert.equal(first.length, second.length);
  assert.equal(
    first.reduce((n, frame) => n + frame.ciphertext.length, 0),
    second.reduce((n, frame) => n + frame.ciphertext.length, 0)
  );
});

test("reassembleMediaEnvelope rejects malformed media frame sequences", () => {
  const operator = generateOperatorKeypair();
  const envelope = encryptBytes(
    padToBucket(packMediaPlaintext(Buffer.from("hello"), "image/png")),
    hexToPubkey(operator.publicKeyHex),
    generateEphemeralKeypair()
  );
  const frames = chunkMediaEnvelope("req-bad", envelope);

  assert.throws(() => reassembleMediaEnvelope(frames.slice(1)), /header frame/);
  assert.throws(() => reassembleMediaEnvelope([{ ...frames[0], ciphertext: `${frames[0].ciphertext}\n` }]), /count|sequence/);
  assert.throws(() => reassembleMediaEnvelope([{ ...frames[0], total: 999 }]), /count/);
});
