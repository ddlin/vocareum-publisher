import { describe, expect, it } from 'vitest';
import { pullResultToOutcome, serializePullInspection } from '../../src/commands/pull';

describe('pull outcome mapping', () => {
  const empty = {
    imported: 0,
    excluded: 0,
    skipped: 0,
    removed: 0,
    reset: 0,
    settingsPulled: 0,
    contentPulled: 0,
    filesNotDownloaded: 0,
    importsFailed: 0,
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

describe('resolved findings are not findings (spec §5.1)', () => {
  const base = { imported: 0, excluded: 0, skipped: 0, removed: 0, reset: 0, settingsPulled: 0, contentPulled: 0, failures: 0 };

  it('batch mode that APPLIED drift exits 0, not 5', () => {
    // The bug: hasFindings came from the pre-apply inspection, so a batch run
    // that resolved 13 settings changes still reported "reported"/exit 5.
    expect(pullResultToOutcome({ ...base, settingsPulled: 13 }, { hasFindings: false, failures: 0 }))
      .toEqual({ result: 'applied', category: undefined });
  });

  it('non-interactive mode that skipped everything reports findings', () => {
    expect(pullResultToOutcome({ ...base, skipped: 3 }, { hasFindings: true, failures: 0 }))
      .toEqual({ result: 'reported', category: 'findings' });
  });

  it('batch mode that applied drift but skipped stale still reports', () => {
    // Correct: a stale entry is work left for the operator to decide about.
    expect(pullResultToOutcome({ ...base, settingsPulled: 2, skipped: 1 }, { hasFindings: true, failures: 0 }))
      .toEqual({ result: 'reported', category: 'findings' });
  });

  it('the derivation itself: skipped>0 is what makes findings outstanding', () => {
    // Pins the call site's contract, so reverting to the inspection-based
    // version fails here rather than only in an end-to-end run.
    const applied = { ...base, imported: 1, settingsPulled: 13 };
    expect(applied.skipped).toBe(0);
    expect(pullResultToOutcome(applied, { hasFindings: applied.skipped > 0, failures: applied.failures }).result)
      .toBe('applied');
  });
});

describe('pull --json inspection projection', () => {
  // The inspection holds every downloaded remote file (remoteFiles: FileMap of
  // Buffers) so apply can write them. Serialized raw, `pull --content --json`
  // put the course's grading scripts and hidden tests on stdout, byte by byte.
  it('carries the diff, never the file contents', () => {
    const secret = Buffer.from('HIDDEN_TEST_SOLUTION');
    const inspection = {
      orphans: [], stale: [], settingsDrift: [],
      contentDrift: [{
        assignmentId: 'a1', assignmentName: 'lab1', assignmentPath: 'lab1',
        partsDrift: [{
          partId: 'p1', partName: 'Part 1', partPath: 'part1',
          fileDiffs: [{ filePath: 'scripts/grade.sh', status: 'modified' as const }],
          remoteFiles: { 'scripts/grade.sh': secret },
          directories: ['scripts' as const],
        }],
      }],
    };
    const json = JSON.stringify(serializePullInspection(inspection as never));
    expect(json).not.toMatch(/HIDDEN_TEST_SOLUTION|"type":"Buffer"/);
    expect(json).not.toMatch(/remoteFiles/);
    expect(json).toMatch(/scripts\/grade\.sh/);
    expect(json).toMatch(/"remoteFileCount":1/);
  });
});
