import { describe, expect, it } from 'vitest';
import { pullResultToOutcome } from '../../src/commands/pull';

describe('pull outcome mapping', () => {
  const empty = {
    imported: 0,
    excluded: 0,
    skipped: 0,
    removed: 0,
    reset: 0,
    settingsPulled: 0,
    contentPulled: 0,
    failures: 0,
  };

  it('no findings and nothing applied is a clean no-op', () => {
    expect(pullResultToOutcome(empty, { hasFindings: false, failures: 0 }))
      .toEqual({ result: 'no-op', category: undefined });
  });

  it('findings that were applied exit 0', () => {
    expect(pullResultToOutcome({ ...empty, settingsPulled: 13 }, { hasFindings: false, failures: 0 }))
      .toEqual({ result: 'applied', category: undefined });
  });

  it('findings left outstanding are a findings failure', () => {
    expect(pullResultToOutcome(empty, { hasFindings: true, failures: 0 }))
      .toEqual({ result: 'reported', category: 'findings' });
  });

  it('some applied and some failed is partial', () => {
    expect(pullResultToOutcome({ ...empty, imported: 3 }, { hasFindings: false, failures: 2 }))
      .toEqual({ result: 'partial', category: 'partial' });
  });

  it('partial outranks findings', () => {
    expect(pullResultToOutcome({ ...empty, imported: 1 }, { hasFindings: true, failures: 1 }).result)
      .toBe('partial');
  });
});
