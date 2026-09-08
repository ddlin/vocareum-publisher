import { describe, it, expect, vi } from 'vitest';
import { ConfigError } from '../../src/core/config';
import { RateLimitError } from '../../src/api/client';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { buildReport, reportingFailures, writeReport } from '../../src/core/report';

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

describe('reportingFailures', () => {
  async function captureFailure(run: () => Promise<void>): Promise<unknown> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true; });
    try {
      await run();
    } catch (error) {
      return { error, chunks };
    } finally {
      spy.mockRestore();
    }
    return { error: null, chunks };
  }

  it('writes a failed envelope for config errors in json mode', async () => {
    const collector = new CollectingEventSink();
    const result = await captureFailure(async () => {
      await reportingFailures('status', true, collector, async () => {
        throw new ConfigError('bad yaml', 'INVALID_CONFIG');
      });
    }) as { error: unknown; chunks: string[] };

    expect(result.chunks).toHaveLength(1);
    const doc = JSON.parse(result.chunks[0]) as { result: string; retryable: boolean; error: { code: string; retryable: boolean } };
    expect(doc.result).toBe('failed');
    expect(doc.retryable).toBe(false);
    expect(doc.error.code).toBe('usage');
    expect(doc.error.retryable).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('writes a retryable failed envelope for rate limits in json mode', async () => {
    const collector = new CollectingEventSink();
    const result = await captureFailure(async () => {
      await reportingFailures('push', true, collector, async () => {
        throw new RateLimitError(30);
      });
    }) as { error: unknown; chunks: string[] };

    expect(result.chunks).toHaveLength(1);
    const doc = JSON.parse(result.chunks[0]) as { retryable: boolean; error: { code: string; retryable: boolean } };
    expect(doc.retryable).toBe(true);
    expect(doc.error.code).toBe('transient');
    expect(doc.error.retryable).toBe(true);
  });
});

describe('writeReport failure signalling', () => {
  it('returns true when the report serialized cleanly', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(writeReport(buildReport({ ...base, result: 'no-op' }))).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('returns false when it fell back, so the caller can fail the command', () => {
    // Previously this printed "failed" to stdout and the process still exited 0.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(writeReport(buildReport({ ...base, result: 'applied', payload: cyclic }))).toBe(false);
    } finally { spy.mockRestore(); }
  });
});
