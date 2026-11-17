/**
 * Hash refresh (spec "Hash refresh for unchanged directories"): a directory the
 * content drift check proved complete and identical gets its stored hash
 * rewritten with the current exclusion-aware hash, so the next push does not
 * re-upload it with reset:1 and wipe the tree an exclude pattern names.
 *
 * Only the remote fetch is mocked (plus a pass-through wrapper around
 * calculateDirectoryHash, so one test can make the second hash differ); the
 * workspace is a real temporary tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockDownloadContent, mockReconcile, hashHook } = vi.hoisted(() => ({
  mockDownloadContent: vi.fn(),
  mockReconcile: vi.fn(),
  /** When set, may replace the result of the n-th calculateDirectoryHash call (1-based). */
  hashHook: { fn: undefined as undefined | ((dir: string, call: number, real: string) => string), calls: 0 },
}));
vi.mock('../../src/api/content', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/content')>('../../src/api/content');
  return { ...actual, downloadContent: mockDownloadContent };
});
vi.mock('../../src/core/reconciler', () => ({ reconcile: mockReconcile }));
vi.mock('../../src/utils/files', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/files')>('../../src/utils/files');
  return {
    ...actual,
    calculateDirectoryHash: async (dir: string, excludes?: string[]): Promise<string> => {
      const real = await actual.calculateDirectoryHash(dir, excludes);
      hashHook.calls++;
      return hashHook.fn ? hashHook.fn(dir, hashHook.calls, real) : real;
    },
  };
});

import { applyPull, inspectPull } from '../../src/core/services/pull-service';
import type { PullResolver, PullInspection, PullResult } from '../../src/core/services/pull-service';
import { serializePullInspection, pullResultToOutcome } from '../../src/commands/pull';
import type { Assignment, Config, PublishHistory } from '../../src/types/config';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import type { ServiceEvent } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { PullContext } from '../../src/core/services/context';
import type { LockedSession } from '../../src/core/session';
import { calculateDirectoryHash } from '../../src/utils/files';

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;
const HASHING = ['.gitkeep', '**/.gitkeep', 'venv'];
const KEY = path.join('asn1', 'data');

let workspaceRoot: string;
const chmodded: string[] = [];

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-hash-refresh-'));
  mockReconcile.mockResolvedValue({ orphanedInVocareum: [], staleInConfig: [] });
  hashHook.fn = undefined;
  hashHook.calls = 0;
});
afterEach(async () => {
  for (const p of chmodded.splice(0)) { await fs.chmod(p, 0o755).catch(() => undefined); }
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  mockDownloadContent.mockReset();
});

const abs = (rel: string): string => path.join(workspaceRoot, rel);

async function put(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
}

async function lockOut(rel: string): Promise<void> {
  await fs.chmod(abs(rel), 0o000);
  chmodded.push(abs(rel));
}

function asn(id: string, name: string, dir: string, directories: string[] = ['data']): Assignment {
  return {
    assignment_id: id, name, path: dir,
    parts: [{ part_id: `P-${id}`, name: 'Part 1', path: '.', directories }],
  } as unknown as Assignment;
}

function history(state: Record<string, string>): PublishHistory[] {
  return [{ timestamp: '2026-11-01T00:00:00Z', commit_sha: 'x', published_by: 'u', status: 'success', content_state: state }];
}

function makeConfig(opts: { state?: Record<string, string>; assignments?: Assignment[] } = {}): Config {
  return {
    version: '1.0',
    vocareum: { org_id: '1', course_id: 'C1', architecture: 'container', excluded_assignments: [] },
    publish_options: { sync_settings: false, sync_rubrics: false, exclude_patterns: ['venv'] },
    assignments: opts.assignments ?? [asn('A1', 'Asn One', 'asn1')],
    ...(opts.state ? { publish_history: history(opts.state) } : {}),
  } as unknown as Config;
}

function makeCtx(config: Config): { ctx: PullContext; events: CollectingEventSink } {
  const events = new CollectingEventSink();
  const ctx: PullContext = {
    persistedConfig: config, effectiveConfig: config, configPath: `${workspaceRoot}/vocareum.yaml`,
    workspaceRoot, events, prompter: new NonInteractivePrompter(), client: {} as never,
  };
  return { ctx, events };
}

