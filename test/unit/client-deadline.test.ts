/**
 * Spec step 2 "Deadline": the per-directory deadline as the client enforces it.
 * Every test drives the REAL client through a custom axios adapter, so the
 * interceptor, the scheduler and the retry loop are all in the path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, CanceledError } from 'axios';
import { AuthenticationError, VocareumClient } from '../../src/api/client';
import { DeadlineError, abortableSleep, createDeadline } from '../../src/api/deadline';
import { OAuthClientCredentialsProvider } from '../../src/api/auth/oauth-provider';
import { RequestScheduler } from '../../src/api/scheduler';
import type { AuthProvider } from '../../src/api/auth/auth-provider';

const ONE_SLOT = { maxConcurrency: 1, minIntervalMs: 0, jitter: false } as const;

interface SeenConfig {
  url?: string;
  timeout?: number;
  signal?: AbortSignal;
  headers: { get(name: string): unknown };
}
type Answer = (config: SeenConfig, call: number) => unknown;

/** A token-auth provider (no refreshAfterUnauthorized: a 401 is terminal). */
class TokenProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  async getAuthorizationHeader() { return 'Token fake'; }
}

/** An OAuth-like provider: a refresh changes the header the next read returns. */
class RefreshingProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  generation = 1;
  refreshed = 0;
  async getAuthorizationHeader() { return `Bearer gen${this.generation}`; }
  async refreshAfterUnauthorized() { this.refreshed += 1; this.generation += 1; }
}

function response(config: SeenConfig, status: number, data: unknown = {}, headers: Record<string, string> = {}) {
  return { data, status, statusText: '', headers, config };
}

function httpError(config: SeenConfig, status: number, headers: Record<string, string> = {}): AxiosError {
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE',
    config as never, {}, response(config, status, {}, headers) as never);
}

