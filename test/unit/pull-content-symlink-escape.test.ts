import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock ONLY the remote content fetch. path-security and fs stay REAL so the
// symlink-confinement logic is genuinely exercised against a real on-disk tree.
const { mockDownloadContent } = vi.hoisted(() => ({ mockDownloadContent: vi.fn() }));
vi.mock('../../src/api/content', () => ({
  downloadContent: mockDownloadContent,
}));

import { detectContentDrift, applyPull, toRemoteKey, managedLinkCovering } from '../../src/core/services/pull-service';
import type {
  PullResolver,
  PullInspection,
} from '../../src/core/services/pull-service';
import type { Assignment, Config } from '../../src/types/config';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import type { EventSink, ServiceEvent } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { PullContext } from '../../src/core/services/context';
import type { PullRequest } from '../../src/core/services/types';
import type { LockedSession } from '../../src/core/session';

/**
 * Regression: a repo pulled by an older vocgit contains a symlink that escapes
 * the part directory (e.g. `docs/README.html` -> the shared course/ tree). When
 * the user then deletes a *different* directory (`scripts/`) and runs
 * `pull --content`, the escaping symlink must NOT abort drift detection for the
 * whole assignment — otherwise the deleted directory is never restored (the
 * "had to drop vocareum.yaml and re-init" bug).
 */
