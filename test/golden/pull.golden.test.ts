// test/golden/pull.golden.test.ts
//
// Characterization (golden) tests for the `pull` command.
// These tests capture the CURRENT behaviour of the unrefactored code;
// they are the regression net that service-layer refactoring must keep green.
//
// Cases:
//   (a) INTERACTIVE ORDERING — two orphans; proves prompt-then-immediately-import
//       ordering via a shared event log: [prompt#1, import#1, prompt#2, import#2].
//       This is the contract P0 task #4 (split resolver) must preserve.
//   (b) BATCH MODE — pull --batch with two orphans; snapshot { sequence, output }.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── output capture ────────────────────────────────────────────────────────────
const out: string[] = [];
const err: string[] = [];

// ── logger mock (same pattern as status/push golden tests) ───────────────────
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
  isCI: vi.fn().mockReturnValue(false),
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

// ── files mock ────────────────────────────────────────────────────────────────
vi.mock('../../src/utils/files', () => ({
  pathExists: vi.fn().mockResolvedValue(false),
  readFile: vi.fn().mockResolvedValue('content'),
  ensureDirectory: vi.fn().mockResolvedValue(undefined),
  readDirectory: vi.fn().mockResolvedValue({}),
  readLocalDirectory: vi.fn().mockResolvedValue({}),
  writeFile: vi.fn().mockResolvedValue(undefined),
  writeFileUnderBase: vi.fn().mockResolvedValue(undefined),
  calculateDirectoryHash: vi.fn().mockResolvedValue('hash-abc123'),
  validatePath: vi.fn(),
}));

// ── git mock ──────────────────────────────────────────────────────────────────
vi.mock('../../src/utils/git', () => ({
  getCommitSha: vi.fn().mockResolvedValue('abc1234abc1234abc1234abc1234abc1234abc1234'),
  getGitUserName: vi.fn().mockResolvedValue('test-user'),
  commitChanges: vi.fn().mockResolvedValue(undefined),
}));

// ── prompts mock (hoisted so we can access in tests) ─────────────────────────
const { mockPromptChoice, mockPrompt } = vi.hoisted(() => ({
  mockPromptChoice: vi.fn(),
  mockPrompt: vi.fn(),
}));

