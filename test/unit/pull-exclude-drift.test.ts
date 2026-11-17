/**
 * exclude_patterns in the pull service: the import, the zip gate, both sides of
 * the content drift check, and the drift-apply rehash. Only the remote fetch
 * (and the API reads an import makes) are mocked; the local workspace is a real
 * temporary tree, so the local walk and hashing run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  mockDownloadContent, mockReconcile, mockGetAssignment, mockListParts, mockGetPart,
} = vi.hoisted(() => ({
  mockDownloadContent: vi.fn(),
  mockReconcile: vi.fn(),
  mockGetAssignment: vi.fn(),
  mockListParts: vi.fn(),
  mockGetPart: vi.fn(),
}));
vi.mock('../../src/api/content', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/content')>('../../src/api/content');
  return { ...actual, downloadContent: mockDownloadContent };
});
vi.mock('../../src/core/reconciler', () => ({ reconcile: mockReconcile }));
vi.mock('../../src/api/assignments', () => ({ getAssignment: mockGetAssignment }));
vi.mock('../../src/api/parts', () => ({ listParts: mockListParts, getPart: mockGetPart }));

import {
  detectContentDrift, applyPull, inspectPull, skipContentExcludePatterns,
} from '../../src/core/services/pull-service';
import type { PullResolver, PullInspection, ContentDriftSkip } from '../../src/core/services/pull-service';
import type { Assignment, Config, DirectoryType } from '../../src/types/config';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { PullContext } from '../../src/core/services/context';
import type { PullRequest } from '../../src/core/services/types';
import type { LockedSession } from '../../src/core/session';
import { calculateDirectoryHash, compileExcludedPathMatcher } from '../../src/utils/files';
import { FakeVocareumTree, install } from '../helpers/fake-vocareum-tree';

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;
const ZIP = { enabled: true, timeoutMs: 600_000 };

let workspaceRoot: string;
const chmodded: string[] = [];

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-exclude-drift-'));
  mockReconcile.mockResolvedValue({ orphanedInVocareum: [], staleInConfig: [] });
});
afterEach(async () => {
  for (const p of chmodded.splice(0)) { await fs.chmod(p, 0o755).catch(() => undefined); }
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  mockDownloadContent.mockReset();
  mockGetAssignment.mockReset();
  mockListParts.mockReset();
  mockGetPart.mockReset();
});

async function put(rel: string, content: string): Promise<void> {
  const abs = path.join(workspaceRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function lockOut(rel: string): Promise<void> {
  const abs = path.join(workspaceRoot, rel);
  await fs.chmod(abs, 0o000);
  chmodded.push(abs);
}

const assignment = (): Assignment => ({
  assignment_id: 'A1',
  name: 'Asn One',
  path: 'asn1',
  parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['data'] }],
} as unknown as Assignment);

function makeConfig(patterns: string[], extra: Partial<Config> = {}): Config {
  return {
    version: '1.0',
    vocareum: { org_id: '1', course_id: 'C1', architecture: 'container', excluded_assignments: [] },
    publish_options: { sync_settings: false, sync_rubrics: false, exclude_patterns: patterns },
    assignments: [assignment()],
    ...extra,
  } as unknown as Config;
}

function makeCtx(config: Config, client: unknown = {}): { ctx: PullContext; events: CollectingEventSink } {
  const events = new CollectingEventSink();
  const ctx: PullContext = {
    persistedConfig: config,
    effectiveConfig: config,
    configPath: `${workspaceRoot}/vocareum.yaml`,
    workspaceRoot,
    events,
    prompter: new NonInteractivePrompter(),
    client: client as never,
  };
  return { ctx, events };
}

function resolver(over: Partial<Record<keyof PullResolver, unknown>> = {}): PullResolver {
  return {
    resolveOrphanAction: vi.fn().mockResolvedValue('import'),
    resolveStaleAction: vi.fn().mockResolvedValue('skip'),
    resolveSettingsDriftAction: vi.fn().mockResolvedValue('skip'),
    resolveContentDriftAction: vi.fn().mockResolvedValue('pull'),
    resolveImportPath: vi.fn().mockImplementation((_i: unknown, s: string) => Promise.resolve(s)),
    ...over,
  } as unknown as PullResolver;
}

interface DriftRun {
  drift: Awaited<ReturnType<typeof detectContentDrift>>;
  warnings: string[];
  skipped: ContentDriftSkip[];
  debug: string[];
}

async function driftCheck(patterns: string[], client: unknown = {}): Promise<DriftRun> {
  const warnings: string[] = [];
  const skipped: ContentDriftSkip[] = [];
  const debug: string[] = [];
  const drift = await detectContentDrift(
    makeConfig(patterns),
    client as never,
    new Set<string>(),
    workspaceRoot,
    (m) => { warnings.push(m); },
    undefined,
    skipped,
    undefined,
    (m) => { debug.push(m); },
  );
  return { drift, warnings, skipped, debug };
}

function diffsOf(run: DriftRun): Array<{ filePath: string; status: string }> {
  return run.drift.flatMap((d) => d.partsDrift.flatMap((p) => p.fileDiffs));
}

function downloadOptions(call: number): { excludePatterns?: string[]; zip?: unknown } {
  return mockDownloadContent.mock.calls[call][6] as { excludePatterns?: string[]; zip?: unknown };
}

async function applyDrift(config: Config, run: DriftRun): Promise<ReturnType<typeof vi.fn>> {
  const { ctx } = makeCtx(config);
  const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
  const inspection: PullInspection = { orphans: [], stale: [], settingsDrift: [], contentDrift: run.drift };
  await applyPull({ applyConfigUpdate } as LockedSession, ctx, { batch: true, verbose: false, skipContent: false },
    inspection, resolver());
  return applyConfigUpdate;
}

async function setupX3(): Promise<void> {
  await put('asn1/data/a.txt', 'old');
  await put('asn1/data/venv/bin/python', 'PYTHON');
  mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('new') });
}

const ORPHAN = { type: 'assignment' as const, id: 'A9', name: 'Orphan Nine', message: '' };

function enqueueImport(files: Record<string, string>): void {
  mockGetAssignment.mockResolvedValue({ id: 'A9', name: 'Orphan Nine' });
  mockListParts.mockResolvedValue([{ id: 'P9', name: 'Part 1', seqnum: '1', deleted: '0' }]);
  mockGetPart.mockResolvedValue({ id: 'P9', name: 'Part 1', seqnum: '1', deleted: '0' });
  mockDownloadContent.mockResolvedValue(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  );
}

async function importOrphan(
  patterns: string[],
  req: PullRequest,
  over: Partial<Record<keyof PullResolver, unknown>> = {},
): Promise<{ update: ReturnType<typeof vi.fn>; events: CollectingEventSink; result: Awaited<ReturnType<typeof applyPull>> }> {
  const config = makeConfig(patterns, { assignments: [] } as Partial<Config>);
  const { ctx, events } = makeCtx(config);
  const update = vi.fn().mockResolvedValue(undefined);
  const inspection: PullInspection = { orphans: [ORPHAN], stale: [], settingsDrift: [], contentDrift: [] };
  const result = await applyPull({ applyConfigUpdate: update } as LockedSession, ctx, req, inspection, resolver(over));
  return { update, events, result };
}

describe('pull exclude_patterns: content drift check', () => {
  it('X3: assignment with an excluded tree is checked, other drift still reported', async () => {
    await setupX3();
    const run = await driftCheck(['venv']);
    expect(diffsOf(run)).toEqual([{ filePath: 'data/a.txt', status: 'modified' }]);
    expect(run.skipped).toEqual([]);
    expect(downloadOptions(0).excludePatterns).toEqual(['venv']);
    expect(downloadOptions(0).zip).toBeUndefined();
  });

  it.each([['venv'], ['venv/**']])('X4: local-only files under venv are not reported deleted (%s)', async (pattern) => {
    await put('asn1/data/venv/bin/python', 'PYTHON');
    mockDownloadContent.mockResolvedValue({});
    const run = await driftCheck([pattern]);
    expect(diffsOf(run)).toEqual([]);
    expect(run.warnings).toEqual([]);
  });

  it('X4: apply leaves local venv untouched', async () => {
    await setupX3();
    const run = await driftCheck(['venv']);
    await applyDrift(makeConfig(['venv']), run);
    expect(await fs.readFile(path.join(workspaceRoot, 'asn1/data/a.txt'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(workspaceRoot, 'asn1/data/venv/bin/python'), 'utf8')).toBe('PYTHON');
  });

  it('X4b: remote venv is a file, local venv is a directory → nothing reported or unlinked', async () => {
    const actual = await vi.importActual<typeof import('../../src/api/content')>('../../src/api/content');
    mockDownloadContent.mockImplementation(actual.downloadContent);
    const tree = new FakeVocareumTree()
      .file('/voc/data/a.txt', 'same')
      .file('/voc/data/venv', 'i am a file');
    const inst = install(tree);
    await put('asn1/data/a.txt', 'same');
    await put('asn1/data/venv/x', 'X');

    const run = await driftCheck(['venv'], inst.client);
    expect(diffsOf(run)).toEqual([]);
    expect(run.warnings).toEqual([]);
    expect(tree.log.some((e) => e.path.includes('venv'))).toBe(false);

    await applyDrift(makeConfig(['venv']), run);
    expect(await fs.readFile(path.join(workspaceRoot, 'asn1/data/venv/x'), 'utf8')).toBe('X');
  });

  it('X7: pattern removed → local venv files reported deleted', async () => {
    await put('asn1/data/venv/x', 'X');
    mockDownloadContent.mockResolvedValue({});
    const run = await driftCheck([]);
    expect(diffsOf(run)).toEqual([{ filePath: 'data/venv/x', status: 'deleted' }]);
    expect(downloadOptions(0).excludePatterns).toEqual([]);
  });

  it('X7b: venv → env2 in one edit', async () => {
    await put('asn1/data/venv/x', 'X');
    await put('asn1/data/env2/y', 'Y');
    mockDownloadContent.mockResolvedValue({});
    const run = await driftCheck(['env2']);
    expect(diffsOf(run)).toEqual([{ filePath: 'data/venv/x', status: 'deleted' }]);
  });

  it.runIf(canChmod)('local walk does not open an excluded unreadable directory', async () => {
    await put('asn1/data/b.txt', 'local only');
    await put('asn1/data/venv/sub/secret', 'S');
    await lockOut('asn1/data/venv/sub');
    mockDownloadContent.mockResolvedValue({});
    const run = await driftCheck(['venv']);
    expect(run.warnings).toEqual([]);
    expect(run.skipped).toEqual([]);
    expect(diffsOf(run)).toEqual([{ filePath: 'data/b.txt', status: 'deleted' }]);
  });

  it('local walk emits a debug line for an excluded local entry', async () => {
    await put('asn1/data/venv/x', 'X');
    mockDownloadContent.mockResolvedValue({});
    const { ctx, events } = makeCtx(makeConfig(['venv']));
    const inspection = await inspectPull(ctx, { content: true });
    expect(inspection.contentDrift).toEqual([]);
    const lines = events.drain().filter((e) => e.level === 'debug' && e.message.includes('data/venv'));
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toContain('exclude_patterns');
  });

  it.runIf(canChmod)('unreadable non-excluded local subdirectory is reported, not swallowed', async () => {
    await put('asn1/data/a.txt', 'old');
    await put('asn1/data/sub/s.txt', 'S');
    await lockOut('asn1/data/sub');
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('new') });
    const { ctx } = makeCtx(makeConfig(['venv']));
    const inspection = await inspectPull(ctx, { content: true });
    expect(inspection.contentDriftIncomplete).toEqual([
      { assignmentName: 'Asn One', reason: 'could not read local data/sub; it was not compared' },
    ]);
    expect(inspection.contentDrift.flatMap((d) => d.partsDrift.flatMap((p) => p.fileDiffs)))
      .toEqual([{ filePath: 'data/a.txt', status: 'modified' }]);
  });

  it('drift-apply rehash uses publishExcludePatterns', async () => {
    await setupX3();
    const run = await driftCheck(['venv']);
    const update = await applyDrift(makeConfig(['venv']), run);
    const state = update.mock.calls[0][0].publish_history[0].content_state as Record<string, string>;
    const dataDir = path.join(workspaceRoot, 'asn1', 'data');
    const expected = await calculateDirectoryHash(dataDir, ['.gitkeep', '**/.gitkeep', 'venv']);
    expect(state[path.join('asn1', 'data')]).toBe(expected);
    expect(expected).not.toBe(await calculateDirectoryHash(dataDir, ['.gitkeep', '**/.gitkeep']));
  });
});

