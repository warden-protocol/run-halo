import { DEFAULT_COMPLETION_CEILING_TOKENS } from "@halo/vault-core";
import { ANTHROPIC_API_VERSION } from "./providers";

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIChatMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  [k: string]: unknown;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const FINISH_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

/** Translate OpenAI chat input to Anthropic Messages, lifting system messages to `system`. */
export function chatCompletionsToAnthropicRequest(
  body: OpenAIChatRequest
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const systemChunks: string[] = [];
  const converted: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") {
      systemChunks.push(m.content);
    } else if (m.role === "user" || m.role === "assistant") {
      converted.push({ role: m.role, content: m.content });
    }
    // Drop tool/function messages — Anthropic models invoked directly here
    // don't get the tool-loop shape from a single OpenAI translation.
  }

  const maxCompletionTokens =
    typeof body.max_completion_tokens === "number" &&
    Number.isFinite(body.max_completion_tokens) &&
    Number.isInteger(body.max_completion_tokens) &&
    body.max_completion_tokens > 0
      ? body.max_completion_tokens
      : undefined;
  // Keep the adapter's historic handling of numeric max_tokens values so
  // malformed numeric budget requests still fail upstream instead of silently
  // becoming a potentially billable default-sized generation.
  const maxTokens =
    typeof body.max_tokens === "number"
      ? body.max_tokens
      : (maxCompletionTokens ?? DEFAULT_COMPLETION_CEILING_TOKENS);

  const out: Record<string, unknown> = {
    model: body.model,
    messages: converted,
    max_tokens: maxTokens,
  };
  if (systemChunks.length > 0) out.system = systemChunks.join("\n\n");
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stop !== undefined) {
    out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  return out;
}

/** Translate Anthropic text blocks and usage to an OpenAI chat completion; tool-use blocks are omitted. */
export function anthropicResponseToChatCompletion(
  resp: AnthropicResponse,
  requestedModel: string | undefined
): {
  data: unknown;
  usage: { total_tokens: number; prompt_tokens: number; completion_tokens: number };
} {
  const text = Array.isArray(resp.content)
    ? resp.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("")
    : "";

  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;
  const totalTokens = inputTokens + outputTokens;

  const finishReason =
    resp.stop_reason && FINISH_REASON_MAP[resp.stop_reason]
      ? FINISH_REASON_MAP[resp.stop_reason]
      : resp.stop_reason || "stop";

  const data = {
    id: resp.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model || requestedModel || "claude",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: totalTokens,
    },
  };

  return {
    data,
    usage: {
      total_tokens: totalTokens,
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
    },
  };
}

/** Build the headers Anthropic's API expects. */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_API_VERSION,
  };
}
