import { isTeeProviderSlug } from "../providers";

export interface TeeSignatureOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export function shouldFetchTeeProof(providerSlug: string, headers: Record<string, string | undefined>): boolean {
  return isTeeProviderSlug(providerSlug) && (typeof headers["x-client-pub-key"] === "string" || typeof headers["x-encryption-version"] === "string");
}

export async function fetchTeeSignature(
  baseUrl: string,
  apiKey: string | undefined,
  chatId: string,
  model: string,
  readBody: (response: Response, signal: AbortSignal, maxBodyBytes: number) => Promise<string>,
  options: TeeSignatureOptions = {}
): Promise<string | null> {
  if (!apiKey || !chatId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    if (!response.ok) return null;
    const text = await readBody(response, controller.signal, options.maxBodyBytes ?? 256 * 1024);
    return Buffer.from(text, "utf-8").toString("base64");
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function fetchTeeSignatureForRequest(params: {
  providerSlug: string;
  baseUrl: string;
  apiKey: string | undefined;
  chatId: string;
  model: string;
  headers: Record<string, string | undefined>;
  readBody: (response: Response, signal: AbortSignal, maxBodyBytes: number) => Promise<string>;
  options?: TeeSignatureOptions;
}): Promise<string | null> {
  if (!shouldFetchTeeProof(params.providerSlug, params.headers)) return null;
  return fetchTeeSignature(params.baseUrl, params.apiKey, params.chatId, params.model, params.readBody, params.options);
}
