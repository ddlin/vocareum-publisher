// test/unit/push-rubrics-scope.test.ts
//
// Scope-containment tests (spec §10): a rubric write must never escape the scope
// the user actually requested. Each scenario builds a config with TWO
// rubric-bearing assignments and asserts createRubrics was called for the
// in-scope part only — a migration aimed at one assignment must not touch
// another's points.
//
// --assignment and --part are applied in planPush, before reconciliation
// (push-service.ts ~143-176): the out-of-scope assignment/part is filtered out
// of workingConfig and never even reaches the reconciler, so it is never fetched,
// diffed, or written. vocareum.excluded_assignments is applied inside reconcile
// (reconciler.ts ~141-172): the excluded assignment is marked 'skip' before any
// per-assignment fetch (getAssignment/listParts/getPart/listRubrics), so it never
// reaches rubric planning either.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/types/config';

const { mockListRubrics, mockCreateRubrics, mockUpdateRubrics } = vi.hoisted(() => ({
  mockListRubrics: vi.fn(),
  mockCreateRubrics: vi.fn(),
  mockUpdateRubrics: vi.fn(),
}));

vi.mock('../../src/api/rubrics', () => ({
  listRubrics: mockListRubrics,
  createRubrics: mockCreateRubrics,
  updateRubrics: mockUpdateRubrics,
}));

const { mockCalculateDirectoryHash, mockReadDirectory, mockReadFile } = vi.hoisted(() => ({
  mockCalculateDirectoryHash: vi.fn(),
  mockReadDirectory: vi.fn(),
  mockReadFile: vi.fn().mockResolvedValue('vocareum-yaml-content'),
}));

vi.mock('../../src/utils/files', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  readFile: mockReadFile,
  ensureDirectory: vi.fn().mockResolvedValue(undefined),
  readDirectory: mockReadDirectory,
  calculateDirectoryHash: mockCalculateDirectoryHash,
}));

import { RecordingClient } from '../helpers/recording-client';

let recorder: RecordingClient;

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    VocareumClient: vi.fn().mockImplementation(() => recorder),
  };
});

import { planPush, executePush } from '../../src/core/services/push-service';
import type { PushContext } from '../../src/core/services/context';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { LockedSession } from '../../src/core/session';

const COURSE_ID = 'course-scope-1';

function makeCtx(config: Config): PushContext {
  return {
    persistedConfig: config,
    effectiveConfig: config,
    configPath: 'vocareum.yaml',
    workspaceRoot: process.cwd(),
    events: new CollectingEventSink(),
    prompter: new NonInteractivePrompter(),
    client: recorder,
  };
}

/** Two rubric-bearing assignments: A (asn-A / part-A) and B (asn-B / part-B). Each
 *  part's local rubric ("NewCriterion") has no remote counterpart, so a full,
 *  unfiltered push would create a rubric criterion for BOTH parts. */
function makeTwoAssignmentConfig(bIdOverride?: string): Config {
  return {
    vocareum: {
      course_id: COURSE_ID,
      api_base_url: 'https://api.vocareum.com',
      org_id: 'org-scope-1',
      excluded_assignments: bIdOverride !== undefined ? [bIdOverride] : [],
    },
    assignments: [
      {
        path: 'labA',
        name: 'Lab A',
        assignment_id: 'asn-A',
        parts: [
          {
            path: 'partA',
            name: 'Part A',
            part_id: 'part-A',
            rubrics: [{ name: 'NewCriterion', seqnum: '1', maxscore: '10' }],
          },
        ],
      },
      {
        path: 'labB',
        name: 'Lab B',
        assignment_id: bIdOverride ?? 'asn-B',
        parts: [
          {
            path: 'partB',
            name: 'Part B',
            part_id: 'part-B',
            rubrics: [{ name: 'NewCriterion', seqnum: '1', maxscore: '10' }],
          },
        ],
      },
    ],
    publish_history: [],
  } as unknown as Config;
}

