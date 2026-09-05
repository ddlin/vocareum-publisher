// test/integration/push-fingerprint.test.ts
//
// Acceptance test for P0: proves that `planPush` produces a semanticFingerprint
// that is sensitive to REAL content and settings changes.
//
// This test drives planPush (not synthetic PushIntents) so it exercises the
// actual path that was broken: empty contentHashes meant two materially
// different pushes produced the same fingerprint.
//
// Before the P0 fix: (a) and (b) would FAIL — the fingerprint was insensitive
// to content or settings because contentHashes were always empty strings.
// After the fix: all three assertions pass.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Rubric } from '../../src/types/config';

// ── rubrics API mock — Task 3 makes reconciliation fetch rubrics for any part
// whose config carries a `rubrics` key. Mocking the module directly (rather than
// enqueueing another RecordingClient response) keeps this fetch off the shared
// response queue so it can't desynchronize the reconcile-response sequence.
const { mockListRubrics } = vi.hoisted(() => ({
  mockListRubrics: vi.fn(),
}));

vi.mock('../../src/api/rubrics', () => ({
  listRubrics: mockListRubrics,
}));

// ── files mock — controls calculateDirectoryHash and readFile return values ───
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

// ── RecordingClient + VocareumClient mock ─────────────────────────────────────
import { RecordingClient } from '../helpers/recording-client';

let recorder: RecordingClient;

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    VocareumClient: vi.fn().mockImplementation(() => recorder),
  };
});

// ── imports (after mocks) ─────────────────────────────────────────────────────
import { planPush } from '../../src/core/services/push-service';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';
import type { PushContext } from '../../src/core/services/context';
import type { Config } from '../../src/types/config';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';

// ── constants ─────────────────────────────────────────────────────────────────
const ASSIGNMENT_ID = 'asn-fp-1';
const PART_ID = 'part-fp-1';
const COURSE_ID = 'course-fp-1';

// Hash values for the "stale" (last recorded) and "current" states
const STALE_HASH = 'aaa111aaa111';
const CONTENT_HASH_V1 = 'bbb222bbb222';
const CONTENT_HASH_V2 = 'ccc333ccc333'; // a different content change

// ── API response fixtures (same structure as push.golden.test.ts) ─────────────
const courseResponse = {
  courses: [{ id: COURSE_ID, name: 'FP Course', org_id: 'org-fp-1' }],
};
const assignmentsListResponse = {
  assignments: [{ id: ASSIGNMENT_ID, name: 'FP Assignment', nosubmit: false }],
  total_records: '1',
};
const fullAssignmentResponse = {
  assignments: [{ id: ASSIGNMENT_ID, name: 'FP Assignment', nosubmit: false }],
};
const partsListResponse = {
  parts: [{ id: PART_ID, name: 'FP Part', seqnum: '1', deleted: '0' }],
};
const getPartResponseDefault = {
  parts: [{ id: PART_ID, name: 'FP Part', seqnum: '1', deleted: '0', session_length: 60 }],
};

// ── base config factory ───────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<Config['assignments'][0]>): Config {
  return {
    vocareum: { course_id: COURSE_ID, api_base_url: 'https://api.vocareum.com', org_id: 'org-fp-1' },
    assignments: [
      {
        path: 'assignment1',
        name: 'FP Assignment',
        assignment_id: ASSIGNMENT_ID,
        ...overrides,
        parts: [
          {
            path: 'part1',
            name: 'FP Part',
            part_id: PART_ID,
            directories: ['startercode'],
            ...(overrides?.parts?.[0] ?? {}),
          },
        ],
      },
    ],
    publish_history: [
      {
        timestamp: '2025-01-01T00:00:00.000Z',
        commit_sha: 'deadbeef',
        published_by: 'prev-user',
        status: 'success' as const,
        content_state: { 'assignment1/part1/startercode': STALE_HASH },
      },
    ],
  };
}

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

/** Enqueue the standard reconciliation responses (getCourse → getAssignment → getPart). */
function enqueueReconcileResponses(getPartResponse = getPartResponseDefault): void {
  recorder.enqueue(courseResponse);
  recorder.enqueue(assignmentsListResponse);
  recorder.enqueue(fullAssignmentResponse);
  recorder.enqueue(partsListResponse);
  recorder.enqueue(getPartResponse);
}

/**
 * Plan a push for a config whose single part carries the given rubrics, with an
 * always-empty remote rubric list (every local criterion reads as a create). Task 3
 * makes reconciliation fetch rubrics for any part whose config has a `rubrics` key,
 * so `mockListRubrics` (not the RecordingClient queue) supplies that response —
 * see the `vi.mock('../../src/api/rubrics')` above.
 */
