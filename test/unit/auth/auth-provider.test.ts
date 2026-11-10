import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createAuthProvider } from '../../../src/api/auth/auth-provider';
import { TokenAuthProvider } from '../../../src/api/auth/token-auth-provider';
import { OAuthClientCredentialsProvider } from '../../../src/api/auth/oauth-provider';
import type { EventSink, ServiceEvent } from '../../../src/core/services/event-sink';

/** Records every event so a test can assert on what was (not) emitted. */
class RecordingSink implements EventSink {
  readonly events: ServiceEvent[] = [];
  emit(event: ServiceEvent): void { this.events.push(event); }
}

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

describe('createAuthProvider — v2 host selection (NA/EU)', () => {
  const NA = 'https://api.vocareum.com';
  const EU = 'https://api.eu.vocareum.com';
  const SECRET = 'super-secret-token-value';
  const savedEnvHost = process.env.VOCAREUM_API_BASE_URL;

  beforeEach(() => {
    process.env.VOCAREUM_API_KEY = SECRET;
    delete process.env.VOCAREUM_API_BASE_URL;
    delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;
  });
  afterEach(() => {
    delete process.env.VOCAREUM_API_KEY;
    if (savedEnvHost === undefined) { delete process.env.VOCAREUM_API_BASE_URL; }
    else { process.env.VOCAREUM_API_BASE_URL = savedEnvHost; }
  });

  it('uses the EU host from vocareum.yaml with no override and no warning', () => {
    const events = new RecordingSink();
    const p = createAuthProvider({ apiBaseUrl: EU, events });
    expect(p.apiBaseUrl).toBe(`${EU}/api/v2`);
    expect(events.events).toEqual([]);
  });

  it('VOCAREUM_API_BASE_URL beats vocareum.yaml', () => {
    process.env.VOCAREUM_API_BASE_URL = EU;
    expect(createAuthProvider({ apiBaseUrl: NA }).apiBaseUrl).toBe(`${EU}/api/v2`);
  });

  it('--api-base-url beats VOCAREUM_API_BASE_URL and vocareum.yaml', () => {
    process.env.VOCAREUM_API_BASE_URL = NA;
    expect(createAuthProvider({ apiBaseUrl: NA, apiBaseUrlOverride: EU }).apiBaseUrl).toBe(`${EU}/api/v2`);
  });

  it('an env host still has to pass the v2 allowlist', () => {
    process.env.VOCAREUM_API_BASE_URL = 'https://api.eu.vocareum.com.evil.com';
    expect(() => createAuthProvider({ apiBaseUrl: NA })).toThrow(/Insecure/);
  });

  it('a flag host still has to pass the v2 allowlist (v3 host refused for token auth)', () => {
    expect(() => createAuthProvider({ apiBaseUrlOverride: 'https://labs.vocareum.com/api/v3' })).toThrow(/Insecure/);
  });

  it('warns — naming hosts, never the token — when an override disagrees with vocareum.yaml', () => {
    process.env.VOCAREUM_API_BASE_URL = EU;
    const events = new RecordingSink();
    createAuthProvider({ apiBaseUrl: NA, events });
    const warnings = events.events.filter(e => e.level === 'warn').map(e => e.message);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/VOCAREUM_API_BASE_URL/);
    expect(warnings[0]).toMatch(/api\.eu\.vocareum\.com \(EU\)/);
    expect(warnings[0]).toMatch(/api\.vocareum\.com \(NA\)/);
    expect(warnings[0]).not.toContain(SECRET);
  });

  it('does not warn when the override matches vocareum.yaml (modulo /api/v2 and slashes)', () => {
    process.env.VOCAREUM_API_BASE_URL = `${EU}/api/v2/`;
    const events = new RecordingSink();
    createAuthProvider({ apiBaseUrl: EU, events });
    expect(events.events).toEqual([]);
  });

  it('rejects --api-base-url with OAuth mode instead of silently ignoring it', () => {
    expect(() => createAuthProvider({
      authMode: 'oauth', clientId: 'c', clientSecret: 's', apiBaseUrlOverride: EU,
    })).toThrow(/cannot be used with --auth oauth/);
  });

  it('OAuth mode ignores VOCAREUM_API_BASE_URL (it is a v2-only override)', () => {
    process.env.VOCAREUM_API_BASE_URL = EU;
    const p = createAuthProvider({ authMode: 'oauth', clientId: 'c', clientSecret: 's' });
    expect(p.apiBaseUrl).toBe('https://labs.vocareum.com/api/v3');
  });
});
