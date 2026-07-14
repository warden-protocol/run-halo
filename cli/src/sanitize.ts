const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "prompt",
  // Generation controls (no consumer identity)
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop",
  "stop_sequences",
  "frequency_penalty",
  "presence_penalty",
  "n",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "response_format",
  "size",
  "quality",
  "style",
  "background",
  "output_format",
  "output_compression",
  "seed",
  "stream",
  "stream_options",
  // Tool/function calling — content, not identity
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "functions",
  "function_call",
]);

/** Identity and provider-telemetry fields rejected explicitly in addition to the allowlist. */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  "user", // OpenAI's stable per-user identifier — never forward
  "metadata", // OpenAI Assistant API user metadata
  "store", // OpenAI's "save this conversation on their side" opt-in
  "x-source", // common debug/source tag from SDK wrappers
  "x-user-id",
  "x-session-id",
  "client_reference_id",
]);

export interface SanitizationReport {
  dropped: string[];
}

/** Return allowlisted fields and dropped names; non-object input passes through for upstream validation. */
export function sanitizeChatRequest(
  body: unknown
): { sanitized: Record<string, unknown>; report: SanitizationReport } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { sanitized: {} as Record<string, unknown>, report: { dropped: [] } };
  }
  const dropped: string[] = [];
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (ALLOWED_FIELDS.has(k)) {
      sanitized[k] = v;
    } else {
      dropped.push(k);
    }
  }
  return { sanitized, report: { dropped } };
}

/** Keep message content and tool-call protocol fields, but drop identity-bearing metadata such as `name`. */
export function sanitizeMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const src = m as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof src.role === "string") out.role = src.role;
    if (src.content !== undefined) out.content = src.content;
    if (src.tool_calls !== undefined) out.tool_calls = src.tool_calls;
    if (typeof src.tool_call_id === "string") out.tool_call_id = src.tool_call_id;
    // Deliberately drop: name, function_call (legacy, replaced by tool_calls),
    // any custom keys.
    return out;
  });
}
