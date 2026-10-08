interface PendingCapture {
  start: () => void;
}

/** Serial execution with bounded pending work and cancellable queue waits. */
export class CaptureQueue {
  private active = false;
  private waiting: PendingCapture[] = [];

  constructor(
    private maxPending = 8,
    private maxWaitMs = 30_000,
  ) {}

  get size() {
    return this.waiting.length + Number(this.active);
  }

  run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted)
      return Promise.reject(
        new Error("CANCELLED: capture was cancelled before execution."),
      );
    if (this.size >= this.maxPending)
      return Promise.reject(
        new Error("QUEUE_FULL: retry after the active capture finishes."),
      );
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const cancel = (message: string) => {
        const position = this.waiting.indexOf(entry);
        if (position < 0) return; // Active operations retain their slot until they actually settle.
        this.waiting.splice(position, 1);
        cleanup();
        reject(new Error(message));
      };
      const abort = () =>
        cancel("CANCELLED: capture was cancelled before execution.");
      const entry: PendingCapture = {
        start: () => {
          cleanup();
          this.active = true;
          void (async () => {
            try {
              resolve(await job());
            } catch (error) {
              reject(error);
            } finally {
              this.active = false;
              this.drain();
            }
          })();
        },
      };
      this.waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => cancel("QUEUE_TIMEOUT: capture expired before execution."),
        this.maxWaitMs,
      );
      this.drain();
    });
  }

  private drain() {
    if (this.active) return;
    this.waiting.shift()?.start();
  }
}
