import { describe, it, expect, vi } from 'vitest';
import { chooseContentDriftAction, driftIncludesAsnlib, rootEvidenceLookup } from '../../src/commands/pull';
import type { VocareumClient } from '../../src/api/client';
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

describe('S39: the command wiring of the root lookup', () => {
  /** A client that answers only root listings, recording each request. */
  function rootClient(names: unknown[]) {
    const requests: { url: string; params?: Record<string, unknown> }[] = [];
    const client = {
      request: vi.fn(async (cfg: { url: string; params?: { dir?: string; page?: number } }) => {
        requests.push({ url: cfg.url, params: cfg.params });
        if (cfg.params?.dir !== '/') { throw new Error(`unexpected request ${cfg.url}`); }
        return (cfg.params.page ?? 0) === 0 ? names : [];
      }),
    } as unknown as VocareumClient;
    return { client, requests };
  }

  function driftIssue(assignmentId: string, partIds: string[]): PullIssueContentDrift {
    const base = issue(['asnlib/a.py']);
    return {
      ...base,
      drift: {
        ...base.drift,
        assignmentId,
        partsDrift: partIds.map((partId) => ({ ...base.drift.partsDrift[0], partId })),
      },
    };
  }

  it('lists the root of the drift\'s own assignment and first part, in the configured course', async () => {
    const { client, requests } = rootClient(['resource/', 'voc/', 'work/']);
    const lookup = rootEvidenceLookup(client, 'c77', new Map());
    expect(await lookup(driftIssue('a5', ['p8', 'p9']))).toEqual({ kind: 'container' });
    expect(requests.map((r) => r.url)).toEqual([
      '/courses/c77/assignments/a5/parts/p8/files',
      '/courses/c77/assignments/a5/parts/p8/files',
    ]);
    expect(requests.map((r) => [r.params?.dir, r.params?.page ?? 0])).toEqual([['/', 0], ['/', 1]]);
  });

  it('drives the prompt: a Container root shows the note; an Elite root does not; one lookup per course per run', async () => {
    const container = rootClient(['resource/', 'voc/', 'work/']);
    const messages: string[] = [];
    const events = { emit: (e: ServiceEvent) => { if (e.message) { messages.push(e.message); } } };
    const ask = vi.fn(async (_q: string, opts: string[]) => opts[2]);
    const cache = new Map<string, RootEvidence>();
    const deps = { batch: false, nonInteractive: false, events, ask, lookupRootEvidence: rootEvidenceLookup(container.client, 'c77', cache) };
    expect(await chooseContentDriftAction(driftIssue('a5', ['p8']), deps)).toBe('skip');
    expect(messages).toContain(NOTE);
    await chooseContentDriftAction(driftIssue('a6', ['p10']), deps);
    expect(container.requests.filter((r) => (r.params?.page ?? 0) === 0)).toHaveLength(1);

    const elite = rootClient(['resource/', 'work/']);
    const quiet: string[] = [];
    await chooseContentDriftAction(driftIssue('a5', ['p8']), {
      ...deps,
      events: { emit: (e: ServiceEvent) => { if (e.message) { quiet.push(e.message); } } },
      lookupRootEvidence: rootEvidenceLookup(elite.client, 'c77', new Map()),
    });
    expect(quiet).not.toContain(NOTE);
  });

  it('a drift with no part makes no request: not positively Elite', async () => {
    const { client, requests } = rootClient(['resource/', 'work/']);
    expect(await rootEvidenceLookup(client, 'c77', new Map())(driftIssue('a5', []))).toEqual({
      kind: 'unknown', detail: 'no part of this course existed to check',
    });
    expect(requests).toEqual([]);
  });
});
