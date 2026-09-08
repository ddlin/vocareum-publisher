import { describe, it, expect } from 'vitest';
import { collectDiagnostics } from '../../src/core/diagnostics';

const warn = (data?: Record<string, unknown>) =>
  ({ level: 'warn' as const, code: 'download_failed', message: 'm', ...(data !== undefined ? { data } : {}) });

describe('dedupe key matches what JSON.stringify will actually emit', () => {
  it('treats an undefined-valued key as absent', () => {
    // Both payloads serialize to {} in the report. Two entries with identical
    // JSON is not dedupe, it is a duplicate with extra steps.
    const out = collectDiagnostics([warn({}), warn({ path: undefined })]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(2);
  });

  it('still separates a present null from an absent key', () => {
    // null survives JSON.stringify, so it is a real distinction.
    const out = collectDiagnostics([warn({}), warn({ path: null })]);
    expect(out).toHaveLength(2);
  });
});

describe('circular data cannot take down the report', () => {
  it('collects a diagnostic whose data is circular instead of overflowing', () => {
    // buildReport calls collectDiagnostics BEFORE writeReport's try/catch, so a
    // RangeError here escapes the one place that guarantees a document.
    const circular: Record<string, unknown> = { part_id: '1' };
    circular.self = circular;
    expect(() => collectDiagnostics([warn(circular)])).not.toThrow();
    const out = collectDiagnostics([warn(circular)]);
    expect(out).toHaveLength(1);
  });

  it('dedupes two structurally identical circular payloads', () => {
    const a: Record<string, unknown> = { p: 1 }; a.self = a;
    const b: Record<string, unknown> = { p: 1 }; b.self = b;
    expect(collectDiagnostics([warn(a), warn(b)])).toHaveLength(1);
  });

  it('does not treat repeated (non-circular) references as a cycle', () => {
    // A shared child appearing twice is legitimate and must not be elided.
    const shared = { k: 'v' };
    const out = collectDiagnostics([warn({ a: shared, b: shared })]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out[0].data)).toBe(JSON.stringify({ a: shared, b: shared }));
  });
});

describe('severity does not depend on emission order', () => {
  it('escalates to error when the same code+data is emitted at both levels', () => {
    const warnFirst = collectDiagnostics([
      { level: 'warn', code: 'download_failed', message: 'm', data: { f: 1 } },
      { level: 'error', code: 'download_failed', message: 'm', data: { f: 1 } },
    ]);
    expect(warnFirst[0].severity).toBe('error');

    const errorFirst = collectDiagnostics([
      { level: 'error', code: 'download_failed', message: 'm', data: { f: 1 } },
      { level: 'warn', code: 'download_failed', message: 'm', data: { f: 1 } },
    ]);
    expect(errorFirst[0].severity).toBe('error');
    expect(errorFirst[0].count).toBe(2);
  });
});
