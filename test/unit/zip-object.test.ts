/**
 * Spec step 4 (pin, then download) and step 4a (settle check) over HTTP. A fake
 * S3 runs as an axios adapter under fake timers: `performance.now()` is the
 * monotonic clock passed as `ctx.now`, and the fake S3's own clock is
 * `performance.now() + offset`, so `Date` and `Last-Modified` are what a
 * truthful origin would send. `Date` is faked separately so a wall-clock jump
 * can be shown to have no effect.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import type { Deadline } from '../../src/api/deadline';
import {
  downloadPinned,
  pinObject,
  settleCheck,
  type ZipObjectContext,
} from '../../src/api/zip-object';
import type { HeaderSample } from '../../src/api/zip-clock';

const URL_ = 'https://bucket.s3.amazonaws.com/u1_p2.zip?X-Amz-Signature=secret&X-Amz-Credential=c';
/** S3 epoch = monotonic + OFFSET (a whole second). */
const OFFSET = 1_800_000_000_000;

interface Version { at: number; etag: string; body: Buffer }
interface Seen { send: number; range?: string; ifMatch?: string; auth: unknown; maxRedirects?: number; timeout?: number; responseType?: string }
interface Override { status?: number; headers?: Record<string, string>; body?: Readable }

/**
 * A truthful S3 origin for one object. `versions` land at monotonic `at`; the
 * request is answered with the version current at the midpoint of its round
 * trip, which is also when `Date` is stamped (unless `stampAtSend`).
 */
class FakeS3 {
  versions: Version[] = [];
  rt = 100;
  offset = OFFSET;
  stampAtSend = false;
  requests: Seen[] = [];
  /** Per-request override by 1-based request number. */
  override: (n: number, config: InternalAxiosRequestConfig) => Override | undefined = () => undefined;
  /** Bodies handed out, to check whether a body was consumed. */
  streams: { stream: Readable; reads: () => number }[] = [];

  write(at: number, etag: string, body: string | Buffer): void {
    this.versions.push({ at, etag, body: Buffer.from(body) });
  }

  private current(t: number): Version | undefined {
    return [...this.versions].filter((v) => v.at <= t).pop();
  }

  private trackedStream(data: Buffer): Readable {
    let reads = 0;
    const stream = new Readable({
      read() { reads += 1; this.push(data); this.push(null); },
    });
    this.streams.push({ stream, reads: () => reads });
    return stream;
  }

  adapter = async (config: InternalAxiosRequestConfig) => {
    const send = performance.now();
    const h = config.headers;
    this.requests.push({
      send,
      range: h.get('Range') as string | undefined,
      ifMatch: h.get('If-Match') as string | undefined,
      auth: h.get('Authorization'),
      maxRedirects: config.maxRedirects,
      timeout: config.timeout,
      responseType: config.responseType,
    });
    const n = this.requests.length;
    await new Promise((r) => setTimeout(r, this.rt / 2));
    if (config.signal?.aborted) throw new axios.CanceledError('canceled');
    const stamp = this.stampAtSend ? send : performance.now();
    const v = this.current(performance.now());
    await new Promise((r) => setTimeout(r, this.rt / 2));
    if (config.signal?.aborted) throw new axios.CanceledError('canceled');
    const dateHdr = new Date(stamp + this.offset).toUTCString();
    const ov = this.override(n, config);
    const base = (status: number, headers: Record<string, string>, body: Buffer) => ({
      status: ov?.status ?? status,
      statusText: '',
      headers: { date: dateHdr, ...headers, ...(ov?.headers ?? {}) },
      data: ov?.body ?? this.trackedStream(body),
      config,
    });
    if (!v) return base(404, {}, Buffer.alloc(0));
    const lm = new Date(v.at + this.offset).toUTCString();
    const ifMatch = h.get('If-Match');
    if (ifMatch !== undefined && ifMatch !== null && ifMatch !== v.etag) return base(412, {}, Buffer.alloc(0));
    const common = { etag: v.etag, 'last-modified': lm };
    if (h.get('Range') === 'bytes=0-0') {
      return base(206, { ...common, 'content-range': `bytes 0-0/${v.body.length}` }, v.body.subarray(0, 1));
    }
    return base(200, { ...common, 'content-length': String(v.body.length) }, v.body);
  };
}

