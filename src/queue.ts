// Keep the slot until the actual operation settles. Never release it on a raced timeout.
export class CaptureQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private maxPending = 8, private maxWaitMs = 30_000) {}
  get size() { return this.pending; }
  async run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.pending >= this.maxPending) throw new Error("QUEUE_FULL: retry after the active capture finishes.");
    this.pending++;
    const started = Date.now();
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      if (signal?.aborted) throw new Error("CANCELLED: capture was cancelled before execution.");
      if (Date.now() - started > this.maxWaitMs) throw new Error("QUEUE_TIMEOUT: capture expired before execution.");
      return await job();
    } finally { this.pending--; release(); }
  }
}
export const captureQueue = new CaptureQueue();
