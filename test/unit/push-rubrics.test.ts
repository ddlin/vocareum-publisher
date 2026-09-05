import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import type { ReconciliationPlan } from '../../src/types/state';
import type { RubricCreate, RubricUpdate, RemoteRubric, RubricSyncPlan } from '../../src/types/api';
import type { VocareumClient } from '../../src/api/client';
import { ForbiddenError } from '../../src/api/client';
import { executePush, emitRubricPlanSummary } from '../../src/core/services/push-service';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';
import type { PushPlan } from '../../src/core/services/types';
import type { LockedSession } from '../../src/core/session';
import type { ServiceEvent } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';

const {
  createRubricsMock,
  updateRubricsMock,
  copyAssignmentMock,
  getAssignmentMock,
  updateAssignmentMock,
  updateCourseMock,
  getPartMock,
  updatePartMock,
  readDirectoryMock,
  syncDirectoryMock,
  commitChangesMock,
  getCommitShaMock,
  getGitUserNameMock,
} = vi.hoisted(() => ({
  createRubricsMock: vi.fn(),
  updateRubricsMock: vi.fn(),
  copyAssignmentMock: vi.fn(),
  getAssignmentMock: vi.fn(),
  updateAssignmentMock: vi.fn(),
  updateCourseMock: vi.fn(),
  getPartMock: vi.fn(),
  updatePartMock: vi.fn(),
  readDirectoryMock: vi.fn(),
  syncDirectoryMock: vi.fn(),
  commitChangesMock: vi.fn(),
  getCommitShaMock: vi.fn(),
  getGitUserNameMock: vi.fn(),
}));

vi.mock('../../src/api/rubrics', () => ({
  createRubrics: createRubricsMock,
  updateRubrics: updateRubricsMock,
}));

vi.mock('../../src/api/assignments', () => ({
  copyAssignment: copyAssignmentMock,
  getAssignment: getAssignmentMock,
  updateAssignment: updateAssignmentMock,
}));

vi.mock('../../src/api/courses', () => ({
  updateCourse: updateCourseMock,
}));

vi.mock('../../src/api/parts', () => ({
  getPart: getPartMock,
  updatePart: updatePartMock,
}));

vi.mock('../../src/core/uploader', () => ({
  readDirectory: readDirectoryMock,
  syncDirectory: syncDirectoryMock,
}));

vi.mock('../../src/utils/git', () => ({
  commitChanges: commitChangesMock,
  getCommitSha: getCommitShaMock,
  getGitUserName: getGitUserNameMock,
}));

getCommitShaMock.mockResolvedValue('abc123');
getGitUserNameMock.mockResolvedValue('tester');
readDirectoryMock.mockResolvedValue({});
syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
createRubricsMock.mockResolvedValue([]);
updateRubricsMock.mockResolvedValue([]);

interface RubricPlanInput {
  creates?: RubricCreate[];
  updates?: RubricUpdate[];
  orphans?: RemoteRubric[];
  duplicateNames?: string[];
}

interface HarnessOptions {
  assignmentAction?: 'create' | 'update';
  nonInteractive?: boolean;
  abortOnError?: boolean;
  /** Rubrics carried on the local config's part — distinct from `rubricPlan`,
   *  which is the reconciler's diff. Used only to exercise the create-path
   *  disclosure warning (rule 3), which fires off config content, not a plan. */
  partRubrics?: { name: string; seqnum: string; maxscore: string }[];
}

