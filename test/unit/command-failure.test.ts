import { describe, it, expect } from 'vitest';
import { CommandFailureError, exitCodeForCategory } from '../../src/utils/command-failure';

describe('CommandFailureError', () => {
  it('defaults exitCode to 1', () => {
    const err = new CommandFailureError('boom');
    expect(err.exitCode).toBe(1);
  });

  it('preserves the message', () => {
    const err = new CommandFailureError('boom');
    expect(err.message).toBe('boom');
  });

  it('is an instance of Error', () => {
    const err = new CommandFailureError('boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('sets name to CommandFailureError', () => {
    const err = new CommandFailureError('boom');
    expect(err.name).toBe('CommandFailureError');
  });

  it('derives exitCode from the category', () => {
    const err = new CommandFailureError('fatal', 'usage');
    expect(err.exitCode).toBe(2);
  });
});

describe('failure categories', () => {
  it('maps every category to its documented exit code', () => {
    expect(exitCodeForCategory('internal')).toBe(1);
    expect(exitCodeForCategory('usage')).toBe(2);
    expect(exitCodeForCategory('auth')).toBe(3);
    expect(exitCodeForCategory('transient')).toBe(4);
    expect(exitCodeForCategory('findings')).toBe(5);
    expect(exitCodeForCategory('partial')).toBe(6);
  });

  it('defaults to internal/1 so an uncategorized failure is never silently success', () => {
    const error = new CommandFailureError('boom');
    expect(error.category).toBe('internal');
    expect(error.exitCode).toBe(1);
  });

  it('derives exitCode from the category', () => {
    expect(new CommandFailureError('nope', 'auth').exitCode).toBe(3);
    expect(new CommandFailureError('later', 'transient').exitCode).toBe(4);
  });

  it('reports retryability for exactly the transient category', () => {
    expect(new CommandFailureError('x', 'transient').retryable).toBe(true);
    expect(new CommandFailureError('x', 'auth').retryable).toBe(false);
    expect(new CommandFailureError('x', 'usage').retryable).toBe(false);
  });
});
