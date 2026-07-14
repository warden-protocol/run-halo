import test from "node:test";
import assert from "node:assert/strict";
import { decryptRequiredOperatorE2eResponse } from "./commands/consume";
import {
  encryptResponse,
  generateEphemeralKeypair,
  generateOperatorKeypair,
  hexToPubkey,
} from "./encryption";

test("decryptRequiredOperatorE2eResponse accepts only a decryptable operator envelope", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const expected = { choices: [{ message: { content: "halo-dev-ok" } }] };
  const envelope = encryptResponse(
    expected,
    hexToPubkey(consumer.publicKeyHex),
    operator.privateKey
  );

  assert.deepEqual(
    JSON.parse(
      decryptRequiredOperatorE2eResponse(
        JSON.stringify({ _enc: envelope }),
        hexToPubkey(operator.publicKeyHex),
        consumer.privateKey
      )
    ),
    expected
  );
});

test("decryptRequiredOperatorE2eResponse rejects plaintext and malformed success bodies", () => {
  const operator = generateOperatorKeypair();
  const consumer = generateEphemeralKeypair();
  const decrypt = (body: unknown): string =>
    decryptRequiredOperatorE2eResponse(
      JSON.stringify(body),
      hexToPubkey(operator.publicKeyHex),
      consumer.privateKey
    );

  assert.throws(
    () => decrypt({ choices: [{ message: { content: "plaintext" } }] }),
    /not an envelope-only encrypted payload/
  );
  assert.throws(
    () => decrypt({ _enc: { v: 2, alg: "wrong" } }),
    /not an envelope-only encrypted payload/
  );
  const validEnvelope = encryptResponse(
    { choices: [{ message: { content: "encrypted" } }] },
    hexToPubkey(consumer.publicKeyHex),
    operator.privateKey
  );
  assert.throws(
    () => decrypt({ _enc: validEnvelope, choices: [{ message: { content: "plaintext leak" } }] }),
    /not an envelope-only encrypted payload/
  );
  assert.throws(
    () => decrypt({ _enc: { ...validEnvelope, choices: [{ message: { content: "nested leak" } }] } }),
    /not an envelope-only encrypted payload/
  );
});
