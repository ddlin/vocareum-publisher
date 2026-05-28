import { describe, it, expect, afterEach } from 'vitest';
import { createAuthProvider } from '../../../src/api/auth/auth-provider';

describe('createAuthProvider', () => {
  afterEach(() => {
    delete process.env.VOCAREUM_AUTH_MODE;
    delete process.env.VOCAREUM_API_KEY;
    delete process.env.VOCAREUM_API_TOKEN;
    delete process.env.VOCAREUM_OAUTH_CLIENT_ID;
    delete process.env.VOCAREUM_OAUTH_CLIENT_SECRET;
  });

  it('opts override conflicting env values (precedence)', () => {
    process.env.VOCAREUM_AUTH_MODE = 'token';
    process.env.VOCAREUM_API_KEY = 'tok';
    process.env.VOCAREUM_OAUTH_CLIENT_ID = 'env-id';
    process.env.VOCAREUM_OAUTH_CLIENT_SECRET = 'env-sec';
    // opts pick oauth + explicit creds, overriding the token-mode env
    const p = createAuthProvider({ authMode: 'oauth', clientId: 'opt-id', clientSecret: 'opt-sec' });
    expect(p.constructor.name).toBe('OAuthClientCredentialsProvider');
  });

  it('trims whitespace from credentials (paste safety)', () => {
    const p = createAuthProvider({ authMode: 'oauth', clientId: '  c  ', clientSecret: '  s  ' });
    expect(p.constructor.name).toBe('OAuthClientCredentialsProvider');
  });

  it('treats an all-whitespace client secret as missing', () => {
    expect(() => createAuthProvider({ authMode: 'oauth', clientId: 'c', clientSecret: '   ' })).toThrow(/CLIENT/);
  });
});
