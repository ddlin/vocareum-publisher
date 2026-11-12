import { describe, it, expect } from 'vitest';
import { collectDiagnostics, DIAGNOSTIC_CODES, isDiagnosticCode } from '../../src/core/diagnostics';

describe('collectDiagnostics', () => {
  it('ignores events with no code', () => {
    expect(collectDiagnostics([{ level: 'info', message: 'chatter' }])).toEqual([]);
  });

  it('keeps only warn and error levels', () => {
    const out = collectDiagnostics([
      { level: 'info', code: 'rubric_write_skipped', message: 'not a diagnostic' },
      { level: 'warn', code: 'rubric_write_skipped', message: 'is one' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('is one');
  });

  it('dedupes identical (code, data) pairs and counts them', () => {
    const events = Array.from({ length: 107 }, () => ({
      level: 'warn' as const,
      code: 'unknown_settings',
      message: 'Vocareum returned unsupported settings fields',
      data: { scope: 'part', fields: ['cleanup_time'] },
    }));
    const out = collectDiagnostics(events);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(107);
  });

  it('treats differing data as distinct diagnostics', () => {
    const out = collectDiagnostics([
      { level: 'warn', code: 'directory_unreachable', message: 'a', data: { directory: 'docs' } },
      { level: 'warn', code: 'directory_unreachable', message: 'b', data: { directory: 'scripts' } },
    ]);
    expect(out).toHaveLength(2);
  });

  it('dedupes regardless of key order in data', () => {
    // Two emit sites building the same object in different order must not
    // produce two entries.
    const out = collectDiagnostics([
      { level: 'warn', code: 'directory_unreachable', message: 'x', data: { a: 1, b: 2 } },
      { level: 'warn', code: 'directory_unreachable', message: 'x', data: { b: 2, a: 1 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });

  it('preserves first-occurrence order', () => {
    const out = collectDiagnostics([
      { level: 'warn', code: 'download_failed', message: 'second-listed first' },
      { level: 'warn', code: 'directory_unreachable', message: 'first-listed second' },
      { level: 'warn', code: 'download_failed', message: 'second-listed first' },
    ]);
    expect(out.map((d) => d.code)).toEqual(['download_failed', 'directory_unreachable']);
  });

  it('drops a coded event whose code is not in the registry', () => {
    // A typo must not invent a public contract entry.
    expect(collectDiagnostics([{ level: 'warn', code: 'made_up_code', message: 'x' }])).toEqual([]);
  });
});

describe('registry', () => {
  it('has no duplicate codes', () => {
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it('recognises exactly its own members', () => {
    expect(DIAGNOSTIC_CODES.every((c) => isDiagnosticCode(c))).toBe(true);
    expect(isDiagnosticCode('not_a_real_code')).toBe(false);
  });
});
