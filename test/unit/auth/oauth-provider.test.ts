import { describe, it, expect, vi } from 'vitest';
import { OAuthClientCredentialsProvider, OAuthTokenExchangeError } from '../../../src/api/auth/oauth-provider';

function makeProvider(post: ReturnType<typeof vi.fn>) {
  return new OAuthClientCredentialsProvider({
    clientId: 'cid', clientSecret: 'sec',
    apiBaseUrl: 'https://labs.vocareum.com/api/v3',
    tokenUrl: 'https://labs.vocareum.com/api/v3/oauth/token',
    httpPost: post,
    now: () => 1_000_000,
  });
}

describe('OAuthClientCredentialsProvider', () => {
  it('exchanges form-encoded client_credentials and returns a Bearer header', async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    expect(await p.getAuthorizationHeader()).toBe('Bearer AT');
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe('https://labs.vocareum.com/api/v3/oauth/token');
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=sec');
    expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('caches the token until expires_in minus the 5-min buffer', async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    await p.getAuthorizationHeader();
    await p.getAuthorizationHeader();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent exchanges into one request', async () => {
    let resolve!: (v: unknown) => void;
    const post = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));
    const p = makeProvider(post);
    const a = p.getAuthorizationHeader();
    const b = p.getAuthorizationHeader();
    resolve({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    expect(await a).toBe('Bearer AT');
    expect(await b).toBe('Bearer AT');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refreshAfterUnauthorized forces a re-exchange on next header', async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    await p.getAuthorizationHeader();
    await p.refreshAfterUnauthorized();
    await p.getAuthorizationHeader();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('throws OAuthTokenExchangeError (no secret in message) on exchange failure', async () => {
    const err = Object.assign(new Error('bad'), { isAxiosError: true, response: { status: 401, data: { error: 'invalid_client' } } });
    const post = vi.fn().mockRejectedValue(err);
    const p = makeProvider(post);
    await expect(p.getAuthorizationHeader()).rejects.toBeInstanceOf(OAuthTokenExchangeError);
    await expect(p.getAuthorizationHeader()).rejects.not.toThrow(/sec/);
  });

  it('rejects a non-HTTPS or non-allowlisted tokenUrl unless override set', () => {
    expect(() => new OAuthClientCredentialsProvider({
      clientId: 'c', clientSecret: 's',
      apiBaseUrl: 'https://labs.vocareum.com/api/v3',
      tokenUrl: 'https://evil.example.com/oauth/token',
    })).toThrow(/Insecure/);
  });

  it('rejects a crossed apiBaseUrl pointed at the v2 host (no Bearer to v2)', () => {
    expect(() => new OAuthClientCredentialsProvider({
      clientId: 'c', clientSecret: 's',
      apiBaseUrl: 'https://api.vocareum.com/api/v2', // v2 host in oauth mode
      tokenUrl: 'https://labs.vocareum.com/api/v3/oauth/token',
    })).toThrow(/Insecure/);
  });

  it('throws OAuthTokenExchangeError when the response has no access_token', async () => {
    const post = vi.fn().mockResolvedValue({ data: { token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    await expect(p.getAuthorizationHeader()).rejects.toBeInstanceOf(OAuthTokenExchangeError);
  });

  it('re-exchanges after the cached token expires (by clock)', async () => {
    let nowMs = 1_000_000;
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = new OAuthClientCredentialsProvider({
      clientId: 'cid', clientSecret: 'sec',
      apiBaseUrl: 'https://labs.vocareum.com/api/v3',
      tokenUrl: 'https://labs.vocareum.com/api/v3/oauth/token',
      httpPost: post,
      now: () => nowMs,
    });
    await p.getAuthorizationHeader();
    expect(post).toHaveBeenCalledTimes(1);
    nowMs += 3600 * 1000; // advance past expiry (expires_in - 300s buffer)
    await p.getAuthorizationHeader();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