/** The real client with `answer` as its transport. `answer` may return a response or throw. */
function clientWith(provider: AuthProvider, answer: Answer, scheduler?: RequestScheduler) {
  const client = new VocareumClient(provider, ONE_SLOT, scheduler);
  const seen: SeenConfig[] = [];
  (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter =
    async (config: SeenConfig) => {
      seen.push(config);
      const out = await answer(config, seen.length);
      return out ?? response(config, 200, { ok: true });
    };
  return { client, seen };
}

function activeCount(scheduler: RequestScheduler): number {
  return (scheduler as unknown as { activeCount: number }).activeCount;
}

afterEach(() => { vi.useRealTimers(); });

describe('deadline primitives', () => {
  it('createDeadline counts down on the injected clock and aborts with a DeadlineError', async () => {
    let t = 1_000;
    const d = createDeadline(50, () => t);
    expect(d.remainingMs()).toBe(50);
    t += 20;
    expect(d.remainingMs()).toBe(30);
    expect(d.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(d.signal.aborted).toBe(true);
    expect(d.signal.reason).toBeInstanceOf(DeadlineError);
  });

  it('a deadline of 0 ms is aborted at once', () => {
    const d = createDeadline(0);
    expect(d.signal.aborted).toBe(true);
    expect(d.remainingMs()).toBeLessThanOrEqual(0);
  });

  it('DeadlineError is an APIError that is never retryable', () => {
    const e = new DeadlineError();
    expect(e.retryable).toBe(false);
    expect(e.name).toBe('DeadlineError');
  });

  it('abortableSleep resolves after the delay, and rejects with the reason on abort', async () => {
    await expect(abortableSleep(5)).resolves.toBeUndefined();
    const ac = new AbortController();
    const p = abortableSleep(60_000, ac.signal);
    ac.abort(new DeadlineError());
    await expect(p).rejects.toBeInstanceOf(DeadlineError);
    const pre = new AbortController();
    pre.abort(new DeadlineError());
    await expect(abortableSleep(60_000, pre.signal)).rejects.toBeInstanceOf(DeadlineError);
  });
});

describe('S7c: no attempt with 0 ms left', () => {
  it('a deadline already at 0 sends nothing', async () => {
    const { client, seen } = clientWith(new TokenProvider(), () => undefined);
    await expect(client.request({ url: '/x' }, { deadline: createDeadline(0) }))
      .rejects.toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(0);
  });

  it('the clock reaching the deadline before the timer fires still sends nothing', async () => {
    let t = 0;
    const deadline = createDeadline(10_000, () => t);
    t = 10_000; // signal not yet aborted: only remainingMs() says so
    const { client, seen } = clientWith(new TokenProvider(), () => undefined);
    await expect(client.request({ url: '/x' }, { deadline, zipAuth: true }))
      .rejects.toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(0);
  });

  it('time running out during the scheduler wait sends nothing once the slot is granted', async () => {
    let t = 0;
    const deadline = createDeadline(10_000, () => t);
    let releaseBlocker!: () => void;
    const scheduler = new RequestScheduler(ONE_SLOT);
    const { client, seen } = clientWith(new TokenProvider(), (config) => {
      if (config.url === '/blocker') { return new Promise((r) => { releaseBlocker = () => r(undefined); }); }
      return undefined;
    }, scheduler);
    const blocker = client.request({ url: '/blocker' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const zip = client.request({ url: '/zip' }, { deadline, zipAuth: true });
    const zipOutcome = zip.catch((e: unknown) => e);
    t = 10_000;
    releaseBlocker();
    await blocker;
    expect(await zipOutcome).toBeInstanceOf(DeadlineError);
    expect(seen.map((c) => c.url)).toEqual(['/blocker']);
    expect(activeCount(scheduler)).toBe(0);
  });

  it('each attempt carries timeout min(30 s, time left), floored, and the deadline signal', async () => {
    let t = 0;
    const far = createDeadline(600_000, () => t);
    const near = createDeadline(5_000.7, () => t);
    const { client, seen } = clientWith(new TokenProvider(), () => undefined);
    await client.request({ url: '/far' }, { deadline: far });
    await client.request({ url: '/near' }, { deadline: near });
    expect(seen[0].timeout).toBe(30_000);
    expect(seen[0].signal).toBe(far.signal);
    expect(seen[1].timeout).toBe(5_000);
    expect(seen[1].signal).toBe(near.signal);
  });

  it('callers without a deadline keep the client timeout and send no signal', async () => {
    const { client, seen } = clientWith(new TokenProvider(), () => undefined);
    await client.request({ url: '/x' });
    expect(seen[0].timeout).toBe(30_000);
    expect(seen[0].signal).toBeUndefined();
  });
});

describe('S7d: the token is obtained before the scheduler slot', () => {
  const V3 = 'https://labs.vocareum.com/api/v3';
  const TOKEN_URL = 'https://labs.vocareum.com/api/v3/oauth/token';

  it('a 20 s exchange with 1 s left: the zip request fails without the slot; a listing succeeds after', async () => {
    vi.useFakeTimers();
    let posts = 0;
    const provider = new OAuthClientCredentialsProvider({
      clientId: 'id', clientSecret: 'secret', apiBaseUrl: V3, tokenUrl: TOKEN_URL,
      now: () => Date.now(),
      httpPost: () => {
        posts += 1;
        return new Promise((resolve) => setTimeout(
          () => resolve({ data: { access_token: 'tok', expires_in: 3600 } }), 20_000));
      },
    });
    const scheduler = new RequestScheduler(ONE_SLOT);
    const { client, seen } = clientWith(provider, () => undefined, scheduler);

    const listing = client.request({ url: '/listing' });
    const zip = client.request({ url: '/zip' }, { deadline: createDeadline(1_000, () => Date.now()), zipAuth: true })
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await zip).toBeInstanceOf(DeadlineError);
    // The listing still holds the only slot, awaiting the shared exchange.
    expect(activeCount(scheduler)).toBe(1);

    await vi.advanceTimersByTimeAsync(19_000);
    await expect(listing).resolves.toEqual({ ok: true });
    expect(posts).toBe(1); // the shared exchange was never cancelled or repeated
    expect(seen.map((c) => c.url)).toEqual(['/listing']);
    expect(seen[0].headers.get('Authorization')).toBe('Bearer tok');
    expect(activeCount(scheduler)).toBe(0);
  });

  it('variant: a 401 clears the cache after the prefetch; the interceptor is skipped for the zip request', async () => {
    let posts = 0;
    const provider = new OAuthClientCredentialsProvider({
      clientId: 'id', clientSecret: 'secret', apiBaseUrl: V3, tokenUrl: TOKEN_URL,
      httpPost: () => { posts += 1; return Promise.resolve({ data: { access_token: `tok${posts}`, expires_in: 3600 } }); },
    });
    const headerReads = vi.spyOn(provider, 'getAuthorizationHeader');
    const scheduler = new RequestScheduler(ONE_SLOT);
    let releaseBlocker!: () => void;
    const { client, seen } = clientWith(provider, (config) => {
      if (config.url === '/blocker') { return new Promise((r) => { releaseBlocker = () => r(undefined); }); }
      return undefined;
    }, scheduler);

    const blocker = client.request({ url: '/blocker' });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    const zip = client.request({ url: '/zip' }, { deadline: createDeadline(60_000), zipAuth: true });
    await vi.waitFor(() => expect(headerReads).toHaveBeenCalledTimes(2)); // blocker's interceptor + zip's prefetch
    await provider.refreshAfterUnauthorized(); // a concurrent 401 cleared the cache
    releaseBlocker();
    await blocker;
    await expect(zip).resolves.toEqual({ ok: true });

    expect(headerReads).toHaveBeenCalledTimes(2); // no read inside the zip request's slot
    expect(posts).toBe(1); // so no exchange ran inside the slot
    expect(seen[1].url).toBe('/zip');
    expect(seen[1].headers.get('Authorization')).toBe('Bearer tok1');
  });
});

describe('S7f: deadline failures are not retried; 401 replay rules', () => {
  it('ERR_CANCELED becomes a DeadlineError after 1 attempt', async () => {
    const { client, seen } = clientWith(new TokenProvider(), () => { throw new CanceledError('canceled'); });
    await expect(client.request({ url: '/x' }, { deadline: createDeadline(60_000), backoff: 1 }))
      .rejects.toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(1);
  });

  it('a clamped timeout (ECONNABORTED) becomes a DeadlineError after 1 attempt', async () => {
    const { client, seen } = clientWith(new TokenProvider(), (config) => {
      throw new AxiosError(`timeout of ${config.timeout}ms exceeded`, 'ECONNABORTED', config as never);
    });
    await expect(client.request({ url: '/x' }, { deadline: createDeadline(5_000), backoff: 1 }))
      .rejects.toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(1);
    expect(seen[0].timeout).toBeLessThanOrEqual(5_000);
  });

  it('a 30 s timeout with time left is retried', async () => {
    const { client, seen } = clientWith(new TokenProvider(), (config, call) => {
      if (call === 1) { throw new AxiosError('timeout of 30000ms exceeded', 'ECONNABORTED', config as never); }
      return undefined;
    });
    await expect(client.request({ url: '/x' }, { deadline: createDeadline(600_000), backoff: 1 }))
      .resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[0].timeout).toBe(30_000);
  });

  it('a poll 401 with 0 ms left is not replayed', async () => {
    let t = 0;
    const deadline = createDeadline(10_000, () => t);
    const provider = new RefreshingProvider();
    const { client, seen } = clientWith(provider, (config) => { t = 10_000; throw httpError(config, 401); });
    await expect(client.request({ url: '/poll' }, { deadline, zipAuth: true }))
      .rejects.toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(1);
    expect(provider.refreshed).toBe(0);
  });

  it('a poll 401 with time left under OAuth is replayed once with the new header; no slot is left held', async () => {
    const provider = new RefreshingProvider();
    const scheduler = new RequestScheduler(ONE_SLOT);
    const { client, seen } = clientWith(provider, (config, call) => {
      if (call === 1) { throw httpError(config, 401); }
      return undefined;
    }, scheduler);
    await expect(client.request({ url: '/poll' }, { deadline: createDeadline(60_000), zipAuth: true }))
      .resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(provider.refreshed).toBe(1);
    expect(seen[0].headers.get('Authorization')).toBe('Bearer gen1');
    expect(seen[1].headers.get('Authorization')).toBe('Bearer gen2');
    // Review Focus 4: the refresh ran outside the slot and nothing leaked.
    expect(activeCount(scheduler)).toBe(0);
  });

  it('a poll 401 under token auth is terminal, with no second request', async () => {
    const { client, seen } = clientWith(new TokenProvider(), (config) => { throw httpError(config, 401); });
    await expect(client.request({ url: '/poll' }, { deadline: createDeadline(60_000), zipAuth: true }))
      .rejects.toBeInstanceOf(AuthenticationError);
    expect(seen).toHaveLength(1);
  });

  it('noAuthReplay suppresses the replay even under OAuth', async () => {
    const provider = new RefreshingProvider();
    const { client, seen } = clientWith(provider, (config) => { throw httpError(config, 401); });
    await expect(client.request({ url: '/start', method: 'POST' },
      { deadline: createDeadline(60_000), zipAuth: true, noAuthReplay: true, maxRetries: 1 }))
      .rejects.toBeInstanceOf(AuthenticationError);
    expect(seen).toHaveLength(1);
    expect(provider.refreshed).toBe(0);
  });
});

describe('Retry-After against the deadline', () => {
  it('Retry-After: 120 with 5 s left fails at once with a DeadlineError, without sleeping', async () => {
    vi.useFakeTimers();
    const { client, seen } = clientWith(new TokenProvider(), (config) => {
      throw httpError(config, 429, { 'retry-after': '120' });
    });
    const outcome = client.request({ url: '/poll' }, { deadline: createDeadline(5_000, () => Date.now()) })
      .catch((e: unknown) => e);
    // No timer is advanced: a sleep would leave the promise pending forever.
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(1);
  });

  it('a later retry delay that would pass the deadline fails at once', async () => {
    vi.useFakeTimers();
    const { client, seen } = clientWith(new TokenProvider(), (config) => {
      throw httpError(config, 429, { 'retry-after': '2' });
    });
    const outcome = client.request({ url: '/poll' }, { deadline: createDeadline(3_000, () => Date.now()), maxRetries: 5 })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await outcome).toBeInstanceOf(DeadlineError);
    expect(seen).toHaveLength(2); // t=0 and t=2 s; the second 2 s sleep would pass the deadline
  });
});