describe('detectContentDrift — escaping symlink must not abort the whole assignment', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-drift-'));
  });
  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('skips only the escaping file and still flags a locally-deleted directory as added', async () => {
    // Part directory: assignment "asn1", single part at '.'.
    const partDir = path.join(workspaceRoot, 'asn1');
    await fs.mkdir(path.join(partDir, 'docs'), { recursive: true });

    // docs/README.html is a symlink whose target escapes the part directory.
    const outside = path.join(workspaceRoot, 'outside.html');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(partDir, 'docs', 'README.html'));

    // scripts/ was deleted locally (never created); remote still has scripts/build.sh.
    mockDownloadContent.mockResolvedValue({
      'docs/README.html': Buffer.from('remote readme'),
      'scripts/build.sh': Buffer.from('echo build'),
    });

    const assignment = {
      assignment_id: 'A1',
      name: 'Databricks Simple',
      path: 'asn1',
      parts: [
        { part_id: 'P1', name: 'Part 1', path: '.', directories: ['docs', 'scripts'] },
      ],
    } as unknown as Assignment;

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    // The whole-assignment abort must NOT fire.
    expect(warnings.some((w) => w.startsWith('Skipping content drift check for'))).toBe(false);

    // Drift IS detected for the assignment/part.
    expect(drift).toHaveLength(1);
    const diffs = drift[0].partsDrift[0].fileDiffs;

    // The locally-deleted directory's file is queued for restore.
    expect(diffs).toContainEqual({ filePath: 'scripts/build.sh', status: 'added' });

    // The escaping symlink file is skipped — never compared or restored — with a
    // targeted per-file warning instead of aborting the assignment.
    expect(diffs.find((d) => d.filePath === 'docs/README.html')).toBeUndefined();
    expect(warnings.some((w) => w.includes('docs/README.html') && w.includes('symlink'))).toBe(true);

    // apply writes partDrift.remoteFiles verbatim, and writeFileUnderBase THROWS
    // on an escaping path — so the escaping entry must be excluded from the stored
    // map, or apply would abort before restoring the deleted directory.
    const stored = Object.keys(drift[0].partsDrift[0].remoteFiles);
    expect(stored).toContain('scripts/build.sh');
    expect(stored).not.toContain('docs/README.html');
  });

  it('never flags a file reached through an escaping symlinked directory as deleted (would unlink outside the workspace)', async () => {
    // `startercode` is a symlink whose target is OUTSIDE the part directory and
    // holds a file that does not exist on the remote. The deleted-file detector
    // must not flag it — otherwise apply's fs.unlink would follow the symlink and
    // delete a file outside the workspace.
    const partDir = path.join(workspaceRoot, 'asn1');
    await fs.mkdir(partDir, { recursive: true });
    const outsideDir = path.join(workspaceRoot, 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'do not touch');
    await fs.symlink(outsideDir, path.join(partDir, 'startercode'));

    // Remote has no files at all.
    mockDownloadContent.mockResolvedValue({});

    const assignment = {
      assignment_id: 'A1',
      name: 'Databricks Simple',
      path: 'asn1',
      parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['startercode'] }],
    } as unknown as Assignment;

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    // No 'deleted' diff pointing through the escaping symlink → nothing to unlink.
    const allDiffs = drift.flatMap((d) => d.partsDrift.flatMap((p) => p.fileDiffs));
    expect(allDiffs.some((d) => d.filePath.startsWith('startercode/'))).toBe(false);
    expect(warnings.some((w) => w.includes('startercode') && w.includes('symlink'))).toBe(true);
    // And the outside file is untouched (detection is read-only, but assert intent).
    await expect(fs.readFile(path.join(outsideDir, 'secret.txt'), 'utf8')).resolves.toBe('do not touch');
  });

  it('skips a drifted file whose local path is an IN-PART symlink (writeFileUnderBase rejects all symlink targets) and still restores an unrelated deleted directory', async () => {
    // docs/README.html is a symlink to ../shared.html — target is INSIDE the part,
    // so isPathConfinedToBase passes. But writeFileUnderBase rejects ANY final
    // symlink target, so apply (which writes the whole remote-file map) would throw
    // and never restore the separately-deleted scripts/ directory. The file must be
    // excluded from the stored map at detection time.
    const partDir = path.join(workspaceRoot, 'asn1');
    await fs.mkdir(path.join(partDir, 'docs'), { recursive: true });
    await fs.writeFile(path.join(partDir, 'shared.html'), 'local');
    await fs.symlink('../shared.html', path.join(partDir, 'docs', 'README.html'));

    mockDownloadContent.mockResolvedValue({
      'docs/README.html': Buffer.from('remote'), // differs from local → would be "modified"
      'scripts/build.sh': Buffer.from('echo build'), // scripts/ deleted locally
    });

    const assignment = {
      assignment_id: 'A1',
      name: 'Databricks Simple',
      path: 'asn1',
      parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['docs', 'scripts'] }],
    } as unknown as Assignment;

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    expect(drift).toHaveLength(1);
    const part = drift[0].partsDrift[0];
    // The deleted directory is still queued for restore.
    expect(part.fileDiffs).toContainEqual({ filePath: 'scripts/build.sh', status: 'added' });
    // The symlink file is neither flagged for restore nor kept in the write map,
    // so apply cannot abort on it.
    expect(part.fileDiffs.find((d) => d.filePath === 'docs/README.html')).toBeUndefined();
    expect(Object.keys(part.remoteFiles)).not.toContain('docs/README.html');
    expect(Object.keys(part.remoteFiles)).toContain('scripts/build.sh');
    expect(warnings.some((w) => w.includes('docs/README.html') && w.includes('symlink'))).toBe(true);
  });

  it('restores an entirely-deleted part directory (missing base) without falsely flagging every file as an escaping symlink', async () => {
    // The whole assignment/part directory was deleted — the base does not exist.
    // There are no local files or symlinks, so every remote file is a fresh add.
    // The base must not be mistaken for a symlink escape just because realpath()
    // throws ENOENT on the missing directory.
    const assignment = {
      assignment_id: 'A1',
      name: 'AI BI Lab',
      path: 'ai-bi', // NOTE: this directory is intentionally never created
      parts: [{ part_id: 'P1', name: 'Lab', path: '.', directories: ['scripts', 'notebooks'] }],
    } as unknown as Assignment;

    mockDownloadContent.mockResolvedValue({
      'scripts/grade.sh': Buffer.from('#!/bin/sh'),
      'notebooks/lab.py': Buffer.from('print(1)'),
    });

    const warnings: string[] = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' } },
      {} as never,
      new Set<string>(),
      workspaceRoot,
      (m) => warnings.push(m),
    );

    // No file is falsely skipped as an escaping symlink.
    expect(warnings.some((w) => w.includes('symlink'))).toBe(false);
    // Every remote file is queued for restore, and kept in the write map.
    expect(drift).toHaveLength(1);
    const part = drift[0].partsDrift[0];
    expect(part.fileDiffs).toContainEqual({ filePath: 'scripts/grade.sh', status: 'added' });
    expect(part.fileDiffs).toContainEqual({ filePath: 'notebooks/lab.py', status: 'added' });
    expect(Object.keys(part.remoteFiles).sort()).toEqual(['notebooks/lab.py', 'scripts/grade.sh']);
  });
});

