import { describe, it, expect } from 'vitest';
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SEVERITY,
  DIRECTORY_BLOCKED_REASONS,
  ZIP_NOT_USED_REASONS,
  collectDiagnostics,
  zipNotUsedDiagnostic,
} from '../../src/core/diagnostics';

describe('zip diagnostics', () => {
  it('S43: the allow-lists equal the spec lists exactly', () => {
    expect([...ZIP_NOT_USED_REASONS]).toEqual([
      'listing_failed', 'listing_over_budget', 'listed_size_over_limit',
      'start_failed', 'poll_failed', 'deadline', 'url_rejected',
      'clock_uncertain', 'object_stale', 'object_window', 'object_headers',
      'object_changed', 'object_download_failed', 'object_settle_changed',
      'zip_invalid', 'zip_over_budget', 'cycle_pattern', 'name_mismatch', 'budget',
      'quarantined',
    ]);
    expect(ZIP_NOT_USED_REASONS).toHaveLength(20);
    expect([...DIRECTORY_BLOCKED_REASONS]).toEqual(['incomplete-pull', 'container-asnlib']);
  });

  it('S43: no reason equals a registered diagnostic code', () => {
    const codes = new Set<string>(DIAGNOSTIC_CODES);
    for (const r of [...ZIP_NOT_USED_REASONS, ...DIRECTORY_BLOCKED_REASONS]) {
      expect(codes.has(r)).toBe(false);
    }
  });

  it('declares severities', () => {
    expect(DIAGNOSTIC_SEVERITY.zip_not_used).toBe('warn');
    expect(DIAGNOSTIC_SEVERITY.directory_blocked).toBe('error');
  });

  it('collectDiagnostics keeps a zip_not_used event with its data', () => {
    const w = zipNotUsedDiagnostic('p1', 'startercode', 'deadline', true);
    expect(w).toEqual({
      code: 'zip_not_used',
      data: { part_id: 'p1', directory: 'startercode', reason: 'deadline', quarantined: true },
    });
    const out = collectDiagnostics([{ level: 'warn', code: w.code, message: 'm', data: w.data }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'zip_not_used', severity: 'warn', count: 1, data: w.data });
  });
});
