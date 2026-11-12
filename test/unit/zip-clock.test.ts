/**
 * Spec step 4 (offset interval, stale, upper window, clock check) and step 4a
 * (settle wait, settle `Date` rules) as pure arithmetic. All values in ms:
 * `send`/`arrival`/`jobStart`/`success` are monotonic; `dateMs`/`lastModifiedMs`
 * are epoch ms on the S3 clock.
 */
import { describe, expect, it } from 'vitest';
import {
  clockUncertain,
  isPastWindow,
  isStale,
  offsetInterval,
  settleDateOk,
  settleWaitUntil,
  type HeaderSample,
} from '../../src/api/zip-clock';

/** S3 epoch = monotonic + OFFSET. A whole second, so `Date` stamps fall on known values. */
const OFFSET = 1_800_000_000_000;
const NONE: ReadonlySet<string> = new Set();

function sample(over: Partial<HeaderSample>): HeaderSample {
  return {
    send: 20_000,
    arrival: 20_100,
    dateMs: OFFSET + 20_000,
    lastModifiedMs: OFFSET + 15_000,
    etag: '"abc"',
    total: 100,
    age: false,
    ...over,
  };
}

describe('offsetInterval', () => {
  it('is [Date − arrival, Date + 1 s − send]', () => {
    const s = sample({ send: 20_000, arrival: 20_300, dateMs: OFFSET + 20_000 });
    expect(offsetInterval(s)).toEqual({ lo: OFFSET - 300, hi: OFFSET + 1_000 });
  });
});

describe('isStale (lower bound and seen set)', () => {
  const jobStart = 10_000;

  it('S10c: certainly before the job is stale; a later write is fresh', () => {
    // lo = OFFSET − 100; jobStart on S3 = OFFSET + 9_900 at the lowest offset.
    const old = sample({ lastModifiedMs: OFFSET + 8_000 });
    expect(isStale(old, jobStart, NONE)).toBe(true);
    const fresh = sample({ lastModifiedMs: OFFSET + 10_000 });
    expect(isStale(fresh, jobStart, NONE)).toBe(false);
  });

  it('S10c2: Date stamped at send, 1.5 s round trip, written 3 s before the job → stale', () => {
    // True S3 time at send is OFFSET + 20_000, so Date is exactly that.
    const s = sample({
      send: 20_000, arrival: 21_500, dateMs: OFFSET + 20_000,
      lastModifiedMs: OFFSET + jobStart - 3_000,
    });
    // lo = OFFSET − 1_500: 7_000 + 1_000 ≤ 10_000 − 1_500.
    expect(isStale(s, jobStart, NONE)).toBe(true);
  });

  it('an ETag already seen is stale whatever its date', () => {
    const s = sample({ lastModifiedMs: OFFSET + 19_000, etag: '"x"' });
    expect(isStale(s, jobStart, new Set(['"x"']))).toBe(true);
    // exact string: a differently quoted value is a different ETag
    expect(isStale(s, jobStart, new Set(['x']))).toBe(false);
  });

  it('boundary: Last-Modified + 1 s == jobStart + lo is stale; 1 ms later is not', () => {
    const lo = offsetInterval(sample({})).lo;
    const edge = jobStart + lo - 1_000;
    expect(isStale(sample({ lastModifiedMs: edge }), jobStart, NONE)).toBe(true);
    expect(isStale(sample({ lastModifiedMs: edge + 1 }), jobStart, NONE)).toBe(false);
  });
});

describe('isPastWindow (upper bound)', () => {
  const success = 18_000;

  it('S10d: Last-Modified after success + 5 s at the highest offset is past the window', () => {
    // hi = OFFSET + 1_000 → limit OFFSET + 18_000 + 1_000 + 5_000 = OFFSET + 24_000.
    expect(isPastWindow(sample({ lastModifiedMs: OFFSET + 25_000 }), success)).toBe(true);
    expect(isPastWindow(sample({ lastModifiedMs: OFFSET + 19_000 }), success)).toBe(false);
  });

  it('boundary: equal to success + hi + 5 s is inside; 1 ms more is past', () => {
    const hi = offsetInterval(sample({})).hi;
    const edge = success + hi + 5_000;
    expect(isPastWindow(sample({ lastModifiedMs: edge }), success)).toBe(false);
    expect(isPastWindow(sample({ lastModifiedMs: edge + 1 }), success)).toBe(true);
  });
});

