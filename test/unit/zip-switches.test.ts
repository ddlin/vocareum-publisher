import { describe, expect, it } from 'vitest';
import { resolvePullZipSettings } from '../../src/utils/zip-switches';
import { ConfigError } from '../../src/core/config';

const DEFAULT_TIMEOUT = 600_000;

function settings(env: Record<string, string | undefined>) {
  return resolvePullZipSettings(env as NodeJS.ProcessEnv);
}

describe('resolvePullZipSettings: VOCAREUM_PULL_ZIP', () => {
  it('unset gives zip on with the default timeout', () => {
    expect(settings({})).toEqual({ enabled: true, timeoutMs: DEFAULT_TIMEOUT });
  });
  it('empty string is treated as unset (on)', () => {
    expect(settings({ VOCAREUM_PULL_ZIP: '' }).enabled).toBe(true);
  });
  it.each(['1', 'true', 'on', 'yes', 'TRUE', ' Yes '])('%j is on', (v) => {
    expect(settings({ VOCAREUM_PULL_ZIP: v }).enabled).toBe(true);
  });
  it.each(['0', 'false', 'off', 'no', 'OFF', ' OFF '])('%j is off', (v) => {
    expect(settings({ VOCAREUM_PULL_ZIP: v }).enabled).toBe(false);
  });
  it.each(['2', 'of', 'y', 'enabled'])('%j throws INVALID_ENV naming the variable', (v) => {
    const run = () => settings({ VOCAREUM_PULL_ZIP: v });
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (e) {
      expect((e as ConfigError).code).toBe('INVALID_ENV');
      expect((e as Error).message).toContain('VOCAREUM_PULL_ZIP');
    }
  });
});

describe('resolvePullZipSettings: VOCAREUM_ZIP_TIMEOUT_MS', () => {
  it('unset gives 600,000', () => {
    expect(settings({}).timeoutMs).toBe(DEFAULT_TIMEOUT);
  });
  it('empty gives 600,000', () => {
    expect(settings({ VOCAREUM_ZIP_TIMEOUT_MS: '  ' }).timeoutMs).toBe(DEFAULT_TIMEOUT);
  });
  it.each([['1000', 1000], ['3600000', 3_600_000], [' 5000 ', 5000]])('%j is accepted', (v, n) => {
    expect(settings({ VOCAREUM_ZIP_TIMEOUT_MS: v }).timeoutMs).toBe(n);
  });
  it.each(['999', '3600001', '600000.5', '1e6', '-1', 'NaN', 'abc', '0x10', '+5000'])(
    '%j throws INVALID_ENV',
    (v) => {
      const run = () => settings({ VOCAREUM_ZIP_TIMEOUT_MS: v });
      expect(run).toThrow(ConfigError);
      try {
        run();
      } catch (e) {
        expect((e as ConfigError).code).toBe('INVALID_ENV');
        expect((e as Error).message).toContain('VOCAREUM_ZIP_TIMEOUT_MS');
      }
    },
  );
  it('is validated even when zip is off', () => {
    expect(() => settings({ VOCAREUM_PULL_ZIP: 'off', VOCAREUM_ZIP_TIMEOUT_MS: '5' })).toThrow(ConfigError);
  });
});