function enqueueAssignmentReconcileResponses(assignmentId: string, partId: string, name: string): void {
  recorder.enqueue({ assignments: [{ id: assignmentId, name, nosubmit: false }] }); // getAssignment
  recorder.enqueue({ parts: [{ id: partId, name, seqnum: '1', deleted: '0' }] }); // listParts
  recorder.enqueue({ parts: [{ id: partId, name, seqnum: '1', deleted: '0' }] }); // getPart
}

beforeEach(() => {
  vi.clearAllMocks();
  recorder = new RecordingClient();
  mockListRubrics.mockResolvedValue([]); // every local criterion reads as a create
  mockCreateRubrics.mockResolvedValue([]);
  mockUpdateRubrics.mockResolvedValue([]);
  mockCalculateDirectoryHash.mockResolvedValue('hash');
  mockReadDirectory.mockResolvedValue({});
});

async function planAndExecute(config: Config, req: Parameters<typeof planPush>[1]) {
  const ctx = makeCtx(config);
  const plan = await planPush(ctx, req);
  const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
  await executePush(
    { applyConfigUpdate } as unknown as LockedSession,
    ctx,
    req,
    plan,
  );
}

describe('rubric write scope containment (spec §10)', () => {
  it('--assignment limits rubric writes to the named assignment', async () => {
    const config = makeTwoAssignmentConfig();

    // planPush filters to labA before reconcile ever runs, so only labA is fetched.
    recorder.enqueue({ courses: [{ id: COURSE_ID, name: 'Scope Course', org_id: 'org-scope-1' }] });
    recorder.enqueue({ assignments: [{ id: 'asn-A', name: 'Lab A' }, { id: 'asn-B', name: 'Lab B' }] });
    enqueueAssignmentReconcileResponses('asn-A', 'part-A', 'Lab A');

    await planAndExecute(config, { assignment: 'labA', nonInteractive: true });

    expect(mockCreateRubrics).toHaveBeenCalledTimes(1);
    expect(mockCreateRubrics).toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, 'asn-A', 'part-A', expect.anything(),
    );
    expect(mockCreateRubrics).not.toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, 'asn-B', 'part-B', expect.anything(),
    );
  });

  it('--part limits rubric writes to the named part', async () => {
    const config = makeTwoAssignmentConfig();

    // partFilters drop assignment B's only part, and an assignment left with zero
    // parts after part-filtering is dropped entirely — labB never reaches reconcile.
    recorder.enqueue({ courses: [{ id: COURSE_ID, name: 'Scope Course', org_id: 'org-scope-1' }] });
    recorder.enqueue({ assignments: [{ id: 'asn-A', name: 'Lab A' }, { id: 'asn-B', name: 'Lab B' }] });
    enqueueAssignmentReconcileResponses('asn-A', 'part-A', 'Lab A');

    await planAndExecute(config, { part: 'partA', nonInteractive: true });

    expect(mockCreateRubrics).toHaveBeenCalledTimes(1);
    expect(mockCreateRubrics).toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, 'asn-A', 'part-A', expect.anything(),
    );
    expect(mockCreateRubrics).not.toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, 'asn-B', 'part-B', expect.anything(),
    );
  });

  it('vocareum.excluded_assignments prevents rubric writes on an excluded assignment', async () => {
    // Assignment B's configured ID does not exist remotely (never actually created,
    // or deleted since) AND is listed in excluded_assignments, so reconcile marks it
    // 'skip' before any per-assignment fetch — it is never diffed or written to.
    const config = makeTwoAssignmentConfig('asn-B-missing');

    recorder.enqueue({ courses: [{ id: COURSE_ID, name: 'Scope Course', org_id: 'org-scope-1' }] });
    // Remote only knows about A — B's id genuinely does not exist server-side.
    recorder.enqueue({ assignments: [{ id: 'asn-A', name: 'Lab A' }] });
    enqueueAssignmentReconcileResponses('asn-A', 'part-A', 'Lab A');

    await planAndExecute(config, { nonInteractive: true });

    expect(mockCreateRubrics).toHaveBeenCalledTimes(1);
    expect(mockCreateRubrics).toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, 'asn-A', 'part-A', expect.anything(),
    );
    expect(mockCreateRubrics).not.toHaveBeenCalledWith(
      expect.anything(), COURSE_ID, 'asn-B-missing', 'part-B', expect.anything(),
    );
  });
});
