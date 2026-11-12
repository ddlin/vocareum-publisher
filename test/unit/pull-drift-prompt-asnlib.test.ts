import { describe, it, expect, vi } from 'vitest';
import { chooseContentDriftAction, driftIncludesAsnlib } from '../../src/commands/pull';
import type { PullIssueContentDrift } from '../../src/core/services/pull-service';
import type { RootEvidence } from '../../src/core/course-architecture';
import type { ServiceEvent } from '../../src/core/services/event-sink';

const NOTE = 'Note: push refuses `asnlib` on this course, so keeping local `asnlib` files will not overwrite the remote.';

function issue(files: string[]): PullIssueContentDrift {
  return {
    kind: 'content-drift', index: 0, total: 1,
    drift: {
      assignmentId: '10', assignmentName: 'Lab', assignmentPath: 'lab',
      partsDrift: [{
        partId: '100', partName: 'Part', partPath: '.',
        fileDiffs: files.map((filePath) => ({ filePath, status: 'modified' as const })),
        remoteFiles: {}, directories: ['startercode', 'asnlib'],
      }],
    },
  };
}

function run(
  files: string[],
  lookup: () => Promise<RootEvidence>,
  mode: { batch?: boolean; nonInteractive?: boolean } = {},
) {
  const messages: string[] = [];
  const events = { emit: (e: ServiceEvent) => { if (e.message) { messages.push(e.message); } } };
  const ask = vi.fn(async (_q: string, opts: string[]) => opts[2]);
  const lookupFn = vi.fn(lookup);
  const result = chooseContentDriftAction(issue(files), {
    batch: mode.batch ?? false, nonInteractive: mode.nonInteractive ?? false,
    events, lookupRootEvidence: lookupFn, ask,
  });
  return { result, messages, ask, lookupFn };
}

describe('S39: drift prompt note for asnlib', () => {
  it('S39: asnlib drift on Container shows the note before the question', async () => {
    const r = run(['asnlib/a.py'], async () => ({ kind: 'container' }));
    expect(await r.result).toBe('skip');
    expect(r.messages).toContain(NOTE);
    expect(r.ask).toHaveBeenCalledTimes(1);
    expect(r.ask.mock.calls[0][1]).toEqual([
      'Pull remote files (overwrite local)',
      'Keep local files (will overwrite remote on next push)',
      'Skip (do nothing for now)',
    ]);
  });

  it('S39: asnlib drift on Elite shows no note', async () => {
    const r = run(['asnlib/a.py'], async () => ({ kind: 'elite' }));
    await r.result;
    expect(r.messages).not.toContain(NOTE);
    expect(r.lookupFn).toHaveBeenCalledTimes(1);
  });

  it('S39: a lookup error shows the note and the pull continues', async () => {
    const r = run(['asnlib/a.py'], async () => { throw new Error('boom'); });
    expect(await r.result).toBe('skip');
    expect(r.messages).toContain(NOTE);
    expect(r.ask).toHaveBeenCalledTimes(1);
  });

  it('S39: unknown evidence shows the note', async () => {
    const r = run(['asnlib/a.py'], async () => ({ kind: 'unknown', detail: 'x' }));
    await r.result;
    expect(r.messages).toContain(NOTE);
  });

  it('S39: startercode-only drift on Container shows no note and makes no lookup', async () => {
    const r = run(['startercode/a.py'], async () => ({ kind: 'container' }));
    await r.result;
    expect(r.messages).not.toContain(NOTE);
    expect(r.lookupFn).not.toHaveBeenCalled();
  });

  it('S39: --batch and non-interactive never look up', async () => {
    const b = run(['asnlib/a.py'], async () => ({ kind: 'container' }), { batch: true });
    expect(await b.result).toBe('pull');
    const n = run(['asnlib/a.py'], async () => ({ kind: 'container' }), { nonInteractive: true });
    expect(await n.result).toBe('skip');
    expect(b.lookupFn).not.toHaveBeenCalled();
    expect(n.lookupFn).not.toHaveBeenCalled();
    expect(b.ask).not.toHaveBeenCalled();
  });

  it('S39: an incomplete asnlib directory counts as asnlib drift', () => {
    const i = issue([]);
    i.drift.partsDrift[0].incompleteDirectories = ['asnlib'];
    expect(driftIncludesAsnlib(i.drift)).toBe(true);
    expect(driftIncludesAsnlib(issue(['asnlib2/x']).drift)).toBe(false);
  });
});
