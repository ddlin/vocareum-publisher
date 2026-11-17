/**
 * Cross-command scenario (X6, push state): a hash-refresh pull writes a
 * publish_history entry; the next push plans from that entry. If the pull
 * entry dropped push-owned state (settings_state, file_size_state), the push
 * would re-send every accepted-unverified setting nobody changed.
 *
 * Pull runs the real service on a temporary workspace with the remote fetch
 * mocked; push planning runs the real reconciler against mocked API modules
 * whose readback omits the accepted-unverified keys, as Vocareum does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockDownloadContent, pullReconcile, api } = vi.hoisted(() => ({
  mockDownloadContent: vi.fn(),
  pullReconcile: vi.fn(),
  api: {
    getCourse: vi.fn(),
    listAssignments: vi.fn(),
    getAssignment: vi.fn(),
    listParts: vi.fn(),
    getPart: vi.fn(),
    listRubrics: vi.fn(),
  },
}));
vi.mock('../../src/api/content', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/content')>('../../src/api/content');
  return { ...actual, downloadContent: mockDownloadContent };
});
// Pull's own orphan/stale reconcile is stubbed; push planning below uses the real one.
vi.mock('../../src/core/reconciler', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/reconciler')>('../../src/core/reconciler');
  return { ...actual, reconcile: pullReconcile };
});
vi.mock('../../src/api/courses', () => ({ getCourse: api.getCourse }));
vi.mock('../../src/api/assignments', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/assignments')>('../../src/api/assignments');
  return { ...actual, listAssignments: api.listAssignments, getAssignment: api.getAssignment };
});
vi.mock('../../src/api/parts', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/parts')>('../../src/api/parts');
  return { ...actual, listParts: api.listParts, getPart: api.getPart };
});
vi.mock('../../src/api/rubrics', async () => {
  const actual = await vi.importActual<typeof import('../../src/api/rubrics')>('../../src/api/rubrics');
  return { ...actual, listRubrics: api.listRubrics };
});

import { applyPull, inspectPull } from '../../src/core/services/pull-service';
import type { PullResolver } from '../../src/core/services/pull-service';
import type { Config, PublishHistory } from '../../src/types/config';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { PullContext } from '../../src/core/services/context';
import type { LockedSession } from '../../src/core/session';
import type { VocareumClient } from '../../src/api/client';
import { calculateDirectoryHash } from '../../src/utils/files';
import { publishExcludePatterns } from '../../src/core/local-scan';

const KEY = path.join('asn1', 'data');
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-refresh-push-'));
  pullReconcile.mockResolvedValue({ orphanedInVocareum: [], staleInConfig: [] });
  api.getCourse.mockResolvedValue({ id: 'C1', name: 'Course' });
  api.listAssignments.mockResolvedValue([{ id: 'A1', name: 'Asn One', deleted: '0' }]);
  // No readback of num_attempts or deadlinedate: they are accepted-unverified.
  api.getAssignment.mockResolvedValue({ id: 'A1', name: 'Asn One', deleted: '0', courseid: 'C1' });
  api.listParts.mockResolvedValue([{ id: 'P1', seqnum: '0', name: 'Part 1', deleted: '0' }]);
  api.getPart.mockResolvedValue({ id: 'P1', seqnum: '0', name: 'Part 1', deleted: '0', assignmentid: 'A1', courseid: 'C1' });
  api.listRubrics.mockResolvedValue([]);
});
afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function put(rel: string, content: string): Promise<void> {
  const file = path.join(workspaceRoot, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function makeConfig(state: Record<string, string>): Config {
  const history: PublishHistory = {
    timestamp: '2026-11-01T00:00:00Z', commit_sha: 'x', published_by: 'u', status: 'success',
    content_state: state,
    settings_state: {
      'assignments/asn1/settings/num_attempts': 3,
      'assignments/asn1/parts/./settings/deadlinedate': '2026-12-31T23:59:00Z',
    },
    file_size_state: { 'asn1/data/a.txt': 4 },
  };
  return {
    version: '1.0',
    vocareum: { org_id: '1', course_id: 'C1', architecture: 'container', excluded_assignments: [] },
    publish_options: { sync_settings: true, sync_rubrics: false, exclude_patterns: ['venv'] },
    assignments: [{
      assignment_id: 'A1', name: 'Asn One', path: 'asn1', create_from_template: false,
      settings: { num_attempts: 3 },
      parts: [{
        part_id: 'P1', name: 'Part 1', path: '.', directories: ['data'],
        settings: { deadlinedate: '2026-12-31T23:59:00Z' },
      }],
    }],
    publish_history: [history],
  } as unknown as Config;
}

function resolver(): PullResolver {
  return {
    resolveOrphanAction: vi.fn().mockResolvedValue('skip'),
    resolveStaleAction: vi.fn().mockResolvedValue('skip'),
    resolveSettingsDriftAction: vi.fn().mockResolvedValue('skip'),
    resolveContentDriftAction: vi.fn().mockResolvedValue('skip'),
    resolveImportPath: vi.fn(),
  } as unknown as PullResolver;
}

describe('X6 cross-command: refresh pull, then push planning', () => {
  it('X6: after a hash-refresh pull, push plans no settings write and no content upload', async () => {
    await put('asn1/data/a.txt', 'same');
    await put('asn1/data/venv/bin/python', 'PYTHON');
    mockDownloadContent.mockResolvedValue({ 'data/a.txt': Buffer.from('same') });
    // The stored hash predates the pattern: it includes the venv.
    const stale = await calculateDirectoryHash(path.join(workspaceRoot, KEY), ['.gitkeep', '**/.gitkeep']);
    const config = makeConfig({ [KEY]: stale });

    const events = new CollectingEventSink();
    const ctx: PullContext = {
      persistedConfig: config, effectiveConfig: config, configPath: `${workspaceRoot}/vocareum.yaml`,
      workspaceRoot, events, prompter: new NonInteractivePrompter(), client: {} as never,
    };
    const inspection = await inspectPull(ctx, { content: true });
    expect(inspection.hashRefresh).toHaveLength(1);
    const update = vi.fn().mockResolvedValue(undefined);
    await applyPull({ applyConfigUpdate: update } as LockedSession, ctx,
      { batch: false, nonInteractive: true, verbose: false, skipContent: false }, inspection, resolver());
    expect(update).toHaveBeenCalledTimes(1);

    const written: Config = { ...config, publish_history: update.mock.calls[0][0].publish_history as PublishHistory[] };
    // The pull touched only history: no settings were rewritten.
    expect(update.mock.calls[0][0].assignments ?? []).toEqual([]);
    const entry = (written.publish_history as PublishHistory[])[0];
    expect(entry.status).toBe('success');
    expect(entry.content_state[KEY]).toBe(await calculateDirectoryHash(path.join(workspaceRoot, KEY), publishExcludePatterns(written)));

    const { reconcile } = await vi.importActual<typeof import('../../src/core/reconciler')>('../../src/core/reconciler');
    const plan = await reconcile(written, {} as VocareumClient, entry, { workspaceRoot, events: new CollectingEventSink() });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
    expect(plan.assignments[0].parts[0].type).toBe('skip');
    expect(plan.assignments[0].parts[0].metadataChanged).toBeUndefined();
  });
});
