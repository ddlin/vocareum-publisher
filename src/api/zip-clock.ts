/**
 * The S3 clock arithmetic of a zip pull (spec step 4 "Pin the object" and step
 * 4a "Settle check"). Pure functions, all in milliseconds.
 *
 * Two clocks meet here. `send`, `arrival`, `jobStart` and `success` are local
 * MONOTONIC instants (`performance.now()`), never wall-clock: a wall-clock step
 * must not move any bound. `dateMs` and `lastModifiedMs` are S3's own clock,
 * HTTP dates parsed to epoch ms. The offset interval measured at the pin is the
 * only bridge between them.
 */

/** What one ranged GET told us, with the local instants around it. */
export interface HeaderSample {
  /** Monotonic time the request was sent. */
  send: number;
  /** Monotonic time the response headers arrived. */
  arrival: number;
  /** `Date` header, epoch ms (1 s resolution). */
  dateMs: number;
  /** `Last-Modified` header, epoch ms (1 s resolution). */
  lastModifiedMs: number;
  /** Strong ETag, the exact header string with its quotes. */
  etag: string;
  /** Object size from the `Content-Range` total. */
  total: number;
  /** True when the response carried an `Age` header (possibly cached). */
  age: boolean;
}

/** Clock check: a round trip above this means `Date` cannot be placed well enough. */
const MAX_ROUND_TRIP_MS = 2_000;
/** HTTP dates are truncated to the second. */
const DATE_RESOLUTION_MS = 1_000;
/** Threat assumption: our job's write lands within this long after `success`. */
const WRITE_WINDOW_MS = 5_000;
/** The settle GET's `Date` must advance at least this much over the pin's. */
const SETTLE_DATE_ADVANCE_MS = 2_000;

/**
 * The S3-minus-local offset at the pin. `Date` was stamped somewhere between
 * `send` and `arrival` and truncated to the second, so the true offset lies in
 * `[Date − arrival, Date + 1 s − send]`.
 *
 * @returns `lo` and `hi`, in ms; S3 time ≈ monotonic time + offset
 */
export function offsetInterval(s: HeaderSample): { lo: number; hi: number } {
  return { lo: s.dateMs - s.arrival, hi: s.dateMs + DATE_RESOLUTION_MS - s.send };
}

/**
 * The object is stale (not our job's write) when its ETag was already seen for
 * this part, or when it was certainly written before our job started:
 * `Last-Modified + 1 s ≤ jobStart + lo`. The lowest offset is used so that our
 * own write, which always follows `jobStart`, can never be judged stale.
 *
 * @param jobStart - monotonic time the start request was sent
 * @param seen - ETags already pinned for this part in this run (exact strings)
 */
export function isStale(s: HeaderSample, jobStart: number, seen: ReadonlySet<string>): boolean {
  return seen.has(s.etag) || s.lastModifiedMs + DATE_RESOLUTION_MS <= jobStart + offsetInterval(s).lo;
}

/**
 * The object was written after our job's write could still land
 * (`Last-Modified > success + hi + 5 s`, the highest offset), so it is someone
 * else's later write.
 *
 * @param success - monotonic time the poll response reporting `success` arrived
 */
export function isPastWindow(s: HeaderSample, success: number): boolean {
  return s.lastModifiedMs > success + offsetInterval(s).hi + WRITE_WINDOW_MS;
}

/**
 * `Date` cannot be trusted as S3's clock now: the round trip is over 2 s, or the
 * response carries `Age` (it may be cached).
 */
export function clockUncertain(s: HeaderSample): boolean {
  return s.arrival - s.send > MAX_ROUND_TRIP_MS || s.age;
}

/**
 * Monotonic instant at which the S3 clock has certainly passed `success + 5 s`.
 * `success` on the S3 clock is at most `success + hi`; S3 time at `t` is at
 * least `t + lo`; so `t + lo ≥ success + hi + 5 s`, which is
 * `t ≥ success + 6 s + (arrival − send)`.
 *
 * The settle GET must also wait for `pin.arrival + 2 s` (spacing); that bound
 * is applied by the caller.
 */
export function settleWaitUntil(pin: HeaderSample, success: number): number {
  return success + WRITE_WINDOW_MS + DATE_RESOLUTION_MS + (pin.arrival - pin.send);
}

/**
 * S3's own clock agrees the settle point has passed. Both must hold:
 *  - `settle.Date ≥ pin.Date + (success − pin.send) + 6 s`: `success + 5 s` at
 *    the upper end of the pin's offset interval, as S3 itself reports it;
 *  - `settle.Date ≥ pin.Date + 2 s`: the ≥ 2 s spacing shows as a whole 2 s on
 *    a truthful origin, so a replayed (or one-second-bumped) pin response fails
 *    however late the pin was.
 */
export function settleDateOk(pin: HeaderSample, settle: HeaderSample, success: number): boolean {
  return (
    settle.dateMs >= pin.dateMs + (success - pin.send) + DATE_RESOLUTION_MS + WRITE_WINDOW_MS &&
    settle.dateMs >= pin.dateMs + SETTLE_DATE_ADVANCE_MS
  );
}
