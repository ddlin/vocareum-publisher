/**
 * The per-directory deadline of a zip pull (spec step 2, "Deadline"): one
 * AbortSignal plus a monotonic countdown, carried through every wait and
 * request of the directory.
 */
import { APIError } from './errors';

/**
 * The deadline passed. Never retryable: a retry could only start with no time
 * left, so the failure is final and its reason is `deadline`.
 */
export class DeadlineError extends APIError {
  constructor(message = 'Deadline exceeded') {
    super(message, undefined, undefined, false);
    this.name = 'DeadlineError';
  }
}

/** A countdown and the signal that fires when it reaches zero. */
export interface Deadline {
  /** Aborted with a `DeadlineError` when the deadline passes. */
  readonly signal: AbortSignal;
  /** Milliseconds left on the monotonic clock; zero or less once passed. */
  remainingMs(): number;
  /** Clear the pending timer once the work it bounds is over. Does not abort the signal. */
  dispose(): void;
}

/** setTimeout fires at once for a delay above 2^31 - 1 ms; never arm it beyond that. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Start a deadline `ms` from now.
 *
 * @param ms - milliseconds until the deadline; 0 or less is already passed
 * @param now - the monotonic clock. `performance.now()` by default, never
 *   `Date.now()`: a wall-clock step (NTP, VM resume) must not move the deadline.
 * @returns a `Deadline` whose signal aborts with a `DeadlineError`
 */
export function createDeadline(ms: number, now: () => number = () => performance.now()): Deadline {
  const end = now() + ms;
  const controller = new AbortController();
  const fire = (): void => { controller.abort(new DeadlineError(`Deadline of ${ms} ms exceeded`)); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (ms <= 0) {
    fire();
  } else {
    // unref: a pending deadline must not keep the process alive after the work is done.
    timer = setTimeout(fire, Math.min(ms, MAX_TIMER_MS));
    (timer as { unref?: () => void }).unref?.();
  }
  return {
    signal: controller.signal,
    remainingMs: () => end - now(),
    dispose: (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    },
  };
}

/**
 * Sleep that ends early when `signal` aborts. Without a signal it is a plain
 * timed sleep.
 *
 * @param ms - milliseconds to sleep
 * @param signal - optional; on abort the sleep rejects with `signal.reason`
 *   and its timer is cleared
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      // The reason is the deadline's DeadlineError; pass it on unchanged.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
