/**
 * Environment Utilities Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { loadDotEnvIfPresent } from '../../src/utils/env';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe('loadDotEnvIfPresent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should do nothing if file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    loadDotEnvIfPresent('.env');

    expect(existsSync).toHaveBeenCalledWith('.env');
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('should load simple key=value pairs', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('FOO=bar\nBAZ=qux');

    loadDotEnvIfPresent('.env');

    expect(process.env.FOO).toBe('bar');
    expect(process.env.BAZ).toBe('qux');
  });

  it('should handle quoted values with double quotes', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('QUOTED="hello world"');

    loadDotEnvIfPresent('.env');

    expect(process.env.QUOTED).toBe('hello world');
  });

  it('should handle quoted values with single quotes', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("SINGLE='hello world'");

    loadDotEnvIfPresent('.env');

    expect(process.env.SINGLE).toBe('hello world');
  });

  it('should skip comments', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('# This is a comment\nKEY=value');

    loadDotEnvIfPresent('.env');

    expect(process.env.KEY).toBe('value');
    expect(process.env['# This is a comment']).toBeUndefined();
  });

  it('should skip empty lines', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('KEY1=value1\n\n\nKEY2=value2');

    loadDotEnvIfPresent('.env');

    expect(process.env.KEY1).toBe('value1');
    expect(process.env.KEY2).toBe('value2');
  });

  it('should handle export prefix', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('export MY_VAR=exported');

    loadDotEnvIfPresent('.env');

    expect(process.env.MY_VAR).toBe('exported');
  });

  it('should not overwrite existing env vars', () => {
    process.env.EXISTING = 'original';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('EXISTING=new_value');

    loadDotEnvIfPresent('.env');

    expect(process.env.EXISTING).toBe('original');
  });

  it('should handle values with equals signs', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('URL=https://example.com?foo=bar');

    loadDotEnvIfPresent('.env');

    expect(process.env.URL).toBe('https://example.com?foo=bar');
  });

  it('should use custom file path', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('CUSTOM=value');

    loadDotEnvIfPresent('.env.local');

    expect(existsSync).toHaveBeenCalledWith('.env.local');
  });

  it('should handle Windows-style line endings', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('WIN1=val1\r\nWIN2=val2');

    loadDotEnvIfPresent('.env');

    expect(process.env.WIN1).toBe('val1');
    expect(process.env.WIN2).toBe('val2');
  });

  it('should skip lines without equals sign', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('INVALID_LINE\nVALID=yes');

    loadDotEnvIfPresent('.env');

    expect(process.env.VALID).toBe('yes');
    expect(process.env.INVALID_LINE).toBeUndefined();
  });
});
