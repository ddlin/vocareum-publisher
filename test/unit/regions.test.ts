import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VocareumClient, assertAllowedBaseUrl, assertBaseUrlForVersion, isAllowlistedBaseUrl, normalizeApiBaseUrl,
} from '../../src/api/client';
import { OAuthClientCredentialsProvider } from '../../src/api/auth/oauth-provider';
import {
  REGION_HOSTS, regionForBaseUrl, resolveV2ApiBaseUrl,
} from '../../src/api/regions';
import { TokenAuthProvider } from '../../src/api/auth/token-auth-provider';
import type { EventSink, ServiceEvent } from '../../src/core/services/event-sink';

/** Records every event so a test can assert on what was (not) emitted. */
class RecordingSink implements EventSink {
  readonly events: ServiceEvent[] = [];
  emit(event: ServiceEvent): void { this.events.push(event); }
}

const EU_V2 = 'https://api.eu.vocareum.com/api/v2';

// Each test starts with no override and no env host, and restores whatever the
// developer's shell had (a stray export must not leak into or out of a test).
const SAVED = {
  allowCustom: process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL,
  apiBaseUrl: process.env.VOCAREUM_API_BASE_URL,
};
beforeEach(() => {
  delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;
  delete process.env.VOCAREUM_API_BASE_URL;
});
afterEach(() => {
  for (const [key, value] of [
    ['VOCAREUM_ALLOW_CUSTOM_BASE_URL', SAVED.allowCustom],
    ['VOCAREUM_API_BASE_URL', SAVED.apiBaseUrl],
  ] as const) {
    if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
  }
});

describe('EU v2 host — allowlisted without the override flag', () => {
  it('passes assertAllowedBaseUrl with no warning', () => {
    const sink = new RecordingSink();
    expect(() => assertAllowedBaseUrl(EU_V2, sink)).not.toThrow();
    expect(sink.events).toEqual([]);
  });

  it("passes assertBaseUrlForVersion(..., 'v2') with no warning", () => {
    const sink = new RecordingSink();
    expect(() => assertBaseUrlForVersion(EU_V2, 'v2', sink)).not.toThrow();
    expect(sink.events).toEqual([]);
  });

  it("is rejected by assertBaseUrlForVersion(..., 'v3') — token/OAuth host binding holds", () => {
    expect(() => assertBaseUrlForVersion(EU_V2, 'v3')).toThrow(/Insecure/);
  });

  it('NA v2 host is still accepted, and still rejected as a v3 host', () => {
    expect(() => assertBaseUrlForVersion('https://api.vocareum.com/api/v2', 'v2')).not.toThrow();
    expect(() => assertBaseUrlForVersion('https://api.vocareum.com/api/v2', 'v3')).toThrow(/Insecure/);
  });

  it('NA v3 host is still rejected as a v2 host', () => {
    expect(() => assertBaseUrlForVersion('https://labs.vocareum.com/api/v3', 'v2')).toThrow(/Insecure/);
  });

  it('a v3 path on the EU host is not allowlisted (no confirmed EU v3 host)', () => {
    expect(() => assertAllowedBaseUrl('https://api.eu.vocareum.com/api/v3')).toThrow(/Insecure/);
    expect(() => assertBaseUrlForVersion('https://api.eu.vocareum.com/api/v3', 'v3')).toThrow(/Insecure/);
    expect(REGION_HOSTS.eu.v3BaseUrl).toBeUndefined();
  });

  it('error message names the EU host so a user knows it is supported', () => {
    expect(() => assertAllowedBaseUrl('https://evil.example.com/api/v2')).toThrow(/api\.eu\.vocareum\.com/);
  });
});