function manualDeadline(ms: number): Deadline & { abort(): void } {
  const end = performance.now() + ms;
  const c = new AbortController();
  return { signal: c.signal, remainingMs: () => end - performance.now(), abort: () => c.abort(new Error('deadline')) };
}

function setup(s3: FakeS3, jobStart: number, success: number, over: Partial<ZipObjectContext> = {}): ZipObjectContext {
  const http: AxiosInstance = axios.create({ adapter: s3.adapter });
  return {
    now: () => performance.now(),
    http,
    deadline: manualDeadline(600_000),
    maxBytes: 1_000_000,
    seen: new Set<string>(),
    jobStart,
    success,
    ...over,
  };
}

/** Run `p` to completion with every fake timer flushed. */
async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Advance the fake clocks to monotonic time `t`. */
async function at(t: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(t - performance.now());
}

describe('pinObject', () => {
  it('S10a: an old ETag then a new one → the new one is pinned, used, and recorded as seen', async () => {
    const s3 = new FakeS3();
    s3.write(0, '"prev"', 'old-zip');
    s3.write(1_500, '"ours"', 'new-zip-bytes');
    await at(1_000);
    const ctx = setup(s3, 1_000, 2_000);
    ctx.seen.add('"prev"');
    const r = await run(pinObject(URL_, ctx));
    expect('sample' in r && r.sample.etag).toBe('"ours"');
    expect(ctx.seen.has('"ours"')).toBe(true);
    expect(s3.requests.length).toBe(2);
    expect(s3.requests[1].send - s3.requests[0].send).toBeGreaterThanOrEqual(1_000);
    // Ranged, streamed, no auth, no redirects.
    for (const q of s3.requests) {
      expect(q.range).toBe('bytes=0-0');
      expect(q.responseType).toBe('stream');
      expect(q.auth).toBeFalsy();
      expect(q.maxRedirects).toBe(0);
    }
    if ('sample' in r) {
      expect(r.sample.total).toBe('new-zip-bytes'.length);
      expect(r.sample.arrival - r.sample.send).toBe(100);
    }
  });

  it('S10b: the old ETag persists → object_stale after 5 retries, 1 s apart', async () => {
    const s3 = new FakeS3();
    s3.write(0, '"prev"', 'old');
    await at(5_000);
    const ctx = setup(s3, 5_000, 6_000);
    ctx.seen.add('"prev"');
    const r = await run(pinObject(URL_, ctx));
    expect(r).toEqual({ reason: 'object_stale' });
    expect(s3.requests.length).toBe(6);
    for (let i = 1; i < 6; i++) {
      // round trip (100 ms) then a 1 s sleep
      expect(s3.requests[i].send - s3.requests[i - 1].send).toBe(1_100);
    }
  });

  it('S9: a persisting 403 or 404 → object_stale after the retries', async () => {
    for (const status of [403, 404]) {
      const s3 = new FakeS3();
      s3.write(0, '"x"', 'body');
      s3.override = () => ({ status, headers: {} });
      const ctx = setup(s3, 0, 1_000);
      const r = await run(pinObject(URL_, ctx));
      expect(r).toEqual({ reason: 'object_stale' });
      expect(s3.requests.length).toBe(6);
    }
  });

  it('S10c: certainly older than the job → stale, then our write → pinned', async () => {
    const s3 = new FakeS3();
    s3.write(0, '"pre"', 'pre-job');
    s3.write(13_500, '"ours"', 'ours');
    await at(12_000);
    const ctx = setup(s3, 10_000, 12_000);
    const r = await run(pinObject(URL_, ctx));
    expect('sample' in r && r.sample.etag).toBe('"ours"');
    expect(s3.requests.length).toBe(3);
  });

  it('S10d: Last-Modified after success + 5 s → object_window, not retried', async () => {
    const s3 = new FakeS3();
    s3.write(9_000, '"later"', 'x');
    await at(10_000);
    const ctx = setup(s3, 1_000, 2_000);
    expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'object_window' });
    expect(s3.requests.length).toBe(1);
  });

  it('S10d: a missing ETag, Last-Modified, Date or total → object_headers', async () => {
    for (const drop of ['etag', 'last-modified', 'date', 'content-range']) {
      const s3 = new FakeS3();
      s3.write(1_500, '"x"', 'body');
      s3.override = () => ({ headers: { [drop]: '' } });
      await at(performance.now() + 2_000);
      const ctx = setup(s3, 1_000, 1_400);
      expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'object_headers' });
    }
  });

  it('S10d: an unparseable Date or Content-Range → object_headers', async () => {
    for (const headers of [{ date: 'yesterday' }, { 'content-range': 'bytes 0-0/*' }, { 'content-range': 'bytes 0-0/0' }]) {
      const s3 = new FakeS3();
      s3.write(1_500, '"x"', 'body');
      s3.override = () => ({ headers });
      await at(performance.now() + 2_000);
      const ctx = setup(s3, 1_000, 1_400);
      expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'object_headers' });
    }
  });

  it('S10e: S3 clock an hour off the local clock → pinned and settled', async () => {
    const s3 = new FakeS3();
    s3.offset = OFFSET + 3_600_000;
    s3.write(2_000, '"ours"', 'zip');
    await at(1_500);
    const ctx = setup(s3, 1_000, 1_500);
    const r = await run(pinObject(URL_, ctx));
    expect('sample' in r).toBe(true);
    if (!('sample' in r)) return;
    expect(await run(settleCheck(URL_, r.sample, 1_500, ctx))).toBe(true);
  });

  it('S10g: a 2.5 s round trip → clock_uncertain', async () => {
    const s3 = new FakeS3();
    s3.rt = 2_500;
    s3.write(1_100, '"x"', 'body');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'clock_uncertain' });
  });

  it('S10g: an Age header → clock_uncertain', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"x"', 'body');
    s3.override = () => ({ headers: { age: '3' } });
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'clock_uncertain' });
  });

  it('S10g: a 200 instead of 206 → object_headers, body not consumed', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"x"', 'the-whole-body');
    s3.override = () => ({ status: 200 });
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'object_headers' });
    expect(s3.streams[0].reads()).toBe(0);
    expect(s3.streams[0].stream.destroyed).toBe(true);
  });

  it('S10g: a weak ETag → object_headers', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, 'W/"x"', 'body');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'object_headers' });
  });

  it('the 206 stream is destroyed after its first byte, even if it never ends', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"x"', 'body');
    let pushed = 0;
    // One byte, then silence: the stream never ends on its own.
    const endless = new Readable({ read() { if (pushed++ === 0) this.push(Buffer.from('b')); } });
    s3.override = () => ({ body: endless });
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    const r = await run(pinObject(URL_, ctx));
    expect('sample' in r).toBe(true);
    expect(endless.destroyed).toBe(true);
  });

  it('a default Authorization on the instance is never sent to S3', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"x"', 'body');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    ctx.http.defaults.headers.common.Authorization = 'Token secret';
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    await run(downloadPinned(URL_, r.sample, ctx));
    expect(s3.requests.length).toBe(2);
    for (const q of s3.requests) expect(q.auth).toBeFalsy();
  });

  it('a deadline that fires during the stale retries → deadline', async () => {
    const s3 = new FakeS3();
    s3.write(0, '"prev"', 'old');
    await at(5_000);
    const ctx = setup(s3, 5_000, 6_000, { deadline: manualDeadline(2_500) });
    ctx.seen.add('"prev"');
    const p = pinObject(URL_, ctx);
    await vi.advanceTimersByTimeAsync(1_500);
    (ctx.deadline as ReturnType<typeof manualDeadline>).abort();
    expect(await run(p)).toEqual({ reason: 'deadline' });
    expect(s3.requests.length).toBe(2);
  });

  it('no attempt with 0 ms left', async () => {
    const s3 = new FakeS3();
    s3.write(0, '"x"', 'body');
    const ctx = setup(s3, 0, 0, { deadline: manualDeadline(0) });
    expect(await run(pinObject(URL_, ctx))).toEqual({ reason: 'deadline' });
    expect(s3.requests.length).toBe(0);
  });
});

