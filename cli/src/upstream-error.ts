export type UpstreamProviderErrorCode =
  | "credit_exhausted"
  | "operator_auth_failure"
  | "provider_error";

export interface NormalizedUpstreamError {
  status: number;
  data: unknown;
}

const CREDIT_EXHAUSTED_RE =
  /credit|quota|billing|purchase more credits|insufficient[_ -]?quota|insufficient[^.]{0,80}balance|account[^.]{0,80}balance/i;

// Some providers report exhausted credit as 400; match only unambiguous account-level wording.
export const CREDIT_EXHAUSTED_400_RE =
  /credit[^.]{0,80}balance[^.]{0,80}too low|balance[^.]{0,80}too low|purchase more credits|out of credits|insufficient[_ -]?quota/i;

function upstreamErrorText(parsed: unknown): string {
  const parts: string[] = [];
  if (parsed && typeof parsed === "object") {
    const top = parsed as Record<string, unknown>;
    if (typeof top.message === "string") parts.push(top.message);
    const err = top.error;
    if (typeof err === "string") parts.push(err);
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      for (const key of ["message", "type", "code"]) {
        if (typeof e[key] === "string") parts.push(e[key] as string);
      }
    }
  } else if (typeof parsed === "string") {
    parts.push(parsed);
  }
  return parts.join(" ");
}

export function classifyUpstreamProviderError(
  status: number,
  parsed: unknown
): UpstreamProviderErrorCode | null {
  if (status === 401 || status === 403) return "operator_auth_failure";
  if (status === 402) return "credit_exhausted";
  if (status === 400 && CREDIT_EXHAUSTED_400_RE.test(upstreamErrorText(parsed))) {
    return "credit_exhausted";
  }
  if (status === 429 && CREDIT_EXHAUSTED_RE.test(upstreamErrorText(parsed))) {
    return "credit_exhausted";
  }
  if (status === 429 || status >= 500) return "provider_error";
  return null;
}

function providerErrorMessage(code: UpstreamProviderErrorCode): string {
  if (code === "credit_exhausted") {
    return "The selected operator's upstream provider account cannot serve this request right now.";
  }
  if (code === "operator_auth_failure") {
    return "The selected operator's upstream provider credentials are not working right now.";
  }
  return "The selected operator's upstream provider is temporarily unavailable.";
}

export function upstreamProviderErrorResponse(
  code: UpstreamProviderErrorCode
): NormalizedUpstreamError {
  return {
    status: 502,
    data: {
      error: {
        message: providerErrorMessage(code),
        type: "upstream_provider_error",
        code,
      },
    },
  };
}

export function transientUpstreamErrorResponse(): NormalizedUpstreamError {
  return {
    status: 504,
    data: {
      error: {
        message: "The selected operator's upstream provider did not respond. Retrying may route to a healthy operator.",
        type: "upstream_provider_error",
        code: "provider_error",
      },
    },
  };
}

export function operatorErrorResponse(): NormalizedUpstreamError {
  return {
    status: 502,
    data: {
      error: {
        message: "The selected operator could not complete this request right now.",
        type: "operator_error",
        code: "operator_error",
      },
    },
  };
}

/** Retain bounded OpenAI `message`/`type`/`code` fields for consumer-safe errors. */
function sanitizeConsumerUpstreamError(parsed: unknown, status: number): unknown {
  const src = (parsed as { error?: unknown })?.error;
  const safe: { message: string; type?: string; code?: string } = {
    message: `upstream provider returned ${status}`,
  };
  if (src && typeof src === "object") {
    const e = src as Record<string, unknown>;
    if (typeof e.message === "string" && e.message.length > 0 && e.message.length < 500) {
      safe.message = e.message;
    }
    if (typeof e.type === "string" && e.type.length < 100) safe.type = e.type;
    if (typeof e.code === "string" && e.code.length < 100) safe.code = e.code;
  } else if (typeof (parsed as { message?: unknown })?.message === "string") {
    const m = (parsed as { message: string }).message;
    if (m.length > 0 && m.length < 500) safe.message = m;
  }
  return { error: safe };
}

export function normalizeUpstreamError(parsed: unknown, status: number): NormalizedUpstreamError {
  const code = classifyUpstreamProviderError(status, parsed);
  if (code) return upstreamProviderErrorResponse(code);
  return { status, data: sanitizeConsumerUpstreamError(parsed, status) };
}