async function planWithRubrics(rubrics: Rubric[]) {
  const config = makeConfig({
    parts: [
      {
        path: 'part1',
        name: 'FP Part',
        part_id: PART_ID,
        directories: ['startercode'],
        rubrics,
      },
    ],
  } as Partial<Config['assignments'][0]>);

  recorder = new RecordingClient();
  mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
  mockReadDirectory.mockResolvedValue({ 'hello.txt': Buffer.from('hello') });
  mockListRubrics.mockResolvedValue([]);

  enqueueReconcileResponses();

  return planPush(makeCtx(config), {});
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('push-fingerprint integration: planPush produces sensitive fingerprint', () => {
  beforeEach(() => {
    recorder = new RecordingClient();
    mockReadDirectory.mockResolvedValue({ 'hello.txt': Buffer.from('hello') });
  });

  // ── (a) content change → different fingerprint ────────────────────────────
  it('(a) content change produces a different fingerprint than baseline', async () => {
    // Baseline: local hash is CONTENT_HASH_V1 (differs from STALE_HASH → changed)
    enqueueReconcileResponses();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    const baselinePlan = await planPush(makeCtx(makeConfig()), { dryRun: false });

    // Changed: local hash is CONTENT_HASH_V2 (a different local state)
    recorder = new RecordingClient();
    enqueueReconcileResponses();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V2);
    const changedPlan = await planPush(makeCtx(makeConfig()), { dryRun: false });

    // The fingerprints must differ because the content hash differs.
    expect(baselinePlan.semanticFingerprint).not.toBe(changedPlan.semanticFingerprint);

    // Also verify the intent carries the real hash (not empty string).
    const baselineHash = baselinePlan.intent.assignments[0]?.parts[0]?.contentHashes?.startercode;
    const changedHash = changedPlan.intent.assignments[0]?.parts[0]?.contentHashes?.startercode;
    expect(baselineHash).toBe(CONTENT_HASH_V1);
    expect(changedHash).toBe(CONTENT_HASH_V2);
  });

  // ── (b) settings change → different fingerprint ───────────────────────────
  it('(b) settings change produces a different fingerprint than baseline', async () => {
    // Baseline: part has no local settings change (only content changed).
    // The remote returns session_length=60; local config matches → no metadata change.
    const configNoSettings = makeConfig();
    enqueueReconcileResponses();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    const baselinePlan = await planPush(makeCtx(configNoSettings), { dryRun: false });

    // With settings: part now has session_length=120 which differs from remote (60).
    const configWithSettings = makeConfig({
      parts: [
        {
          path: 'part1',
          name: 'FP Part',
          part_id: PART_ID,
          directories: ['startercode'],
          settings: { session_length: 120 },
        },
      ],
    } as Partial<Config['assignments'][0]>);
    recorder = new RecordingClient();
    enqueueReconcileResponses();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    const settingsPlan = await planPush(makeCtx(configWithSettings), { dryRun: false });

    expect(baselinePlan.semanticFingerprint).not.toBe(settingsPlan.semanticFingerprint);
  });

  // ── (c) identical inputs → identical fingerprint ──────────────────────────
  it('(c) identical inputs produce the same fingerprint', async () => {
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);

    enqueueReconcileResponses();
    const plan1 = await planPush(makeCtx(makeConfig()), { dryRun: false });

    recorder = new RecordingClient();
    enqueueReconcileResponses();
    const plan2 = await planPush(makeCtx(makeConfig()), { dryRun: false });

    expect(plan1.semanticFingerprint).toBe(plan2.semanticFingerprint);
  });

  // ── bonus: intent carries precondition hashes ─────────────────────────────
  it('preconditions.contentHashes contains real directory hashes', async () => {
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    enqueueReconcileResponses();
    const plan = await planPush(makeCtx(makeConfig()), { dryRun: false });

    // The dirKey the reconciler uses is path.join(assignmentPath, partPath, dir)
    expect(plan.preconditions.contentHashes['assignment1/part1/startercode']).toBe(CONTENT_HASH_V1);
  });
});

