/**
 * The shared S3 object of a zip pull: pin it, download it, then check it
 * settled (spec step 4 "Pin the object, then download it" and step 4a "Settle
 * check"). This module decides whether a zip's bytes are trusted.
 *
 * Every request goes through the bare axios instance in `ctx.http`, never
 * `VocareumClient`: S3 must not receive an Authorization header, and S3
 * requests do not take Vocareum scheduler slots.
 *
 * Nothing here throws on an HTTP or transport failure; each outcome is a
 * `ZipNotUsedReason`. The signed URL never appears in a result: a reason is a
 * fixed string, so no error message (which can carry the URL) escapes.
 */
import type { AxiosInstance, AxiosResponse } from 'axios';
import type { Readable } from 'node:stream';
import { abortableSleep, type Deadline } from './deadline';
import {
  clockUncertain,
  isPastWindow,
  isStale,
  settleDateOk,
  settleWaitUntil,
  type HeaderSample,
} from './zip-clock';
import type { ZipNotUsedReason } from '../core/diagnostics';

/** Everything the pin, download and settle steps need for one directory. */
export interface ZipObjectContext {
  /** The monotonic clock (`performance.now()` in production). */
  now: () => number;
  /** A bare axios instance: no auth, no Vocareum interceptors. */
  http: AxiosInstance;
  /** The step 2–6 deadline. The settle check does not use it. */
  deadline: Deadline;
  /** Bytes left in the pull's `maxTotalBytes` budget. */
  maxBytes: number;
  /** ETags already pinned for this part in this run; each pin adds its own. */
  seen: Set<string>;
  /** Monotonic time the zip start request was sent. */
  jobStart: number;
  /** Monotonic time the poll response reporting `success` arrived. */
  success: number;
}

/** Why the zip is not used. */
export interface NotUsed { reason: ZipNotUsedReason }

const STALE_RETRIES = 5;
const STALE_RETRY_MS = 1_000;
const ATTEMPT_TIMEOUT_MS = 30_000;
/** The settle GET is sent at least this long after the pin's arrival. */
const SETTLE_SPACING_MS = 2_000;
/** The settle GET must answer within this long after the wait ends. */
const SETTLE_LIMIT_MS = 30_000;

/** A strong ETag: one quoted string. `W/"…"`, unquoted or empty values refuse. */
const STRONG_ETAG = /^"[^"]*"$/;
/** The total of a `bytes=0-0` answer. `*` (unknown size) refuses. */
const CONTENT_RANGE = /^bytes 0-0\/(\d+)$/;

/** The outcome of one ranged GET, before any staleness or clock rule. */
type Probe =
  | { kind: 'sample'; sample: HeaderSample }
  /** 403 or 404: our upload may not have landed yet. */
  | { kind: 'absent' }
  /** Any other status, or a missing or malformed header. */
  | { kind: 'headers' }
  /** Transport error or timeout. */
  | { kind: 'failed' }
  /** The governing signal fired. */
  | { kind: 'aborted' };

function isReadable(data: unknown): data is Readable {
  return typeof data === 'object' && data !== null &&
    typeof (data as Readable).on === 'function' && typeof (data as Readable).destroy === 'function';
}

/** Drop a response body without reading it. */
function discard(data: unknown): void {
  if (isReadable(data)) {data.destroy();}
}

function header(res: AxiosResponse, name: string): string | undefined {
  const h = res.headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  const v = typeof h.get === 'function' ? h.get(name) : h[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve with the request, or reject as soon as `signal` fires. axios only
 * cancels when its adapter honours the signal; this does not depend on that.
 * A response that arrives after the abort has its body dropped.
 */
function raceAbort(request: Promise<AxiosResponse>, signal: AbortSignal): Promise<AxiosResponse> {
  return new Promise<AxiosResponse>((resolve, reject) => {
    const onAbort = (): void => { reject(new Error('aborted')); };
    if (signal.aborted) {onAbort();}
    else {signal.addEventListener('abort', onAbort, { once: true });}
    request.then(
      (res) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {discard(res.data);}
        resolve(res);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error('request failed'));
      },
    );
  });
}

/** Read the first chunk (the one byte of a 206), then destroy the stream. */
function readOneByte(data: unknown, signal: AbortSignal): Promise<void> {
  if (!isReadable(data)) {return Promise.resolve();}
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      data.off('data', finish);
      data.off('end', finish);
      data.off('error', finish);
      signal.removeEventListener('abort', finish);
      data.destroy();
      resolve();
    };
    if (signal.aborted) { finish(); return; }
    data.on('data', finish);
    data.on('end', finish);
    data.on('error', finish);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Stream a body into one buffer preallocated from the pinned total; never
 * concatenated. A body longer or shorter than `total` is `failed`.
 */