describe('applyPull — scaffolds configured empty directories with .gitkeep on content restore', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-apply-'));
  });
  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('creates configured-but-empty dirs (.gitkeep) while dirs that received content get none', async () => {
    const events = new CollectingEventSink();
    const config = {
      vocareum: { course_id: 'C1', api_base_url: 'https://api.vocareum.com' },
      assignments: [],
    } as unknown as Config;
    const ctx: PullContext = {
      persistedConfig: config,
      effectiveConfig: config,
      configPath: `${workspaceRoot}/vocareum.yaml`,
      workspaceRoot,
      events,
      prompter: new NonInteractivePrompter(),
      client: {} as never,
    };
    const session: LockedSession = { applyConfigUpdate: vi.fn().mockResolvedValue(undefined) };
    const req: PullRequest = { batch: false, verbose: false, skipContent: false };
    const resolver = {
      resolveOrphanAction: vi.fn().mockResolvedValue('skip'),
      resolveStaleAction: vi.fn().mockResolvedValue('skip'),
      resolveSettingsDriftAction: vi.fn().mockResolvedValue('skip'),
      resolveContentDriftAction: vi.fn().mockResolvedValue('pull'),
      resolveImportPath: vi.fn().mockImplementation((_i: unknown, s: string) => Promise.resolve(s)),
    } as unknown as PullResolver;

    const inspection: PullInspection = {
      orphans: [],
      stale: [],
      settingsDrift: [],
      contentDrift: [
        {
          assignmentId: 'A1',
          assignmentName: 'AI Compass',
          assignmentPath: 'ai-compass',
          partsDrift: [
            {
              partId: 'P1',
              partName: 'Part 1',
              partPath: '.',
              directories: ['scripts', 'docs', 'data'],
              fileDiffs: [{ filePath: 'scripts/grade.sh', status: 'added' }],
              remoteFiles: { 'scripts/grade.sh': Buffer.from('#!/bin/sh\n') },
            },
          ],
        },
      ],
    };

    await applyPull(session, ctx, req, inspection, resolver);

    const base = path.join(workspaceRoot, 'ai-compass');
    // The directory that received content is populated and has NO .gitkeep.
    await expect(fs.readFile(path.join(base, 'scripts/grade.sh'), 'utf8')).resolves.toContain('#!/bin/sh');
    await expect(fs.access(path.join(base, 'scripts/.gitkeep'))).rejects.toThrow();
    // Configured-but-empty dirs are scaffolded with a .gitkeep (parity with import).
    await expect(fs.readFile(path.join(base, 'docs/.gitkeep'), 'utf8')).resolves.toBe('');
    await expect(fs.readFile(path.join(base, 'data/.gitkeep'), 'utf8')).resolves.toBe('');
  });

  it('never writes .gitkeep through an escaping symlinked configured directory', async () => {
    const base = path.join(workspaceRoot, 'ai-compass');
    await fs.mkdir(base, { recursive: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-outside-'));
    try {
      // A configured directory that is a symlink escaping the part directory.
      await fs.symlink(outside, path.join(base, 'docs'));

      const warns: string[] = [];
      const events: EventSink = {
        emit(e: ServiceEvent) {
          if (e.level === 'warn' && typeof e.message === 'string') { warns.push(e.message); }
        },
      };
      const config = {
        vocareum: { course_id: 'C1', api_base_url: 'https://api.vocareum.com' },
        assignments: [],
      } as unknown as Config;
      const ctx: PullContext = {
        persistedConfig: config,
        effectiveConfig: config,
        configPath: `${workspaceRoot}/vocareum.yaml`,
        workspaceRoot,
        events,
        prompter: new NonInteractivePrompter(),
        client: {} as never,
      };
      const session: LockedSession = { applyConfigUpdate: vi.fn().mockResolvedValue(undefined) };
      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      const resolver = {
        resolveOrphanAction: vi.fn().mockResolvedValue('skip'),
        resolveStaleAction: vi.fn().mockResolvedValue('skip'),
        resolveSettingsDriftAction: vi.fn().mockResolvedValue('skip'),
        resolveContentDriftAction: vi.fn().mockResolvedValue('pull'),
        resolveImportPath: vi.fn().mockImplementation((_i: unknown, s: string) => Promise.resolve(s)),
      } as unknown as PullResolver;

      const inspection: PullInspection = {
        orphans: [],
        stale: [],
        settingsDrift: [],
        contentDrift: [
          {
            assignmentId: 'A1',
            assignmentName: 'AI Compass',
            assignmentPath: 'ai-compass',
            partsDrift: [
              {
                partId: 'P1',
                partName: 'Part 1',
                partPath: '.',
                directories: ['scripts', 'docs', 'data'],
                fileDiffs: [{ filePath: 'scripts/grade.sh', status: 'added' }],
                remoteFiles: { 'scripts/grade.sh': Buffer.from('#!/bin/sh\n') },
              },
            ],
          },
        ],
      };

      await applyPull(session, ctx, req, inspection, resolver);

      // No .gitkeep escaped into the outside directory through the docs symlink.
      await expect(fs.access(path.join(outside, '.gitkeep'))).rejects.toThrow();
      // The escaping symlink was warned about and skipped, not written through.
      expect(warns.some((w) => w.includes('docs') && w.toLowerCase().includes('symlink'))).toBe(true);
      // The symlink itself is left intact.
      expect((await fs.lstat(path.join(base, 'docs'))).isSymbolicLink()).toBe(true);
      // A legitimate empty configured dir is still scaffolded.
      await expect(fs.readFile(path.join(base, 'data/.gitkeep'), 'utf8')).resolves.toBe('');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

// Recovery for an incomplete pull: the directory carries INCOMPLETE_PULL_MARKER
// (push refuses it). Once the files are actually present, a complete
// `pull --content` must replace the marker with a real hash — even when no
// file differs — or push stays blocked forever.
describe('content drift completes a directory an earlier pull left incomplete', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-incomplete-'));
    await fs.mkdir(path.join(workspaceRoot, 'asn1', 'data'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'asn1', 'data', 'a.txt'), 'same');
  });
  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const assignment = {
    assignment_id: 'A1', name: 'CD15315 v2', path: 'asn1', create_from_template: false, settings: {},
    parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['data'] }],
  } as unknown as Assignment;
  const history = [{
    timestamp: '2026-11-09T00:00:00Z', commit_sha: 'x', published_by: 'pull-command', status: 'failed' as const,
    content_state: { [path.join('asn1', 'data')]: 'incomplete-pull' },
  }];

  it('flags the marked directory with no file differences, and pulling records a real hash', async () => {
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same') });

    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' }, publish_history: history },
      {} as never, new Set<string>(), workspaceRoot, () => {},
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].partsDrift[0].fileDiffs).toEqual([]);
    expect(drift[0].partsDrift[0].incompleteDirectories).toEqual(['data']);

    const config = {
      version: '1.0',
      vocareum: { org_id: '1', course_id: 'C1', excluded_assignments: [] },
      assignments: [assignment],
      publish_history: history,
    } as unknown as Config;
    const ctx: PullContext = {
      persistedConfig: config, effectiveConfig: config, configPath: `${workspaceRoot}/vocareum.yaml`,
      workspaceRoot, events: new CollectingEventSink(), prompter: new NonInteractivePrompter(), client: {} as never,
    };
    const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
    const resolver = {
      resolveOrphanAction: vi.fn().mockResolvedValue('skip'),
      resolveStaleAction: vi.fn().mockResolvedValue('skip'),
      resolveSettingsDriftAction: vi.fn().mockResolvedValue('skip'),
      resolveContentDriftAction: vi.fn().mockResolvedValue('pull'),
      resolveImportPath: vi.fn(),
    } as unknown as PullResolver;
    const inspection: PullInspection = { orphans: [], stale: [], settingsDrift: [], contentDrift: drift };

    await applyPull({ applyConfigUpdate } as LockedSession, ctx, { batch: true, verbose: false, skipContent: false }, inspection, resolver);

    const entry = applyConfigUpdate.mock.calls[0][0].publish_history[0];
    expect(entry.status).toBe('success');
    const value = entry.content_state[path.join('asn1', 'data')];
    expect(value).not.toBe('incomplete-pull');
    expect(value).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('a drift check that still cannot finish leaves the marker (push stays blocked)', async () => {
    mockDownloadContent.mockRejectedValue(new Error('Download limit exceeded: more than 5000 files'));
    const skipped: Array<{ assignmentName: string; reason: string }> = [];
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' }, publish_history: history },
      {} as never, new Set<string>(), workspaceRoot, () => {}, undefined, skipped,
    );
    expect(drift).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  // Codex round 2 (P0): a remote file that cannot be written locally (the local
  // path is a symlink) must keep the marker — otherwise push unblocks and its
  // reset:1 upload deletes that remote file.
  it('keeps the marker when a remote file in the directory cannot be written locally; clears it once fixed', async () => {
    const dataDir = path.join(workspaceRoot, 'asn1', 'data');
    await fs.writeFile(path.join(workspaceRoot, 'asn1', 'target.txt'), 'local target');
    await fs.symlink('../target.txt', path.join(dataDir, 'missed.txt'));
    mockDownloadContent.mockResolvedValue({
      'data/a.txt': Buffer.from('changed on remote'),
      'data/missed.txt': Buffer.from('remote only'),
    });

    const run = async () => {
      const skipped: Array<{ assignmentName: string; reason: string }> = [];
      const drift = await detectContentDrift(
        { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' }, publish_history: history },
        {} as never, new Set<string>(), workspaceRoot, () => {}, undefined, skipped,
      );
      const config = {
        version: '1.0', vocareum: { org_id: '1', course_id: 'C1', excluded_assignments: [] },
        assignments: [assignment], publish_history: history,
      } as unknown as Config;
      const ctx: PullContext = {
        persistedConfig: config, effectiveConfig: config, configPath: `${workspaceRoot}/vocareum.yaml`,
        workspaceRoot, events: new CollectingEventSink(), prompter: new NonInteractivePrompter(), client: {} as never,
      };
      const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
      const resolver = {
        resolveOrphanAction: vi.fn(), resolveStaleAction: vi.fn(), resolveSettingsDriftAction: vi.fn(),
        resolveContentDriftAction: vi.fn().mockResolvedValue('pull'), resolveImportPath: vi.fn(),
      } as unknown as PullResolver;
      await applyPull({ applyConfigUpdate } as LockedSession, ctx, { batch: true, verbose: false, skipContent: false },
        { orphans: [], stale: [], settingsDrift: [], contentDrift: drift }, resolver);
      return { drift, skipped, entry: applyConfigUpdate.mock.calls[0]?.[0]?.publish_history?.[0] };
    };

    // Obstructed: the changed file is restored, but data/ stays marked and the run is failed.
    const blocked = await run();
    expect(blocked.skipped).toHaveLength(1);
    expect(blocked.skipped[0].reason).toMatch(/data\/ still incomplete/);
    expect(blocked.drift[0].partsDrift[0].stillIncompleteDirectories).toEqual(['data']);
    expect(await fs.readFile(path.join(dataDir, 'a.txt'), 'utf8')).toBe('changed on remote');
    expect(blocked.entry.content_state[path.join('asn1', 'data')]).toBe('incomplete-pull');
    expect(blocked.entry.status).toBe('failed');
    expect(blocked.entry.failed).toEqual([expect.objectContaining({ id: path.join('asn1', 'data') })]);

    // Fixed: remove the symlink; a complete recovery now clears the marker.
    await fs.unlink(path.join(dataDir, 'missed.txt'));
    const fixed = await run();
    expect(fixed.skipped).toEqual([]);
    expect(fixed.entry.status).toBe('success');
    expect(fixed.entry.content_state[path.join('asn1', 'data')]).toMatch(/^[0-9a-f]{16,}$/);
  });

  // Codex round 3 (P1): the obstruction is the ONLY difference. Without a drift
  // entry the command returned before apply and no failed history was written.
  it('a still-incomplete directory with no other difference still records a failed run', async () => {
    const dataDir = path.join(workspaceRoot, 'asn1', 'data');
    await fs.writeFile(path.join(workspaceRoot, 'asn1', 'target.txt'), 'local target');
    await fs.symlink('../target.txt', path.join(dataDir, 'missed.txt'));
    mockDownloadContent.mockResolvedValue({
      'data/a.txt': Buffer.from('same'),
      'data/missed.txt': Buffer.from('remote only'),
    });
    const drift = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'container' }, publish_history: history },
      {} as never, new Set<string>(), workspaceRoot, () => {},
    );
    expect(drift).toHaveLength(1);
    expect(drift[0].partsDrift[0].fileDiffs).toEqual([]);
    expect(drift[0].partsDrift[0].stillIncompleteDirectories).toEqual(['data']);

    const config = {
      version: '1.0', vocareum: { org_id: '1', course_id: 'C1', excluded_assignments: [] },
      assignments: [assignment], publish_history: history,
    } as unknown as Config;
    const ctx: PullContext = {
      persistedConfig: config, effectiveConfig: config, configPath: `${workspaceRoot}/vocareum.yaml`,
      workspaceRoot, events: new CollectingEventSink(), prompter: new NonInteractivePrompter(), client: {} as never,
    };
    const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
    const resolver = {
      resolveOrphanAction: vi.fn(), resolveStaleAction: vi.fn(), resolveSettingsDriftAction: vi.fn(),
      resolveContentDriftAction: vi.fn().mockResolvedValue('pull'), resolveImportPath: vi.fn(),
    } as unknown as PullResolver;
    const result = await applyPull({ applyConfigUpdate } as LockedSession, ctx, { batch: true, verbose: false, skipContent: false },
      { orphans: [], stale: [], settingsDrift: [], contentDrift: drift }, resolver);
    const entry = applyConfigUpdate.mock.calls[0]?.[0]?.publish_history?.[0];
    expect(entry.status).toBe('failed');
    expect(entry.content_state[path.join('asn1', 'data')]).toBe('incomplete-pull');
    // Round 4: nothing was actually pulled, so it is not counted or announced as pulled.
    expect(result.contentPulled).toBe(0);
    const lines = (ctx.events as CollectingEventSink).events.map((e: ServiceEvent) => e.message ?? '');
    expect(lines.some(l => l.includes('data/ (still incomplete'))).toBe(true);
    expect(lines.some(l => l.startsWith('Pulled content changes'))).toBe(false);

    // Skipping writes nothing (the help promises no changes); the exit-1 skip list still reports it.
    const skipUpdate = vi.fn().mockResolvedValue(undefined);
    const skipResolver = { ...resolver, resolveContentDriftAction: vi.fn().mockResolvedValue('skip') } as unknown as PullResolver;
    await applyPull({ applyConfigUpdate: skipUpdate } as LockedSession, ctx, { batch: false, verbose: false, skipContent: false },
      { orphans: [], stale: [], settingsDrift: [], contentDrift: drift }, skipResolver);
    expect(skipUpdate).not.toHaveBeenCalled();
  });
});

