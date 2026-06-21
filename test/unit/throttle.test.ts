import { describe, it, expect } from 'vitest';
import { resolveThrottle, DEFAULT_THROTTLE } from '../../src/api/throttle';

describe('resolveThrottle', () => {
  it('returns defaults when nothing is set', () => {
    expect(resolveThrottle(undefined, {})).toEqual(DEFAULT_THROTTLE);
  });

  it('applies config values over defaults', () => {
    expect(resolveThrottle({ max_concurrency: 3, min_interval_ms: 500, jitter: false }, {}))
      .toEqual({ maxConcurrency: 3, minIntervalMs: 500, jitter: false });
  });

  it('lets env override config', () => {
    const r = resolveThrottle(
      { max_concurrency: 2, min_interval_ms: 500, jitter: false },
      { VOCAREUM_MAX_CONCURRENCY: '4', VOCAREUM_MIN_REQUEST_INTERVAL_MS: '1000', VOCAREUM_THROTTLE_JITTER: 'true' },
    );
    expect(r).toEqual({ maxConcurrency: 4, minIntervalMs: 1000, jitter: true });
  });

  it('parses boolean env forms 0/1/true/false', () => {
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: '0' }).jitter).toBe(false);
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: '1' }).jitter).toBe(true);
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: 'false' }).jitter).toBe(false);
    expect(resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: 'true' }).jitter).toBe(true);
  });

  it('throws on non-numeric interval env', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MIN_REQUEST_INTERVAL_MS: 'abc' })).toThrow(/VOCAREUM_MIN_REQUEST_INTERVAL_MS/);
  });

  it('throws on out-of-range concurrency env (0)', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MAX_CONCURRENCY: '0' })).toThrow(/VOCAREUM_MAX_CONCURRENCY/);
  });

  it('throws on concurrency env above 5', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MAX_CONCURRENCY: '6' })).toThrow(/VOCAREUM_MAX_CONCURRENCY/);
  });

  it('throws on interval env above 60000', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_MIN_REQUEST_INTERVAL_MS: '60001' })).toThrow(/VOCAREUM_MIN_REQUEST_INTERVAL_MS/);
  });

  it('throws on an unrecognized jitter env value', () => {
    expect(() => resolveThrottle(undefined, { VOCAREUM_THROTTLE_JITTER: 'maybe' })).toThrow(/VOCAREUM_THROTTLE_JITTER/);
  });
});