describe('EU look-alikes and downgrades are still rejected', () => {
  const rejected = [
    'http://api.eu.vocareum.com/api/v2',                 // plaintext
    'https://api.eu.vocareum.com.evil.com/api/v2',       // suffix look-alike
    'https://api-eu.vocareum.com/api/v2',                // near-miss host
    'https://eu.vocareum.com/api/v2',                    // missing "api."
    'https://api.eu.vocareum.com@evil.com/api/v2',       // userinfo trick: real host is evil.com
    'https://evil.com/api.eu.vocareum.com/api/v2',       // host smuggled into path
    'https://api.eu.vocareum.com/evil',                  // right host, wrong path
    'https://api.eu.vocareum.com:8443/api/v2',           // non-default port
  ];
  for (const url of rejected) {
    it(`rejects ${url} (allowlist + v2 binding)`, () => {
      expect(() => assertAllowedBaseUrl(url)).toThrow(/Insecure/);
      expect(() => assertBaseUrlForVersion(url, 'v2')).toThrow(/Insecure/);
      expect(isAllowlistedBaseUrl(url, 'v2')).toBe(false);
      expect(regionForBaseUrl(url)).toBeUndefined();
    });
  }

  it('TokenAuthProvider refuses a look-alike host from config', () => {
    expect(() => new TokenAuthProvider('tok', 'https://api.eu.vocareum.com.evil.com')).toThrow(/Insecure/);
  });

  it('the override flag still unlocks a custom host, with a credentials warning', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';
    const sink = new RecordingSink();
    expect(() => assertBaseUrlForVersion('https://staging.example.com/api/v2', 'v2', sink)).not.toThrow();
    expect(sink.events.map(e => e.message).join('\n')).toMatch(/credentials will be sent/);
  });
});

describe('malformed base URLs: validated one way, sent another — always refused', () => {
  // Each of these PARSES to the allowlisted EU host+path (the URL parser drops or
  // rewrites the offending part), but axios joins the RAW string with the
  // request path: the course path lands in a query or fragment, or a credential
  // rides along in userinfo.
  const malformed: Array<[string, string]> = [
    ['query', 'https://api.eu.vocareum.com/api/v2?x=/api/v2'],
    ['empty query', 'https://api.eu.vocareum.com/api/v2?'],
    ['fragment', 'https://api.eu.vocareum.com/api/v2#/api/v2'],
    ['userinfo', 'https://token@api.eu.vocareum.com/api/v2'],
    ['empty userinfo', 'https://@api.eu.vocareum.com/api/v2'],
    ['backslashes', 'https://api.eu.vocareum.com\\api\\v2'],
    ['embedded tab', 'https://api.eu.vocareum.com/api/\tv2'],
    ['embedded newline', 'https://api.eu.vocareum.com/api/\nv2'],
    ['NUL', 'https://api.eu.vocareum.com/api/v2\u0000'],
  ];

  for (const [label, url] of malformed) {
    it(`refuses ${label} even with VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`, () => {
      // Sanity: the parser really does see the allowlisted host — this is the trap.
      expect(new URL(url).host).toBe('api.eu.vocareum.com');
      for (const override of [undefined, '1']) {
        if (override === undefined) { delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL; }
        else { process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = override; }
        expect(() => assertAllowedBaseUrl(url)).toThrow(/must be a plain https/);
        expect(() => assertBaseUrlForVersion(url, 'v2')).toThrow(/must be a plain https/);
      }
      expect(isAllowlistedBaseUrl(url, 'v2')).toBe(false);
      expect(regionForBaseUrl(url)).toBeUndefined();
    });
  }

  it('TokenAuthProvider refuses a query URL arriving from config/env/flag', () => {
    expect(() => new TokenAuthProvider('tok', 'https://api.eu.vocareum.com/api/v2?x=1')).toThrow(/must be a plain https/);
  });

  it('VocareumClient refuses a provider whose base URL carries a fragment', () => {
    const provider = {
      apiBaseUrl: 'https://api.eu.vocareum.com/api/v2#/api/v2',
      getAuthorizationHeader: () => Promise.resolve('Token t'),
    };
    expect(() => new VocareumClient(provider, { maxConcurrency: 1, minIntervalMs: 0, jitter: false }))
      .toThrow(/must be a plain https/);
  });

  it('the OAuth token URL gets the same rule', () => {
    expect(() => new OAuthClientCredentialsProvider({
      clientId: 'c', clientSecret: 's',
      apiBaseUrl: 'https://labs.vocareum.com/api/v3',
      tokenUrl: 'https://labs.vocareum.com/api/v3/oauth/token?x=1',
    })).toThrow(/must be a plain https/);
  });

  it('the error message never echoes a credential from the URL', () => {
    const secret = 'secret-token-789';
    for (const url of [
      `https://${secret}@api.eu.vocareum.com/api/v2`,
      `https://api.eu.vocareum.com/api/v2?key=${secret}`,
      `https://${secret}@evil.example.com/api/v2`,
      `not a url ${secret}`,
    ]) {
      let message = '';
      try { assertAllowedBaseUrl(url); } catch (e) { message = (e as Error).message; }
      expect(message).toMatch(/Insecure API base URL/);
      expect(message).not.toContain(secret);
    }
  });

  it('plain NA and EU URLs (with trailing slash, uppercase, default port) still pass', () => {
    for (const url of [
      'https://api.vocareum.com/api/v2', 'https://api.vocareum.com/api/v2/',
      'https://API.EU.VOCAREUM.COM/api/v2', 'https://api.eu.vocareum.com:443/api/v2',
    ]) {
      expect(() => assertBaseUrlForVersion(url, 'v2')).not.toThrow();
    }
  });
});