// ── templateCourseId fingerprint sensitivity ──────────────────────────────────
describe('push-fingerprint: templateCourseId shifts fingerprint (FIX 1a)', () => {
  const TEMPLATE_ASSIGNMENT_ID = 'tpl-asn-1';
  const TEMPLATE_COURSE_A = 'template-course-A';
  const TEMPLATE_COURSE_B = 'template-course-B';

  // Config with create_from_template + a named template
  function makeCreateConfig(templateCourseId: string): Config {
    return {
      vocareum: {
        course_id: COURSE_ID,
        api_base_url: 'https://api.vocareum.com',
        org_id: 'org-fp-1',
        templates: [{ id: TEMPLATE_ASSIGNMENT_ID, name: 'default', course_id: templateCourseId }],
      },
      assignments: [
        {
          path: 'assignment-new',
          name: 'New Assignment',
          assignment_id: null as unknown as string,
          create_from_template: true,
          parts: [{ path: 'part1', name: 'Part 1', part_id: null as unknown as string, directories: ['startercode'] }],
        },
      ],
    };
  }

  beforeEach(() => {
    recorder = new RecordingClient();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    mockReadDirectory.mockResolvedValue({ 'hello.txt': Buffer.from('hello') });
  });

  it('a templateCourseId change shifts the planPush fingerprint', async () => {
    // Both configs trigger a create action — no existing assignment in Vocareum.
    const createCourseResponse = { courses: [{ id: COURSE_ID, name: 'FP Course', org_id: 'org-fp-1' }] };
    const emptyAssignments = { assignments: [], total_records: '0' };

    // Plan A: template is in course-A
    recorder.enqueue(createCourseResponse);
    recorder.enqueue(emptyAssignments);
    const planA = await planPush(makeCtx(makeCreateConfig(TEMPLATE_COURSE_A)), { dryRun: false });

    // Plan B: template is in course-B
    recorder = new RecordingClient();
    recorder.enqueue(createCourseResponse);
    recorder.enqueue(emptyAssignments);
    const planB = await planPush(makeCtx(makeCreateConfig(TEMPLATE_COURSE_B)), { dryRun: false });

    // The intent must carry the templateCourseId
    expect(planA.intent.assignments[0]?.templateCourseId).toBe(TEMPLATE_COURSE_A);
    expect(planB.intent.assignments[0]?.templateCourseId).toBe(TEMPLATE_COURSE_B);

    // A change in template SOURCE COURSE must shift the fingerprint
    expect(planA.semanticFingerprint).not.toBe(planB.semanticFingerprint);
  });
});

// ── deletePaths fingerprint sensitivity (FIX 1b) ─────────────────────────────
describe('push-fingerprint: deletePaths populated and shifts fingerprint (FIX 1b)', () => {
  beforeEach(() => {
    recorder = new RecordingClient();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    mockReadDirectory.mockResolvedValue({ 'local-file.txt': Buffer.from('hello') });
  });

  /** Enqueue the standard reconcile responses + one listFiles response for syncDeletes. */
  function enqueueWithDeleteResponses(remoteFiles: { path: string }[]): void {
    recorder.enqueue(courseResponse);
    recorder.enqueue(assignmentsListResponse);
    recorder.enqueue(fullAssignmentResponse);
    recorder.enqueue(partsListResponse);
    recorder.enqueue(getPartResponseDefault);
    // listFiles response (called once per changed directory when syncDeletes=true)
    recorder.enqueue({ files: remoteFiles });
  }

  it('a different remote file set produces a different deletePaths and shifts fingerprint', async () => {
    // Plan 1: remote has one extra file (remote-only.txt)
    enqueueWithDeleteResponses([{ path: 'local-file.txt' }, { path: 'remote-only.txt' }]);
    const plan1 = await planPush(makeCtx(makeConfig()), { syncDeletes: true });

    // Plan 2: remote has a different extra file (other-remote.txt)
    recorder = new RecordingClient();
    enqueueWithDeleteResponses([{ path: 'local-file.txt' }, { path: 'other-remote.txt' }]);
    const plan2 = await planPush(makeCtx(makeConfig()), { syncDeletes: true });

    // deletePaths must be populated for plan1
    const part1 = plan1.intent.assignments[0]?.parts[0];
    expect(part1?.deletePaths).toBeDefined();

    // The fingerprints must differ because the delete sets differ
    expect(plan1.semanticFingerprint).not.toBe(plan2.semanticFingerprint);
  });

  it('zero API calls for deletePaths when syncDeletes is false', async () => {
    // Only enqueue reconcile responses — no listFiles response
    enqueueReconcileResponses();
    const plan = await planPush(makeCtx(makeConfig()), { syncDeletes: false });

    // recorder must not have received a listFiles GET
    const sequence = recorder.sequence();
    const listCalls = sequence.filter((s) => s.includes('list=true') || s.includes('/files'));
    expect(listCalls.length).toBe(0);

    // deletePaths must be absent
    expect(plan.intent.assignments[0]?.parts[0]?.deletePaths).toBeUndefined();
  });

  it('single-session CLI defers deletion resolution to preserve API-call order', async () => {
    enqueueReconcileResponses();
    const plan = await planPush(makeCtx(makeConfig()), {
      syncDeletes: true,
      deferDeleteResolution: true,
    });

    expect(recorder.sequence().filter((call) => call.includes('/files'))).toHaveLength(0);
    const part = plan.intent.assignments[0]?.parts[0];
    expect(part?.deletePaths).toBeUndefined();
    expect(part?.reconcileDeleteDirectories).toEqual(['startercode']);
  });
});

