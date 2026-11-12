/**
 * Spec step 2 "Start the zip and poll for it" and step 3 "Check the URL".
 * Every test drives the REAL client through a custom axios adapter, so the
 * retry loop, the 401 replay, the overload detection and the debug events are
 * all in the path; `client.request` is spied (call-through) to assert the
 * options each request carried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';
import { VocareumClient } from '../../src/api/client';
import { createDeadline, type Deadline } from '../../src/api/deadline';
import { runZipJob } from '../../src/api/zip-job';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import type { AuthProvider } from '../../src/api/auth/auth-provider';

const ONE_SLOT = { maxConcurrency: 1, minIntervalMs: 0, jitter: false } as const;
const IDS = { courseId: '215500', assignmentId: '3001', partId: '6036046' };
const BASE = '/voc/startercode';
const FILES_URL = '/courses/215500/assignments/3001/parts/6036046/files';
const SIGNED = 'https://bucket.s3.amazonaws.com/u1_p6036046.zip?X-Amz-Credential=CREDSECRET&X-Amz-Signature=SIGSECRET';
const OVERLOAD = 'VOCAREUM-ERROR: We are experiencing heavy traffic. Please try again.';
const STARTED = { status: 'success', message: 'Started', transactionid: '777', objid: '42' };

interface SeenConfig {
  url?: string;
  params?: Record<string, unknown>;
  headers: { get(name: string): unknown };
}
type Answer = (config: SeenConfig, call: number) => unknown;

class TokenProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  async getAuthorizationHeader() { return 'Token fake'; }
}

/** OAuth-like: a 401 would normally be replayed once after a refresh. */
class RefreshingProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  refreshed = 0;
  async getAuthorizationHeader() { return 'Bearer gen1'; }
  async refreshAfterUnauthorized() { this.refreshed += 1; }
}

function response(config: SeenConfig, status: number, data: unknown, headers: Record<string, string> = {}) {
  return { data, status, statusText: '', headers, config };
}

function httpError(config: SeenConfig, status: number, headers: Record<string, string> = {}): AxiosError {
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE',
    config as never, {}, response(config, status, { message: 'nope' }, headers) as never);
}