function buildPlan(rubricPlan: RubricSyncPlan, options: HarnessOptions) {
  const assignmentAction = options.assignmentAction ?? 'update';
  const assignmentId = assignmentAction === 'create' ? null : 'a1';
  const partId = assignmentAction === 'create' ? null : 'p1';

  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: 'c1',
      api_base_url: 'https://api.vocareum.com',
    },
    assignments: [
      {
        assignment_id: assignmentId,
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: assignmentAction === 'create',
        parts: [{
          part_id: partId,
          path: 'part1',
          ...(options.partRubrics !== undefined ? { rubrics: options.partRubrics } : {}),
        }],
      },
    ],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: false,
      abort_on_error: false,
      sync_deletes: false,
      exclude_patterns: [],
    },
  } as unknown as Config;

  const reconciliation = {
    config,
    course: { type: 'skip' },
    assignments: [
      {
        type: assignmentAction,
        assignment: config.assignments[0],
        parts: [
          {
            type: assignmentAction,
            part: config.assignments[0].parts[0],
            contentChanged: false,
            rubricPlan,
          },
        ],
        ...(assignmentAction === 'create' ? { willCreate: true, templateId: 'tmpl-1' } : {}),
      },
    ],
    summary: {
      coursesToUpdate: 0,
      assignmentsToCreate: assignmentAction === 'create' ? 1 : 0,
      assignmentsToUpdate: assignmentAction === 'create' ? 0 : 1,
      assignmentsWithDiscoveredIds: 0,
      assignmentsToSkip: 0,
      partsToCreate: 0,
      partsToUpdate: 0,
      estimatedApiCalls: 1,
    },
    orphanedInVocareum: [],
  } as unknown as ReconciliationPlan;

  const intent = {
    assignments: [
      {
        path: 'lab1',
        name: 'Lab 1',
        assignmentId,
        ...(assignmentAction === 'create' ? { templateAssignmentId: 'tmpl-1' } : {}),
        action: assignmentAction,
        parts: [
          {
            partId,
            path: 'part1',
            contentHashes: {},
            rubricPlan,
          },
        ],
      },
    ],
  };

  const plan: PushPlan = {
    intent,
    preconditions: {
      configDigest: 'digest',
      contentHashes: {},
      assignmentIds: assignmentId ? [assignmentId] : [],
      partIds: partId ? [partId] : [],
      remoteAssumptions: [
        {
          assignmentPath: 'lab1',
          assignmentId,
          exists: assignmentAction !== 'create',
          partIds: partId ? [partId] : [],
        },
      ],
    },
    semanticFingerprint: semanticFingerprint(intent),
    summary: 'test plan',
    hasChanges: true,
    execution: { reconciliation, workingConfig: config },
  };

  return { plan, config };
}

async function runExecutePush(
  plan: PushPlan,
  config: Config,
  options: HarnessOptions,
) {
  copyAssignmentMock.mockResolvedValue({
    assignment_id: 'a1',
    parts: [{ part_id: 'p1', seqnum: '0' }],
  });
  getAssignmentMock.mockResolvedValue({ id: 'a1', name: 'Lab 1', deleted: '0', courseid: 'c1' });
  getPartMock.mockResolvedValue({
    id: 'p1', name: 'Part 1', seqnum: '0', deleted: '0', courseid: 'c1', assignmentid: 'a1',
  });

  const events: ServiceEvent[] = [];
  const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);

  const result = await executePush(
    { applyConfigUpdate } as unknown as LockedSession,
    {
      persistedConfig: config,
      effectiveConfig: config,
      configPath: 'vocareum.yaml',
      workspaceRoot: process.cwd(),
      events: { emit: (e: ServiceEvent) => { events.push(e); } },
      prompter: new NonInteractivePrompter(),
      client: {} as VocareumClient,
    },
    { nonInteractive: options.nonInteractive ?? false, abortOnError: options.abortOnError ?? false },
    plan,
  );

  return {
    result,
    events,
    warnings: events.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.message ?? ''),
  };
}

async function executePushWithRubricPlan(
  rubricPlanInput: RubricPlanInput,
  options: HarnessOptions = {},
) {
  vi.clearAllMocks();
  getCommitShaMock.mockResolvedValue('abc123');
  getGitUserNameMock.mockResolvedValue('tester');
  readDirectoryMock.mockResolvedValue({});
  syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
  createRubricsMock.mockResolvedValue([]);
  updateRubricsMock.mockResolvedValue([]);

  const rubricPlan: RubricSyncPlan = {
    creates: rubricPlanInput.creates ?? [],
    updates: rubricPlanInput.updates ?? [],
    orphans: rubricPlanInput.orphans ?? [],
    duplicateNames: rubricPlanInput.duplicateNames ?? [],
  };

  const { plan, config } = buildPlan(rubricPlan, options);
  const { result, events, warnings } = await runExecutePush(plan, config, options);

  return {
    createMock: createRubricsMock,
    updateMock: updateRubricsMock,
    result,
    events,
    warnings,
  };
}

