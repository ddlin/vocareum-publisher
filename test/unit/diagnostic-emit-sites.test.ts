/**
 * The registry is only useful if real emit sites populate it. These assert the
 * code AND the data shape at a site a consumer would actually branch on --
 * a registered code with no emit path is a promise the report never keeps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { VocareumClient } from '../../src/api/client';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { TokenAuthProvider } from '../../src/api/auth/token-auth-provider';
import { collectDiagnostics } from '../../src/core/diagnostics';

const priorOverride = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;
afterEach(() => {
  if (priorOverride === undefined) { delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL; }
  else { process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = priorOverride; }
});

describe('insecure_base_url', () => {
  it('is emitted as a registered diagnostic with the base URL in data', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';
    const collector = new CollectingEventSink();
    new VocareumClient(
      new TokenAuthProvider('test-token', 'https://example.invalid/api/v2'),
      undefined, undefined, collector,
    );

    const diagnostics = collectDiagnostics(collector.drain());
    const found = diagnostics.find((d) => d.code === 'insecure_base_url');
    expect(found, 'no insecure_base_url diagnostic was emitted').toBeDefined();
    expect(found?.severity).toBe('warn');
    expect(found?.data?.base_url).toContain('example.invalid');
  });

  it('carries no credential material in data', () => {
    // data goes into CI logs; a URL is fine, an embedded token is not.
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';
    const collector = new CollectingEventSink();
    new VocareumClient(
      new TokenAuthProvider('super-secret-token', 'https://example.invalid/api/v2'),
      undefined, undefined, collector,
    );
    const serialized = JSON.stringify(collectDiagnostics(collector.drain()));
    expect(serialized).not.toContain('super-secret-token');
  });
});