function resolver(contentAction: 'pull' | 'keep' | 'skip' = 'pull', onContent?: () => void): PullResolver {
  return {
    resolveOrphanAction: vi.fn().mockResolvedValue('skip'),
    resolveStaleAction: vi.fn().mockResolvedValue('skip'),
    resolveSettingsDriftAction: vi.fn().mockResolvedValue('skip'),
    resolveContentDriftAction: vi.fn().mockImplementation(() => { onContent?.(); return Promise.resolve(contentAction); }),
    resolveImportPath: vi.fn(),
  } as unknown as PullResolver;
}

interface Run {
  inspection: PullInspection;
  events: CollectingEventSink;
  update: ReturnType<typeof vi.fn>;
  result: PullResult;
}

async function inspect(config: Config): Promise<{ inspection: PullInspection; ctx: PullContext; events: CollectingEventSink }> {
  const { ctx, events } = makeCtx(config);
  const inspection = await inspectPull(ctx, { content: true });
  return { inspection, ctx, events };
}

async function apply(
  config: Config, inspection: PullInspection, r: PullResolver = resolver(),
  ctxIn?: { ctx: PullContext; events: CollectingEventSink },
): Promise<Omit<Run, 'inspection'>> {
  const { ctx, events } = ctxIn ?? makeCtx(config);
  const update = vi.fn().mockResolvedValue(undefined);
  const result = await applyPull({ applyConfigUpdate: update } as LockedSession, ctx,
    { batch: false, nonInteractive: true, verbose: false, skipContent: false }, inspection, r);
  return { events, update, result };
}

async function inspectAndApply(config: Config, r?: PullResolver): Promise<Run> {
  const { inspection } = await inspect(config);
  return { inspection, ...await apply(config, inspection, r) };
}

function storedState(update: ReturnType<typeof vi.fn>): Record<string, string> | undefined {
  return update.mock.calls[0]?.[0]?.publish_history?.[0]?.content_state as Record<string, string> | undefined;
}

const messages = (events: CollectingEventSink): string[] => events.events.map((e: ServiceEvent) => e.message ?? '');

/** The customer's layout: data/a.txt equals remote, data/venv is local only. */
async function setupVenv(): Promise<{ withVenv: string; withoutVenv: string }> {
  await put('asn1/data/a.txt', 'same');
  await put('asn1/data/venv/bin/python', 'PYTHON');
  mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same') });
  const dir = abs('asn1/data');
  const withVenv = await calculateDirectoryHash(dir, ['.gitkeep', '**/.gitkeep']);
  const withoutVenv = await calculateDirectoryHash(dir, HASHING);
  hashHook.calls = 0;
  return { withVenv, withoutVenv };
}

