import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamSseParser } from "./upstream-sse";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

test("UpstreamSseParser handles split CRLF, comments, multiline data, and EOF", () => {
  const parser = new UpstreamSseParser();
  const events = [
    ...parser.push(bytes(": keepalive\r\nevent: message\r")),
    ...parser.push(bytes("\ndata: {\"choices\":\r\ndata: [{\"delta\":{}}]}\r\n\r")),
    ...parser.push(bytes("\ndata: {\"usage\":{\"prompt_tokens\":1,")),
    ...parser.push(bytes("\"completion_tokens\":2}}")),
    ...parser.finish(),
  ];

  assert.deepEqual(events, [
    {
      event: "message",
      data: '{"choices":\n[{"delta":{}}]}',
    },
    {
      data: '{"usage":{"prompt_tokens":1,"completion_tokens":2}}',
    },
  ]);
});

test("UpstreamSseParser accepts CR-only framing", () => {
  const parser = new UpstreamSseParser();
  const events = [
    ...parser.push(bytes("data: one\r\rdata: two\r\r")),
    ...parser.finish(),
  ];
  assert.deepEqual(events, [{ data: "one" }, { data: "two" }]);
});

test("UpstreamSseParser bounds an unterminated event", () => {
  const parser = new UpstreamSseParser();
  assert.throws(
    () => parser.push(bytes(`data: ${"x".repeat(1024 * 1024)}`)),
    /framing limit/
  );
});
