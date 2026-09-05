import { describe, it, expect, vi } from 'vitest';
import { buildReport, writeReport } from '../../src/core/report';

const base = { command: 'pull' as const, payload: { payload_schema_version: 1 }, events: [] };

describe('buildReport', () => {
  it('stamps a string envelope version and an ISO timestamp', () => {
    const report = buildReport({ ...base, result: 'no-op' });
    expect(report.schema_version).toBe('1.0');
    expect(typeof report.schema_version).toBe('string');
    expect(() => new Date(report.generated_at).toISOString()).not.toThrow();
  });

  it('defaults error to null and retryable to false', () => {
    const report = buildReport({ ...base, result: 'applied' });
    expect(report.error).toBeNull();
    expect(report.retryable).toBe(false);
  });

  it('mirrors the error retryable flag onto the envelope', () => {
    const report = buildReport({
      ...base,
      result: 'failed',
      error: { code: 'api_transient', message: 'HTTP 500', retryable: true },
    });
    expect(report.retryable).toBe(true);
  });

  it('emits empty collections rather than omitting them', () => {
    const report = buildReport({ ...base, result: 'no-op' });
    expect(report.diagnostics).toEqual([]);
    expect('diagnostics' in report).toBe(true);
  });

  it('collects diagnostics from the event stream', () => {
    const report = buildReport({
      ...base,
      result: 'applied',
      events: [{ level: 'warn', code: 'directory_unreachable', message: 'absent', data: { directory: 'docs' } }],
    });
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0].code).toBe('directory_unreachable');
  });
});

describe('writeReport', () => {
  it('writes exactly one parseable JSON document with a trailing newline', () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true; });
    try {
      writeReport(buildReport({ ...base, result: 'no-op' }));
    } finally {
      spy.mockRestore();
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0].endsWith('\n')).toBe(true);
    expect(() => JSON.parse(chunks[0])).not.toThrow();
  });

  it('emits a minimal envelope when the payload cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true; });
    try {
      writeReport(buildReport({ ...base, result: 'applied', payload: cyclic }));
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(chunks[0]) as { result: string; error: { code: string } };
    expect(parsed.result).toBe('failed');
    expect(parsed.error.code).toBe('report_serialization_failed');
  });
});