describe('hash refresh: service', () => {
  it('X6 (service): refresh recorded with the exclusion-aware hash; no file written', async () => {
    const { withVenv, withoutVenv } = await setupVenv();
    expect(withVenv).not.toBe(withoutVenv);
    const config = makeConfig({ state: { [KEY]: withVenv } });
    const mtimes = await Promise.all(['asn1/data/a.txt', 'asn1/data/venv/bin/python'].map(async (f) => (await fs.stat(abs(f))).mtimeMs));

    const run = await inspectAndApply(config);

    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.hashRefresh).toEqual([
      { assignmentName: 'Asn One', stateKey: KEY, directoryAbs: abs('asn1/data'), hash: withoutVenv },
    ]);
    expect(storedState(run.update)?.[KEY]).toBe(withoutVenv);
    expect(run.update.mock.calls[0][0].publish_history[0].status).toBe('success');
    expect(run.result.hashesRefreshed).toBe(1);
    expect(run.result.contentPulled).toBe(0);
    expect(messages(run.events)).toContain(`Refreshed the stored hash of ${KEY}/ (no files changed)`);
    const after = await Promise.all(['asn1/data/a.txt', 'asn1/data/venv/bin/python'].map(async (f) => (await fs.stat(abs(f))).mtimeMs));
    expect(after).toEqual(mtimes);
    expect(await fs.readdir(abs('asn1/data'))).toEqual(expect.arrayContaining(['a.txt', 'venv']));
    expect(await fs.readdir(abs('asn1/data'))).toHaveLength(2);
  });

  it('X6b: a non-excluded download failure → no refresh', async () => {
    const { withVenv } = await setupVenv();
    mockDownloadContent.mockRejectedValue(new Error('could not download data/a.txt'));
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: withVenv } }));
    expect(run.inspection.hashRefresh).toEqual([]);
    expect(run.inspection.contentDriftIncomplete).toEqual([
      { assignmentName: 'Asn One', reason: 'could not download data/a.txt' },
    ]);
    expect(run.result.hashesRefreshed).toBe(0);
    expect(run.update).not.toHaveBeenCalled();
  });

  it('X6c: file edited after inspect → not refreshed', async () => {
    const { withVenv } = await setupVenv();
    const config = makeConfig({ state: { [KEY]: withVenv } });
    const { inspection } = await inspect(config);
    expect(inspection.hashRefresh).toHaveLength(1);
    await put('asn1/data/a.txt', 'edited while the prompt was open');
    const run = await apply(config, inspection);
    expect(run.result.hashesRefreshed).toBe(0);
    expect(run.update).not.toHaveBeenCalled();
    expect(messages(run.events)).toContain(`${KEY}/ changed during the pull; its stored hash was not refreshed`);
  });

  it('X6c: file edited between comparison and hash → not eligible', async () => {
    const { withVenv } = await setupVenv();
    // Call 1 is the hash taken before the comparison, call 2 the one after the
    // local walk: an edit in between changes the second.
    hashHook.fn = (_dir, call, real): string => (call === 2 ? `${real}-edited` : real);
    const { inspection } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
    expect(hashHook.calls).toBe(2);
    expect(inspection.hashRefresh).toEqual([]);
    expect(inspection.contentDrift).toEqual([]);
  });

  it('directory removed between check and apply → no refresh, even when its checked hash is the empty digest', async () => {
    await put('asn1/data/venv/bin/python', 'PYTHON');
    mockDownloadContent.mockResolvedValue({});
    const empty = await calculateDirectoryHash(abs('asn1/data'), HASHING);
    expect(empty).toBe(await calculateDirectoryHash(abs('asn1/nowhere'), HASHING));
    const config = makeConfig({ state: { [KEY]: 'stale-hash-with-venv' } });
    const { inspection } = await inspect(config);
    expect(inspection.hashRefresh?.map((r) => r.hash)).toEqual([empty]);
    await fs.rm(abs('asn1/data'), { recursive: true });
    const run = await apply(config, inspection);
    expect(run.result.hashesRefreshed).toBe(0);
    expect(run.update).not.toHaveBeenCalled();
    expect(messages(run.events)).toContain(`${KEY}/ changed during the pull; its stored hash was not refreshed`);
  });

  it('a directory missing locally is never refreshed (an empty remote is not proof)', async () => {
    mockDownloadContent.mockResolvedValue({});
    await fs.mkdir(abs('asn1'), { recursive: true });
    const { inspection } = await inspect(makeConfig({ state: { [KEY]: 'old' } }));
    expect(inspection.hashRefresh).toEqual([]);
  });

  it('X6d: incomplete-pull marker with identical content → refreshed, no partsDrift entry', async () => {
    const { withoutVenv } = await setupVenv();
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: 'incomplete-pull' } }));
    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
    expect(run.inspection.hashRefresh?.map((r) => r.stateKey)).toEqual([KEY]);
    expect(storedState(run.update)?.[KEY]).toBe(withoutVenv);
    expect(messages(run.events).some((m) => m.includes('an earlier pull was incomplete'))).toBe(false);
  });

  it.each([['missing', undefined], ['push-incomplete', 'push-incomplete']])(
    'rule 2: %s content_state is refreshed too', async (_label, stored) => {
      const { withoutVenv } = await setupVenv();
      const state: Record<string, string> = { other: 'keep-me' };
      if (stored !== undefined) { state[KEY] = stored; }
      const run = await inspectAndApply(makeConfig({ state }));
      expect(run.inspection.hashRefresh?.map((r) => r.stateKey)).toEqual([KEY]);
      expect(storedState(run.update)).toEqual({ other: 'keep-me', [KEY]: withoutVenv });
    },
  );

  it('an already-current hash is not refreshed (no-op pull stays a no-op)', async () => {
    const { withoutVenv } = await setupVenv();
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: withoutVenv } }));
    expect(run.inspection.hashRefresh).toEqual([]);
    expect(run.update).not.toHaveBeenCalled();
    expect(run.result.hashesRefreshed).toBe(0);
  });

  it.runIf(canChmod)('X6e: unreadable non-excluded local subdirectory → no refresh', async () => {
    const { withVenv } = await setupVenv();
    await put('asn1/data/sub/s.txt', 'S');
    await lockOut('asn1/data/sub');
    const { inspection } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
    expect(inspection.hashRefresh).toEqual([]);
    expect(inspection.contentDriftIncomplete).toEqual([
      { assignmentName: 'Asn One', reason: 'could not read local data/sub; it was not compared' },
    ]);
  });

  it.runIf(canChmod)('X6e-pruned: unreadable directory inside venv does not block refresh', async () => {
    const { withVenv, withoutVenv } = await setupVenv();
    await put('asn1/data/venv/sub/secret', 'S');
    await lockOut('asn1/data/venv/sub');
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: withVenv } }));
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
    expect(run.inspection.hashRefresh?.map((r) => r.hash)).toEqual([withoutVenv]);
    expect(run.result.hashesRefreshed).toBe(1);
  });

  it('rule 1: an escaped local entry disqualifies the directory', async () => {
    const { withVenv } = await setupVenv();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-hash-refresh-out-'));
    try {
      await fs.symlink(outside, abs('asn1/data/escape'));
      const { inspection } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
      expect(inspection.contentDrift).toEqual([]);
      expect(inspection.hashRefresh).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rule 1: an omitted remote file (local path is a symlink) disqualifies the directory', async () => {
    const { withVenv } = await setupVenv();
    await put('asn1/target.txt', 'T');
    await fs.symlink('../target.txt', abs('asn1/data/linked.txt'));
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same'), 'data/linked.txt': Buffer.from('T') });
    const { inspection } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
    expect(inspection.contentDrift).toEqual([]);
    expect(inspection.hashRefresh).toEqual([]);
  });

  it('a dangling local symlink is ignored by the comparison (as before) but blocks the refresh', async () => {
    const { withVenv } = await setupVenv();
    await fs.symlink('does-not-exist', abs('asn1/data/dangling'));
    const { inspection, events } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
    expect(inspection.contentDrift).toEqual([]);
    expect(inspection.contentDriftIncomplete).toEqual([]);
    expect(events.events.filter((e) => e.level === 'warn')).toEqual([]);
    expect(inspection.hashRefresh).toEqual([]);
  });

  it('a dangling local symlink does not stop later files in data/ being compared', async () => {
    const { withVenv } = await setupVenv();
    await fs.symlink('does-not-exist', abs('asn1/data/aaa-dangling'));
    await put('asn1/data/zzz-local-only.txt', 'L');
    const { inspection } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
    expect(inspection.contentDrift.flatMap((d) => d.partsDrift.flatMap((p) => p.fileDiffs)))
      .toEqual([{ filePath: 'data/zzz-local-only.txt', status: 'deleted' }]);
    expect(inspection.hashRefresh).toEqual([]);
  });

  it.runIf(canChmod)('a local-only file beside an unreadable subdirectory is reported deleted; no refresh', async () => {
    const { withVenv } = await setupVenv();
    await put('asn1/data/local-only.txt', 'L');
    await put('asn1/data/sub/s.txt', 'S');
    await lockOut('asn1/data/sub');
    const { inspection } = await inspect(makeConfig({ state: { [KEY]: withVenv } }));
    expect(inspection.contentDrift.flatMap((d) => d.partsDrift.flatMap((p) => p.fileDiffs)))
      .toEqual([{ filePath: 'data/local-only.txt', status: 'deleted' }]);
    expect(inspection.contentDriftIncomplete?.map((s) => s.assignmentName)).toEqual(['Asn One']);
    expect(inspection.hashRefresh).toEqual([]);
  });

  it('refresh is independent of the drift action', async () => {
    const { withVenv, withoutVenv } = await setupVenv();
    await put('asn1/docs/readme.md', 'local');
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same'), 'docs/readme.md': Buffer.from('remote') });
    const config = makeConfig({
      state: { [KEY]: withVenv, [path.join('asn1', 'docs')]: 'docs-old' },
      assignments: [asn('A1', 'Asn One', 'asn1', ['data', 'docs'])],
    });
    const run = await inspectAndApply(config, resolver('skip'));
    expect(run.inspection.contentDrift).toHaveLength(1);
    expect(run.result.skipped).toBe(1);
    expect(run.result.hashesRefreshed).toBe(1);
    expect(storedState(run.update)).toEqual({ [KEY]: withoutVenv, [path.join('asn1', 'docs')]: 'docs-old' });
    expect(await fs.readFile(abs('asn1/docs/readme.md'), 'utf8')).toBe('local');
  });

  it('a directory with drift is not refreshed', async () => {
    const { withVenv } = await setupVenv();
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('changed') });
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: withVenv } }), resolver('keep'));
    expect(run.inspection.hashRefresh).toEqual([]);
    expect(run.inspection.contentDrift).toHaveLength(1);
    expect(run.update).not.toHaveBeenCalled();
  });

  it('a pulled directory keeps the pull rehash, not a second refresh', async () => {
    const { withVenv } = await setupVenv();
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('changed') });
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: withVenv } }), resolver('pull'));
    expect(run.result.contentPulled).toBe(1);
    expect(run.result.hashesRefreshed).toBe(0);
    expect(storedState(run.update)?.[KEY]).toBe(await calculateDirectoryHash(abs('asn1/data'), HASHING));
  });

  it('stillIncompleteDirectories behaviour unchanged', async () => {
    await put('asn1/data/a.txt', 'same');
    await put('asn1/target.txt', 'T');
    await fs.symlink('../target.txt', abs('asn1/data/missed.txt'));
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same'), 'data/missed.txt': Buffer.from('remote only') });
    const run = await inspectAndApply(makeConfig({ state: { [KEY]: 'incomplete-pull' } }));
    expect(run.inspection.hashRefresh).toEqual([]);
    expect(run.inspection.contentDrift[0].partsDrift[0].stillIncompleteDirectories).toEqual(['data']);
    const entry = run.update.mock.calls[0][0].publish_history[0];
    expect(entry.status).toBe('failed');
    expect(entry.content_state[KEY]).toBe('incomplete-pull');
  });

  it("history: a refresh in a run where another assignment's drift check was skipped records status failed with that skip in failed[]", async () => {
    const { withVenv, withoutVenv } = await setupVenv();
    mockDownloadContent.mockImplementation((_c: unknown, _course: string, assignmentId: string) =>
      assignmentId === 'A2'
        ? Promise.reject(new Error('Download limit exceeded'))
        : Promise.resolve({ 'data/a.txt': Buffer.from('same') }));
    const config = makeConfig({
      state: { [KEY]: withVenv },
      assignments: [asn('A1', 'Asn One', 'asn1'), asn('A2', 'Asn Two', 'asn2')],
    });
    const run = await inspectAndApply(config);
    expect(run.result.hashesRefreshed).toBe(1);
    const entry = run.update.mock.calls[0][0].publish_history[0];
    expect(entry.content_state[KEY]).toBe(withoutVenv);
    expect(entry.status).toBe('failed');
    expect(entry.failed).toEqual([
      { type: 'assignment', id: 'Asn Two', error: 'content drift check skipped: Download limit exceeded' },
    ]);
  });

  it('interactive: refreshes are listed before the drift prompts', async () => {
    const { withVenv } = await setupVenv();
    await put('asn1/docs/readme.md', 'local');
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same'), 'docs/readme.md': Buffer.from('remote') });
    const config = makeConfig({
      state: { [KEY]: withVenv },
      assignments: [asn('A1', 'Asn One', 'asn1', ['data', 'docs'])],
    });
    const { inspection } = await inspect(config);
    const holder = makeCtx(config);
    let seenAtPrompt: string[] = [];
    await apply(config, inspection, resolver('skip', () => { seenAtPrompt = messages(holder.events); }), holder);
    const line = `Will refresh the stored hash of ${KEY}/ (unchanged content; no files are written)`;
    expect(seenAtPrompt).toContain(line);
    expect(holder.events.events.find((e) => e.message === line)?.level).toBe('plain');
  });
});

describe('hash refresh: command projection', () => {
  it('serializePullInspection exposes refresh state keys only', () => {
    const inspection: PullInspection = {
      orphans: [], stale: [], settingsDrift: [], contentDrift: [],
      hashRefresh: [{ assignmentName: 'Asn One', stateKey: KEY, directoryAbs: '/abs/ws/asn1/data', hash: 'deadbeef' }],
    };
    const doc = serializePullInspection(inspection) as { hashRefresh: unknown };
    expect(doc.hashRefresh).toEqual([{ assignmentName: 'Asn One', stateKey: KEY }]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('/abs/ws');
    expect(text).not.toContain('deadbeef');
  });

  it('a run that only refreshed hashes is applied, not a no-op', () => {
    const applied: PullResult = {
      imported: 0, excluded: 0, skipped: 0, removed: 0, reset: 0, settingsPulled: 0, contentPulled: 0,
      filesNotDownloaded: 0, importsFailed: 0, hashesRefreshed: 1,
    };
    expect(pullResultToOutcome(applied, { hasFindings: false, failures: 0 }))
      .toEqual({ result: 'applied', category: undefined });
  });
});
