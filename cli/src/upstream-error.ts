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

const MAX_CLASSIFICATION_FIELD_CHARS = 2_000;
const REQUEST_SCOPED_403_RE =
  /\b(?:model|region|regional|geographic(?:al)?|geo[- ]?block(?:ed|ing)?|location|moderation|content (?:policy|filter)|safety (?:policy|filter)|request (?:was )?blocked|provider policy)\b/i;
const CREDENTIAL_THEN_FAILURE_MESSAGE_RE =
  /^(?:the |your )?(?:api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?[ _-]?token|credentials?|authorization header)\b[^.]{0,120}\b(?:invalid|incorrect|expired|revoked|disabled|missing|required|rejected|refused|not (?:found|valid|recognized))\b[\s.!]*$/i;
const FAILURE_THEN_CREDENTIAL_MESSAGE_RE =
  /^(?:the )?(?:invalid|incorrect|expired|revoked|disabled|missing|required|rejected|refused|unknown)\b[^.]{0,80}\b(?:api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?[ _-]?token|credentials?|authorization header)\b[\s.!]*$/i;
const AUTHENTICATION_FAILURE_MESSAGE_RE =
  /^authentication (?:failed|required)(?: for (?:the )?(?:supplied )?credentials?)?[\s.!]*$/i;
const ACCOUNT_CREDIT_403_MESSAGE_RE =
  /^(?:your |the )?(?:account )?(?:credit balance|account balance|balance|credits?)\b[^.]{0,100}\b(?:too low|insufficient|exhausted|depleted|empty)\b[\s.!;]*$/i;

const AUTH_FAILURE_403_CODES = new Set([
  "api_key_invalid",
  "authentication_error",
  "credentials_invalid",
  "invalid_api_key",
  "invalid_api_key_error",
  "invalid_auth",
  "invalid_token",
  "token_expired",
]);
const CREDIT_EXHAUSTED_403_CODES = new Set([
  "account_balance_too_low",
  "credit_exhausted",
  "insufficient_credit",
  "insufficient_credits",
  "insufficient_quota",
]);

interface UpstreamErrorFields {
  allText: string;
  messages: string[];
  codes: string[];
}

function upstreamErrorFields(parsed: unknown): UpstreamErrorFields {
  const messages: string[] = [];
  const codes: string[] = [];
  const raw: string[] = [];
  const append = (target: string[], value: unknown): void => {
    if (typeof value === "string") {
      target.push(value.slice(0, MAX_CLASSIFICATION_FIELD_CHARS));
    }
  };
  if (parsed && typeof parsed === "object") {
    const top = parsed as Record<string, unknown>;
    append(messages, top.message);
    const err = top.error;
    append(messages, err);
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      append(messages, e.message);
      append(codes, e.type);
      append(codes, e.code);
      const metadata = e.metadata;
      if (metadata && typeof metadata === "object") {
        append(raw, (metadata as Record<string, unknown>).raw);
      }
    }
  } else if (typeof parsed === "string") {
    append(messages, parsed);
  }
  return {
    allText: [...messages, ...codes, ...raw].join(" "),
    messages,
    codes,
  };
}

function normalizedErrorCode(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function hasStructuredCode(codes: string[], allowlist: Set<string>): boolean {
  return codes.some((code) => allowlist.has(normalizedErrorCode(code)));
}

function hasExplicitAuthMessage(messages: string[]): boolean {
  return messages.some(
    (message) =>
      CREDENTIAL_THEN_FAILURE_MESSAGE_RE.test(message) ||
      FAILURE_THEN_CREDENTIAL_MESSAGE_RE.test(message) ||
      AUTHENTICATION_FAILURE_MESSAGE_RE.test(message)
  );
}

export function classifyUpstreamProviderError(
  status: number,
  parsed: unknown
): UpstreamProviderErrorCode | null {
  if (status === 401) return "operator_auth_failure";
  if (status === 402) return "credit_exhausted";
  const fields = upstreamErrorFields(parsed);
  if (status === 403) {
    if (REQUEST_SCOPED_403_RE.test(fields.allText)) return "provider_error";
    if (
      hasStructuredCode(fields.codes, CREDIT_EXHAUSTED_403_CODES) ||
      fields.messages.some((message) => ACCOUNT_CREDIT_403_MESSAGE_RE.test(message))
    ) {
      return "credit_exhausted";
    }
    if (
      hasStructuredCode(fields.codes, AUTH_FAILURE_403_CODES) ||
      hasExplicitAuthMessage(fields.messages)
    ) {
      return "operator_auth_failure";
    }
    return "provider_error";
  }
  const text = fields.allText;
  if (status === 400 && CREDIT_EXHAUSTED_400_RE.test(text)) {
    return "credit_exhausted";
  }
  if (status === 429 && CREDIT_EXHAUSTED_RE.test(text)) {
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

export function normalizeUpstreamError(
  parsed: unknown,
  status: number,
  code: UpstreamProviderErrorCode | null = classifyUpstreamProviderError(status, parsed)
): NormalizedUpstreamError {
  if (code) return upstreamProviderErrorResponse(code);
  return { status, data: sanitizeConsumerUpstreamError(parsed, status) };
}
