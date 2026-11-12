import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { AxiosError } from 'axios';
import { normalizeApiBaseUrl, assertAllowedBaseUrl, VocareumClient, sanitizeForLog, sanitizeLogString } from '../../src/api/client';
import { OAuthTokenExchangeError } from '../../src/api/auth/oauth-provider';
import type { AuthProvider } from '../../src/api/auth/auth-provider';

const NO_THROTTLE = { maxConcurrency: 1, minIntervalMs: 0, jitter: false } as const;

class FakeProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  header = 'Token fake';
  // refreshed/refreshAfterUnauthorized are scaffolding exercised by the 401-retry task.
  refreshed = 0;
  async getAuthorizationHeader() { return this.header; }
  async refreshAfterUnauthorized() { this.refreshed += 1; }
}

describe('normalizeApiBaseUrl', () => {
  it('appends /api/v2 when no version path present', () => {
    expect(normalizeApiBaseUrl('https://api.vocareum.com')).toBe('https://api.vocareum.com/api/v2');
  });
  it('strips trailing slash then appends /api/v2', () => {
    expect(normalizeApiBaseUrl('https://api.vocareum.com/')).toBe('https://api.vocareum.com/api/v2');
  });
  it('leaves an existing version path untouched', () => {
    expect(normalizeApiBaseUrl('https://api.vocareum.com/api/v2')).toBe('https://api.vocareum.com/api/v2');
    expect(normalizeApiBaseUrl('https://labs.vocareum.com/api/v3')).toBe('https://labs.vocareum.com/api/v3');
  });
});

describe('assertAllowedBaseUrl', () => {
  it('accepts the canonical v2 host+path', () => {
    expect(() => assertAllowedBaseUrl('https://api.vocareum.com/api/v2')).not.toThrow();
  });
  it('accepts the canonical v3 host+path', () => {
    expect(() => assertAllowedBaseUrl('https://labs.vocareum.com/api/v3')).not.toThrow();
  });
  it('rejects a known host with an unexpected path', () => {
    expect(() => assertAllowedBaseUrl('https://api.vocareum.com/evil')).toThrow(/Insecure/);
  });
  it('rejects an unknown host', () => {
    expect(() => assertAllowedBaseUrl('https://evil.example.com/api/v2')).toThrow(/Insecure/);
  });
  it('rejects http', () => {
    expect(() => assertAllowedBaseUrl('http://api.vocareum.com/api/v2')).toThrow(/Insecure/);
  });
  it('allows override with VOCAREUM_ALLOW_CUSTOM_BASE_URL=1', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';
    try { expect(() => assertAllowedBaseUrl('https://staging.example.com/api/v2')).not.toThrow(); }
    finally { delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL; }
  });
  it('allows override with VOCAREUM_ALLOW_CUSTOM_BASE_URL=1 for http', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';
    try { expect(() => assertAllowedBaseUrl('http://localhost/api/v2')).not.toThrow(); }
    finally { delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL; }
  });
});

describe('VocareumClient header injection', () => {
  it('asks the provider for the Authorization header on each request', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    const spy = vi.spyOn(provider, 'getAuthorizationHeader');
    let capturedConfig: unknown;
    (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter =
      async (config: unknown) => { capturedConfig = config; return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }; };
    await client.request({ method: 'GET', url: '/courses' });
    expect(spy).toHaveBeenCalled();
    expect((capturedConfig as { headers: { get(k: string): string } }).headers.get('Authorization')).toBe('Token fake');
  });
});

