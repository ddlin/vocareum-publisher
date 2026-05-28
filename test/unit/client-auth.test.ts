import { describe, it, expect } from 'vitest';
import { normalizeApiBaseUrl, assertAllowedBaseUrl } from '../../src/api/client';

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
});
