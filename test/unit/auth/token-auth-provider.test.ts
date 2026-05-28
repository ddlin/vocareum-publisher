import { describe, it, expect } from 'vitest';
import { TokenAuthProvider } from '../../../src/api/auth/token-auth-provider';

describe('TokenAuthProvider', () => {
  it('exposes a v2 apiBaseUrl normalized from a host-only URL', () => {
    const p = new TokenAuthProvider('tok', 'https://api.vocareum.com');
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });
  it('defaults apiBaseUrl to the canonical v2 URL', () => {
    const p = new TokenAuthProvider('tok');
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });
  it('produces a Token header', async () => {
    const p = new TokenAuthProvider('tok');
    expect(await p.getAuthorizationHeader()).toBe('Token tok');
  });
  it('has no refreshAfterUnauthorized (401 is terminal for token auth)', () => {
    const p = new TokenAuthProvider('tok');
    expect(p.refreshAfterUnauthorized).toBeUndefined();
  });
  it('rejects a crossed base URL pointed at the v3 host (no Token to v3)', () => {
    expect(() => new TokenAuthProvider('tok', 'https://labs.vocareum.com/api/v3')).toThrow(/Insecure/);
  });
});