async function executePushWithForbiddenRubrics() {
  vi.clearAllMocks();
  getCommitShaMock.mockResolvedValue('abc123');
  getGitUserNameMock.mockResolvedValue('tester');
  readDirectoryMock.mockResolvedValue({});
  syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
  createRubricsMock.mockRejectedValue(new ForbiddenError('Forbidden: rubrics scope missing'));
  updateRubricsMock.mockResolvedValue([]);

  const rubricPlan: RubricSyncPlan = {
    creates: [{ name: 'A', maxscore: '10' }],
    updates: [],
    orphans: [],
    duplicateNames: [],
  };

  const { plan, config } = buildPlan(rubricPlan, {});
  const { result, events, warnings } = await runExecutePush(plan, config, {});

  return { result, events, warnings };
}

/**
 * Two parts on one assignment, each with its own non-empty create-only rubric plan.
 * Used only by the post-403 recording test (Finding 2): `buildPlan` above models a
 * single part, which cannot show that a part *after* the one that trips `ForbiddenError`
 * is still recorded rather than silently skipped.
 */
function buildTwoPartForbiddenPlan() {
  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: 'c1',
      api_base_url: 'https://api.vocareum.com',
    },
    assignments: [
      {
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        parts: [
          { part_id: 'p1', path: 'part1' },
          { part_id: 'p2', path: 'part2' },
        ],
      },
    ],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: false,
      abort_on_error: false,
      sync_deletes: false,
      exclude_patterns: [],
    },
  } as unknown as Config;

  const rubricPlan1: RubricSyncPlan = { creates: [{ name: 'A', maxscore: '10' }], updates: [], orphans: [], duplicateNames: [] };
  const rubricPlan2: RubricSyncPlan = { creates: [{ name: 'B', maxscore: '5' }], updates: [], orphans: [], duplicateNames: [] };

  const reconciliation = {
    config,
    course: { type: 'skip' },
    assignments: [
      {
        type: 'update',
        assignment: config.assignments[0],
        parts: [
          { type: 'update', part: config.assignments[0].parts[0], contentChanged: false, rubricPlan: rubricPlan1 },
          { type: 'update', part: config.assignments[0].parts[1], contentChanged: false, rubricPlan: rubricPlan2 },
        ],
      },
    ],
    summary: {
      coursesToUpdate: 0,
      assignmentsToCreate: 0,
      assignmentsToUpdate: 1,
      assignmentsWithDiscoveredIds: 0,
      assignmentsToSkip: 0,
      partsToCreate: 0,
      partsToUpdate: 0,
      estimatedApiCalls: 1,
    },
    orphanedInVocareum: [],
  } as unknown as ReconciliationPlan;

  const intent = {
    assignments: [
      {
        path: 'lab1',
        name: 'Lab 1',
        assignmentId: 'a1',
        action: 'update' as const,
        parts: [
          { partId: 'p1', path: 'part1', contentHashes: {}, rubricPlan: rubricPlan1 },
          { partId: 'p2', path: 'part2', contentHashes: {}, rubricPlan: rubricPlan2 },
        ],
      },
    ],
  };

  const plan: PushPlan = {
    intent,
    preconditions: {
      configDigest: 'digest',
      contentHashes: {},
      assignmentIds: ['a1'],
      partIds: ['p1', 'p2'],
      remoteAssumptions: [
        { assignmentPath: 'lab1', assignmentId: 'a1', exists: true, partIds: ['p1', 'p2'] },
      ],
    },
    semanticFingerprint: semanticFingerprint(intent),
    summary: 'test plan',
    hasChanges: true,
    execution: { reconciliation, workingConfig: config },
  };

  return { plan, config };
}

/**
 * Two separate assignments, each with one part carrying a non-empty rubric plan. The
 * first part's plan has duplicate names (a synchronous refusal, no API call involved) —
 * used only by the --abort-on-error test (FIX 4) to show the run stops there and never
 * reaches the second assignment's part, whose creates would otherwise be sent.
 */
