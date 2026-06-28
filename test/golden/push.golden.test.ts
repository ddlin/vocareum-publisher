// test/golden/push.golden.test.ts
//
// Characterization (golden) tests for the `push` command (publishCommand).
// These tests capture the CURRENT behaviour of the unrefactored code;
// they are the regression net that service-layer refactoring must keep green.
//
// Cases:
//   (a) changed  — content hash differs from publish_history → PUT occurs
//   (b) cancel   — user declines confirm prompt → no PUT
//   (c) failure  — PUT throws → failure appears in output, run does not throw

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── output capture ────────────────────────────────────────────────────────────
const out: string[] = [];
const err: string[] = [];

// ── logger mock (same pattern as status.golden.test.ts) ──────────────────────
vi.mock('../../src/utils/logger', () => {
  const o = (s: unknown = '') => out.push(String(s));
  const e = (s: unknown = '') => err.push(String(s));
  return {
    logger: {
      info: o,
      success: o,
      plain: o,
      newline: () => out.push(''),
      warn: e,
      error: e,
      debug: vi.fn(),
    },
  };
});

// ── env mock ──────────────────────────────────────────────────────────────────
vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: vi.fn(),
  isCI: vi.fn().mockReturnValue(false), // non-CI so confirm prompt fires
  getApiKeyOrThrow: vi.fn().mockReturnValue('test-api-key'),
  getOAuthClientId: vi.fn().mockReturnValue(undefined),
  getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
  getAuthModeEnv: vi.fn().mockReturnValue(undefined),
  getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
  getOAuthTokenUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3/oauth/token'),
}));

// ── config mock ───────────────────────────────────────────────────────────────
vi.mock('../../src/core/config', () => ({
  loadConfig: vi.fn(),
  updateConfig: vi.fn().mockResolvedValue(undefined),
  withConfigLock: vi.fn((_path: string, fn: () => Promise<unknown>) => fn()),
}));

// ── files mock (controls hash comparison and local directory reads) ────────────
// Must use vi.hoisted so the fns are available inside the vi.mock factory.
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

// ── git mock ──────────────────────────────────────────────────────────────────
vi.mock('../../src/utils/git', () => ({
  getCommitSha: vi.fn().mockResolvedValue('abc1234abc1234abc1234abc1234abc1234abc1234'),
  getGitUserName: vi.fn().mockResolvedValue('test-user'),
  commitChanges: vi.fn().mockResolvedValue(undefined),
}));

