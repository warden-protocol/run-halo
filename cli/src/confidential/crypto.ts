import * as crypto from "crypto";
import { ethers } from "ethers";

function hkdf(ikm: Buffer, info: string, length: number): Buffer {
  const prk = crypto.createHmac("sha256", Buffer.alloc(32)).update(ikm).digest();
  return crypto.createHmac("sha256", prk).update(Buffer.from(info)).update(Buffer.from([1])).digest().slice(0, length);
}

function sharedSecret(privKeyHex: string, peerPubPoint: Buffer): Buffer {
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privKeyHex.replace(/^0x/, ""), "hex"));
  return ecdh.computeSecret(peerPubPoint);
}

function uncompressedPub(privKey: string): string {
  return ethers.SigningKey.computePublicKey(privKey, false);
}

export function encryptToTee(plaintext: string, modelPub64: string): string {
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(modelPub64, "hex")]);
  const eph = ethers.Wallet.createRandom();
  const aesKey = hkdf(sharedSecret(eph.privateKey, point), "ecdsa_encryption", 32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf-8")), cipher.final()]);
  const ephPub = Buffer.from(uncompressedPub(eph.privateKey).slice(2), "hex");
  return Buffer.concat([ephPub, nonce, ciphertext, cipher.getAuthTag()]).toString("hex");
}

export function decryptFromTee(encHex: string, clientPrivKey: string): string {
  const buf = Buffer.from(encHex, "hex");
  const ephPub = buf.slice(0, 65);
  const nonce = buf.slice(65, 77);
  const ctTag = buf.slice(77);
  const aesKey = hkdf(sharedSecret(clientPrivKey, ephPub), "ecdsa_encryption", 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  decipher.setAuthTag(ctTag.slice(-16));
  return Buffer.concat([decipher.update(ctTag.slice(0, -16)), decipher.final()]).toString("utf-8");
}

export function newClientKey(): { privateKey: string; pubHex: string } {
  const wallet = ethers.Wallet.createRandom();
  return { privateKey: wallet.privateKey, pubHex: uncompressedPub(wallet.privateKey).slice(4) };
}