describe('downloadPinned', () => {
  async function pinned(s3: FakeS3, ctx: ZipObjectContext): Promise<HeaderSample> {
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error(`not pinned: ${r.reason}`);
    return r.sample;
  }

  it('downloads into one buffer with If-Match, no Authorization, no redirects', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"ours"', 'zip-bytes-here');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    const pin = await pinned(s3, ctx);
    const buf = await run(downloadPinned(URL_, pin, ctx));
    expect(Buffer.isBuffer(buf) && buf.toString()).toBe('zip-bytes-here');
    const q = s3.requests[1];
    expect(q.ifMatch).toBe('"ours"');
    expect(q.range).toBeUndefined();
    expect(q.auth).toBeFalsy();
    expect(q.maxRedirects).toBe(0);
    expect(q.timeout).toBeGreaterThan(0);
  });

  it('S10f: the object changes between the ranged GET and the full GET → 412 → object_changed', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"ours"', 'zip');
    s3.write(1_500, '"other"', 'zip2');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    const pin = await pinned(s3, ctx);
    await at(1_600);
    expect(await run(downloadPinned(URL_, pin, ctx))).toEqual({ reason: 'object_changed' });
  });

  it('a total over the remaining budget is refused before the GET → zip_over_budget', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"ours"', 'twelve bytes');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200, { maxBytes: 11 });
    const pin = await pinned(s3, ctx);
    expect(await run(downloadPinned(URL_, pin, ctx))).toEqual({ reason: 'zip_over_budget' });
    expect(s3.requests.length).toBe(1);
  });

  it('a body longer or shorter than the pinned total → object_download_failed', async () => {
    for (const body of ['short', 'much-too-long-body-for-the-pin']) {
      const s3 = new FakeS3();
      const t0 = performance.now();
      s3.write(t0 + 1_100, '"ours"', 'pinned-size');
      await at(t0 + 1_200);
      const ctx = setup(s3, t0 + 1_000, t0 + 1_200);
      const pin = await pinned(s3, ctx);
      s3.override = (n) => (n === 2 ? { body: Readable.from([Buffer.from(body)]) } : undefined);
      expect(await run(downloadPinned(URL_, pin, ctx))).toEqual({ reason: 'object_download_failed' });
    }
  });

  it('a body that keeps coming past the pinned total is cut off at once → object_download_failed', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"ours"', 'pinned-size');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    const pin = await pinned(s3, ctx);
    let pushed = 0;
    // Three 8-byte chunks (24 > 11), then silence: only the overflow rule can end the read.
    const endless = new Readable({ read() { if (pushed++ < 3) this.push(Buffer.alloc(8)); } });
    s3.override = (n) => (n === 2 ? { body: endless } : undefined);
    const p = downloadPinned(URL_, pin, ctx);
    await vi.runAllTimersAsync();
    expect(await Promise.race([p, Promise.resolve('still reading')])).toEqual({ reason: 'object_download_failed' });
    expect(endless.destroyed).toBe(true);
  });

  it('a redirect or a transport error → object_download_failed', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"ours"', 'zip');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200);
    const pin = await pinned(s3, ctx);
    s3.override = () => ({ status: 302, headers: { location: 'https://elsewhere.example/' } });
    expect(await run(downloadPinned(URL_, pin, ctx))).toEqual({ reason: 'object_download_failed' });
    const err = axios.create({ adapter: async () => { throw new Error('ECONNRESET'); } });
    expect(await run(downloadPinned(URL_, pin, { ...ctx, http: err }))).toEqual({ reason: 'object_download_failed' });
  });

  it('a deadline that fires mid-download → deadline', async () => {
    const s3 = new FakeS3();
    s3.write(1_100, '"ours"', 'zip');
    await at(1_200);
    const ctx = setup(s3, 1_000, 1_200, { deadline: manualDeadline(60_000) });
    const pin = await pinned(s3, ctx);
    const slow = new Readable({ read() { /* never delivers */ } });
    s3.override = (n) => (n === 2 ? { body: slow } : undefined);
    const p = downloadPinned(URL_, pin, ctx);
    await vi.advanceTimersByTimeAsync(500);
    (ctx.deadline as ReturnType<typeof manualDeadline>).abort();
    expect(await run(p)).toEqual({ reason: 'deadline' });
    expect(slow.destroyed).toBe(true);
  });
});

