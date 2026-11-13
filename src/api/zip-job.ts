/**
 * The Vocareum directory zip job (spec step 2 "Start the zip and poll for it"
 * and step 3 "Check the URL").
 *
 * Nothing here throws on an API failure; each outcome is a fixed reason. The
 * signed URL is only ever returned to the caller: it never goes into a reason,
 * an event or an error, because its query string is the credential.
 */
import { OverloadError, type VocareumClient } from './client';
import { DeadlineError, abortableSleep, type Deadline } from './deadline';

/** The part a zip is requested for. IDs are strings, as the API returns them. */
export interface ZipJobIds {
  courseId: string;
  assignmentId: string;
  partId: string;
}

/** Why the job gave no usable URL. */
export type ZipJobFailure = { reason: 'start_failed' | 'poll_failed' | 'deadline' | 'url_rejected' };

/** A finished job: its signed URL and the two monotonic instants step 4 needs. */
export interface ZipJobSuccess {
  url: string;
  /** Monotonic time just before the start request that created the job was sent. */
  jobStart: number;
  /** Monotonic time the poll response reporting `success` arrived. */
  success: number;
}

/** First poll wait; each later wait doubles, up to the cap. */
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 5_000;
/** The client's usual retry backoff, reused by the start loop's overload retries. */
const START_BACKOFF_MS = 1_000;

/** The start response's transaction id, or undefined when the job did not start. */
function transactionIdOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') { return undefined; }
  const { status, transactionid } = body as { status?: unknown; transactionid?: unknown };
  if (status !== 'success') { return undefined; }
  // IDs are strings; a numeric id is accepted and normalised so the poll matches.
  if (typeof transactionid === 'number' && Number.isFinite(transactionid)) { return String(transactionid); }
  if (typeof transactionid === 'string' && transactionid !== '') { return transactionid; }
  return undefined;
}

/** Step 3: only `https:`, and no user-info (a credential S3 must not receive). */
function urlAccepted(text: string): boolean {
  let parsed: URL;
  try { parsed = new URL(text); } catch { return false; }
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
}

/**
 * Start the zip of one directory and poll until it is ready.
 *
 * The start request is sent once per try (`maxRetries: 1`, no 401 replay): a
 * replayed start could leave an earlier job running unseen. Only the overload
 * answer is retried, by this loop, because it is the gateway refusing the
 * request, so no job was created. Polls by transaction id are idempotent and
 * use the client's retries; an overload answer there is a pending sample.
 *
 * Every request passes the deadline and `zipAuth`, so no token exchange runs
 * inside a scheduler slot.
 *
 * @param client - the Vocareum client
 * @param ids - the part's course, assignment and part ids
 * @param baseApiPath - the prefixed directory, e.g. `/voc/startercode`
 * @param deadline - the directory's step 2–6 deadline
 * @param now - the monotonic clock (`performance.now()` in production)
 * @returns the signed URL with `jobStart` and `success`, or the reason it was not obtained
 */
export async function runZipJob(
  client: VocareumClient,
  ids: ZipJobIds,
  baseApiPath: string,
  deadline: Deadline,
  now: () => number,
): Promise<ZipJobSuccess | ZipJobFailure> {
  const url = `/courses/${ids.courseId}/assignments/${ids.assignmentId}/parts/${ids.partId}/files`;

  // Start. No includeHidden: the zip must match the step-1/step-7 listings.
  // jobStart is read when the start is handed to axios (onSend), after the
  // token and the scheduler slot: an object written while we waited for
  // either is newer than the job's start and must fail the stale check.
  let jobStart = Number.NaN;
  let transactionId: string | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const body = await client.request<unknown>(
        { method: 'GET', url, params: { dir: baseApiPath } },
        { maxRetries: 1, noAuthReplay: true, deadline, zipAuth: true, onSend: () => { jobStart = now(); } },
      );
      transactionId = transactionIdOf(body);
      break;
    } catch (error) {
      if (error instanceof DeadlineError) { return { reason: 'deadline' }; }
      if (!(error instanceof OverloadError)) { return { reason: 'start_failed' }; }
      // Floored: a `Retry-After: 0` would otherwise restart at once, in a
      // tight loop of start requests until the deadline.
      const delayMs = error.retryAfter !== undefined
        ? Math.max(error.retryAfter * 1_000, START_BACKOFF_MS)
        : START_BACKOFF_MS * Math.pow(2, attempt);
      // A wait that reaches the deadline leaves no time for the next try.
      if (delayMs >= deadline.remainingMs()) { return { reason: 'deadline' }; }
      try { await abortableSleep(delayMs, deadline.signal); } catch { return { reason: 'deadline' }; }
    }
  }
  // NaN only if no attempt was ever handed to axios; never trust a start time
  // we did not observe (a NaN compares false and would pass the stale check).
  if (transactionId === undefined || Number.isNaN(jobStart)) { return { reason: 'start_failed' }; }

  // Poll. The waits are lower bounds: polls share the client's scheduler.
  let waitMs = FIRST_POLL_MS;
  for (;;) {
    try { await abortableSleep(waitMs, deadline.signal); } catch { return { reason: 'deadline' }; }
    waitMs = Math.min(waitMs * 2, MAX_POLL_MS);
    let body: unknown;
    try {
      body = await client.request<unknown>(
        { method: 'GET', url, params: { transactionid: transactionId } },
        { retryOverload: false, deadline, zipAuth: true },
      );
    } catch (error) {
      if (error instanceof DeadlineError) { return { reason: 'deadline' }; }
      if (error instanceof OverloadError) { continue; }
      return { reason: 'poll_failed' };
    }
    const arrived = now();
    const { state, message } = (body !== null && typeof body === 'object'
      ? body
      : {}) as { state?: unknown; message?: unknown };
    if (state === 'pending') { continue; }
    if (state !== 'success' || typeof message !== 'string') { return { reason: 'poll_failed' }; }
    if (!urlAccepted(message)) { return { reason: 'url_rejected' }; }
    return { url: message, jobStart, success: arrived };
  }
}
