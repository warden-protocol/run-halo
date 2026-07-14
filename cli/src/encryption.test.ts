import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import {
  authenticatedOperatorPubkey,
  decryptBytes,
  decryptRequest,
  decryptResponse,
  encryptBytes,
  encryptRequest,
  encryptResponse,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from "./encryption";

function patternedBytes(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + 17) & 0xff;
  return out;
}

test("v1 text envelope round-trips unchanged", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const requestBody = { prompt: "hello", nested: { n: 42 }, ok: true };

  const requestEnvelope = encryptRequest(requestBody, hexToPubkey(operator.publicKeyHex), consumer);
  assert.equal(requestEnvelope.v, 1);
  assert.equal(requestEnvelope.alg, "x25519-aes256gcm");
  assert.match(requestEnvelope.epk, /^[0-9a-f]+$/);
  assert.match(requestEnvelope.nonce, /^[0-9a-f]+$/);
  assert.match(requestEnvelope.ct, /^[0-9a-f]+$/);
  assert.equal(isEncryptedEnvelope(requestEnvelope), true);

  const { plaintext, consumerPublicKey } = decryptRequest(requestEnvelope, operator.privateKey);
  assert.deepEqual(plaintext, requestBody);

  const responseBody = { choices: [{ delta: "world" }] };
  const responseEnvelope = encryptResponse(responseBody, consumerPublicKey, operator.privateKey);
  assert.equal(responseEnvelope.v, 1);
  assert.match(responseEnvelope.ct, /^[0-9a-f]+$/);
  assert.deepEqual(decryptResponse(responseEnvelope, hexToPubkey(operator.publicKeyHex), consumer.privateKey), responseBody);
});

test("v2 byte envelope round-trips exact bytes in request and response directions", () => {
  const operator = generateOperatorKeypair();
  const operatorPublicKey = hexToPubkey(operator.publicKeyHex);

  for (const bytes of [Buffer.alloc(0), Buffer.from([0, 1, 2, 255]), patternedBytes(2 * 1024 * 1024)]) {
    const consumer = generateEphemeralKeypair();
    const requestEnvelope = encryptBytes(bytes, operatorPublicKey, consumer);

    assert.equal(requestEnvelope.v, 2);
    assert.equal(requestEnvelope.alg, "x25519-aes256gcm");
    assert.equal(isEncryptedEnvelope(requestEnvelope), true);
    assert.doesNotMatch(requestEnvelope.ct, /[\r\n]/);

    const requestPlaintext = decryptBytes(requestEnvelope, operator.privateKey);
    assert.deepEqual(requestPlaintext.plaintext, bytes);
    assert.deepEqual(Buffer.from(requestPlaintext.senderPublicKey), Buffer.from(consumer.publicKeyHex, "hex"));

    const responseEnvelope = encryptBytes(bytes, requestPlaintext.senderPublicKey, operator);
    assert.equal(responseEnvelope.v, 2);
    assert.doesNotMatch(responseEnvelope.ct, /[\r\n]/);

    const responsePlaintext = decryptBytes(responseEnvelope, consumer.privateKey, operatorPublicKey);
    assert.deepEqual(responsePlaintext.plaintext, bytes);
    assert.deepEqual(Buffer.from(responsePlaintext.senderPublicKey), Buffer.from(operator.publicKeyHex, "hex"));
  }
});

test("v1 and v2 decoders reject the other version", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const operatorPublicKey = hexToPubkey(operator.publicKeyHex);

  const textEnvelope = encryptRequest({ prompt: "text" }, operatorPublicKey, consumer);
  const bytesEnvelope = encryptBytes(Buffer.from("bytes"), operatorPublicKey, consumer);

  assert.throws(() => decryptBytes(textEnvelope, operator.privateKey), /unsupported bytes envelope/);
  assert.throws(() => decryptRequest(bytesEnvelope, operator.privateKey), /unsupported envelope/);
  assert.throws(() => decryptResponse(bytesEnvelope, operatorPublicKey, consumer.privateKey), /unsupported envelope/);
});

test("v2 byte envelope fails closed on unknown shape and tampering", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const envelope = encryptBytes(Buffer.from("sensitive bytes"), hexToPubkey(operator.publicKeyHex), consumer);

  assert.equal(isEncryptedEnvelope({ ...envelope, v: 3 }), false);
  assert.equal(isEncryptedEnvelope({ ...envelope, alg: "x25519-aes256gcm-b64" }), false);

  const malformed = { ...envelope, ct: `${envelope.ct}\n` };
  assert.throws(() => decryptBytes(malformed as EncryptedEnvelope, operator.privateKey), /unwrapped/);

  const tampered = { ...envelope, ct: `${envelope.ct.slice(0, -2)}AA` };
  assert.throws(() => decryptBytes(tampered, operator.privateKey), /bytes decryption failed|malformed base64/);
});

test("v2 byte response decryption can pin the expected sender key", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const attacker = generateOperatorKeypair();
  const envelope = encryptBytes(Buffer.from("operator bytes"), Buffer.from(consumer.publicKeyHex, "hex"), operator);

  assert.throws(
    () => decryptBytes(envelope, consumer.privateKey, hexToPubkey(attacker.publicKeyHex)),
    /unexpected bytes envelope sender public key/
  );

  const decrypted = decryptBytes(envelope, consumer.privateKey, hexToPubkey(operator.publicKeyHex));
  assert.deepEqual(decrypted.plaintext, Buffer.from("operator bytes"));
});

test("authenticatedOperatorPubkey accepts the operator's normalized key binding", async () => {
  const operator = Wallet.createRandom();
  const pubkey = "AB".repeat(32);
  const normalized = pubkey.toLowerCase();
  const attestation = await operator.signMessage(
    `halo-pubkey:${operator.address.toLowerCase()}:${normalized}`
  );

  assert.equal(
    authenticatedOperatorPubkey(operator.address, `0x${pubkey}`, attestation),
    normalized
  );
});

test("authenticatedOperatorPubkey rejects missing, malformed, and substituted bindings", async () => {
  const operator = Wallet.createRandom();
  const other = Wallet.createRandom();
  const pubkey = "11".repeat(32);
  const attestation = await operator.signMessage(
    `halo-pubkey:${operator.address.toLowerCase()}:${pubkey}`
  );

  assert.equal(authenticatedOperatorPubkey(operator.address, pubkey, null), null);
  assert.equal(authenticatedOperatorPubkey(operator.address, "not-a-key", attestation), null);
  assert.equal(authenticatedOperatorPubkey(other.address, pubkey, attestation), null);
});