function buildTwoAssignmentDuplicateNamesFirstPlan() {
  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: 'c1',
      api_base_url: 'https://api.vocareum.com',
    },
    assignments: [
      {
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        parts: [{ part_id: 'p1', path: 'part1' }],
      },
      {
        assignment_id: 'a2',
        name: 'Lab 2',
        path: 'lab2',
        create_from_template: false,
        parts: [{ part_id: 'p2', path: 'part1' }],
      },
    ],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: false,
      abort_on_error: true,
      sync_deletes: false,
      exclude_patterns: [],
    },
  } as unknown as Config;

  const rubricPlan1: RubricSyncPlan = { creates: [], updates: [], orphans: [], duplicateNames: ['A'] };
  const rubricPlan2: RubricSyncPlan = { creates: [{ name: 'B', maxscore: '5' }], updates: [], orphans: [], duplicateNames: [] };

  const reconciliation = {
    config,
    course: { type: 'skip' },
    assignments: [
      {
        type: 'update',
        assignment: config.assignments[0],
        parts: [{ type: 'update', part: config.assignments[0].parts[0], contentChanged: false, rubricPlan: rubricPlan1 }],
      },
      {
        type: 'update',
        assignment: config.assignments[1],
        parts: [{ type: 'update', part: config.assignments[1].parts[0], contentChanged: false, rubricPlan: rubricPlan2 }],
      },
    ],
    summary: {
      coursesToUpdate: 0,
      assignmentsToCreate: 0,
      assignmentsToUpdate: 2,
      assignmentsWithDiscoveredIds: 0,
      assignmentsToSkip: 0,
      partsToCreate: 0,
      partsToUpdate: 0,
      estimatedApiCalls: 1,
    },
    orphanedInVocareum: [],
  } as unknown as ReconciliationPlan;

  const intent = {
    assignments: [
      {
        path: 'lab1',
        name: 'Lab 1',
        assignmentId: 'a1',
        action: 'update' as const,
        parts: [{ partId: 'p1', path: 'part1', contentHashes: {}, rubricPlan: rubricPlan1 }],
      },
      {
        path: 'lab2',
        name: 'Lab 2',
        assignmentId: 'a2',
        action: 'update' as const,
        parts: [{ partId: 'p2', path: 'part1', contentHashes: {}, rubricPlan: rubricPlan2 }],
      },
    ],
  };

  const plan: PushPlan = {
    intent,
    preconditions: {
      configDigest: 'digest',
      contentHashes: {},
      assignmentIds: ['a1', 'a2'],
      partIds: ['p1', 'p2'],
      remoteAssumptions: [
        { assignmentPath: 'lab1', assignmentId: 'a1', exists: true, partIds: ['p1'] },
        { assignmentPath: 'lab2', assignmentId: 'a2', exists: true, partIds: ['p2'] },
      ],
    },
    semanticFingerprint: semanticFingerprint(intent),
    summary: 'test plan',
    hasChanges: true,
    execution: { reconciliation, workingConfig: config },
  };

  return { plan, config };
}

async function executePushWithTwoPartsAndForbiddenFirst() {
  vi.clearAllMocks();
  getCommitShaMock.mockResolvedValue('abc123');
  getGitUserNameMock.mockResolvedValue('tester');
  readDirectoryMock.mockResolvedValue({});
  syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
  // Only the first call rejects; a second call (which should never happen once
  // `rubricsAvailable` latches false) would otherwise resolve normally and mask the bug.
  createRubricsMock.mockRejectedValueOnce(new ForbiddenError('Forbidden: rubrics scope missing'));
  createRubricsMock.mockResolvedValue([]);
  updateRubricsMock.mockResolvedValue([]);

  const { plan, config } = buildTwoPartForbiddenPlan();
  const { result, events, warnings } = await runExecutePush(plan, config, {});

  return { result, events, warnings };
}

async function executePushAbortOnErrorAcrossAssignments() {
  vi.clearAllMocks();
  getCommitShaMock.mockResolvedValue('abc123');
  getGitUserNameMock.mockResolvedValue('tester');
  readDirectoryMock.mockResolvedValue({});
  syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
  createRubricsMock.mockResolvedValue([]);
  updateRubricsMock.mockResolvedValue([]);

  const { plan, config } = buildTwoAssignmentDuplicateNamesFirstPlan();
  const { result, events, warnings } = await runExecutePush(plan, config, { abortOnError: true });

  return { result, events, warnings };
}

