/**
 * RequestScheduler — strict-FIFO request gate with a concurrency cap and
 * jittered minimum spacing between request starts. Clock, timer, and RNG are
 * injectable so spacing is deterministic in tests.
 *
 * Governs only requests routed through VocareumClient.
 */
export interface SchedulerOptions {
  maxConcurrency: number;
  minIntervalMs: number;
  jitter: boolean;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  random?: () => number;
}

export class RequestScheduler {
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private readonly jitter: boolean;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly random: () => number;

  private readonly queue: Array<() => void> = [];
  private activeCount = 0;
  private nextAllowedStart = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: SchedulerOptions) {
    this.maxConcurrency = opts.maxConcurrency;
    this.minIntervalMs = opts.minIntervalMs;
    this.jitter = opts.jitter;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.random = opts.random ?? (() => Math.random());
  }

  /** Acquire a slot, run the task, release the slot (even on throw). */
  public async schedule<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Always enqueues (never inline-starts) so ordering is strictly FIFO. */
  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private release(): void {
    this.activeCount -= 1;
    this.pump();
  }

  /** Start eligible work from the head of the queue; schedule a timer when the
   *  head is concurrency-eligible but spacing-blocked. */
  private pump(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
      const current = this.now();
      if (current < this.nextAllowedStart) {
        this.scheduleTimer(this.nextAllowedStart - current);
        return;
      }
      const start = this.queue.shift()!;
      this.activeCount += 1;
      this.nextAllowedStart = current + this.spacing();
      start();
    }
  }

  private scheduleTimer(delay: number): void {
    if (this.pendingTimer !== undefined) { return; }
    this.pendingTimer = this.setTimeoutFn(() => {
      this.pendingTimer = undefined;
      this.pump();
    }, delay);
  }

  private spacing(): number {
    if (this.minIntervalMs <= 0) { return 0; }
    if (!this.jitter) { return this.minIntervalMs; }
    const offset = (this.random() * 2 - 1) * 0.4 * this.minIntervalMs;
    return this.minIntervalMs + offset;
  }
}
