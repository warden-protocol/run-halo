export type RelayDeliveryFailure =
  | "relay-aborted"
  | "confirmation-timeout"
  | "socket-closed"
  | "terminal-send-failed";

export type RelayDeliveryResult =
  | { ok: true }
  | { ok: false; reason: RelayDeliveryFailure };

interface PendingDelivery {
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: RelayDeliveryResult) => void;
}

/** Correlate one terminal response with the relay's HTTP-delivery confirmation. */
export class RelayDeliveryTracker {
  private readonly pending = new Map<string, PendingDelivery>();

  constructor(private readonly timeoutMs = 20_000) {}

  async sendAndWait(
    requestId: string,
    sendTerminal: () => Promise<void>
  ): Promise<RelayDeliveryResult> {
    if (this.pending.has(requestId)) {
      throw new Error(`relay delivery confirmation already pending for ${requestId}`);
    }

    let finish!: (result: RelayDeliveryResult) => void;
    const result = new Promise<RelayDeliveryResult>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(
      () => this.finish(requestId, { ok: false, reason: "confirmation-timeout" }),
      this.timeoutMs
    );
    this.pending.set(requestId, { timer, resolve: finish });

    try {
      void sendTerminal().catch(() => {
        this.finish(requestId, { ok: false, reason: "terminal-send-failed" });
      });
    } catch {
      this.finish(requestId, { ok: false, reason: "terminal-send-failed" });
    }
    return result;
  }

  confirm(requestId: string): boolean {
    return this.finish(requestId, { ok: true });
  }

  abort(requestId: string): boolean {
    return this.finish(requestId, { ok: false, reason: "relay-aborted" });
  }

  close(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.finish(requestId, { ok: false, reason: "socket-closed" });
    }
  }

  private finish(requestId: string, result: RelayDeliveryResult): boolean {
    const delivery = this.pending.get(requestId);
    if (!delivery) return false;
    this.pending.delete(requestId);
    clearTimeout(delivery.timer);
    delivery.resolve(result);
    return true;
  }
}
