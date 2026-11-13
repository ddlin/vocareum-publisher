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

/** A queued acquire. `onAbort` is the listener registered on the caller's signal. */
interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class RequestScheduler {
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private readonly jitter: boolean;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly random: () => number;

  private readonly queue: Waiter[] = [];
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

  /**
   * Acquire a slot, run the task, release the slot (even on throw). With a
   * signal, a wait that is aborted before a slot is taken rejects with
   * `signal.reason` and never releases: only a waiter that incremented
   * `activeCount` may decrement it.
   */
  public async schedule<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal); // a rejection here must skip the release below
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Always enqueues (never inline-starts) so ordering is strictly FIFO. */
  private acquire(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        // The spec requires rejecting with signal.reason verbatim, whatever its type.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason);
        return;
      }
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          // Remove from the queue synchronously, so pump can never hand this
          // waiter a slot after the caller has given up.
          const i = this.queue.indexOf(waiter);
          if (i === -1) { return; }
          this.queue.splice(i, 1);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal.reason);
          // A removed head may have been blocking a spacing timer's target; pump is cheap and idempotent.
          this.pump();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
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
      // Detach before taking the slot: an abort after this point must not reject a waiter that holds one.
      if (start.onAbort) { start.signal?.removeEventListener('abort', start.onAbort); }
      this.activeCount += 1;
      this.nextAllowedStart = current + this.spacing();
      start.resolve();
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