describe('sanitizeForLog (recursive)', () => {
  it('redacts secrets nested in objects and bodies', () => {
    const out = JSON.stringify(sanitizeForLog({
      headers: { Authorization: 'Bearer abc' },
      data: { grant_type: 'client_credentials', client_secret: 'shh', nested: { access_token: 'tok' } },
    } as never));
    expect(out).not.toContain('shh');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('"tok"');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts secrets in a urlencoded form-string body, preserving non-secret params', () => {
    const out = sanitizeForLog('grant_type=client_credentials&client_id=cid&client_secret=shh') as string;
    expect(out).not.toContain('shh');
    expect(out).toContain('client_id=cid');
    expect(out).toContain('client_secret=[REDACTED]');
  });

  it('redacts the query string of signed download URLs, keeping the host', () => {
    // Shapes seen in API responses: the directory-zip job result and the files API download_url.
    const out = JSON.stringify(sanitizeForLog({
      data: {
        state: 'success',
        message: 'https://bucket.s3.us-west-2.amazonaws.com/u1_p2.zip?response-content-disposition=attachment&X-Amz-Security-Token=TOK&X-Amz-Credential=CRED&X-Amz-Signature=SIG',
        files: [{ download_url: 'https://labs.vocareum.com/web/download.php?k=SECRETKEY&e=1' }],
      },
    }));
    for (const secret of ['TOK', 'CRED', 'SIG', 'SECRETKEY']) { expect(out).not.toContain(secret); }
    expect(out).toContain('https://bucket.s3.us-west-2.amazonaws.com/u1_p2.zip?[REDACTED]');
    expect(out).toContain('https://labs.vocareum.com/web/download.php?[REDACTED]');
  });

  it('leaves a URL without a query, and plain text, alone', () => {
    expect(sanitizeForLog('see https://labs.vocareum.com/api/v2/courses for details')).toBe('see https://labs.vocareum.com/api/v2/courses for details');
    expect(sanitizeForLog('what? nothing here')).toBe('what? nothing here');
    // Error text the content code matches on must survive unchanged.
    expect(sanitizeForLog('specified file does not exist data/x/token=1.txt')).toBe('specified file does not exist data/x/token=1.txt');
  });

  // Shapes from the adversarial review of the first version (2026-11-11).
  it.each([
    ['user-info', 'https://user:s3cret@host/a?X-Amz-Signature=SIG', ['s3cret', 'SIG']],
    ['a quote inside the query', 'https://host/a?name="q"&X-Amz-Signature=SIG', ['SIG']],
    ['a line break inside the query', 'https://host/a?\nX-Amz-Signature=SIG', ['SIG']],
    ['JSON-escaped slashes', '{"u":"https:\\/\\/b.s3.amazonaws.com\\/a.zip?X-Amz-Signature=SIG"}', ['SIG']],
    ['a protocol-relative URL', '//bucket.s3.amazonaws.com/a?X-Amz-Security-Token=TOK&X-Amz-Credential=CRED', ['TOK', 'CRED']],
    ['upper-case scheme', 'HTTPS://HOST/A?X-Amz-Signature=SIG', ['SIG']],
  ])('redacts a signed URL with %s', (_label, input, secrets) => {
    const out = sanitizeForLog(input) as string;
    for (const secret of secrets) { expect(out).not.toContain(secret); }
  });

  it('keeps punctuation that ends the sentence, not the URL', () => {
    expect(sanitizeForLog('see https://host/a?X-Amz-Signature=SIG, next')).toBe('see https://host/a?[REDACTED], next');
    expect(sanitizeForLog('(https://host/p?k=SECRET).')).toBe('(https://host/p?[REDACTED]).');
  });

  it('runs in linear time on many URL-like fragments', () => {
    const big = 'https://a/'.repeat(80_000);
    const start = Date.now();
    sanitizeForLog(big);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('API error text is sanitized', () => {
  it('a signed URL in an error body never reaches the thrown message or details', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    const body = { message: 'download failed https://bucket.s3.amazonaws.com/p.zip?X-Amz-Signature=SECRETSIG' };
    setAdapter(client, mockAdapter([{ status: 400, data: body }]));
    const error = await client.request({ method: 'GET', url: '/courses' }).catch((e: unknown) => e) as Error & { details?: unknown };
    expect(error.message).not.toContain('SECRETSIG');
    expect(error.message).toContain('https://bucket.s3.amazonaws.com/p.zip?[REDACTED]');
    expect(JSON.stringify(error.details)).not.toContain('SECRETSIG');
  });
});

// A custom adapter must reject non-2xx itself — axios only applies validateStatus
// inside its built-in adapters (via settle), not to a custom adapter's resolved
// value. So we throw a REAL AxiosError (carrying .response.status) for status >= 400.
function mockAdapter(responses: Array<{ status: number; data?: unknown }>) {
  let i = 0;
  return async (config: unknown) => {
    const r = responses[Math.min(i, responses.length - 1)]; i += 1;
    const response = { data: r.data ?? {}, status: r.status, statusText: '', headers: {}, config };
    if (r.status >= 400) {
      throw new AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE',
        config as never, {}, response as never);
    }
    return response;
  };
}
function setAdapter(client: VocareumClient, adapter: unknown) {
  (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter = adapter;
}

describe('VocareumClient 401 refresh-retry', () => {
  it('refreshes once and retries once on an API 401, then succeeds', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 401 }, { status: 200, data: { ok: true } }]));
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' });
    expect(out).toEqual({ ok: true });
    expect(provider.refreshed).toBe(1);
  });

  it('does not retry past one refresh; a second 401 throws', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 401 }, { status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow();
    expect(provider.refreshed).toBe(1);
  });

  it('does not attempt refresh when the provider has no refreshAfterUnauthorized', async () => {
    const provider = new FakeProvider();
    (provider as Partial<FakeProvider>).refreshAfterUnauthorized = undefined;
    const client = new VocareumClient(provider as AuthProvider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow();
  });

  it('normal retry (500 then 200) still works and is independent of the 401 path', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 500 }, { status: 200, data: { ok: true } }]));
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
    expect(out).toEqual({ ok: true });
    expect(provider.refreshed).toBe(0);
  });

  it('an auth-acquisition failure (interceptor throws) does NOT trigger the 401 refresh path', async () => {
    const provider = new FakeProvider();
    provider.getAuthorizationHeader = async () => { throw new Error('token exchange failed'); };
    const client = new VocareumClient(provider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 200, data: { ok: true } }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow(/token exchange failed/);
    expect(provider.refreshed).toBe(0);
  });

  it('an OAuthTokenExchangeError (statusCode 401, not an AxiosError) does NOT trigger refresh', async () => {
    // Pins that the refresh decision keys on an AxiosError carrying a 401 RESPONSE,
    // not on statusCode === 401. A bad-secret token-exchange failure carries 401 but
    // must propagate immediately — refreshing would loop a known-bad credential.
    const provider = new FakeProvider();
    provider.getAuthorizationHeader = async () => {
      throw new OAuthTokenExchangeError('OAuth token exchange failed (HTTP 401).');
    };
    const client = new VocareumClient(provider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 200, data: { ok: true } }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toBeInstanceOf(OAuthTokenExchangeError);
    expect(provider.refreshed).toBe(0);
  });

  it('uses the provider unauthorizedHint in the 401 message (OAuth wording)', async () => {
    const provider = new FakeProvider();
    (provider as { unauthorizedHint?: string }).unauthorizedHint =
      'OAuth authentication failed. Verify VOCAREUM_OAUTH_CLIENT_ID / VOCAREUM_OAUTH_CLIENT_SECRET.';
    (provider as Partial<FakeProvider>).refreshAfterUnauthorized = undefined; // 401 terminal
    const client = new VocareumClient(provider as AuthProvider, NO_THROTTLE);
    setAdapter(client, mockAdapter([{ status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' }))
      .rejects.toThrow(/VOCAREUM_OAUTH_CLIENT_ID/);
  });

  it('retries an axios timeout (ECONNABORTED) then succeeds', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      if (calls === 1) {
        throw new AxiosError('timeout of 30000ms exceeded', 'ECONNABORTED', config as never, {}, undefined);
      }
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    });
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('does not retry an ambiguous timeout for a non-idempotent POST', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      throw new AxiosError('timeout after server may have accepted request', 'ECONNABORTED',
        config as never, {}, undefined);
    });

    await expect(
      client.request({ method: 'POST', url: '/courses/c1/assignments', data: { method: 'copy' } }, { backoff: 1 })
    ).rejects.toThrow(/timeout after server may have accepted request/);
    expect(calls).toBe(1);
  });

  it('does not retry a 5xx response for a non-idempotent POST', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      const response = { data: {}, status: 503, statusText: '', headers: {}, config };
      throw new AxiosError('Service unavailable', 'ERR_BAD_RESPONSE',
        config as never, {}, response as never);
    });

    await expect(
      client.request({ method: 'POST', url: '/courses/c1/assignments', data: { method: 'copy' } }, { backoff: 1 })
    ).rejects.toThrow(/Service unavailable/);
    expect(calls).toBe(1);
  });

  it.each(['ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK'])(
    'retries transient connection error %s then succeeds',
    async (code) => {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          throw new AxiosError('connection failure', code, config as never, {}, undefined);
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });
      const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
      expect(out).toEqual({ ok: true });
      expect(calls).toBe(2);
    }
  );

  it('exposes Retry-After from a 429 response on the thrown RateLimitError', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    setAdapter(client, async (config: unknown) => {
      const response = {
        data: {}, status: 429, statusText: '', headers: { 'retry-after': '7' }, config,
      };
      throw new AxiosError('Request failed with status code 429', 'ERR_BAD_RESPONSE',
        config as never, {}, response as never);
    });
    await expect(
      client.request({ method: 'GET', url: '/courses' }, { maxRetries: 1 })
    ).rejects.toMatchObject({ name: 'RateLimitError', retryAfter: 7 });
  });

  it('waits the Retry-After duration (not the exponential backoff) before retrying a 429', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          const response = {
            data: {}, status: 429, statusText: '', headers: { 'retry-after': '3' }, config,
          };
          throw new AxiosError('Request failed with status code 429', 'ERR_BAD_RESPONSE',
            config as never, {}, response as never);
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });

      const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1000 });
      const guarded = pending.catch(() => undefined); // avoid unhandled rejection noise

      // After the 1s exponential backoff would have elapsed, we must still be waiting
      await vi.advanceTimersByTimeAsync(1500);
      expect(calls).toBe(1);

      // After the full Retry-After window, the retry fires and succeeds
      await vi.advanceTimersByTimeAsync(2000);
      const out = await pending;
      expect(out).toEqual({ ok: true });
      expect(calls).toBe(2);
      await guarded;
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors Retry-After on a retryable 503 response', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          const response = {
            data: {}, status: 503, statusText: '', headers: { 'retry-after': '4' }, config,
          };
          throw new AxiosError('Service unavailable', 'ERR_BAD_RESPONSE',
            config as never, {}, response as never);
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });

      const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
      await vi.advanceTimersByTimeAsync(3999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors an HTTP-date Retry-After value', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
    try {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          const response = {
            data: {},
            status: 503,
            statusText: '',
            headers: { 'retry-after': 'Thu, 11 Jun 2026 00:00:05 GMT' },
            config,
          };
          throw new AxiosError('Service unavailable', 'ERR_BAD_RESPONSE',
            config as never, {}, response as never);
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });

      const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' });
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors Retry-After values longer than 60 seconds', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          const response = {
            data: {}, status: 429, statusText: '', headers: { 'retry-after': '120' }, config,
          };
          throw new AxiosError('Rate limited', 'ERR_BAD_RESPONSE',
            config as never, {}, response as never);
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });

      const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(59_999);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['1.5', '1e2', '-1', 'not-a-date'])(
    'ignores invalid Retry-After value %s',
    async (retryAfter) => {
      vi.useFakeTimers();
      try {
        const provider = new FakeProvider();
        const client = new VocareumClient(provider, NO_THROTTLE);
        let calls = 0;
        setAdapter(client, async (config: unknown) => {
          calls += 1;
          if (calls === 1) {
            const response = {
              data: {}, status: 429, statusText: '', headers: { 'retry-after': retryAfter }, config,
            };
            throw new AxiosError('Rate limited', 'ERR_BAD_RESPONSE',
              config as never, {}, response as never);
          }
          return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
        });

        const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 25 });
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toBe(1);
        await vi.advanceTimersByTimeAsync(25);
        await expect(pending).resolves.toEqual({ ok: true });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('retries a transient network error (ECONNRESET) then succeeds', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider, NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      if (calls === 1) {
        throw new AxiosError('socket hang up', 'ECONNRESET', config as never, {}, undefined);
      }
      return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
    });
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe('VocareumClient throttle scheduling', () => {
  it('spaces requests by minIntervalMs through the scheduler', async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const client = new VocareumClient(provider, { maxConcurrency: 1, minIntervalMs: 1000, jitter: false });
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      });
      const all = Promise.all([
        client.request({ method: 'GET', url: '/a' }),
        client.request({ method: 'GET', url: '/b' }),
        client.request({ method: 'GET', url: '/c' }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(3);
      await all;
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Under load Vocareum answers HTTP 200 with a plain-text body instead of JSON
 * (probed 2026-11-11 on courses 215500 and 240788: 5 of 24 listing requests).
 * Returned as data, a listing read it as an empty page: a directory looked
 * empty, or a paged listing ended early, and drift read the lost names as
 * remote deletions. It must be an error, retried like a 503.
 */
const THROTTLE_BODY =
  'VOCAREUM-ERROR: Sorry, your access to Vocareum is temporarily unavailable due to heavy traffic, ' +
  'you may re-connect later. If issues persist, please contact Vocareum technical support\n';

describe('a 200 response whose body is a VOCAREUM-ERROR text', () => {
  it('is retried for a GET, and the retry\'s answer is returned', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      const data = calls === 1 ? THROTTLE_BODY : { files: ['a.txt'] };
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    });
    const out = await client.request<{ files: string[] }>({ method: 'GET', url: '/x' }, { backoff: 1 });
    expect(out).toEqual({ files: ['a.txt'] });
    expect(calls).toBe(2);
  });

  it('throws a 503 OverloadError (an APIError) naming the overload once retries run out; it is never returned as data', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      return { data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: {}, config };
    });
    await expect(client.request({ method: 'GET', url: '/x' }, { backoff: 1 }))
      .rejects.toMatchObject({ name: 'OverloadError', statusCode: 503, message: expect.stringMatching(/heavy traffic/) });
    expect(calls).toBe(3);
  });

  it('is an error but is not retried for a non-idempotent POST (it may have been applied)', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      return { data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: {}, config };
    });
    await expect(client.request({ method: 'POST', url: '/x', data: {} }, { backoff: 1 }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toBe(1);
  });

  it('is recognised with leading whitespace', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    setAdapter(client, async (config: unknown) =>
      ({ data: `\n  ${THROTTLE_BODY}`, status: 200, statusText: 'OK', headers: {}, config }));
    await expect(client.request({ method: 'GET', url: '/x' }, { maxRetries: 1 }))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('leaves other string bodies alone', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    setAdapter(client, async (config: unknown) =>
      ({ data: 'plain text answer', status: 200, statusText: 'OK', headers: {}, config }));
    expect(await client.request({ method: 'GET', url: '/x' })).toBe('plain text answer');
  });
});

