import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../src/core/config';
import { APIError, AuthenticationError, RateLimitError } from '../../src/api/client';
import { commandFailureFromError, reportErrorFromFailure } from '../../src/utils/failure-classifier';
import { buildReport, writeReport } from '../../src/core/report';

describe('command error classification', () => {
  it('makes malformed config failures exit 2', () => {
    const failure = commandFailureFromError(
      'Validation failed: Invalid configuration',
      new ConfigError('Invalid configuration', 'INVALID_CONFIG'),
    );
    expect(failure.exitCode).toBe(2);
  });

  it('makes auth failures exit 3', () => {
    const failure = commandFailureFromError(
      'Pull failed: bad credentials',
      new AuthenticationError('bad credentials'),
    );
    expect(failure.exitCode).toBe(3);
  });

  it('makes rate-limit and API 5xx failures exit 4', () => {
    expect(commandFailureFromError('Push failed: 429', new RateLimitError(10)).exitCode).toBe(4);
    expect(commandFailureFromError('Push failed: 503', new APIError('unavailable', 503)).exitCode).toBe(4);
  });
});

describe('JSON failure envelope', () => {
  let stdoutWrites: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrites = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('writes result=failed with a structured error and empty collections', () => {
    const failure = commandFailureFromError('Status failed: bad yaml', new ConfigError('bad yaml', 'INVALID_CONFIG'));
    writeReport(buildReport({
      command: 'status',
      result: 'failed',
      payload: { payload_schema_version: 2 },
      events: [],
      error: reportErrorFromFailure(failure),
    }));

    expect(stdoutWrites).toHaveLength(1);
    const doc = JSON.parse(stdoutWrites[0]) as {
      result: string;
      retryable: boolean;
      diagnostics: unknown[];
      error: { code: string; retryable: boolean };
    };
    expect(doc.result).toBe('failed');
    expect(doc.retryable).toBe(false);
    expect(doc.diagnostics).toEqual([]);
    expect(doc.error).toEqual({ code: 'usage', message: 'Status failed: bad yaml', retryable: false });
  });
});