describe('pull exclude_patterns: zip gate', () => {
  it.each([['venv'], ['venv/**']])('X8: zip is not passed at either call site when user exclusions are set (%s)', async (pattern) => {
    await put('asn1/data/a.txt', 'same');
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same') });
    const { ctx } = makeCtx(makeConfig([pattern]));
    await inspectPull(ctx, { content: true, zip: ZIP });
    expect(downloadOptions(0).zip).toBeUndefined();
    expect(downloadOptions(0).excludePatterns).toEqual([pattern]);

    mockDownloadContent.mockClear();
    enqueueImport({ 'data/a.txt': 'a' });
    await importOrphan([pattern], { batch: true, verbose: false, skipContent: false, zip: ZIP });
    expect(downloadOptions(0).zip).toBeUndefined();
    expect(downloadOptions(0).excludePatterns).toEqual([pattern]);
  });

  it('X8: with no exclusions both call sites get req.zip', async () => {
    await put('asn1/data/a.txt', 'same');
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same') });
    const { ctx } = makeCtx(makeConfig([]));
    await inspectPull(ctx, { content: true, zip: ZIP });
    expect(downloadOptions(0).zip).toEqual(ZIP);

    mockDownloadContent.mockClear();
    enqueueImport({ 'data/a.txt': 'a' });
    await importOrphan([], { batch: true, verbose: false, skipContent: false, zip: ZIP });
    expect(downloadOptions(0).zip).toEqual(ZIP);
    expect(downloadOptions(0).excludePatterns).toEqual([]);
  });
});