// ── prompts mock ──────────────────────────────────────────────────────────────
const { mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptConfirm: vi.fn(),
}));
vi.mock('../../src/utils/prompts', () => ({
  promptConfirm: mockPromptConfirm,
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
import { publishCommand } from '../../src/commands/publish';
import { loadConfig } from '../../src/core/config';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Normalise volatile values so snapshots are deterministic */
function norm(lines: string[]): string {
  return lines
    .join('\n')
    .replace(new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<cwd>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b[0-9a-f]{7,39}\b/g, '<sha>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>');
}

// ── shared config fixture ──────────────────────────────────────────────────────
// Assignment with a known ID + one part with a known ID.
// The assignment path 'assignment1/part1' is relative to process.cwd() which is
// always inside itself (confined), so no path-security issues.
import type { Config } from '../../src/types/config';

const ASSIGNMENT_ID = 'asn-golden-1';
const PART_ID = 'part-golden-1';
const COURSE_ID = 'course-golden-1';
const STALE_DIR_HASH = 'aaaa1111';
const NEW_DIR_HASH = 'bbbb2222';

const mockConfig: Config = {
  vocareum: {
    course_id: COURSE_ID,
    api_base_url: 'https://api.vocareum.com',
    org_id: 'org-golden-1',
  },
  assignments: [
    {
      path: 'assignment1',
      name: 'Assignment Golden',
      assignment_id: ASSIGNMENT_ID,
      parts: [
        {
          path: 'part1',
          name: 'Part Golden',
          part_id: PART_ID,
          directories: ['startercode'],
        },
      ],
    },
  ],
  // publish_history with a different hash so the directory looks changed
  publish_history: [
    {
      timestamp: '2025-01-01T00:00:00.000Z',
      commit_sha: 'deadbeef',
      published_by: 'prev-user',
      status: 'success',
      content_state: {
        'assignment1/part1/startercode': STALE_DIR_HASH,
      },
    },
  ],
};

// API response shapes (mirrored from test/integration/publish.test.ts)
const courseResponse = {
  courses: [{ id: COURSE_ID, name: 'Golden Course', org_id: 'org-golden-1' }],
};
const assignmentsListResponse = {
  assignments: [{ id: ASSIGNMENT_ID, name: 'Assignment Golden', nosubmit: false }],
  total_records: '1',
};
const fullAssignmentResponse = {
  assignments: [{ id: ASSIGNMENT_ID, name: 'Assignment Golden', nosubmit: false }],
};
const partsListResponse = {
  parts: [{ id: PART_ID, name: 'Part Golden', seqnum: '1', deleted: '0' }],
};
// getPart response (called by reconciler when shouldSyncPartSettings = true)
const getPartResponse = {
  parts: [{ id: PART_ID, name: 'Part Golden', seqnum: '1', deleted: '0' }],
};
// PUT response for content upload (no transaction polling needed)
const putSuccessResponse = { status: 'success', state: 'success' };
// PUT failure response — triggers the APIError branch in uploadContent
const putFailureResponse = { status: 'error', state: 'error', message: 'Upload failed: server error' };

// Command options shared across cases
const CMD_OPTS = {
  config: 'vocareum.yaml',
  root: '.',
  nonInteractive: false, // allow prompt
  dryRun: false,
  verbose: false,
};

// ─────────────────────────────────────────────────────────────────────────────
describe('golden: push', () => {
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    vi.mocked(loadConfig).mockResolvedValue(mockConfig);
    mockPromptConfirm.mockResolvedValue(true); // default: user confirms
    // New hash ≠ stale hash → content changed
    mockCalculateDirectoryHash.mockResolvedValue(NEW_DIR_HASH);
    // readDirectory returns one file for the upload
    mockReadDirectory.mockResolvedValue({ 'hello.txt': Buffer.from('hello') });
    recorder = new RecordingClient();
  });

  // ── (a) CHANGED push ────────────────────────────────────────────────────────
  it('(a) changed: sequence contains PUT and snapshot is stable', async () => {
    // Enqueue responses in call order:
    // 1. getCourse
    recorder.enqueue(courseResponse);
    // 2. listAssignments (page 0)
    recorder.enqueue(assignmentsListResponse);
    // 3. getAssignment (reconciler — full details for settings compare)
    recorder.enqueue(fullAssignmentResponse);
    // 4. listParts
    recorder.enqueue(partsListResponse);
    // 5. getPart (reconciler settings sync check — shouldSyncPartSettings defaults true)
    recorder.enqueue(getPartResponse);
    // 6. PUT content upload
    recorder.enqueue(putSuccessResponse);

    await publishCommand({ ...CMD_OPTS });

    const sequence = recorder.sequence();
    expect(sequence.some((s) => s.startsWith('PUT'))).toBe(true);
    expect({ sequence, output: norm(out), errors: norm(err) }).toMatchSnapshot();
  });

  // ── (b) CANCEL ──────────────────────────────────────────────────────────────
  it('(b) cancel: no PUT when user declines', async () => {
    mockPromptConfirm.mockResolvedValue(false); // user says no

    // Enqueue responses up through reconcile (no PUT needed)
    recorder.enqueue(courseResponse);
    recorder.enqueue(assignmentsListResponse);
    recorder.enqueue(fullAssignmentResponse);
    recorder.enqueue(partsListResponse);
    // getPart for settings sync
    recorder.enqueue(getPartResponse);

    await publishCommand({ ...CMD_OPTS });

    const sequence = recorder.sequence();
    expect(sequence.some((s) => s.startsWith('PUT'))).toBe(false);
    expect({ sequence, output: norm(out), errors: norm(err) }).toMatchSnapshot();
  });

  // ── (c) FAILURE ─────────────────────────────────────────────────────────────
  it('(c) failure: upload error is recorded and run does not throw', async () => {
    recorder.enqueue(courseResponse);
    recorder.enqueue(assignmentsListResponse);
    recorder.enqueue(fullAssignmentResponse);
    recorder.enqueue(partsListResponse);
    // getPart for settings sync
    recorder.enqueue(getPartResponse);
    // Enqueue the failure response for the PUT call (triggers APIError in uploadContent)
    recorder.enqueue(putFailureResponse);

    // publishCommand throws 'Push completed with errors' on failure;
    // we catch it so the test does not fail.
    let caughtError: unknown = null;
    try {
      await publishCommand({ ...CMD_OPTS });
    } catch (e) {
      caughtError = e;
    }

    const allOutput = norm([...out, ...err]);
    // The failure must be surfaced somewhere in the combined output
    expect(allOutput).toMatch(/[Ff]ailed|[Ee]rror/);
    expect({ sequence: recorder.sequence(), output: norm(out), errors: norm(err), threw: caughtError instanceof Error ? caughtError.message : null }).toMatchSnapshot();
  });
});
