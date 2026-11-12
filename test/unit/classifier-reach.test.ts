import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../../src/utils/failure-classifier';
import { APIError } from '../../src/api/client';
import { WorkspaceError } from '../../src/core/workspace';
import { UsageError } from '../../src/utils/command-failure';
import { CredentialsMissingError } from '../../src/utils/env';

/**
 * The taxonomy is only worth having if real failure sites can reach it. Each
 * case below exited 1 ("internal error, file a bug") in shipped code, which is
 * both wrong and the least actionable answer available.
 */
describe('classifier reach', () => {
  it('missing credentials is auth, not internal', () => {
    expect(classifyFailure(new CredentialsMissingError('no token'))).toBe('auth');
  });

  it('a bad --assignment/--part combination is usage, not internal', () => {
    expect(classifyFailure(new UsageError('--part requires --content'))).toBe('usage');
  });

  it('an unresolvable workspace root is usage, not internal', () => {
    expect(classifyFailure(new WorkspaceError('cannot determine workspace root'))).toBe('usage');
  });

  it('an HTTP 400 is usage: the request was rejected, retrying will not help', () => {
    // e.g. a nonexistent course_id -> 400 { error: { message: "Invalid course" } }
    expect(classifyFailure(new APIError('Invalid course', 400, undefined, false))).toBe('usage');
  });

  it('a 500 stays transient, so retry advice is unaffected', () => {
    expect(classifyFailure(new APIError('boom', 500, undefined, true))).toBe('transient');
  });

  it('a 418 stays internal — only 400 carries the "your input" meaning', () => {
    expect(classifyFailure(new APIError('teapot', 418, undefined, false))).toBe('internal');
  });
});
