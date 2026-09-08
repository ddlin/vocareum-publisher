import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/config';
import {
  APIError,
  AuthenticationError,
  ForbiddenError,
  InsecureBaseUrlError,
  NotFoundError,
  RateLimitError,
} from '../../src/api/client';
import {
  classifyFailure,
  commandFailureFromError,
  reportErrorFromFailure,
} from '../../src/utils/failure-classifier';

describe('classifyFailure', () => {
  it('maps config, missing-resource, and insecure base-url errors to usage', () => {
    expect(classifyFailure(new ConfigError('bad yaml', 'INVALID_CONFIG'))).toBe('usage');
    expect(classifyFailure(new NotFoundError('course', 'course-1'))).toBe('usage');
    expect(classifyFailure(new InsecureBaseUrlError('http://example.test'))).toBe('usage');
  });

  it('maps auth and forbidden API errors to auth', () => {
    expect(classifyFailure(new AuthenticationError('no token'))).toBe('auth');
    expect(classifyFailure(new ForbiddenError('course access forbidden', 'course'))).toBe('auth');
  });

  it('maps rate limits, API 5xx, and preserved timeout/network errors to transient', () => {
    expect(classifyFailure(new RateLimitError(30))).toBe('transient');
    expect(classifyFailure(new APIError('server exploded', 503))).toBe('transient');
    expect(classifyFailure(new APIError('timeout of 30000ms exceeded', undefined, { code: 'ECONNABORTED' }, true))).toBe('transient');
  });

  it('maps a rejected request (400) to usage, not internal', () => {
    // Changed deliberately. This previously asserted 'internal', which the
    // code review of Task 6 identified as the defect: a 400 means the request
    // was rejected as invalid, so retrying it unchanged cannot help and "file a
    // bug" is the wrong advice. Vocareum answers a nonexistent course_id with
    // 400 { error: { message: "Invalid course" } }, and that user exited 1.
    expect(classifyFailure(new APIError('bad request', 400))).toBe('usage');
    expect(classifyFailure(new APIError('Invalid course', 400))).toBe('usage');
  });

  it('maps other non-retryable API errors and unknown throws to internal', () => {
    expect(classifyFailure(new APIError('teapot', 418))).toBe('internal');
    expect(classifyFailure(new Error('plain boom'))).toBe('internal');
    expect(classifyFailure('string throw')).toBe('internal');
  });
});

describe('commandFailureFromError', () => {
  it('wraps with the classified category and derived exit code', () => {
    const failure = commandFailureFromError('Pull failed: no token', new AuthenticationError('no token'));
    expect(failure.category).toBe('auth');
    expect(failure.exitCode).toBe(3);
  });

  it('keeps retryability aligned with the category for JSON errors', () => {
    const failure = commandFailureFromError('Push failed: 500', new APIError('server exploded', 500));
    expect(reportErrorFromFailure(failure)).toEqual({
      code: 'transient',
      message: 'Push failed: 500',
      retryable: true,
    });
  });
});