describe('S10e: a 1 h constant local offset', () => {
  it('the window is computed on the S3 clock, so the zip is usable', () => {
    // Local monotonic time is unrelated to epoch; S3 is an hour "ahead" of whatever
    // a naive mapping would say. Only the offset measured at the pin matters.
    const off = OFFSET + 3_600_000;
    const jobStart = 1_000;
    const success = 4_000;
    const pin = sample({
      send: 4_200, arrival: 4_300, dateMs: off + 4_000,
      lastModifiedMs: off + 3_000, // written during the job, on the S3 clock
    });
    expect(isStale(pin, jobStart, NONE)).toBe(false);
    expect(isPastWindow(pin, success)).toBe(false);
    expect(clockUncertain(pin)).toBe(false);
    const settle = sample({ ...pin, send: 10_400, arrival: 10_500, dateMs: off + 10_000 });
    expect(settleDateOk(pin, settle, success)).toBe(true);
  });
});

describe('clockUncertain', () => {
  it('S10g: a 2.5 s round trip is uncertain', () => {
    expect(clockUncertain(sample({ send: 0, arrival: 2_500 }))).toBe(true);
  });

  it('S10g: an Age header is uncertain', () => {
    expect(clockUncertain(sample({ age: true }))).toBe(true);
  });

  it('boundary: exactly 2 s is certain; 2 s + 1 ms is not', () => {
    expect(clockUncertain(sample({ send: 0, arrival: 2_000 }))).toBe(false);
    expect(clockUncertain(sample({ send: 0, arrival: 2_001 }))).toBe(true);
  });
});

describe('settleWaitUntil', () => {
  it('is success + 5 s + 1 s + round trip', () => {
    const pin = sample({ send: 20_000, arrival: 21_500 });
    expect(settleWaitUntil(pin, 18_000)).toBe(18_000 + 6_000 + 1_500);
  });
});

describe('settleDateOk', () => {
  const success = 18_000;
  const pin = sample({ send: 20_000, arrival: 20_100, dateMs: OFFSET + 20_000 });

  it('a truthful advancing Date passes', () => {
    // Needs ≥ pin.date + (18_000 − 20_000) + 6_000 = pin.date + 4_000, and ≥ pin.date + 2_000.
    expect(settleDateOk(pin, sample({ dateMs: pin.dateMs + 4_000 }), success)).toBe(true);
  });

  it('boundary, condition 1: equality passes; 1 ms short fails', () => {
    const need = pin.dateMs + (success - pin.send) + 6_000;
    expect(settleDateOk(pin, sample({ dateMs: need }), success)).toBe(true);
    expect(settleDateOk(pin, sample({ dateMs: need - 1 }), success)).toBe(false);
  });

  it('boundary, condition 2: equality passes; 1 ms short fails', () => {
    // A pin long after success makes condition 1 slack, isolating condition 2.
    const late = sample({ send: 40_000, arrival: 40_100, dateMs: OFFSET + 40_000 });
    expect(settleDateOk(late, sample({ dateMs: late.dateMs + 2_000 }), success)).toBe(true);
    expect(settleDateOk(late, sample({ dateMs: late.dateMs + 1_999 }), success)).toBe(false);
  });

  it('S10a5: a replayed Date fails, with the pin 5 s and 11 s after success', () => {
    for (const lateBy of [5_000, 11_000]) {
      const send = success + lateBy;
      const p = sample({ send, arrival: send + 100, dateMs: OFFSET + send });
      const replay = { ...p };
      expect(settleDateOk(p, replay, success)).toBe(false);
      // Bumped by one second: still fails (the 2 s spacing must show as ≥ 2 s).
      expect(settleDateOk(p, { ...p, dateMs: p.dateMs + 1_000 }, success)).toBe(false);
    }
  });
});
