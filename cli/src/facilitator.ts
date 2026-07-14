// Per-attempt timeout for a single facilitator URL. If it doesn't respond
// within this window, we abort and try the next URL in the failover list.
const FACILITATOR_TIMEOUT_MS = 30_000;

export class Facilitator {
  private readonly urls: string[];

  constructor(
    baseUrl: string,
    private readonly apiKey?: string,
    failoverUrls: string[] = []
  ) {
    this.urls = [baseUrl, ...failoverUrls]
      .map((u) => u.replace(/\/+$/, ""))
      .filter(Boolean);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /** Fail over URLs on transport errors or 5xx; return 4xx responses unchanged. */
  private async tryAll<T>(path: string, body: unknown): Promise<T> {
    let lastErr: Error | null = null;
    for (let i = 0; i < this.urls.length; i++) {
      const url = `${this.urls[i]}${path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status >= 500) {
          lastErr = new Error(`${url} returned ${res.status}`);
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`facilitator ${path} ${res.status}: ${text}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastErr || new Error(`all facilitators failed for ${path}`);
  }

  /** Activate a signed Permit2 budget; repeated `(consumer, nonce)` submissions are idempotent. */
  async permitSubmit(payload: unknown): Promise<{
    submitted: boolean;
    alreadyActive?: boolean;
    budgetId: string;
    consumer?: string;
    transaction?: string;
    errorReason?: string;
  }> {
    return this.tryAll("/permit-submit", { payload });
  }

  /** Draw down one inference from an active budget through Permit2. */
  async settleBudget(req: {
    budgetId: string;
    operator: string;
    amount: string;
    voucher?: {
      voucher: { budgetId: string; operator: string; cumulative: string; expiry: number };
      signature: string;
    };
    metadata?: { inferenceId?: string; model?: string; tokens?: number };
  }): Promise<{
    success: boolean;
    transaction?: string;
    spent?: string;
    remaining?: string;
    errorReason?: string;
  }> {
    return this.tryAll("/settle-budget", req);
  }
}