describe('the overload error after review (Retry-After, redaction, type)', () => {
  it('honours a Retry-After header sent with the 200 text body', async () => {
    vi.useFakeTimers();
    try {
      const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          return { data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: { 'retry-after': '5' }, config };
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });
      const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/x' }, { backoff: 1 });
      await vi.advanceTimersByTimeAsync(4999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is an OverloadError, so pollers can tell it from a real failure', async () => {
    const { isOverloadError } = await import('../../src/api/client');
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    setAdapter(client, async (config: unknown) =>
      ({ data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: {}, config }));
    const err = await client.request({ method: 'GET', url: '/x' }, { maxRetries: 1 }).catch((e: unknown) => e);
    expect(isOverloadError(err)).toBe(true);
  });

  it('redacts a signed URL or token in the server text before it reaches the message', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    const body = 'VOCAREUM-ERROR: retry at https://bucket.s3.amazonaws.com/u1_p2.zip?X-Amz-Signature=deadbeefsecret&X-Amz-Credential=AKIAEXAMPLE later';
    setAdapter(client, async (config: unknown) =>
      ({ data: body, status: 200, statusText: 'OK', headers: {}, config }));
    const err = await client.request({ method: 'GET', url: '/x' }, { maxRetries: 1 }).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/overloaded/);
    expect(err.message).not.toMatch(/deadbeefsecret|AKIAEXAMPLE/);
  });

  it('a padded body is retried, not only recognised', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      const data = calls === 1 ? `\n  ${THROTTLE_BODY}` : { ok: true };
      return { data, status: 200, statusText: 'OK', headers: {}, config };
    });
    expect(await client.request({ method: 'GET', url: '/x' }, { backoff: 1 })).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});