// ── fail-closed preconditions (FIX 2) ────────────────────────────────────────
describe('push-fingerprint: planPush fails closed when preconditions cannot be captured (FIX 2)', () => {
  beforeEach(() => {
    recorder = new RecordingClient();
    mockCalculateDirectoryHash.mockResolvedValue(CONTENT_HASH_V1);
    mockReadDirectory.mockResolvedValue({ 'hello.txt': Buffer.from('hello') });
  });

  it('throws when configDigest cannot be read (config file unreadable)', async () => {
    // Make readFile throw to simulate an unreadable config
    mockReadFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));

    recorder.enqueue(courseResponse);
    recorder.enqueue(assignmentsListResponse);
    recorder.enqueue(fullAssignmentResponse);
    recorder.enqueue(partsListResponse);
    recorder.enqueue(getPartResponseDefault);

    await expect(
      planPush(makeCtx(makeConfig()), { dryRun: false })
    ).rejects.toThrow(/Cannot compute push preconditions.*config/);
  });

  it('throws when a directory hash fails for a create action (no reconciler hash available)', async () => {
    // For a CREATE action, the reconciler does not compute dirHashes — planPush
    // must compute the hash itself and must throw if it fails (fail-closed).
    // Simulate by making calculateDirectoryHash throw on ALL calls so both
    // the reconciler's detectChangedDirectories (create path) and planPush fail.
    // The reconciler's create path doesn't call detectChangedDirectories, so
    // the throw only fires in planPush's fallback hash call.
    mockCalculateDirectoryHash.mockRejectedValue(new Error('EACCES: permission denied'));

    const createCourseResponse = { courses: [{ id: COURSE_ID, name: 'FP Course', org_id: 'org-fp-1' }] };
    const emptyAssignments = { assignments: [], total_records: '0' };
    recorder.enqueue(createCourseResponse);
    recorder.enqueue(emptyAssignments);

    const createConfig: Config = {
      vocareum: {
        course_id: COURSE_ID,
        api_base_url: 'https://api.vocareum.com',
        org_id: 'org-fp-1',
        templates: [{ id: 'tpl-1', name: 'default', course_id: COURSE_ID }],
      },
      assignments: [{
        path: 'new-asn',
        name: 'New Assignment',
        assignment_id: null as unknown as string,
        create_from_template: true,
        parts: [{ path: 'part1', name: 'Part 1', part_id: null as unknown as string, directories: ['startercode'] }],
      }],
    };

    await expect(
      planPush(makeCtx(createConfig), { dryRun: false })
    ).rejects.toThrow(/Cannot compute push preconditions.*hash/);
  });
});

describe('push-fingerprint: rubric plans are covered', () => {
  it('a changed rubric maxscore shifts the semanticFingerprint', async () => {
    const baseline = await planWithRubrics([{ name: 'A', seqnum: '1', maxscore: '10' }]);
    const changed  = await planWithRubrics([{ name: 'A', seqnum: '1', maxscore: '12' }]);

    expect(baseline.semanticFingerprint).not.toBe(changed.semanticFingerprint);
  });

  it('an added criterion shifts the semanticFingerprint', async () => {
    const baseline = await planWithRubrics([{ name: 'A', seqnum: '1', maxscore: '10' }]);
    const added    = await planWithRubrics([
      { name: 'A', seqnum: '1', maxscore: '10' },
      { name: 'B', seqnum: '2', maxscore: '5' },
    ]);

    expect(baseline.semanticFingerprint).not.toBe(added.semanticFingerprint);
  });

  it('an identical rubric plan produces a stable fingerprint across two plans', async () => {
    const a = await planWithRubrics([{ name: 'A', seqnum: '1', maxscore: '10' }]);
    const b = await planWithRubrics([{ name: 'A', seqnum: '1', maxscore: '10' }]);

    expect(a.semanticFingerprint).toBe(b.semanticFingerprint);
  });
});
