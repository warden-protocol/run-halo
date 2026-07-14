import { Wallet, HDNodeWallet } from "ethers";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";

export async function generateAndEncrypt(passphrase: string): Promise<{
  address: string;
  encryptedJson: string;
  privateKey: string;
}> {
  const w = Wallet.createRandom();
  const encryptedJson = await w.encrypt(passphrase);
  return { address: w.address, encryptedJson, privateKey: w.privateKey };
}

export async function importAndEncrypt(
  privateKey: string,
  passphrase: string
): Promise<{ address: string; encryptedJson: string }> {
  const w = new Wallet(privateKey);
  const encryptedJson = await w.encrypt(passphrase);
  return { address: w.address, encryptedJson };
}

export function writeKeystore(keystorePath: string, encryptedJson: string): void {
  const abs = resolve(keystorePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, encryptedJson, { mode: 0o600 });
  chmodSync(abs, 0o600);
}

export async function loadWallet(
  keystorePath: string,
  passphrase: string
): Promise<Wallet | HDNodeWallet> {
  const abs = resolve(keystorePath);
  if (!existsSync(abs)) throw new Error(`Keystore not found at ${abs}`);
  const json = readFileSync(abs, "utf-8");
  // Generated mnemonic keystores decrypt to HDNodeWallet; both wallet classes are valid BaseWallet signers.
  return Wallet.fromEncryptedJson(json, passphrase);
}