describe("detectContentDrift — Vocareum's lib/publicdata link (round-3 review)", () => {
  let workspaceRoot: string;
  beforeEach(async () => { workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-drift-link-')); });
  afterEach(async () => { await fs.rm(workspaceRoot, { recursive: true, force: true }); vi.clearAllMocks(); });

  async function drift(localFiles: Record<string, string>) {
    for (const [rel, content] of Object.entries(localFiles)) {
      const full = path.join(workspaceRoot, 'asn1', rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    // The walk skipped the unreadable link and said so through `managedLinks`.
    mockDownloadContent.mockImplementation(async (...args: unknown[]) => {
      const options = args[6] as { managedLinks?: string[] } | undefined;
      options?.managedLinks?.push('lib/publicdata');
      return { 'lib/helper.py': Buffer.from('h') };
    });
    const assignment = {
      assignment_id: 'A1', name: 'Elite lab', path: 'asn1',
      parts: [{ part_id: 'P1', name: 'Part 1', path: '.', directories: ['lib'] }],
    } as unknown as Assignment;
    const skipped: { assignmentName: string; reason: string }[] = [];
    const warnings: string[] = [];
    const result = await detectContentDrift(
      { assignments: [assignment], vocareum: { course_id: 'C1', architecture: 'elite' } },
      {} as never, new Set<string>(), workspaceRoot, (m) => warnings.push(m), undefined, skipped,
    );
    return { result, skipped, warnings };
  }

  it('local files under lib/publicdata are never planned as deletions; the check is reported incomplete', async () => {
    const { result, skipped } = await drift({ 'lib/helper.py': 'h', 'lib/publicdata/notes.txt': 'mine' });
    const diffs = result.flatMap(d => d.partsDrift.flatMap(p => p.fileDiffs));
    expect(diffs.find(d => d.filePath.includes('publicdata'))).toBeUndefined();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain('lib/publicdata/');
  });

  it('the user is told which path was not compared and what to do (round 4: the reason was never printed)', async () => {
    const { warnings } = await drift({ 'lib/helper.py': 'h', 'lib/publicdata/notes.txt': 'mine' });
    expect(warnings.join('\n')).toMatch(/lib\/publicdata\/.*Move them elsewhere/);
  });

  it('Windows paths are compared in the remote "/" form, so the guard and every lookup still match (round 4)', () => {
    expect(toRemoteKey('lib\\publicdata\\notes.txt', '\\')).toBe('lib/publicdata/notes.txt');
    expect(toRemoteKey('lib\\helper.py', '\\')).toBe('lib/helper.py');
    expect(toRemoteKey('lib/helper.py', '/')).toBe('lib/helper.py');
    const links = ['lib/publicdata'];
    expect(managedLinkCovering(toRemoteKey('lib\\publicdata', '\\'), links)).toBe('lib/publicdata');
    expect(managedLinkCovering(toRemoteKey('lib\\publicdata\\notes.txt', '\\'), links)).toBe('lib/publicdata');
    expect(managedLinkCovering(toRemoteKey('lib\\publicdata2\\x', '\\'), links)).toBeUndefined();
  });

  it('with nothing local at that path, the skipped link costs nothing (clean, not incomplete)', async () => {
    const { result, skipped } = await drift({ 'lib/helper.py': 'h' });
    expect(result).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
