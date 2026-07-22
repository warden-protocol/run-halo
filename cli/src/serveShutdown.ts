export class ActiveServeRequests {
  private readonly tasks = new Set<Promise<unknown>>();
  private accepting = true;

  track<T>(task: Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error("serve request admission is sealed");
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task)
    );
    return task;
  }

  tryTrack<T>(start: () => Promise<T>): boolean {
    if (!this.accepting) return false;
    this.track(Promise.resolve().then(start));
    return true;
  }

  async sealAndWaitForIdle(): Promise<void> {
    this.accepting = false;
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}

export async function drainServeForShutdown(args: {
  activeRequests: ActiveServeRequests;
  flushRedeems: () => Promise<void>;
  redeemFlushTimeoutMs: number;
  drainOutbox: () => Promise<boolean>;
  closeOutbox: () => void;
}): Promise<boolean> {
  if (!Number.isSafeInteger(args.redeemFlushTimeoutMs) || args.redeemFlushTimeoutMs < 0) {
    throw new Error("redeem flush timeout must be a non-negative integer");
  }
  await args.activeRequests.sealAndWaitForIdle();
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = Promise.race([
    args.flushRedeems(),
    new Promise<void>((resolve) => {
      flushTimer = setTimeout(resolve, args.redeemFlushTimeoutMs);
    }),
  ]);
  try {
    const [drained] = await Promise.all([args.drainOutbox(), flush]);
    return drained;
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    args.closeOutbox();
  }
}