function readInto(data: unknown, total: number, signal: AbortSignal): Promise<Buffer | 'failed' | 'aborted'> {
  if (!isReadable(data)) {
    discard(data);
    return Promise.resolve('failed');
  }
  return new Promise((resolve) => {
    const buf = Buffer.alloc(total);
    let offset = 0;
    let settled = false;
    const done = (result: Buffer | 'failed' | 'aborted'): void => {
      if (settled) {return;}
      settled = true;
      data.off('data', onData);
      data.off('end', onEnd);
      data.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (result !== buf) {data.destroy();}
      resolve(result);
    };
    const onData = (chunk: unknown): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (offset + bytes.length > total) { done('failed'); return; }
      bytes.copy(buf, offset);
      offset += bytes.length;
    };
    const onEnd = (): void => { done(offset === total ? buf : 'failed'); };
    const onError = (): void => { done('failed'); };
    const onAbort = (): void => { done('aborted'); };
    if (signal.aborted) { done('aborted'); return; }
    data.on('data', onData);
    data.on('end', onEnd);
    data.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One ranged GET (`Range: bytes=0-0`), streamed so that a 200 with the full
 * body is never buffered. `send` and `arrival` bracket the headers.
 */
async function rangedGet(
  url: string, http: AxiosInstance, now: () => number, signal: AbortSignal, timeoutMs: number,
): Promise<Probe> {
  const send = now();
  let res: AxiosResponse;
  try {
    res = await raceAbort(http.get(url, {
      // Authorization: false removes any default the instance might carry: S3 gets no credentials.
      headers: { Range: 'bytes=0-0', Authorization: false },
      responseType: 'stream',
      maxRedirects: 0,
      timeout: timeoutMs,
      signal,
      validateStatus: () => true,
    }), signal);
  } catch {
    return signal.aborted ? { kind: 'aborted' } : { kind: 'failed' };
  }
  const arrival = now();
  if (res.status === 403 || res.status === 404) {
    discard(res.data);
    return { kind: 'absent' };
  }
  if (res.status !== 206) {
    discard(res.data);
    return { kind: 'headers' };
  }
  await readOneByte(res.data, signal);

  const etag = header(res, 'etag');
  const dateMs = Date.parse(header(res, 'date') ?? '');
  const lastModifiedMs = Date.parse(header(res, 'last-modified') ?? '');
  const range = CONTENT_RANGE.exec(header(res, 'content-range') ?? '');
  const total = range ? Number(range[1]) : NaN;
  if (
    etag === undefined || !STRONG_ETAG.test(etag) ||
    !Number.isFinite(dateMs) || !Number.isFinite(lastModifiedMs) ||
    !Number.isSafeInteger(total) || total < 1
  ) {
    return { kind: 'headers' };
  }
  const age = header(res, 'age') !== undefined;
  return { kind: 'sample', sample: { send, arrival, dateMs, lastModifiedMs, etag, total, age } };
}

function deadlinePassed(deadline: Deadline): boolean {
  return deadline.signal.aborted || deadline.remainingMs() <= 0;
}

/**
 * Pin the object: a ranged GET that must answer 206 with a strong ETag,
 * `Last-Modified`, `Date` and a `Content-Range` total, within a 2 s round trip
 * and without `Age`. A stale object (ETag already seen, or certainly written
 * before the job), a 403 or a 404 is retried up to 5 times, 1 s apart, under
 * the deadline. An object written after the window is refused at once.
 *
 * On success the ETag is added to `ctx.seen`, whether or not the zip is used
 * later: the next directory must never pin it.
 *
 * @returns the pinned sample, or why the zip is not used
 */
export async function pinObject(url: string, ctx: ZipObjectContext): Promise<{ sample: HeaderSample } | NotUsed> {
  for (let attempt = 0; attempt <= STALE_RETRIES; attempt++) {
    if (attempt > 0) {
      try {
        await abortableSleep(STALE_RETRY_MS, ctx.deadline.signal);
      } catch {
        return { reason: 'deadline' };
      }
    }
    // Never start an attempt with no time left: axios reads a 0 timeout as "none".
    const left = ctx.deadline.remainingMs();
    if (deadlinePassed(ctx.deadline)) {return { reason: 'deadline' };}
    const probe = await rangedGet(url, ctx.http, ctx.now, ctx.deadline.signal, Math.min(ATTEMPT_TIMEOUT_MS, left));
    switch (probe.kind) {
      case 'aborted':
        return { reason: 'deadline' };
      case 'failed':
        // A timeout clamped to the time left is the deadline, not a transport fault.
        return { reason: deadlinePassed(ctx.deadline) ? 'deadline' : 'object_headers' };
      case 'headers':
        return { reason: 'object_headers' };
      case 'absent':
        continue;
      case 'sample': {
        const s = probe.sample;
        if (clockUncertain(s)) {return { reason: 'clock_uncertain' };}
        if (isStale(s, ctx.jobStart, ctx.seen)) {continue;}
        if (isPastWindow(s, ctx.success)) {return { reason: 'object_window' };}
        ctx.seen.add(s.etag);
        return { sample: s };
      }
    }
  }
  return { reason: 'object_stale' };
}

/**
 * Download the pinned object with `If-Match: <pinned ETag>`, no Authorization
 * and no redirects, under the deadline. A total over the remaining budget is
 * refused before the GET. The body goes into one buffer of exactly the pinned
 * total.
 *
 * @returns the zip bytes, or why the zip is not used (412 → `object_changed`)
 */
export async function downloadPinned(url: string, sample: HeaderSample, ctx: ZipObjectContext): Promise<Buffer | NotUsed> {
  if (sample.total > ctx.maxBytes) {return { reason: 'zip_over_budget' };}
  const left = ctx.deadline.remainingMs();
  if (deadlinePassed(ctx.deadline)) {return { reason: 'deadline' };}
  const signal = ctx.deadline.signal;
  let res: AxiosResponse;
  try {
    res = await raceAbort(ctx.http.get(url, {
      headers: { 'If-Match': sample.etag, Authorization: false },
      responseType: 'stream',
      maxRedirects: 0,
      timeout: left,
      signal,
      validateStatus: () => true,
    }), signal);
  } catch {
    return { reason: deadlinePassed(ctx.deadline) ? 'deadline' : 'object_download_failed' };
  }
  if (res.status === 412) {
    discard(res.data);
    return { reason: 'object_changed' };
  }
  if (res.status !== 200) {
    discard(res.data);
    return { reason: 'object_download_failed' };
  }
  const body = await readInto(res.data, sample.total, signal);
  if (Buffer.isBuffer(body)) {return body;}
  return { reason: body === 'aborted' || deadlinePassed(ctx.deadline) ? 'deadline' : 'object_download_failed' };
}

/**
 * The settle check, run right after the full GET and before inflation. Wait
 * until the S3 clock has certainly passed `success + 5 s` and at least 2 s after
 * the pin arrived (monotonic), then repeat the ranged GET under the check's own
 * 30 s limit, not the step 2–6 deadline, which may have expired. The ETag must
 * equal the pinned one and S3's `Date` must agree the settle point passed.
 *
 * @param success - monotonic time the poll response reporting `success` arrived
 * @returns true if the pinned object settled; otherwise why the zip is not used
 */
export async function settleCheck(
  url: string, pin: HeaderSample, success: number, ctx: ZipObjectContext,
): Promise<true | NotUsed> {
  const controller = new AbortController();
  const until = Math.max(settleWaitUntil(pin, success), pin.arrival + SETTLE_SPACING_MS);
  try {
    // Loop: a timer may fire a fraction of a millisecond early against `ctx.now`.
    for (let wait = until - ctx.now(); wait > 0; wait = until - ctx.now()) {
      await abortableSleep(wait, controller.signal);
    }
  } catch {
    return { reason: 'object_settle_changed' };
  }

  const timer = setTimeout(() => { controller.abort(); }, SETTLE_LIMIT_MS);
  // unref: a pending limit must not keep the process alive.
  (timer as { unref?: () => void }).unref?.();
  let probe: Probe;
  try {
    probe = await rangedGet(url, ctx.http, ctx.now, controller.signal, SETTLE_LIMIT_MS);
  } finally {
    clearTimeout(timer);
  }

  switch (probe.kind) {
    case 'aborted':
    case 'failed':
    case 'absent':
      return { reason: 'object_settle_changed' };
    case 'headers':
      return { reason: 'object_headers' };
    case 'sample': {
      const s = probe.sample;
      if (clockUncertain(s)) {return { reason: 'clock_uncertain' };}
      if (s.etag !== pin.etag) {return { reason: 'object_settle_changed' };}
      if (!settleDateOk(pin, s, success)) {return { reason: 'object_settle_changed' };}
      return true;
    }
  }
}
