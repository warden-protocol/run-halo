export interface UpstreamSseEvent {
  event?: string;
  data: string;
}

const MAX_PENDING_SSE_BYTES = 1024 * 1024;

/** Incremental SSE framing with CRLF/LF/CR support and EOF dispatch. */
export class UpstreamSseParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly encoder = new TextEncoder();
  private buffer = "";
  private bufferBytes = 0;
  private eventName: string | undefined;
  private eventNameBytes = 0;
  private dataLines: string[] = [];
  private dataBytes = 0;

  push(chunk: Uint8Array): UpstreamSseEvent[] {
    this.bufferBytes += chunk.byteLength;
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): UpstreamSseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): UpstreamSseEvent[] {
    const events: UpstreamSseEvent[] = [];
    for (;;) {
      const boundary = this.nextLineBoundary(final);
      if (!boundary) break;
      const line = this.buffer.slice(0, boundary.index);
      const lineBytes = this.encoder.encode(line).byteLength;
      if (lineBytes > MAX_PENDING_SSE_BYTES) {
        throw new Error("upstream SSE event exceeds the framing limit");
      }
      this.buffer = this.buffer.slice(boundary.index + boundary.width);
      this.bufferBytes -= lineBytes + boundary.width;
      this.consumeLine(line, events);
    }
    if (final) {
      if (this.buffer.length > 0) {
        const line = this.buffer;
        this.buffer = "";
        this.bufferBytes = 0;
        this.consumeLine(line, events);
      }
      this.dispatch(events);
    }
    this.assertPendingLimit();
    return events;
  }

  private nextLineBoundary(final: boolean): { index: number; width: number } | null {
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char === "\n") return { index, width: 1 };
      if (char !== "\r") continue;
      if (index + 1 >= this.buffer.length && !final) return null;
      return {
        index,
        width: this.buffer[index + 1] === "\n" ? 2 : 1,
      };
    }
    return null;
  }

  private consumeLine(line: string, events: UpstreamSseEvent[]): void {
    if (line.length === 0) {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.dataBytes +=
        this.encoder.encode(value).byteLength + (this.dataLines.length > 0 ? 1 : 0);
      this.dataLines.push(value);
    }
    if (field === "event") {
      this.eventName = value;
      this.eventNameBytes = this.encoder.encode(value).byteLength;
    }
    this.assertPendingLimit();
  }

  private dispatch(events: UpstreamSseEvent[]): void {
    if (this.dataLines.length > 0) {
      events.push({
        ...(this.eventName ? { event: this.eventName } : {}),
        data: this.dataLines.join("\n"),
      });
    }
    this.eventName = undefined;
    this.eventNameBytes = 0;
    this.dataLines = [];
    this.dataBytes = 0;
  }

  private assertPendingLimit(): void {
    if (this.bufferBytes + this.eventNameBytes + this.dataBytes > MAX_PENDING_SSE_BYTES) {
      throw new Error("upstream SSE event exceeds the framing limit");
    }
  }
}