describe('overload follow-up (focused review of 3cd80d6)', () => {
  it('caps a huge Retry-After on the overload answer at 60 s', async () => {
    vi.useFakeTimers();
    try {
      const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
      let calls = 0;
      setAdapter(client, async (config: unknown) => {
        calls += 1;
        if (calls === 1) {
          return { data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: { 'retry-after': '86400' }, config };
        }
        return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
      });
      const pending = client.request<{ ok: boolean }>({ method: 'GET', url: '/x' });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retryOverload: false throws the overload at once, but still retries other errors', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    let calls = 0;
    setAdapter(client, async (config: unknown) => {
      calls += 1;
      return { data: THROTTLE_BODY, status: 200, statusText: 'OK', headers: {}, config };
    });
    await expect(client.request({ method: 'GET', url: '/x' }, { retryOverload: false, backoff: 1 }))
      .rejects.toMatchObject({ name: 'OverloadError' });
    expect(calls).toBe(1);

    const other = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    setAdapter(other, mockAdapter([{ status: 500 }, { status: 200, data: { ok: true } }]));
    expect(await other.request({ method: 'GET', url: '/x' }, { retryOverload: false, backoff: 1 })).toEqual({ ok: true });
  });

  it('redacts before shortening, so a cut inside user-info cannot leave the password', async () => {
    const client = new VocareumClient(new FakeProvider(), NO_THROTTLE);
    const body = `VOCAREUM-ERROR: https://user:SECRETPW${'x'.repeat(400)}@example.com/path`;
    setAdapter(client, async (config: unknown) =>
      ({ data: body, status: 200, statusText: 'OK', headers: {}, config }));
    const err = await client.request({ method: 'GET', url: '/x' }, { maxRetries: 1 }).catch((e: unknown) => e as Error);
    expect(err.message).not.toMatch(/SECRETPW/);
  });
});

describe('sanitizeLogString stays linear', () => {
  it('a URL followed by a long run of punctuation and a letter is redacted quickly', () => {
    // An unanchored trailing-punctuation regex retried at every dot: 80,000
    // dots took ~3 s, and the overload path scrubs the whole server text.
    const text = `VOCAREUM-ERROR: https://host/a?token=SECRET${'.'.repeat(200_000)}x`;
    const started = Date.now();
    const out = sanitizeLogString(text);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out).not.toMatch(/SECRET/);
  });

  it('still keeps sentence punctuation outside the redacted URL', () => {
    expect(sanitizeLogString('see https://host/p?token=abc).')).toBe('see https://host/p?[REDACTED]).');
  });
});
