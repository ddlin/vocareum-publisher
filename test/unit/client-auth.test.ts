import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { normalizeApiBaseUrl, assertAllowedBaseUrl, VocareumClient, sanitizeForLog } from '../../src/api/client';
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
