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

// ── files mock — controls calculateDirectoryHash return value ─────────────────
const { mockCalculateDirectoryHash, mockReadDirectory } = vi.hoisted(() => ({
  mockCalculateDirectoryHash: vi.fn(),
  mockReadDirectory: vi.fn(),
}));

vi.mock('../../src/utils/files', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  readFile: vi.fn().mockResolvedValue('content'),
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