describe('pull exclude_patterns: import', () => {
  it('import hashes with publishExcludePatterns', async () => {
    await put('target/data/venv/x', 'X');
    enqueueImport({ 'data/a.txt': 'a' });
    const { update, result } = await importOrphan(['venv'], { batch: false, verbose: false, skipContent: false }, {
      resolveImportPath: vi.fn().mockResolvedValue('target'),
    });
    expect(result.imported).toBe(1);
    const state = update.mock.calls[0][0].publish_history[0].content_state as Record<string, string>;
    const dataDir = path.join(workspaceRoot, 'target', 'data');
    const expected = await calculateDirectoryHash(dataDir, ['.gitkeep', '**/.gitkeep', 'venv']);
    expect(state[path.join('target', 'data')]).toBe(expected);
    expect(expected).not.toBe(await calculateDirectoryHash(dataDir, ['.gitkeep', '**/.gitkeep']));
  });

  it.runIf(canChmod)('--skip-content reuse never opens an excluded tree', async () => {
    // A name the slug probe does not look at, so only the reuse read is exercised.
    await put('elsewhere/data/a.txt', 'A');
    await put('elsewhere/data/venv/sub/secret', 'S');
    await lockOut('elsewhere/data/venv/sub');
    enqueueImport({});
    const { result, events } = await importOrphan(['venv'], { batch: false, verbose: false, skipContent: true }, {
      resolveImportPath: vi.fn().mockResolvedValue('elsewhere'),
    });
    expect(result.importsFailed).toBe(0);
    expect(result.imported).toBe(1);
    expect(mockDownloadContent).not.toHaveBeenCalled();
    expect(events.drain().some((e) => e.message?.includes('reused 1 existing file') === true)).toBe(true);
  });

  it('slug probe unchanged: a directory holding only excluded content is still the import target', async () => {
    await put('orphan-nine/data/venv/x', 'X');
    enqueueImport({ 'data/a.txt': 'a' });
    const { update, result } = await importOrphan(['venv'], { batch: true, verbose: false, skipContent: true });
    expect(result.imported).toBe(1);
    const imported = update.mock.calls[0][0].assignments as Array<{ path: string }>;
    expect(imported.map((a) => a.path)).toEqual(['orphan-nine']);
    await expect(fs.access(path.join(workspaceRoot, 'orphan-nine-2'))).rejects.toThrow();
  });

  it('Windows: readDirectory-style keys are split on both separators', () => {
    const patterns = skipContentExcludePatterns(['data'] as DirectoryType[], ['venv', '/env2', '\\cache']);
    expect(patterns).toEqual(['.gitkeep', '**/.gitkeep', 'data/venv', 'data/env2', 'data/cache']);
    const dropped = compileExcludedPathMatcher(patterns);
    expect(dropped('data\\venv\\x')).toBe(true);
    expect(dropped('data\\venv')).toBe(true);
    expect(dropped('data\\env2\\y')).toBe(true);
    expect(dropped('data\\cache')).toBe(true);
    expect(dropped('data\\a.txt')).toBe(false);
    expect(dropped('other\\venv\\x')).toBe(false);
  });
});