vi.mock('../../src/utils/prompts', () => ({
  promptConfirm: vi.fn().mockResolvedValue(true),
  promptChoice: mockPromptChoice,
  prompt: mockPrompt,
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
import { pullCommand } from '../../src/commands/pull';
import { loadConfig } from '../../src/core/config';
import type { Config } from '../../src/types/config';

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

// ── shared fixtures ───────────────────────────────────────────────────────────

const COURSE_ID = 'course-pull-golden';
const ORG_ID = 'org-pull-golden';

/** Empty local config → all remote assignments become orphans */
const mockConfig: Config = {
  vocareum: {
    course_id: COURSE_ID,
    api_base_url: 'https://api.vocareum.com',
    org_id: ORG_ID,
  },
  assignments: [],
};

const courseResponse = {
  courses: [{ id: COURSE_ID, name: 'Pull Golden Course', org_id: ORG_ID }],
};

// Two orphaned assignments on Vocareum
const listAssignmentsResponse = {
  assignments: [
    { id: 'asn-orphan-1', name: 'Orphan Alpha' },
    { id: 'asn-orphan-2', name: 'Orphan Beta' },
  ],
};

// Full assignment details (returned by getAssignment per orphan)
const fullOrphan1 = {
  assignments: [{ id: 'asn-orphan-1', name: 'Orphan Alpha', nosubmit: false }],
};
const fullOrphan2 = {
  assignments: [{ id: 'asn-orphan-2', name: 'Orphan Beta', nosubmit: false }],
};

// One part per orphan
const partsOrphan1 = {
  parts: [{ id: 'part-alpha-1', name: 'Part 1', seqnum: '1', deleted: '0' }],
};
const partsOrphan2 = {
  parts: [{ id: 'part-beta-1', name: 'Part 1', seqnum: '1', deleted: '0' }],
};

// Full part details (returned by getPart)
const fullPartAlpha1 = {
  parts: [{ id: 'part-alpha-1', name: 'Part 1', seqnum: '1', deleted: '0', submission_filters: {} }],
};
const fullPartBeta1 = {
  parts: [{ id: 'part-beta-1', name: 'Part 1', seqnum: '1', deleted: '0', submission_filters: {} }],
};

// File listing for each directory: empty (no files to download)
// downloadContent calls listFilesByApiPath for each of 7 DEFAULT_PART_DIRECTORIES.
// Returning an empty list means no files to download (avoids extra file-fetch calls).
const emptyFileList = { files: [] };

/**
 * Enqueue the responses for one orphan's importAssignment call.
 * Sequence: getAssignment, listParts, getPart, then 7x listFiles (one per DEFAULT_PART_DIRECTORY).
 */
function enqueueImportOrphan(
  rec: RecordingClient,
  fullAssignment: unknown,
  parts: unknown,
  fullPart: unknown
): void {
  rec.enqueue(fullAssignment); // getAssignment
  rec.enqueue(parts);          // listParts
  rec.enqueue(fullPart);       // getPart (for part[0])
  // downloadContent: listFilesByApiPath for 7 DEFAULT_PART_DIRECTORIES
  // startercode, scripts, docs, data, private, lib, asnlib
  for (let i = 0; i < 7; i++) {
    rec.enqueue(emptyFileList);
  }
}

// ── CMD_OPTS shared ───────────────────────────────────────────────────────────
const CMD_OPTS_BASE = {
  config: 'vocareum.yaml',
  root: '.',
  verbose: false,
};

// ─────────────────────────────────────────────────────────────────────────────
describe('golden: pull', () => {
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    vi.mocked(loadConfig).mockResolvedValue(mockConfig);
    recorder = new RecordingClient();
    // Reset prompt mocks to neutral defaults
    mockPromptChoice.mockReset();
    mockPrompt.mockReset();
  });

  // ── (a) INTERACTIVE ORDERING ────────────────────────────────────────────────
  //
  // Contract: for two orphans, the pull command prompts for orphan#1, then
  // immediately imports it, THEN prompts for orphan#2, then imports it.
  //
  // Event log must be: [prompt#1, import#1, prompt#2, import#2].
  //
  // This is the P0 #4 (split resolver) contract: a later refactor must
  // preserve this interleaving — the test is the proof that today's code
  // does prompt-then-immediately-import (not batch-prompt-then-batch-import).
  it('(a) interactive: prompts and imports interleave [prompt#1, import#1, prompt#2, import#2]', async () => {
    const events: string[] = [];

    // ── Reconcile calls: getCourse + listAssignments (no local assignments) ──
    recorder.enqueue(courseResponse);
    recorder.enqueue(listAssignmentsResponse);

    // ── importAssignment for orphan 1 ─────────────────────────────────────────
    enqueueImportOrphan(recorder, fullOrphan1, partsOrphan1, fullPartAlpha1);
    // ── importAssignment for orphan 2 ─────────────────────────────────────────
    enqueueImportOrphan(recorder, fullOrphan2, partsOrphan2, fullPartBeta1);

    // ── Prompts push to events array ──────────────────────────────────────────
    //
    // Prompt call order per orphan in pull.ts:
    //   1. promptChoice (what to do?) → user selects 'Import to local repository'
    //   2. prompt (directory name?) → returns suggested name
    //
    // We push ONE event per orphan (the promptChoice call) since that's the
    // key synchronization point that tells us the loop has started orphan#N.
    let promptCallCount = 0;
    mockPromptChoice.mockImplementation(async (_question: string, _choices: string[]) => {
      promptCallCount++;
      events.push(`prompt#${promptCallCount}`);
      return 'Import to local repository';
    });

    // mockPrompt handles the directory name prompt (after promptChoice)
    mockPrompt.mockResolvedValue('orphan-dir');

    // ── Instrument the VocareumClient to push import markers ─────────────────
    //
    // importAssignment's FIRST API call is getAssignment. We intercept the
    // recorder.request method to push an import marker the first time each
    // orphan's getAssignment fires inside the orphan loop.
    //
    // After reconcile finishes (getCourse + listAssignments = 2 calls),
    // the next request per orphan is getAssignment.
    let importCallCount = 0;
    const originalRequest = recorder.request.bind(recorder);
    recorder.request = async function <T = unknown>(config: { method: string; url: string }): Promise<T> {
      // getAssignment for an orphan: URL ends with /assignments/<orphan-id> (no trailing path).
      // This distinguishes getAssignment from listParts (/parts) and getPart (/parts/<id>).
      // Matches: /courses/.../assignments/asn-orphan-1
      // Does NOT match: /courses/.../assignments/asn-orphan-1/parts/...
      const orphanGetAssignmentPattern = /\/assignments\/asn-orphan-[^/]+$/;
      if (config.method === 'GET' && orphanGetAssignmentPattern.test(config.url)) {
        importCallCount++;
        events.push(`import#${importCallCount}`);
      }
      return originalRequest(config);
    };

    await pullCommand({
      ...CMD_OPTS_BASE,
      nonInteractive: false,
    });

    // ── The core ordering assertion ───────────────────────────────────────────
    // Today's code processes orphans one-at-a-time: prompt → import → prompt → import.
    // This is the P0 #4 contract.
    expect(events).toEqual(['prompt#1', 'import#1', 'prompt#2', 'import#2']);

    // Snapshot the full output for regression detection
    expect({ output: norm(out), errors: norm(err) }).toMatchSnapshot();
  });

  // ── (b) BATCH MODE ─────────────────────────────────────────────────────────
  it('(b) batch: --batch imports both orphans without prompting', async () => {
    // ── Reconcile calls: getCourse + listAssignments ──────────────────────────
    recorder.enqueue(courseResponse);
    recorder.enqueue(listAssignmentsResponse);

    // ── importAssignment for orphan 1 ─────────────────────────────────────────
    enqueueImportOrphan(recorder, fullOrphan1, partsOrphan1, fullPartAlpha1);
    // ── importAssignment for orphan 2 ─────────────────────────────────────────
    enqueueImportOrphan(recorder, fullOrphan2, partsOrphan2, fullPartBeta1);

    // Prompts must NOT be called in batch mode
    mockPromptChoice.mockImplementation(async () => {
      throw new Error('promptChoice should not be called in batch mode');
    });
    mockPrompt.mockImplementation(async () => {
      throw new Error('prompt should not be called in batch mode');
    });

    await pullCommand({
      ...CMD_OPTS_BASE,
      batch: true,
    });

    // Verify no prompts were called
    expect(mockPromptChoice).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();

    const sequence = recorder.sequence();
    expect({ sequence, output: norm(out), errors: norm(err) }).toMatchSnapshot();
  });
});