describe('executePush — rubric writes', () => {
  it('creates then updates, one batched call each', async () => {
    const { createMock, updateMock } = await executePushWithRubricPlan({
      creates: [{ name: 'A', maxscore: '10' }],
      updates: [{ id: 'r1', maxscore: '12' }],
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.invocationCallOrder[0])
      .toBeLessThan(updateMock.mock.invocationCallOrder[0]);
  });

  it('makes no call when the plan is empty', async () => {
    const { createMock, updateMock } = await executePushWithRubricPlan({ creates: [], updates: [] });
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('skips rubric writes entirely for a newly created assignment', async () => {
    const { createMock } = await executePushWithRubricPlan(
      { creates: [{ name: 'A', maxscore: '10' }], updates: [] },
      { assignmentAction: 'create' },
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('discloses in the CLI that a created assignment carries unreconciled template rubrics', async () => {
    // Rule 3: created assignments are excluded from rubric sync, but the exclusion must be
    // said out loud — the copied assignment is not rubric-less, it just wasn't diffed.
    const { events } = await executePushWithRubricPlan(
      { creates: [], updates: [] },
      { assignmentAction: 'create', partRubrics: [{ name: 'A', seqnum: '0', maxscore: '10' }] },
    );

    const warning = events.find((e) => e.level === 'warn' && e.message?.includes('were not reconciled'));
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/Run push again/);
  });

  it('refuses a part with duplicate names and marks the run failed', async () => {
    const { result, createMock } = await executePushWithRubricPlan({
      creates: [], updates: [], duplicateNames: ['A'],
    });

    expect(createMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.failed.some(f => (f.error as string).includes('duplicate'))).toBe(true);
  });

  it('holds creates on a part with orphans in non-interactive mode and fails the run', async () => {
    // CI is exactly where nobody sees a warning before a live course's points inflate.
    const { createMock, updateMock, result } = await executePushWithRubricPlan(
      { creates: [{ name: 'NEW', maxscore: '5' }], updates: [{ id: 'r1', maxscore: '9' }],
        orphans: [{ id: 'r9', name: 'OLD', seqnum: '9', maxscore: '5' }] },
      { nonInteractive: true },
    );

    expect(createMock).not.toHaveBeenCalled();   // creates held — a create is what inflates
    expect(updateMock).toHaveBeenCalledTimes(1); // updates still proceed
    expect(result.success).toBe(false);
  });

  // Rule 5, discriminating direction: the orphan-hold test above has an `updates` entry
  // in the same plan, so `wroteAnything` would be `true` even if `partWasUpdated` were
  // wired to always fire — it cannot tell correct behavior from that bug. These two tests
  // pin it: nothing sent must not mark the part updated, and something sent must.
  it('does not record the part in result.updated when creates are held and nothing else is sent', async () => {
    const { createMock, updateMock, result } = await executePushWithRubricPlan(
      {
        creates: [{ name: 'NEW', maxscore: '5' }],
        updates: [],
        orphans: [{ id: 'r9', name: 'OLD', seqnum: '9', maxscore: '5' }],
      },
      { nonInteractive: true },
    );

    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.updated.some((u) => u.parts?.includes('p1') === true)).toBe(false);
  });

  it('records the part in result.updated when a rubric write actually happens', async () => {
    const { createMock, result } = await executePushWithRubricPlan({
      creates: [{ name: 'A', maxscore: '10' }],
      updates: [],
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.updated.some((u) => u.parts?.includes('p1') === true)).toBe(true);
  });

  it('a 403 disables rubric sync for the rest of the run and fails it', async () => {
    const { result, warnings } = await executePushWithForbiddenRubrics();

    expect(result.success).toBe(false);
    expect(warnings.join('\n')).toMatch(/rubrics/i);
  });

  it('after a 403, a later part is still recorded in result.failed and the scope warning fires once', async () => {
    const { result, events } = await executePushWithTwoPartsAndForbiddenFirst();

    // The second part's write must never be attempted once the scope is known lost.
    expect(createRubricsMock).toHaveBeenCalledTimes(1);
    // ...but it must still be recorded, not silently skipped — that's the whole point
    // of the rule: a green push must never hide how much of the migration didn't happen.
    expect(result.failed.some((f) => f.id === 'p2')).toBe(true);
    expect(result.failed.some((f) => f.id === 'p1')).toBe(true);
    expect(result.success).toBe(false);

    // The scope-loss message is emitted once, from inside the ForbiddenError catch — not
    // once per subsequently-skipped part. A regression that moved it inside the per-part
    // loop would make this 2.
    const scopeWarnings = events.filter(
      (e) => e.message?.includes('Rubric writes are not permitted with this API token') === true,
    );
    expect(scopeWarnings).toHaveLength(1);
  });

  // FIX 4: every other failure site in executePush honours --abort-on-error; the four
  // rubric failure sites (no-scope skip, duplicate names, orphan hold, write failure)
  // did not. A user who passed --abort-on-error while mutating grading configuration
  // must get the same guarantee everywhere.
  it('--abort-on-error stops at the first rubric failure and never reaches a second assignment', async () => {
    const { result } = await executePushAbortOnErrorAcrossAssignments();

    // Lab 1's part has duplicate rubric names — a synchronous refusal. Lab 2's part
    // would create a criterion if the run reached it.
    expect(result.success).toBe(false);
    expect(result.failed.some((f) => f.id === 'p1')).toBe(true);
    expect(result.failed.some((f) => f.id === 'p2')).toBe(false);
    expect(createRubricsMock).not.toHaveBeenCalled();
  });

  // FIX 6a: creates succeed, then the update call throws. The history entry must not
  // read as a clean success with a point delta while result.failed records a failure —
  // the true total is unknown once part of the plan landed and part did not.
  it('records held: partial-write and omits the point delta when creates succeed and updates then throw', async () => {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    readDirectoryMock.mockResolvedValue({});
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
    createRubricsMock.mockResolvedValue([]);
    updateRubricsMock.mockRejectedValue(new Error('server exploded mid-update'));

    const rubricPlan: RubricSyncPlan = {
      creates: [{ name: 'B', maxscore: '5' }],
      updates: [{ id: 'r1', maxscore: '12' }],
      orphans: [],
      duplicateNames: [],
    };
    const { plan, config } = buildPlan(rubricPlan, {});
    const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
    copyAssignmentMock.mockResolvedValue({ assignment_id: 'a1', parts: [{ part_id: 'p1', seqnum: '0' }] });
    getAssignmentMock.mockResolvedValue({ id: 'a1', name: 'Lab 1', deleted: '0', courseid: 'c1' });
    getPartMock.mockResolvedValue({ id: 'p1', name: 'Part 1', seqnum: '0', deleted: '0', courseid: 'c1', assignmentid: 'a1' });

    const result = await executePush(
      { applyConfigUpdate } as unknown as LockedSession,
      {
        persistedConfig: config,
        effectiveConfig: config,
        configPath: 'vocareum.yaml',
        workspaceRoot: process.cwd(),
        events: { emit: () => {} },
        prompter: new NonInteractivePrompter(),
        client: {} as VocareumClient,
      },
      { nonInteractive: false },
      plan,
    );

    expect(createRubricsMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.failed).toHaveLength(1);

    const history = applyConfigUpdate.mock.calls[0][0].publish_history[0];
    expect(history.changes.rubrics[0]).toMatchObject({ held: 'partial-write' });
    expect(history.changes.rubrics[0].points_before).toBeUndefined();
    expect(history.changes.rubrics[0].points_after).toBeUndefined();
  });

  // FIX 3: a rubric READ failure at plan time (rubricPlan undefined, rubricReadFailed
  // set) must fail the run and leave an audit record — not read as success having
  // migrated no points.
  it('fails the run and records held: read-failed when the plan-time rubric read failed', async () => {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    readDirectoryMock.mockResolvedValue({});
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });

    const rubricPlan: RubricSyncPlan = { creates: [], updates: [], orphans: [], duplicateNames: [] };
    const { plan, config } = buildPlan(rubricPlan, {});
    // Simulate what the reconciler now does on a read failure: rubricPlan stays
    // undefined, rubricReadFailed carries the message, on both the reconciliation
    // PartAction and the PushIntent's PartIntent (planPush's mapping of the former
    // to the latter).
    const reconciledPart = plan.execution.reconciliation.assignments[0].parts[0] as unknown as {
      rubricPlan?: RubricSyncPlan; rubricReadFailed?: string;
    };
    reconciledPart.rubricPlan = undefined;
    reconciledPart.rubricReadFailed = 'token lacks rubrics scope';
    const intentPart = plan.intent.assignments[0].parts[0] as unknown as {
      rubricPlan?: RubricSyncPlan; rubricReadFailed?: string;
    };
    intentPart.rubricPlan = undefined;
    intentPart.rubricReadFailed = 'token lacks rubrics scope';
    // executePush recomputes and checks the fingerprint against the intent it's handed;
    // it must be refreshed after mutating the intent above or the run rejects as stale.
    (plan as unknown as { semanticFingerprint: string }).semanticFingerprint = semanticFingerprint(plan.intent);

    const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
    getAssignmentMock.mockResolvedValue({ id: 'a1', name: 'Lab 1', deleted: '0', courseid: 'c1' });
    getPartMock.mockResolvedValue({ id: 'p1', name: 'Part 1', seqnum: '0', deleted: '0', courseid: 'c1', assignmentid: 'a1' });

    const result = await executePush(
      { applyConfigUpdate } as unknown as LockedSession,
      {
        persistedConfig: config,
        effectiveConfig: config,
        configPath: 'vocareum.yaml',
        workspaceRoot: process.cwd(),
        events: { emit: () => {} },
        prompter: new NonInteractivePrompter(),
        client: {} as VocareumClient,
      },
      { nonInteractive: false },
      plan,
    );

    expect(result.success).toBe(false);
    expect(result.failed.some((f) => f.id === 'p1')).toBe(true);
    expect(createRubricsMock).not.toHaveBeenCalled();
    expect(updateRubricsMock).not.toHaveBeenCalled();

    const history = applyConfigUpdate.mock.calls[0][0].publish_history[0];
    expect(history.changes.rubrics[0]).toMatchObject({ held: 'read-failed' });
  });
});

describe('emitRubricPlanSummary (plan-confirmation display)', () => {
  /** Render one part's rubric plan the way both planPush display branches do, and
   *  return the joined message text for substring/regex assertions. */
  function renderPlanWithRubrics(input: {
    creates: RubricCreate[];
    updates: RubricUpdate[];
    orphans: RemoteRubric[];
    remoteRubrics: RemoteRubric[];
  }): string {
    const events: ServiceEvent[] = [];
    const rubricPlan: RubricSyncPlan = {
      creates: input.creates,
      updates: input.updates,
      orphans: input.orphans,
      duplicateNames: [],
    };
    emitRubricPlanSummary(
      { emit: (e: ServiceEvent) => { events.push(e); } },
      'Part Golden',
      rubricPlan,
      input.remoteRubrics,
    );
    return events.map((e) => e.message ?? '').join('\n');
  }

  it('shows creates, updates, and the projected point change before confirming', () => {
    const out = renderPlanWithRubrics({
      creates: [{ name: 'B', maxscore: '5' }],
      updates: [],
      orphans: [{ id: 'r9', name: 'OLD', seqnum: '9', maxscore: '5' }],
      remoteRubrics: [{ id: 'r1', name: 'A', seqnum: '1', maxscore: '25', auto: false, exclude: false }],
    });

    expect(out).toContain('1 rubric criterion to create');
    expect(out).toMatch(/no local counterpart/);
    expect(out).toMatch(/25 to 30/); // the sentence that makes the risk legible
    expect(out).toContain('never deletes');
  });

  it('shows updates without a create when only maxscore drifted', () => {
    const out = renderPlanWithRubrics({
      creates: [],
      updates: [{ id: 'r1', maxscore: '15' }],
      orphans: [],
      remoteRubrics: [{ id: 'r1', name: 'A', seqnum: '1', maxscore: '10', auto: false, exclude: false }],
    });

    expect(out).toContain('0 rubric criteria to create, 1 to update');
    expect(out).toMatch(/10 to 15/);
  });

  it('omits the point projection and names the unparseable criteria instead', () => {
    const out = renderPlanWithRubrics({
      creates: [],
      updates: [],
      orphans: [],
      remoteRubrics: [{ id: 'r1', name: 'Bad', seqnum: '1', maxscore: 'N/A', auto: false, exclude: false }],
    });

    expect(out).toMatch(/could not be computed/);
    expect(out).toContain('Bad');
    expect(out).not.toMatch(/Points would go from/);
  });

  it('reports duplicate names and refuses to push, without a point projection', () => {
    const events: ServiceEvent[] = [];
    emitRubricPlanSummary(
      { emit: (e: ServiceEvent) => { events.push(e); } },
      'Part Golden',
      { creates: [], updates: [], orphans: [], duplicateNames: ['Task 1'] },
      [],
    );

    const out = events.map((e) => e.message ?? '').join('\n');
    expect(out).toMatch(/duplicate criterion names/);
    expect(out).toContain('Task 1');
    expect(out).not.toMatch(/to create/);
  });
});