function clientWith(answer: Answer, provider: AuthProvider = new TokenProvider()) {
  const events = new CollectingEventSink();
  const client = new VocareumClient(provider, ONE_SLOT, undefined, events);
  const seen: SeenConfig[] = [];
  (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter =
    async (config: SeenConfig) => {
      seen.push(config);
      return answer(config, seen.length);
    };
  const spy = vi.spyOn(client, 'request');
  return { client, seen, spy, events };
}

const isStart = (c: SeenConfig): boolean => c.params?.dir !== undefined;
const isPoll = (c: SeenConfig): boolean => c.params?.transactionid !== undefined;
/** The monotonic clock under fake timers. */
const now = (): number => Date.now();

/** Run the job while fake time advances until it settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 10_000 && !done; i++) { await vi.advanceTimersByTimeAsync(50); }
  return promise;
}

function startOptions(deadline: Deadline) {
  return { maxRetries: 1, noAuthReplay: true, deadline, zipAuth: true };
}
function pollOptions(deadline: Deadline) {
  return { retryOverload: false, deadline, zipAuth: true };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => { vi.useRealTimers(); });

describe('runZipJob: start and poll', () => {
  it('starts with ?dir= only (no includeHidden), polls ?transactionid=, and returns the signed URL', async () => {
    const { client, seen, spy } = clientWith((config) => {
      if (isStart(config)) { return response(config, 200, STARTED); }
      return response(config, 200, seen.filter(isPoll).length < 3
        ? { state: 'pending', message: 'Working' }
        : { state: 'success', message: SIGNED });
    });
    const deadline = createDeadline(60_000, now);
    const result = await settle(runZipJob(client, IDS, BASE, deadline, now));

    expect(result).toEqual({ url: SIGNED, jobStart: 0, success: 250 + 500 + 1000 });
    const start = seen[0];
    expect(start.url).toBe(FILES_URL);
    expect(start.params).toEqual({ dir: BASE });
    for (const poll of seen.slice(1)) {
      expect(poll.url).toBe(FILES_URL);
      expect(poll.params).toEqual({ transactionid: '777' });
    }
    // Options actually passed: the start request and every poll.
    expect(spy.mock.calls[0][1]).toStrictEqual(startOptions(deadline));
    expect(spy.mock.calls[0][1]?.deadline).toBe(deadline);
    expect(spy.mock.calls).toHaveLength(4);
    for (const call of spy.mock.calls.slice(1)) {
      expect(call[1]).toStrictEqual(pollOptions(deadline));
      expect(call[1]?.deadline).toBe(deadline);
    }
  });

  it('polls at 250 ms, then doubling to a 5 s cap', async () => {
    const sentAt: number[] = [];
    const { client } = clientWith((config) => {
      if (isStart(config)) { return response(config, 200, STARTED); }
      sentAt.push(Date.now());
      return response(config, 200, sentAt.length < 8
        ? { state: 'pending' }
        : { state: 'success', message: SIGNED });
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(120_000, now), now));
    expect('url' in result).toBe(true);
    const gaps = sentAt.map((t, i) => t - (i === 0 ? 0 : sentAt[i - 1]));
    expect(gaps).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it('an OverloadError on a poll is a pending sample, not a failure', async () => {
    let polls = 0;
    const { client } = clientWith((config) => {
      if (isStart(config)) { return response(config, 200, STARTED); }
      polls += 1;
      if (polls <= 2) { return response(config, 200, OVERLOAD); }
      return response(config, 200, { state: 'success', message: SIGNED });
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
    expect(result).toEqual({ url: SIGNED, jobStart: 0, success: 250 + 500 + 1000 });
    // retryOverload: false, so the client did not retry each overload itself.
    expect(polls).toBe(3);
  });

  it('jobStart is read just before the successful start is sent; success when the success response arrives', async () => {
    let starts = 0;
    const { client } = clientWith(async (config) => {
      if (isStart(config)) {
        starts += 1;
        return response(config, 200, starts < 3 ? OVERLOAD : STARTED);
      }
      // The success response takes 120 ms to arrive.
      await new Promise((r) => setTimeout(r, 120));
      return response(config, 200, { state: 'success', message: SIGNED });
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
    // Start backoff 1000, then 2000: the third start is sent at 3000.
    expect(result).toEqual({ url: SIGNED, jobStart: 3_000, success: 3_000 + 250 + 120 });
  });
});

describe('S8: start and poll failures', () => {
  const cases: Array<{ name: string; answer: Answer; reason: string; provider?: () => AuthProvider }> = [
    {
      name: 'start error (HTTP 500, retryable elsewhere, is not retried here)',
      answer: (config) => { throw httpError(config, 500); },
      reason: 'start_failed',
    },
    {
      name: "start error: \"<dir> doesn't exist\"",
      answer: (config) => response(config, 200, { status: 'error', message: "/voc/startercode doesn't exist" }),
      reason: 'start_failed',
    },
    {
      name: 'start network error',
      answer: (config) => { throw new AxiosError('socket hang up', 'ECONNRESET', config as never); },
      reason: 'start_failed',
    },
    {
      name: 'start 401 under OAuth: never replayed',
      answer: (config) => { throw httpError(config, 401); },
      reason: 'start_failed',
      provider: () => new RefreshingProvider(),
    },
    {
      name: 'poll error',
      answer: (config) => {
        if (isStart(config)) { return response(config, 200, STARTED); }
        throw httpError(config, 400);
      },
      reason: 'poll_failed',
    },
    {
      name: 'failed state',
      answer: (config) => isStart(config)
        ? response(config, 200, STARTED)
        : response(config, 200, { state: 'failed', message: 'Something went wrong. Please try again.' }),
      reason: 'poll_failed',
    },
    {
      name: 'success without a string message',
      answer: (config) => isStart(config)
        ? response(config, 200, STARTED)
        : response(config, 200, { state: 'success' }),
      reason: 'poll_failed',
    },
  ];

  for (const c of cases) {
    it(`S8: ${c.name} → ${c.reason}, exactly one start request`, async () => {
      const provider = c.provider?.() ?? new TokenProvider();
      const { client, seen } = clientWith(c.answer, provider);
      const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
      expect(result).toEqual({ reason: c.reason });
      expect(seen.filter(isStart)).toHaveLength(1);
      if (provider instanceof RefreshingProvider) { expect(provider.refreshed).toBe(0); }
    });
  }

  it('S8: overload bodies until the deadline: one start per overload, then deadline', async () => {
    const sentAt: number[] = [];
    const { client, seen, spy } = clientWith((config) => {
      sentAt.push(Date.now());
      return response(config, 200, OVERLOAD);
    });
    const deadline = createDeadline(10_000, now);
    const result = await settle(runZipJob(client, IDS, BASE, deadline, now));
    expect(result).toEqual({ reason: 'deadline' });
    // Backoff 1 s, 2 s, 4 s; the next 8 s would pass the deadline.
    expect(sentAt).toEqual([0, 1_000, 3_000, 7_000]);
    expect(seen.every(isStart)).toBe(true);
    for (const call of spy.mock.calls) { expect(call[1]).toStrictEqual(startOptions(deadline)); }
    expect(Date.now()).toBeLessThanOrEqual(10_000);
  });

  it('S8: an overload Retry-After is honoured by the start loop', async () => {
    const sentAt: number[] = [];
    const { client } = clientWith((config) => {
      if (!isStart(config)) { return response(config, 200, { state: 'success', message: SIGNED }); }
      sentAt.push(Date.now());
      return sentAt.length === 1
        ? response(config, 200, OVERLOAD, { 'retry-after': '3' })
        : response(config, 200, STARTED);
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
    expect(sentAt).toEqual([0, 3_000]);
    expect(result).toEqual({ url: SIGNED, jobStart: 3_000, success: 3_250 });
  });

  it('S8: an overload Retry-After: 0 cannot spin the start loop: each wait is at least the start backoff', async () => {
    const sentAt: number[] = [];
    const { client } = clientWith((config) => {
      if (!isStart(config)) { return response(config, 200, { state: 'success', message: SIGNED }); }
      sentAt.push(Date.now());
      return sentAt.length <= 2
        ? response(config, 200, OVERLOAD, { 'retry-after': '0' })
        : response(config, 200, STARTED);
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
    expect(sentAt).toEqual([0, 1_000, 2_000]);
    expect(result).toEqual({ url: SIGNED, jobStart: 2_000, success: 2_250 });

    // An endless Retry-After: 0 is bounded by the deadline at one start per second.
    const forever: number[] = [];
    const { client: busy } = clientWith((config) => {
      forever.push(Date.now());
      return response(config, 200, OVERLOAD, { 'retry-after': '0' });
    });
    const t0 = Date.now();
    const stopped = await settle(runZipJob(busy, IDS, BASE, createDeadline(5_000, now), now));
    expect(stopped).toEqual({ reason: 'deadline' });
    expect(forever.length).toBeLessThanOrEqual(5);
    expect(forever.map((t) => t - t0)).toEqual([0, 1_000, 2_000, 3_000, 4_000].slice(0, forever.length));
  });

  it('S8: after overloads, any other error ends the loop with no replay', async () => {
    const { client, seen } = clientWith((config) => {
      if (seen.length <= 2) { return response(config, 200, OVERLOAD); }
      throw httpError(config, 503);
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
    expect(result).toEqual({ reason: 'start_failed' });
    expect(seen).toHaveLength(3);
  });
});

describe('S7h: overload on start', () => {
  it('S7h: two overloads, then Started → the URL', async () => {
    let starts = 0;
    const { client, seen } = clientWith((config) => {
      if (isStart(config)) {
        starts += 1;
        return response(config, 200, starts <= 2 ? OVERLOAD : STARTED);
      }
      return response(config, 200, { state: 'success', message: SIGNED });
    });
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
    expect(result).toMatchObject({ url: SIGNED });
    expect(seen.filter(isStart)).toHaveLength(3);
    expect(seen.filter(isPoll)).toHaveLength(1);
  });
});

describe('S7: deadline', () => {
  it('S7: a poll still pending at the deadline gives deadline, without exceeding it', async () => {
    const { client, seen } = clientWith((config) => isStart(config)
      ? response(config, 200, STARTED)
      : response(config, 200, { state: 'pending' }));
    let endedAt = -1;
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(2_000, now), now)
      .then((r) => { endedAt = Date.now(); return r; }));
    expect(result).toEqual({ reason: 'deadline' });
    expect(endedAt).toBeLessThanOrEqual(2_000);
    // Polls at 250, 750 and 1750; the next (5750) would be past the deadline.
    expect(seen.filter(isPoll)).toHaveLength(3);
  });

  it('S7: a 429 on a poll with Retry-After past the deadline gives deadline at once', async () => {
    const { client, seen } = clientWith((config) => {
      if (isStart(config)) { return response(config, 200, STARTED); }
      throw httpError(config, 429, { 'retry-after': '60' });
    });
    let endedAt = -1;
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(10_000, now), now)
      .then((r) => { endedAt = Date.now(); return r; }));
    expect(result).toEqual({ reason: 'deadline' });
    expect(seen.filter(isPoll)).toHaveLength(1);
    // No sleep toward the Retry-After.
    expect(endedAt).toBeLessThan(1_000);
  });

  it('S7: a deadline already passed sends no request', async () => {
    const { client, seen } = clientWith((config) => response(config, 200, STARTED));
    const result = await settle(runZipJob(client, IDS, BASE, createDeadline(0, now), now));
    expect(result).toEqual({ reason: 'deadline' });
    expect(seen).toHaveLength(0);
  });
});

describe('step 3: URL check', () => {
  const rejected = [
    'http://bucket.s3.amazonaws.com/u1_p1.zip?X-Amz-Signature=SIGSECRET',
    'https://u:p@bucket.s3.amazonaws.com/u1_p1.zip?X-Amz-Signature=SIGSECRET',
    'https://u@bucket.s3.amazonaws.com/u1_p1.zip',
    'not a url at all',
    'ftp://bucket/u1_p1.zip',
  ];
  for (const url of rejected) {
    it(`url_rejected for ${url.split('?')[0]}`, async () => {
      const { client } = clientWith((config) => isStart(config)
        ? response(config, 200, STARTED)
        : response(config, 200, { state: 'success', message: url }));
      const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
      expect(result).toStrictEqual({ reason: 'url_rejected' });
    });
  }
});

describe('S20: the signed URL query never reaches an event', () => {
  it('S20: success and url_rejected runs carry no URL query in any event', async () => {
    for (const message of [SIGNED, SIGNED.replace('https:', 'http:'), SIGNED.replace('https://', 'https://u:p@')]) {
      const { client, events } = clientWith((config) => isStart(config)
        ? response(config, 200, STARTED)
        : response(config, 200, { state: 'success', message }));
      const result = await settle(runZipJob(client, IDS, BASE, createDeadline(60_000, now), now));
      const text = JSON.stringify(events.drain());
      expect(text).not.toContain('SIGSECRET');
      expect(text).not.toContain('CREDSECRET');
      expect(text).not.toContain('X-Amz-Signature=');
      if ('reason' in result) { expect(JSON.stringify(result)).not.toContain('SIGSECRET'); }
    }
  });
});
