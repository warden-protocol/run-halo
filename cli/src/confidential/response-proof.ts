import { ethers } from "ethers";

export function verifyTeeSignature(sigB64: string, attestedSigner: string): boolean {
  try {
    const proof = JSON.parse(Buffer.from(sigB64, "base64").toString("utf-8")) as { text: string; signature: string; signing_address: string };
    const recovered = ethers.verifyMessage(proof.text, proof.signature);
    return recovered.toLowerCase() === proof.signing_address.toLowerCase() && recovered.toLowerCase() === attestedSigner.toLowerCase();
  } catch { return false; }
}