describe('settleCheck', () => {
  it('S10a2: our job writes 1 s after the pin of a pre-job object → object_settle_changed', async () => {
    const s3 = new FakeS3();
    // Pre-job object in the window (written in jobStart's own second) and unseen.
    s3.write(1_000, '"pre"', 'pre-job');
    await at(3_000); // success
    const ctx = setup(s3, 1_200, 3_000);
    const r = await run(pinObject(URL_, ctx));
    expect('sample' in r && r.sample.etag).toBe('"pre"');
    if (!('sample' in r)) return;
    s3.write(r.sample.arrival + 1_000, '"ours"', 'our-job');
    expect(await run(settleCheck(URL_, r.sample, 3_000, ctx))).toEqual({ reason: 'object_settle_changed' });
    // The pinned ETag is recorded, so the next directory cannot pin it.
    expect(ctx.seen.has('"pre"')).toBe(true);
  });

  it('S10a3: a pre-job object with byte-identical content (same ETag) → used, bytes correct', async () => {
    const s3 = new FakeS3();
    s3.write(1_000, '"same"', 'identical');
    await at(3_000);
    const ctx = setup(s3, 1_200, 3_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    s3.write(r.sample.arrival + 1_000, '"same"', 'identical');
    const buf = await run(downloadPinned(URL_, r.sample, ctx));
    expect(Buffer.isBuffer(buf) && buf.toString()).toBe('identical');
    expect(await run(settleCheck(URL_, r.sample, 3_000, ctx))).toBe(true);
  });

  it('waits until success + 6 s + round trip on the monotonic clock', async () => {
    const s3 = new FakeS3();
    s3.write(2_500, '"ours"', 'zip');
    await at(3_000);
    const ctx = setup(s3, 1_000, 3_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    expect(await run(settleCheck(URL_, r.sample, 3_000, ctx))).toBe(true);
    const settleSend = s3.requests[1].send;
    expect(settleSend).toBe(3_000 + 6_000 + (r.sample.arrival - r.sample.send));
  });

  it('S10a4: the wall clock jumps 10 s after success; the wait is unaffected and our late write is seen', async () => {
    const s3 = new FakeS3();
    s3.write(1_000, '"pre"', 'pre-job');
    await at(3_000);
    const ctx = setup(s3, 1_200, 3_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    // Our job's write lands 4.5 s after success, within the threat assumption.
    s3.write(7_500, '"ours"', 'our-job');
    vi.setSystemTime(Date.now() + 10_000);
    expect(await run(settleCheck(URL_, r.sample, 3_000, ctx))).toEqual({ reason: 'object_settle_changed' });
    expect(s3.requests[1].send).toBeGreaterThanOrEqual(9_000);
  });

  it('S10a5: a settle response replaying the pin (same Date and ETag) fails, pins 5 s and 11 s late', async () => {
    for (const lateBy of [5_000, 11_000]) {
      const s3 = new FakeS3();
      const success = performance.now();
      s3.write(success - 500, '"ours"', 'zip');
      await at(success + lateBy);
      const ctx = setup(s3, success - 1_000, success);
      const r = await run(pinObject(URL_, ctx));
      if (!('sample' in r)) throw new Error('not pinned');
      const pinDate = new Date(r.sample.dateMs).toUTCString();
      s3.override = () => ({ headers: { date: pinDate } });
      expect(await run(settleCheck(URL_, r.sample, success, ctx))).toEqual({ reason: 'object_settle_changed' });
    }
  });

  it('S10a6: called 0.1 s after the pin arrived → waits until 2 s after the pin', async () => {
    const s3 = new FakeS3();
    s3.write(500, '"ours"', 'zip');
    await at(1_000); // success
    await at(20_000); // a late pin: the settle point has long passed
    const ctx = setup(s3, 0, 1_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    await at(r.sample.arrival + 100);
    expect(await run(settleCheck(URL_, r.sample, 1_000, ctx))).toBe(true);
    expect(s3.requests[1].send).toBe(r.sample.arrival + 2_000);
  });

  it('S10i: a large zip whose download ends after the settle point → no wait, one settle GET', async () => {
    const s3 = new FakeS3();
    s3.write(2_500, '"ours"', 'big-zip');
    await at(3_000);
    const ctx = setup(s3, 1_000, 3_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    s3.rt = 20_000; // a slow full GET
    const buf = await run(downloadPinned(URL_, r.sample, ctx));
    expect(Buffer.isBuffer(buf)).toBe(true);
    s3.rt = 100;
    const entered = performance.now();
    expect(await run(settleCheck(URL_, r.sample, 3_000, ctx))).toBe(true);
    expect(s3.requests.length).toBe(3);
    expect(s3.requests[2].send).toBe(entered);
  });

  it('S7g: runs under its own limit when the step 2–6 deadline has expired', async () => {
    const s3 = new FakeS3();
    s3.write(2_500, '"ours"', 'zip');
    await at(3_000);
    const ctx = setup(s3, 1_000, 3_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    const expired = manualDeadline(0);
    expired.abort();
    expect(await run(settleCheck(URL_, r.sample, 3_000, { ...ctx, deadline: expired }))).toBe(true);
  });

  it('no answer within 30 s after the wait → object_settle_changed', async () => {
    const s3 = new FakeS3();
    s3.write(2_500, '"ours"', 'zip');
    await at(3_000);
    const ctx = setup(s3, 1_000, 3_000);
    const r = await run(pinObject(URL_, ctx));
    if (!('sample' in r)) throw new Error('not pinned');
    s3.rt = 60_000;
    expect(await run(settleCheck(URL_, r.sample, 3_000, ctx))).toEqual({ reason: 'object_settle_changed' });
  });

  it('a 403/404 at the settle point → object_settle_changed; a weak ETag → object_headers; Age → clock_uncertain', async () => {
    const cases: [Override, string][] = [
      [{ status: 404 }, 'object_settle_changed'],
      [{ status: 403 }, 'object_settle_changed'],
      [{ headers: { etag: 'W/"ours"' } }, 'object_headers'],
      [{ headers: { age: '1' } }, 'clock_uncertain'],
      [{ headers: { etag: 'ours' } }, 'object_headers'],
    ];
    for (const [ov, reason] of cases) {
      const s3 = new FakeS3();
      const success = performance.now();
      s3.write(success - 500, '"ours"', 'zip');
      await at(success + 100);
      const ctx = setup(s3, success - 1_000, success);
      const r = await run(pinObject(URL_, ctx));
      if (!('sample' in r)) throw new Error('not pinned');
      s3.override = () => ov;
      expect(await run(settleCheck(URL_, r.sample, success, ctx))).toEqual({ reason });
    }
  });
});

describe('S20: the signed URL never leaves the module', () => {
  it('no result carries X-Amz- or a query, even when the transport error names the URL', async () => {
    const leaky = axios.create({
      adapter: async (config) => { throw new Error(`connect failed for ${config.url ?? ''}`); },
    });
    const s3 = new FakeS3();
    s3.write(0, '"x"', 'body');
    const ctx = setup(s3, 0, 0, { http: leaky });
    const pin: HeaderSample = {
      send: 0, arrival: 10, dateMs: OFFSET, lastModifiedMs: OFFSET, etag: '"x"', total: 4, age: false,
    };
    const results: unknown[] = [];
    results.push(await run(pinObject(URL_, ctx)));
    results.push(await run(downloadPinned(URL_, pin, ctx)));
    results.push(await run(settleCheck(URL_, pin, 0, ctx)));
    for (const res of results) {
      const text = JSON.stringify(res);
      expect(text).not.toContain('X-Amz-');
      expect(text).not.toContain('?');
    }
  });
});
