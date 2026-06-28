import { describe, it, expect } from 'vitest';
import { CommandFailureError } from '../../src/utils/command-failure';

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

  it('accepts a custom exitCode', () => {
    const err = new CommandFailureError('fatal', 2);
    expect(err.exitCode).toBe(2);
  });
});
