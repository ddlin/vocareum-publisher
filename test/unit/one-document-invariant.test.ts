import { describe, it, expect } from 'vitest';
import { CommandFailureError } from '../../src/utils/command-failure';

/**
 * stdout carries exactly ONE document per --json invocation.
 *
 * This broke the first time a command both reported and exited non-zero: pull
 * wrote `result: "reported"` and threw CommandFailureError('findings') to reach
 * exit 5, and the entrypoint's catch wrote a SECOND envelope saying
 * `result: "failed"`. Two documents on stdout, and a consumer reading the last
 * line was told the run failed when it had succeeded at reporting findings.
 *
 * Only a real CLI invocation caught it; every unit test passed throughout.
 */
describe('CommandFailureError.reportWritten', () => {
  it('defaults to false, so an ordinary failure still gets an envelope', () => {
    expect(new CommandFailureError('boom', 'internal').reportWritten).toBe(false);
  });

  it('is carried when a command already wrote its document', () => {
    const error = new CommandFailureError('findings outstanding', 'findings', true);
    expect(error.reportWritten).toBe(true);
    expect(error.exitCode).toBe(5);
  });

  it('does not disturb the category or exit code', () => {
    for (const [category, code] of [['usage', 2], ['auth', 3], ['transient', 4], ['findings', 5], ['partial', 6]] as const) {
      const error = new CommandFailureError('x', category, true);
      expect(error.exitCode).toBe(code);
      expect(error.reportWritten).toBe(true);
    }
  });
});

describe('the entrypoint honours the flag', () => {
  it('guards its writeReport call on !failure.reportWritten', async () => {
    // A behavioural test would need to drive Commander; this pins the guard so
    // the condition cannot be dropped silently. The end-to-end proof is the
    // real-CLI run recorded in the commit message.
    const { readFileSync } = await import('fs');
    const source = readFileSync('src/index.ts', 'utf8');
    expect(source).toMatch(/!failure\.reportWritten/);
  });
});
