import { describe, it, expect, afterEach } from 'vitest';
import { createAuthProvider } from '../../../src/api/auth/auth-provider';
import { TokenAuthProvider } from '../../../src/api/auth/token-auth-provider';
import { OAuthClientCredentialsProvider } from '../../../src/api/auth/oauth-provider';

describe('createAuthProvider', () => {
  afterEach(() => {
    delete process.env.VOCAREUM_AUTH_MODE;
    delete process.env.VOCAREUM_API_KEY;
    delete process.env.VOCAREUM_API_TOKEN;
    delete process.env.VOCAREUM_OAUTH_CLIENT_ID;
    delete process.env.VOCAREUM_OAUTH_CLIENT_SECRET;
  });

  // --- Mode resolution (AGENTS.md rule #4: scenario list IS the acceptance criteria) ---

  it('defaults to token mode (v2)', () => {
    process.env.VOCAREUM_API_KEY = 'tok';
    const p = createAuthProvider({});
    expect(p).toBeInstanceOf(TokenAuthProvider);
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });

  it('honors config base URL in token mode', () => {
    process.env.VOCAREUM_API_KEY = 'tok';
    const p = createAuthProvider({ apiBaseUrl: 'https://api.vocareum.com' });
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });

  it('builds an OAuth provider when mode=oauth and creds present', () => {
    const p = createAuthProvider({ authMode: 'oauth', clientId: 'c', clientSecret: 's' });
    expect(p).toBeInstanceOf(OAuthClientCredentialsProvider);
    expect(p.apiBaseUrl).toBe('https://labs.vocareum.com/api/v3');
  });

  it('reads oauth creds from env when not passed as options', () => {
    process.env.VOCAREUM_AUTH_MODE = 'oauth';
    process.env.VOCAREUM_OAUTH_CLIENT_ID = 'c';
    process.env.VOCAREUM_OAUTH_CLIENT_SECRET = 's';
    expect(createAuthProvider({})).toBeInstanceOf(OAuthClientCredentialsProvider);
  });

  it('throws an actionable error when oauth mode is selected without creds', () => {
    expect(() => createAuthProvider({ authMode: 'oauth' })).toThrow(/CLIENT_ID/);
  });

  it('throws when token mode has no token', () => {
    expect(() => createAuthProvider({ authMode: 'token' })).toThrow(/VOCAREUM_API_KEY/);
  });

  it('throws fast on an invalid auth mode from options', () => {
    expect(() => createAuthProvider({ authMode: 'bogus' })).toThrow(/Invalid auth mode/);
  });

  it('throws fast on an invalid VOCAREUM_AUTH_MODE env value (typo)', () => {
    process.env.VOCAREUM_AUTH_MODE = 'ouath';
    expect(() => createAuthProvider({})).toThrow(/Invalid auth mode/);
  });

  // --- Precedence + credential hygiene ---

  it('opts override conflicting env values (precedence)', () => {
    process.env.VOCAREUM_AUTH_MODE = 'token';
    process.env.VOCAREUM_API_KEY = 'tok';
    process.env.VOCAREUM_OAUTH_CLIENT_ID = 'env-id';
    process.env.VOCAREUM_OAUTH_CLIENT_SECRET = 'env-sec';
    // opts pick oauth + explicit creds, overriding the token-mode env
    const p = createAuthProvider({ authMode: 'oauth', clientId: 'opt-id', clientSecret: 'opt-sec' });
    expect(p).toBeInstanceOf(OAuthClientCredentialsProvider);
  });

  it('trims whitespace from credentials (paste safety)', () => {
    const p = createAuthProvider({ authMode: 'oauth', clientId: '  c  ', clientSecret: '  s  ' });
    expect(p).toBeInstanceOf(OAuthClientCredentialsProvider);
  });

  it('treats an all-whitespace client secret as missing', () => {
    expect(() => createAuthProvider({ authMode: 'oauth', clientId: 'c', clientSecret: '   ' })).toThrow(/CLIENT/);
  });
});
