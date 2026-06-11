import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { AxiosError } from 'axios';
import { normalizeApiBaseUrl, assertAllowedBaseUrl, VocareumClient, sanitizeForLog } from '../../src/api/client';
import { OAuthTokenExchangeError } from '../../src/api/auth/oauth-provider';
import type { AuthProvider } from '../../src/api/auth/auth-provider';

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
    const client = new VocareumClient(provider);
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
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 401 }, { status: 200, data: { ok: true } }]));
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' });
    expect(out).toEqual({ ok: true });
    expect(provider.refreshed).toBe(1);
  });

  it('does not retry past one refresh; a second 401 throws', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 401 }, { status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow();
    expect(provider.refreshed).toBe(1);
  });

  it('does not attempt refresh when the provider has no refreshAfterUnauthorized', async () => {
    const provider = new FakeProvider();
    (provider as Partial<FakeProvider>).refreshAfterUnauthorized = undefined;
    const client = new VocareumClient(provider as AuthProvider);
    setAdapter(client, mockAdapter([{ status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow();
  });

  it('normal retry (500 then 200) still works and is independent of the 401 path', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 500 }, { status: 200, data: { ok: true } }]));
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
    expect(out).toEqual({ ok: true });
    expect(provider.refreshed).toBe(0);
  });

  it('an auth-acquisition failure (interceptor throws) does NOT trigger the 401 refresh path', async () => {
    const provider = new FakeProvider();
    provider.getAuthorizationHeader = async () => { throw new Error('token exchange failed'); };
    const client = new VocareumClient(provider);
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
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 200, data: { ok: true } }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toBeInstanceOf(OAuthTokenExchangeError);
    expect(provider.refreshed).toBe(0);
  });

  it('uses the provider unauthorizedHint in the 401 message (OAuth wording)', async () => {
    const provider = new FakeProvider();
    (provider as { unauthorizedHint?: string }).unauthorizedHint =
      'OAuth authentication failed. Verify VOCAREUM_OAUTH_CLIENT_ID / VOCAREUM_OAUTH_CLIENT_SECRET.';
    (provider as Partial<FakeProvider>).refreshAfterUnauthorized = undefined; // 401 terminal
    const client = new VocareumClient(provider as AuthProvider);
    setAdapter(client, mockAdapter([{ status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' }))
      .rejects.toThrow(/VOCAREUM_OAUTH_CLIENT_ID/);
  });

  it('retries an axios timeout (ECONNABORTED) then succeeds', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
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
    const client = new VocareumClient(provider);
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
    const client = new VocareumClient(provider);
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
      const client = new VocareumClient(provider);
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
    const client = new VocareumClient(provider);
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
      const client = new VocareumClient(provider);
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
      const client = new VocareumClient(provider);
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
      const client = new VocareumClient(provider);
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
      const client = new VocareumClient(provider);
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
        const client = new VocareumClient(provider);
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
    const client = new VocareumClient(provider);
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
