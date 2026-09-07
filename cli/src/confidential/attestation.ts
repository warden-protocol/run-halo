import { type ModelAttestation } from "./types";

const ATTEST_TIMEOUT_MS = 20_000;
const ATTEST_RETRIES = 2;
const ATTEST_RETRY_BASE_DELAY_MS = 600;
const verifiedSignerCache = new Map<string, { signer: string; at: number }>();
const ATTEST_VERIFY_TTL_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTransientAttestErr(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/invalid|mismatch|forged|does not|not verified|tcb|expired certificate|signature/.test(message)) return /collateral|timeout|timed out|network|fetch failed/.test(message);
  return /collateral|timeout|timed out|econn|enotfound|eai_again|fetch failed|socket hang up|network|502|503|504|temporarily/.test(message);
}

async function withAttestRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ATTEST_RETRIES; attempt++) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (attempt >= ATTEST_RETRIES || !isTransientAttestErr(error)) break;
      await sleep(ATTEST_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed: ${String(lastError)}`);
}

function reportUrl(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
}

export async function fetchModelAttestation(baseUrl: string, model: string): Promise<ModelAttestation> {
  return withAttestRetry("attestation report", async () => {
    const response = await fetch(reportUrl(baseUrl, model), { signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`attestation report ${response.status}`);
    const report = await response.json() as { model_attestations?: Array<{ signing_public_key?: string; signing_address?: string }> };
    const attestation = (report.model_attestations || []).find((entry) => entry.signing_public_key && entry.signing_address);
    if (!attestation) throw new Error("no model attestation with a signing key");
    return { signingPublicKey: attestation.signing_public_key!, signingAddress: attestation.signing_address! };
  });
}

export async function verifyAttestationHardware(baseUrl: string, model: string): Promise<string> {
  return withAttestRetry("hardware attestation", async () => {
    const response = await fetch(reportUrl(baseUrl, model), { signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`attestation report ${response.status}`);
    const report = await response.json() as { model_attestations?: Array<{ signing_address?: string; intel_quote?: string; nvidia_payload?: string; request_nonce?: string }> };
    const attestation = (report.model_attestations || []).find((entry) => entry.signing_address && entry.intel_quote);
    if (!attestation) throw new Error("attestation report missing intel_quote / signing_address");
    const { verifyModelAttestation, assertModelAttestationVerified } = await import("nearai-cloud-verifier");
    const verified = await verifyModelAttestation(attestation as Parameters<typeof verifyModelAttestation>[0]);
    assertModelAttestationVerified(verified as Parameters<typeof assertModelAttestationVerified>[0], attestation.request_nonce || "", attestation.signing_address || "");
    return attestation.signing_address!.toLowerCase();
  });
}

export async function verifiedSignerForModel(baseUrl: string, model: string): Promise<string> {
  const key = `${baseUrl.replace(/\/+$/, "")}::${model}`;
  const cached = verifiedSignerCache.get(key);
  if (cached && Date.now() - cached.at < ATTEST_VERIFY_TTL_MS) return cached.signer;
  const signer = await verifyAttestationHardware(baseUrl, model);
  verifiedSignerCache.set(key, { signer, at: Date.now() });
  return signer;
}
