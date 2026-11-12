/**
 * The overload answer through the REAL client, not a stubbed `request`: the
 * client tests and the listing tests each pass on their own, so this pins the
 * seam between them. Vocareum answers HTTP 200 with a plain-text
 * "VOCAREUM-ERROR: … heavy traffic …" body under load (probed 2026-11-11:
 * 5 of 24 listing requests on courses 215500 and 240788).
 */
import { describe, expect, it } from 'vitest';
import { VocareumClient, isOverloadError } from '../../src/api/client';
import type { AuthProvider } from '../../src/api/auth/auth-provider';
import { listFiles, waitForPartUpdateTransaction } from '../../src/api/content';
import { waitForAssignmentObjId } from '../../src/api/assignments';
import { updatePart } from '../../src/api/parts';

const NO_THROTTLE = { maxConcurrency: 1, minIntervalMs: 0, jitter: false } as const;
const THROTTLE_BODY =
  'VOCAREUM-ERROR: Sorry, your access to Vocareum is temporarily unavailable due to heavy traffic, ' +
  'you may re-connect later. If issues persist, please contact Vocareum technical support\n';

class FakeProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  async getAuthorizationHeader() { return 'Token fake'; }
}

interface Req { url?: string; params?: Record<string, unknown>; method?: string }

/** A client whose transport is `answer`; returns the data or a throttle text per call. */
function clientWith(answer: (req: Req, call: number) => unknown) {
  const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
  let call = 0;
  (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter =
    async (config: Req) => {
      call += 1;
      return { data: answer(config, call), status: 200, statusText: 'OK', headers: {}, config };
    };
  return { client, calls: () => call };
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);

/** The real listing shape, paged at 100. */
function listingPage(all: string[], page: number) {
  return { courseid: 'c', assignmentid: 'a', partid: 'p', directory: '/voc/startercode', files: all.slice(page * 100, page * 100 + 100) };
}

describe('listing through the real client', () => {
  it('a throttled later page is retried, and the listing is complete', async () => {
    const all = names(150);
    let throttledOnce = false;
    const { client } = clientWith((req) => {
      const page = (req.params?.page as number | undefined) ?? 0;
      if (page === 1 && !throttledOnce) { throttledOnce = true; return THROTTLE_BODY; }
      return listingPage(all, page);
    });
    const entries = await listFiles(client, 'c', 'a', 'p', 'startercode', 'container');
    expect(entries.map((e) => e.path)).toEqual(all);
  }, 10_000);

  it('a page that stays throttled fails the listing; it never ends it short', async () => {
    const all = names(150);
    const { client } = clientWith((req) => {
      const page = (req.params?.page as number | undefined) ?? 0;
      return page === 1 ? THROTTLE_BODY : listingPage(all, page);
    });
    const err = await listFiles(client, 'c', 'a', 'p', 'startercode', 'container').catch((e: unknown) => e);
    expect(isOverloadError(err)).toBe(true);
  }, 10_000);

  it('a throttled page 0 fails the listing; the directory never reads as empty', async () => {
    const { client } = clientWith(() => THROTTLE_BODY);
    const err = await listFiles(client, 'c', 'a', 'p', 'startercode', 'container').catch((e: unknown) => e);
    expect(isOverloadError(err)).toBe(true);
  }, 10_000);
});

describe('a non-listing body is described without secrets', () => {
  it('redacts a text body before shortening it, and redacts object keys', async () => {
    const text = `https://user:SECRETPW${'x'.repeat(200)}@example.com/x`;
    const a = clientWith(() => text);
    const errA = await listFiles(a.client, 'c', 'a', 'p', 'startercode', 'container').catch((e: unknown) => e as Error);
    expect(errA.message).toMatch(/not a file listing/);
    expect(errA.message).not.toMatch(/SECRETPW/);

    const b = clientWith(() => ({ 'https://u:KEYSECRET@host/x?token=TOKSECRET': 1 }));
    const errB = await listFiles(b.client, 'c', 'a', 'p', 'startercode', 'container').catch((e: unknown) => e as Error);
    expect(errB.message).toMatch(/not a file listing/);
    expect(errB.message).not.toMatch(/KEYSECRET|TOKSECRET/);
  });
});

describe('transaction polls ride out an overloaded sample', () => {
  // Before the fix a text sample had no `state` and the poll simply polled
  // again. Throwing would abandon a running job: an upload's later chunks
  // would never be sent.
  const throttleThenSuccess = (overloadedSamples: number) => (req: Req, call: number) =>
    String(req.url).startsWith('/transaction/') && call <= overloadedSamples * 3
      ? THROTTLE_BODY
      : { status: 'success', state: 'success', objid: 'obj-1' };

  it('part update poll', async () => {
    const { client } = clientWith(throttleThenSuccess(1));
    await expect(waitForPartUpdateTransaction(client, 't1', { maxAttempts: 5, delayMs: 1 })).resolves.toBeUndefined();
  }, 15_000);

  it('assignment copy poll', async () => {
    const { client } = clientWith(throttleThenSuccess(1));
    await expect(waitForAssignmentObjId(client, 't1', { maxAttempts: 5, delayMs: 1, timeoutMs: 60_000 })).resolves.toBe('obj-1');
  }, 15_000);

  it('part settings update poll', async () => {
    const { client } = clientWith((req, call) => {
      if (req.method?.toUpperCase() === 'PUT') { return { status: 'success', transactionid: 't1' }; }
      return call <= 4 ? THROTTLE_BODY : { status: 'success', state: 'success' };
    });
    await expect(updatePart(client, 'c', 'a', 'p', {} as never)).resolves.toBeUndefined();
  }, 30_000);

  it('a poll that only ever sees the overload still times out (it does not spin forever)', async () => {
    const { client } = clientWith(() => THROTTLE_BODY);
    await expect(waitForPartUpdateTransaction(client, 't1', { maxAttempts: 2, delayMs: 1 })).rejects.toThrow(/Timed out/);
  }, 20_000);

  it('each overloaded sample is ONE request: no retry cycle (1 s + 2 s backoff) inside a sample', async () => {
    // Total request counts can coincide either way, so time it: with a retry
    // cycle per sample, two overloaded samples cost at least 1 s of backoff.
    let transactionCalls = 0;
    const { client } = clientWith(() => {
      transactionCalls += 1;
      return transactionCalls <= 2 ? THROTTLE_BODY : { status: 'success', state: 'success' };
    });
    const started = Date.now();
    await waitForPartUpdateTransaction(client, 't1', { maxAttempts: 5, delayMs: 1 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(transactionCalls).toBe(3);
  });

  it('ignores a huge Retry-After inside a poll (the poll keeps its own pace and deadline)', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    let call = 0;
    (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter =
      async (config: Req) => {
        call += 1;
        return call === 1
          ? { data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: { 'retry-after': '86400' }, config }
          : { data: { status: 'success', state: 'success', objid: 'obj-1' }, status: 200, statusText: 'OK', headers: {}, config };
      };
    const started = Date.now();
    await expect(waitForAssignmentObjId(client, 't1', { maxAttempts: 5, delayMs: 1, timeoutMs: 60_000 })).resolves.toBe('obj-1');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a real failure state still fails the poll at once', async () => {
    const { client } = clientWith(() => ({ status: 'success', state: 'failed', message: 'unzip failed' }));
    await expect(waitForPartUpdateTransaction(client, 't1', { maxAttempts: 5, delayMs: 1 })).rejects.toThrow(/unzip failed/);
  });
});