describe('normalizeApiBaseUrl / regionForBaseUrl', () => {
  it('normalizes the bare EU host to its /api/v2 URL', () => {
    expect(normalizeApiBaseUrl('https://api.eu.vocareum.com')).toBe(EU_V2);
    expect(normalizeApiBaseUrl('https://api.eu.vocareum.com/')).toBe(EU_V2);
  });

  it('classifies hosts by exact (scheme, host, path) after normalization', () => {
    expect(regionForBaseUrl('https://api.eu.vocareum.com')).toBe('eu');
    expect(regionForBaseUrl(EU_V2)).toBe('eu');
    expect(regionForBaseUrl('https://API.EU.vocareum.com/')).toBe('eu');
    expect(regionForBaseUrl('https://api.vocareum.com')).toBe('na');
    expect(regionForBaseUrl('https://labs.vocareum.com/api/v3')).toBe('na');
    expect(regionForBaseUrl('not a url')).toBeUndefined();
  });

  it('TokenAuthProvider accepts the bare EU host from vocareum.yaml', () => {
    expect(new TokenAuthProvider('tok', 'https://api.eu.vocareum.com').apiBaseUrl).toBe(EU_V2);
  });
});

describe('resolveV2ApiBaseUrl precedence: flag > env > config > default', () => {
  const NA = 'https://api.vocareum.com';
  const EU = 'https://api.eu.vocareum.com';

  it('default (NA) when nothing is set', () => {
    expect(resolveV2ApiBaseUrl({})).toEqual({ baseUrl: NA, source: 'default' });
  });

  it('config beats default', () => {
    expect(resolveV2ApiBaseUrl({ config: EU })).toEqual({ baseUrl: EU, source: 'config' });
  });

  it('env beats config', () => {
    process.env.VOCAREUM_API_BASE_URL = EU;
    expect(resolveV2ApiBaseUrl({ config: NA })).toEqual({ baseUrl: EU, source: 'env' });
  });

  it('flag beats env and config', () => {
    process.env.VOCAREUM_API_BASE_URL = NA;
    expect(resolveV2ApiBaseUrl({ flag: EU, config: NA })).toEqual({ baseUrl: EU, source: 'flag' });
  });

  it('empty / whitespace-only values fall through to the next source', () => {
    process.env.VOCAREUM_API_BASE_URL = '   ';
    expect(resolveV2ApiBaseUrl({ flag: '', config: EU })).toEqual({ baseUrl: EU, source: 'config' });
  });

  it('trims surrounding whitespace (paste safety)', () => {
    process.env.VOCAREUM_API_BASE_URL = `  ${EU}  `;
    expect(resolveV2ApiBaseUrl({})).toEqual({ baseUrl: EU, source: 'env' });
  });
});
