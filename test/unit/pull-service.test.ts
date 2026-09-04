/**
 * Unit tests for pull-service.ts — applyPull resolver contract
 *
 * These tests exercise the per-item resolver dispatch inside applyPull using a
 * STUB resolver (no real prompts) and a stub LockedSession that records calls to
 * applyConfigUpdate. importAssignment's low-level I/O dependencies (assignments
 * API, parts API, content API, files, git, local-scan) are all mocked so the
 * test runs without touching the filesystem or network.
 *
 * Test cases:
 *   1. "import first, skip rest" — two orphans; stub resolver returns 'import'
 *      for index 0 and 'skip' for index 1. Asserts: (a) applyConfigUpdate is
 *      called once with a new assignment for the first orphan, (b)
 *      resolveImportPath was called with the computed suggested path, (c) the
 *      second orphan is counted as skipped (not imported).
 *
 *   2. "inspectPull is read-only" — drives inspectPull via a RecordingClient
 *      (reconcile + empty lists) and asserts that applyConfigUpdate is NOT called
 *      during inspection (no writes), and that the stub resolver methods are
 *      never invoked (no prompts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── hoisted mock functions (must be declared before vi.mock factories) ────────
const {
  mockReconcile,
  mockGetAssignment,
  mockListParts,
  mockGetPart,
  mockDownloadContent,
  mockListRubrics,
} = vi.hoisted(() => ({
  mockReconcile: vi.fn(),
  mockGetAssignment: vi.fn(),
  mockListParts: vi.fn(),
  mockGetPart: vi.fn(),
  mockDownloadContent: vi.fn(),
  mockListRubrics: vi.fn(),
}));

// ── mock local-scan (assertConfinedToWorkspace) ────────────────────────────────
vi.mock('../../src/core/local-scan', () => ({
  assertConfinedToWorkspace: vi.fn().mockResolvedValue(undefined),
}));

// ── mock reconciler (used by inspectPull) ──────────────────────────────────────
vi.mock('../../src/core/reconciler', () => ({
  reconcile: mockReconcile,
}));

// ── mock assignments API ───────────────────────────────────────────────────────
vi.mock('../../src/api/assignments', () => ({
  getAssignment: mockGetAssignment,
}));

// ── mock parts API ─────────────────────────────────────────────────────────────
vi.mock('../../src/api/parts', () => ({
  listParts: mockListParts,
  getPart: mockGetPart,
}));

// ── mock content API ───────────────────────────────────────────────────────────
vi.mock('../../src/api/content', () => ({
  downloadContent: mockDownloadContent,
}));

// ── mock rubrics API ───────────────────────────────────────────────────────────
vi.mock('../../src/api/rubrics', () => ({
  listRubrics: mockListRubrics,
}));

// ── mock files utilities ───────────────────────────────────────────────────────
vi.mock('../../src/utils/files', () => ({
  pathExists: vi.fn().mockResolvedValue(false),
  ensureDirectory: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  writeFileUnderBase: vi.fn().mockResolvedValue(undefined),
  calculateDirectoryHash: vi.fn().mockResolvedValue('hash-abc123'),
  validatePath: vi.fn(),
  readDirectory: vi.fn().mockResolvedValue({}),
}));

// ── mock path-security (used in content drift path; not exercised here but imported) ──
vi.mock('../../src/utils/path-security', () => ({
  isPathConfinedToBase: vi.fn().mockResolvedValue(true),
}));

// ── mock git utilities ─────────────────────────────────────────────────────────
vi.mock('../../src/utils/git', () => ({
  getCommitSha: vi.fn().mockResolvedValue('abc1234abc1234abc1234abc1234abc1234abc1234'),
  getGitUserName: vi.fn().mockResolvedValue('test-user'),
}));

// ── mock settings utilities ────────────────────────────────────────────────────
vi.mock('../../src/utils/settings', () => ({
  mapAssignmentSettings: vi.fn().mockReturnValue({}),
  mapPartSettings: vi.fn().mockReturnValue({}),
}));

// ── imports (after mocks) ──────────────────────────────────────────────────────
import { inspectPull, applyPull } from '../../src/core/services/pull-service';
import type {
  PullResolver,
  PullInspection,
  PullIssueOrphan,
  PullIssueStale,
  PullIssueSettingsDrift,
  PullIssueContentDrift,
  OrphanAction,
  StaleAction,
  SettingsDriftAction,
  ContentDriftAction,
} from '../../src/core/services/pull-service';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { PullContext } from '../../src/core/services/context';
import type { PullRequest } from '../../src/core/services/types';
import type { LockedSession } from '../../src/core/session';
import type { OrphanedEntity } from '../../src/types/state';
import type { Config, ConfigUpdates, Rubric } from '../../src/types/config';
import type { VocareumRubricResponse } from '../../src/types/api';
import { mapPartSettings } from '../../src/utils/settings';
import { ForbiddenError } from '../../src/api/client';

// ── Shared fixtures ────────────────────────────────────────────────────────────

const COURSE_ID = 'course-unit-test';
const ORG_ID = 'org-unit-test';
const WORKSPACE_ROOT = '/tmp/vocgit-unit-test';

const BASE_CONFIG: Config = {
  vocareum: {
    course_id: COURSE_ID,
    api_base_url: 'https://api.vocareum.com',
    org_id: ORG_ID,
  },
  assignments: [],
};

/** Build a minimal PullContext with the given config, stub client, and fresh EventSink */
function makeCtx(
  config: Config = BASE_CONFIG,
  client: { request: ReturnType<typeof vi.fn> } = { request: vi.fn() }
): { ctx: PullContext; events: CollectingEventSink } {
  const events = new CollectingEventSink();
  const ctx: PullContext = {
    persistedConfig: config,
    effectiveConfig: config,
    configPath: `${WORKSPACE_ROOT}/vocareum.yaml`,
    workspaceRoot: WORKSPACE_ROOT,
    events,
    prompter: new NonInteractivePrompter(),
    client: client as never,
  };
  return { ctx, events };
}

/** Build a stub LockedSession that records applyConfigUpdate calls */
function makeSession(): { session: LockedSession; applyConfigUpdate: ReturnType<typeof vi.fn> } {
  const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
  const session: LockedSession = { applyConfigUpdate };
  return { session, applyConfigUpdate };
}

/**
 * Build a minimal stub PullResolver. All methods default to safe no-ops;
 * override individual methods per test.
 */
function makeStubResolver(overrides: Partial<PullResolver> = {}): PullResolver & {
  resolveOrphanAction: ReturnType<typeof vi.fn>;
  resolveStaleAction: ReturnType<typeof vi.fn>;
  resolveSettingsDriftAction: ReturnType<typeof vi.fn>;
  resolveContentDriftAction: ReturnType<typeof vi.fn>;
  resolveImportPath: ReturnType<typeof vi.fn>;
} {
  return {
    resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>().mockResolvedValue('skip'),
    resolveStaleAction: vi.fn<[PullIssueStale], Promise<StaleAction>>().mockResolvedValue('skip'),
    resolveSettingsDriftAction: vi.fn<[PullIssueSettingsDrift], Promise<SettingsDriftAction>>().mockResolvedValue('skip'),
    resolveContentDriftAction: vi.fn<[PullIssueContentDrift], Promise<ContentDriftAction>>().mockResolvedValue('skip'),
    resolveImportPath: vi.fn<[PullIssueOrphan, string], Promise<string>>().mockImplementation(
      (_issue, suggested) => Promise.resolve(suggested)
    ),
    ...overrides,
  };
}

/** Two orphaned entities for use across tests */
const ORPHAN_1: OrphanedEntity = {
  type: 'assignment',
  id: 'asn-orphan-1',
  name: 'Orphan Alpha',
  message: 'exists in Vocareum but not in config',
};
const ORPHAN_2: OrphanedEntity = {
  type: 'assignment',
  id: 'asn-orphan-2',
  name: 'Orphan Beta',
  message: 'exists in Vocareum but not in config',
};

/** Pre-built PullInspection with two orphans, no stale/drift */
const INSPECTION_TWO_ORPHANS: PullInspection = {
  orphans: [ORPHAN_1, ORPHAN_2],
  stale: [],
  settingsDrift: [],
  contentDrift: [],
};

/** API response shapes expected by importAssignment */
function enqueueImportResponses(client: { request: ReturnType<typeof vi.fn> }): void {
  // getAssignment
  mockGetAssignment.mockResolvedValueOnce({
    assignments: [{ id: ORPHAN_1.id, name: ORPHAN_1.name, nosubmit: false }],
  });
  // listParts
  mockListParts.mockResolvedValueOnce([
    { id: 'part-alpha-1', name: 'Part 1', seqnum: '1', deleted: '0' },
  ]);
  // getPart
  mockGetPart.mockResolvedValueOnce({
    parts: [{ id: 'part-alpha-1', name: 'Part 1', seqnum: '1', deleted: '0', submission_filters: {} }],
  });
  // downloadContent — return empty file map (no actual files to write)
  mockDownloadContent.mockResolvedValueOnce({});
  // suppress unused parameter warning
  void client;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('applyPull resolver contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default reconcile mock (used only in inspectPull tests)
    mockReconcile.mockResolvedValue({
      config: BASE_CONFIG,
      course: { type: 'skip' },
      assignments: [],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 0,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 0,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    });
  });

  // ── Test 1: import first orphan, skip second ─────────────────────────────────
  describe('import first orphan, skip second', () => {
    it('calls applyConfigUpdate with the imported assignment', async () => {
      const { ctx } = makeCtx();
      const { session, applyConfigUpdate } = makeSession();
      const clientMock = { request: vi.fn() };
      (ctx as PullContext & { client: typeof clientMock }).client = clientMock as never;

      // Enqueue API responses for importAssignment (only first orphan is imported)
      enqueueImportResponses(clientMock);

      const resolver = makeStubResolver({
        resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>()
          .mockImplementation(async (issue) => {
            // import first orphan (index 0), skip all others
            return issue.index === 0 ? 'import' : 'skip';
          }),
        // resolveImportPath echoes the suggested path (default implementation above)
      });

      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      const result = await applyPull(session, ctx, req, INSPECTION_TWO_ORPHANS, resolver);

      // (a) Only the first orphan was imported, second was skipped
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);

      // (c) applyConfigUpdate was called exactly once (to persist the new assignment)
      expect(applyConfigUpdate).toHaveBeenCalledTimes(1);

      // The update must include a new assignment for ORPHAN_1's directory
      const updateCall = applyConfigUpdate.mock.calls[0][0] as {
        assignments?: Array<{ assignment_id?: string }>;
      };
      expect(updateCall.assignments).toBeDefined();
      expect(updateCall.assignments!.length).toBeGreaterThanOrEqual(1);
      const importedAsn = updateCall.assignments!.find(
        (a) => a.assignment_id === ORPHAN_1.id
      );
      expect(importedAsn).toBeDefined();
    });

    it('calls resolveImportPath with the computed suggested path', async () => {
      const { ctx } = makeCtx();
      const { session } = makeSession();
      const clientMock = { request: vi.fn() };
      (ctx as PullContext & { client: typeof clientMock }).client = clientMock as never;

      enqueueImportResponses(clientMock);

      const resolveImportPath = vi.fn<[PullIssueOrphan, string], Promise<string>>()
        .mockImplementation((_issue, suggested) => Promise.resolve(suggested));

      const resolver = makeStubResolver({
        resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>()
          .mockImplementation(async (issue) => (issue.index === 0 ? 'import' : 'skip')),
        resolveImportPath,
      });

      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      await applyPull(session, ctx, req, INSPECTION_TWO_ORPHANS, resolver);

      // (b) resolveImportPath was called once (for the first orphan)
      expect(resolveImportPath).toHaveBeenCalledTimes(1);

      // The suggested path must be a slugified form of the orphan's name
      const [_issuePassed, suggestedPath] = resolveImportPath.mock.calls[0] as [PullIssueOrphan, string];
      // slugify('Orphan Alpha') === 'orphan-alpha'
      expect(suggestedPath).toBe('orphan-alpha');
    });

    it('does NOT call resolveImportPath for the skipped (second) orphan', async () => {
      const { ctx } = makeCtx();
      const { session } = makeSession();
      const clientMock = { request: vi.fn() };
      (ctx as PullContext & { client: typeof clientMock }).client = clientMock as never;

      enqueueImportResponses(clientMock);

      const resolveImportPath = vi.fn<[PullIssueOrphan, string], Promise<string>>()
        .mockImplementation((_issue, suggested) => Promise.resolve(suggested));

      const resolver = makeStubResolver({
        resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>()
          .mockImplementation(async (issue) => (issue.index === 0 ? 'import' : 'skip')),
        resolveImportPath,
      });

      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      await applyPull(session, ctx, req, INSPECTION_TWO_ORPHANS, resolver);

      // resolveImportPath called exactly once — only for index 0
      expect(resolveImportPath).toHaveBeenCalledTimes(1);
      const issuePassed = resolveImportPath.mock.calls[0][0] as PullIssueOrphan;
      expect(issuePassed.index).toBe(0);
      expect(issuePassed.orphan.id).toBe(ORPHAN_1.id);
    });
  });

  // ── Test 2: all-skip resolver ─────────────────────────────────────────────────
  describe('all-skip resolver', () => {
    it('does not call applyConfigUpdate when every orphan is skipped', async () => {
      const { ctx } = makeCtx();
      const { session, applyConfigUpdate } = makeSession();

      const resolver = makeStubResolver();   // defaults to 'skip' for everything

      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      const result = await applyPull(session, ctx, req, INSPECTION_TWO_ORPHANS, resolver);

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);
      expect(applyConfigUpdate).not.toHaveBeenCalled();
    });

    it('never calls resolveImportPath when action is skip', async () => {
      const { ctx } = makeCtx();
      const { session } = makeSession();

      const resolver = makeStubResolver();
      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      await applyPull(session, ctx, req, INSPECTION_TWO_ORPHANS, resolver);

      expect(resolver.resolveImportPath).not.toHaveBeenCalled();
    });
  });

  // ── Test 3: batch mode skips resolveImportPath ────────────────────────────────
  describe('batch mode (req.batch = true)', () => {
    it('uses the suggested path directly without calling resolveImportPath', async () => {
      const { ctx } = makeCtx();
      const { session, applyConfigUpdate } = makeSession();
      const clientMock = { request: vi.fn() };
      (ctx as PullContext & { client: typeof clientMock }).client = clientMock as never;

      // Enqueue import responses for BOTH orphans (batch imports all)
      enqueueImportResponses(clientMock);
      // Enqueue a second set for orphan 2
      mockGetAssignment.mockResolvedValueOnce({
        assignments: [{ id: ORPHAN_2.id, name: ORPHAN_2.name, nosubmit: false }],
      });
      mockListParts.mockResolvedValueOnce([
        { id: 'part-beta-1', name: 'Part 1', seqnum: '1', deleted: '0' },
      ]);
      mockGetPart.mockResolvedValueOnce({
        parts: [{ id: 'part-beta-1', name: 'Part 1', seqnum: '1', deleted: '0', submission_filters: {} }],
      });
      mockDownloadContent.mockResolvedValueOnce({});

      const resolver = makeStubResolver({
        // batch=true means applyPull doesn't call resolveImportPath;
        // resolver still needs to return 'import' for both
        resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>()
          .mockResolvedValue('import'),
      });

      const req: PullRequest = { batch: true, verbose: false, skipContent: false };
      const result = await applyPull(session, ctx, req, INSPECTION_TWO_ORPHANS, resolver);

      expect(result.imported).toBe(2);
      // resolveImportPath must NOT be called in batch mode
      expect(resolver.resolveImportPath).not.toHaveBeenCalled();
      // Config must have been written
      expect(applyConfigUpdate).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 4: empty inspection ──────────────────────────────────────────────────
  describe('empty inspection', () => {
    it('does not call applyConfigUpdate or any resolver method', async () => {
      const { ctx } = makeCtx();
      const { session, applyConfigUpdate } = makeSession();
      const resolver = makeStubResolver();

      const emptyInspection: PullInspection = {
        orphans: [],
        stale: [],
        settingsDrift: [],
        contentDrift: [],
      };

      const req: PullRequest = { batch: false, verbose: false, skipContent: false };
      const result = await applyPull(session, ctx, req, emptyInspection, resolver);

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(0);
      expect(applyConfigUpdate).not.toHaveBeenCalled();
      expect(resolver.resolveOrphanAction).not.toHaveBeenCalled();
      expect(resolver.resolveImportPath).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('inspectPull is read-only (no writes, no prompts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not call applyConfigUpdate during inspectPull', async () => {
    const { session, applyConfigUpdate } = makeSession();
    const { ctx } = makeCtx();

    // reconcile returns empty — no orphans, no stale
    mockReconcile.mockResolvedValue({
      config: BASE_CONFIG,
      course: { type: 'skip' },
      assignments: [],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 0,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 0,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    });

    const req: PullRequest = { batch: false, verbose: false, skipContent: false, content: false };
    const inspection = await inspectPull(ctx, req);

    // inspect returns a PullInspection shape
    expect(inspection).toHaveProperty('orphans');
    expect(inspection).toHaveProperty('stale');
    expect(inspection).toHaveProperty('settingsDrift');
    expect(inspection).toHaveProperty('contentDrift');

    // inspectPull does NO writes — applyConfigUpdate must never be called
    expect(applyConfigUpdate).not.toHaveBeenCalled();

    // suppress unused warning
    void session;
  });

  it('does not invoke any resolver method during inspectPull', async () => {
    const { ctx } = makeCtx();
    const resolver = makeStubResolver();

    mockReconcile.mockResolvedValue({
      config: BASE_CONFIG,
      course: { type: 'skip' },
      assignments: [],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 0,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 0,
      },
      orphanedInVocareum: [ORPHAN_1, ORPHAN_2],  // orphans present but inspect never calls resolver
      staleInConfig: [],
    });

    const req: PullRequest = { batch: false, verbose: false, skipContent: false, content: false };
    await inspectPull(ctx, req);

    // inspectPull only detects issues — it must NOT call any resolver method
    expect(resolver.resolveOrphanAction).not.toHaveBeenCalled();
    expect(resolver.resolveStaleAction).not.toHaveBeenCalled();
    expect(resolver.resolveSettingsDriftAction).not.toHaveBeenCalled();
    expect(resolver.resolveContentDriftAction).not.toHaveBeenCalled();
    expect(resolver.resolveImportPath).not.toHaveBeenCalled();
  });

  it('returns the orphans detected by reconcile without acting on them', async () => {
    const { ctx } = makeCtx();

    mockReconcile.mockResolvedValue({
      config: BASE_CONFIG,
      course: { type: 'skip' },
      assignments: [],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 0,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 0,
      },
      orphanedInVocareum: [ORPHAN_1, ORPHAN_2],
      staleInConfig: [],
    });

    const req: PullRequest = { batch: false, verbose: false, skipContent: false, content: false };
    const inspection = await inspectPull(ctx, req);

    expect(inspection.orphans).toHaveLength(2);
    expect(inspection.orphans[0].id).toBe(ORPHAN_1.id);
    expect(inspection.orphans[1].id).toBe(ORPHAN_2.id);
    // No stale or drift detected
    expect(inspection.stale).toHaveLength(0);
    expect(inspection.settingsDrift).toHaveLength(0);
    expect(inspection.contentDrift).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── detectSettingsDrift — rubrics ──────────────────────────────────────────────

const RUBRIC_ASSIGNMENT_ID = 'asn-rubric-1';
const RUBRIC_PART_ID = 'part-rubric-1';

/** Default reconcile result: no orphans, no stale assignments. */
function emptyReconcileResult(config: Config): {
  config: Config;
  course: { type: 'skip' };
  assignments: [];
  summary: {
    coursesToUpdate: number;
    assignmentsToCreate: number;
    assignmentsToUpdate: number;
    assignmentsWithDiscoveredIds: number;
    assignmentsToSkip: number;
    partsToCreate: number;
    partsToUpdate: number;
    estimatedApiCalls: number;
  };
  orphanedInVocareum: [];
  staleInConfig: [];
} {
  return {
    config,
    course: { type: 'skip' },
    assignments: [],
    summary: {
      coursesToUpdate: 0,
      assignmentsToCreate: 0,
      assignmentsToUpdate: 0,
      assignmentsWithDiscoveredIds: 0,
      assignmentsToSkip: 0,
      partsToCreate: 0,
      partsToUpdate: 0,
      estimatedApiCalls: 0,
    },
    orphanedInVocareum: [],
    staleInConfig: [],
  };
}

interface RubricCtxOptions {
  /** Rubrics already in the config part. Default: none. */
  localRubrics?: Rubric[];
  /** Extra remote part settings, to test settings + rubric drift together. */
  remoteSessionLength?: string;
  /** Overrides merged into config.publish_options. Default: {}. */
  publishOptions?: { sync_settings?: boolean; sync_rubrics?: boolean };
}

/**
 * Local rubric baked into the config part when a test omits `opts` entirely
 * (as opposed to passing `{ localRubrics: undefined }`, which explicitly means
 * "no rubrics in config" — the `in` check below distinguishes the two).
 */
const DEFAULT_LOCAL_RUBRICS: Rubric[] = [
  { name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false },
];

/** Build a one-assignment, one-part config wired up for rubric-drift tests. */
function buildRubricConfig(opts: RubricCtxOptions): Config {
  const localRubrics = 'localRubrics' in opts ? opts.localRubrics : DEFAULT_LOCAL_RUBRICS;
  return {
    ...BASE_CONFIG,
    publish_options: opts.publishOptions,
    assignments: [
      {
        assignment_id: RUBRIC_ASSIGNMENT_ID,
        name: 'Rubric Assignment',
        path: 'rubric-assignment',
        create_from_template: false,
        settings: {},
        parts: [
          {
            part_id: RUBRIC_PART_ID,
            path: '.',
            name: 'A',
            settings: {},
            rubrics: localRubrics,
          },
        ],
      },
    ],
  } as Config;
}

/** Wire up mocks so the single assignment/part above is visited by detectSettingsDrift. */
function primeAssignmentAndPartMocks(config: Config, opts: RubricCtxOptions): void {
  mockReconcile.mockResolvedValue(emptyReconcileResult(config));
  mockGetAssignment.mockResolvedValueOnce({ id: RUBRIC_ASSIGNMENT_ID });
  mockListParts.mockResolvedValueOnce([{ id: RUBRIC_PART_ID, name: 'A', seqnum: '1', deleted: '0' }]);
  mockGetPart.mockResolvedValueOnce({ id: RUBRIC_PART_ID, name: 'A' });

  if (opts.remoteSessionLength !== undefined) {
    vi.mocked(mapPartSettings).mockReturnValueOnce({ session_length: opts.remoteSessionLength });
  }
}

/**
 * Build a PullContext with one assignment/part whose rubric fetch resolves to
 * `remoteRubrics` (raw API rows, as `listRubrics` would return them).
 */
function ctxWithRubrics(
  remoteRubrics: VocareumRubricResponse[],
  opts: RubricCtxOptions = {}
): PullContext {
  const config = buildRubricConfig(opts);
  primeAssignmentAndPartMocks(config, opts);
  mockListRubrics.mockResolvedValueOnce(remoteRubrics);
  return makeCtx(config).ctx;
}

/** Build a PullContext whose rubric fetch is rejected with a ForbiddenError. */
function ctxWithForbiddenRubrics(opts: RubricCtxOptions = {}): PullContext {
  const config = buildRubricConfig(opts);
  primeAssignmentAndPartMocks(config, opts);
  mockListRubrics.mockRejectedValueOnce(new ForbiddenError('Access Forbidden', 'part'));
  return makeCtx(config).ctx;
}

describe('detectSettingsDrift — rubrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports drift when a remote rubric maxscore differs from config', async () => {
    // config part has maxscore '10'; remote returns '12'
    const inspection = await inspectPull(ctxWithRubrics([
      { id: '1', name: 'A', seqnum: '1', maxscore: '12', auto: true, exclude: false },
    ]), { });

    const partDrift = inspection.settingsDrift[0].partsDrift[0];
    expect(partDrift.rubricsDrift?.changes.changed).toEqual(['A']);
    expect(partDrift.rubricsDrift?.remote[0].maxscore).toBe('12');
  });

  it('reports drift when the part has rubrics remotely and none in config', async () => {
    const inspection = await inspectPull(ctxWithRubrics([
      { id: '1', name: 'A', seqnum: '1', maxscore: '10' },
    ], { localRubrics: undefined }), { });

    const partDrift = inspection.settingsDrift[0].partsDrift[0];
    expect(partDrift.rubricsDrift?.changes.added).toEqual(['A']);
  });

  it('reports no drift when config and remote rubrics match', async () => {
    const inspection = await inspectPull(ctxWithRubrics([
      { id: '1', name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false },
    ], { localRubrics: [{ name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false }] }), { });

    expect(inspection.settingsDrift).toEqual([]);
  });

  it('still reports settings drift when the rubric fetch is forbidden', async () => {
    // token lacks the rubrics scope: settings drift must survive intact
    const inspection = await inspectPull(ctxWithForbiddenRubrics({ remoteSessionLength: '120' }), { });

    expect(inspection.settingsDrift[0].partsDrift[0].diffs.map(d => d.key)).toContain('session_length');
    expect(inspection.settingsDrift[0].partsDrift[0].rubricsDrift).toBeUndefined();
  });
});

describe('rubric fetching is gated by sync_settings as well', () => {
  beforeEach(() => {
    // Clear call history left by the previous describe block's tests so this
    // block's `not.toHaveBeenCalled()` assertion isn't tripped by a call
    // recorded before this test ever ran.
    vi.clearAllMocks();
  });

  afterEach(() => {
    // ctxWithRubrics queues mockReconcile/mockGetAssignment/mockListParts/
    // mockGetPart/mockListRubrics via primeAssignmentAndPartMocks. Because
    // sync_settings: false makes detectSettingsDrift bail out before the
    // assignment/part loop, those queued values are never consumed here — a
    // plain vi.clearAllMocks() (as used by sibling describes) clears call
    // history but leaves queued `...Once` implementations queued, which would
    // otherwise leak into the next describe block's mocks. Reset just these
    // (not vi.resetAllMocks(), which would also wipe unrelated module-level
    // mock defaults set up elsewhere in this file).
    mockReconcile.mockReset();
    mockGetAssignment.mockReset();
    mockListParts.mockReset();
    mockGetPart.mockReset();
    mockListRubrics.mockReset();
  });

  it('fetches no rubrics when sync_settings is false, even with sync_rubrics true', async () => {
    // detectSettingsDrift continues past the assignment before reaching the part
    // loop (src/core/services/pull-service.ts:696), so the fetcher is never called.
    const inspection = await inspectPull(
      ctxWithRubrics([{ id: '1', name: 'A', seqnum: '1', maxscore: '10' }], {
        publishOptions: { sync_settings: false, sync_rubrics: true },
      }),
      {}
    );

    expect(inspection.settingsDrift).toEqual([]);
    expect(mockListRubrics).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── applyPull — rubrics ─────────────────────────────────────────────────────

interface ApplyPullRubricOptions {
  /** Rubrics already in the config part. Omitted means none in config (forces "added" drift). */
  local?: Rubric[];
  /** Raw rubric rows as `listRubrics` would return them. `id` defaults to a placeholder when omitted. */
  remote: Array<Omit<VocareumRubricResponse, 'id'> & { id?: string }>;
  /** Extra remote part settings, to test settings + rubric drift together. */
  remoteSettings?: { session_length?: string };
  /** Resolver's answer to the settings-drift prompt. */
  action: SettingsDriftAction;
}

/**
 * Drive inspectPull + applyPull over the single-assignment/single-part config
 * from `buildRubricConfig`, with rubric drift and a fixed resolver `action`.
 * Returns the `ConfigUpdates` captured from the mocked
 * `LockedSession.applyConfigUpdate` (undefined if it was never called, e.g.
 * when the user keeps local).
 */
async function applyPullWithRubricDrift(
  opts: ApplyPullRubricOptions
): Promise<{ configUpdates: ConfigUpdates | undefined; events: CollectingEventSink }> {
  const remoteRubrics: VocareumRubricResponse[] = opts.remote.map((r, i) => ({
    id: r.id ?? `rubric-${i}`,
    ...r,
  }));

  // Always forward the `localRubrics` key (even when `opts.local` is undefined)
  // so buildRubricConfig treats "no local given" as "no rubrics in config",
  // not as its own DEFAULT_LOCAL_RUBRICS fallback.
  const ctx = ctxWithRubrics(remoteRubrics, {
    localRubrics: opts.local,
    remoteSessionLength: opts.remoteSettings?.session_length,
  });

  const req: PullRequest = { batch: false, verbose: false, skipContent: false, content: false };
  const inspection = await inspectPull(ctx, req);

  const { session, applyConfigUpdate } = makeSession();
  const resolver = makeStubResolver({
    resolveSettingsDriftAction: vi.fn<[PullIssueSettingsDrift], Promise<SettingsDriftAction>>()
      .mockResolvedValue(opts.action),
  });

  await applyPull(session, ctx, req, inspection, resolver);

  return {
    configUpdates: applyConfigUpdate.mock.calls[0]?.[0] as ConfigUpdates | undefined,
    events: ctx.events as CollectingEventSink,
  };
}

/** Messages emitted by a CollectingEventSink, in order. */
function messagesOf(events: CollectingEventSink): string[] {
  const messages: string[] = [];
  events.flushTo({ emit: (e) => { if (e.message) { messages.push(e.message); } } });
  return messages;
}

describe('applyPull — rubrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes pulled rubrics to the part in config', async () => {
    const { configUpdates } = await applyPullWithRubricDrift({
      remote: [{ name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false }],
      action: 'pull',
    });

    const part = configUpdates!.assignments![0].parts![0];
    expect(part.rubrics).toEqual([{ name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false }]);
  });

  it('removes the rubrics key when the remote part has none left', async () => {
    const { configUpdates } = await applyPullWithRubricDrift({
      local: [{ name: 'A', seqnum: '1', maxscore: '10' }],
      remote: [],
      action: 'pull',
    });

    expect(configUpdates!.assignments![0].parts![0]).not.toHaveProperty('rubrics');
  });

  it('leaves config untouched when the user keeps local', async () => {
    const { configUpdates } = await applyPullWithRubricDrift({
      local: [{ name: 'A', seqnum: '1', maxscore: '10' }],
      remote: [{ name: 'A', seqnum: '1', maxscore: '99' }],
      action: 'keep',
    });

    expect(configUpdates).toBeUndefined();
  });

  it('applies settings and rubrics together without one clobbering the other', async () => {
    const { configUpdates } = await applyPullWithRubricDrift({
      remote: [{ name: 'A', seqnum: '1', maxscore: '10' }],
      remoteSettings: { session_length: '120' },
      action: 'pull',
    });

    const part = configUpdates!.assignments![0].parts![0];
    expect(part.rubrics).toHaveLength(1);
    expect(part.settings!.session_length).toBe('120');
  });

  it('preserves existing rubrics when only settings drift (no rubric drift) is pulled', async () => {
    // Local and remote rubrics match exactly, so there is no rubricsDrift for
    // this part — updates.partRubrics has no entry for it. Only the settings
    // diff (remoteSessionLength) should be written; the part's existing
    // rubrics must survive untouched (via the `{ ...nextPart, settings }`
    // spread), not be dropped because a settings-only update was applied.
    const { configUpdates } = await applyPullWithRubricDrift({
      local: DEFAULT_LOCAL_RUBRICS,
      remote: [{ name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false }],
      remoteSettings: { session_length: '120' },
      action: 'pull',
    });

    const part = configUpdates!.assignments![0].parts![0];
    expect(part.rubrics).toEqual(DEFAULT_LOCAL_RUBRICS);
    expect(part.settings!.session_length).toBe('120');
  });

  it('qualifies the keep message when the drift was rubric-only (FIX E)', async () => {
    // The keep-result message must not unconditionally promise a push that
    // will happen: rubrics are read-only, so push will never send this
    // part's rubric drift regardless of "keep".
    const { events } = await applyPullWithRubricDrift({
      local: [{ name: 'A', seqnum: '1', maxscore: '10' }],
      remote: [{ name: 'A', seqnum: '1', maxscore: '99' }],
      action: 'keep',
    });

    const messages = messagesOf(events);
    expect(messages.some((m) =>
      m.includes('Keeping local settings') &&
      m.includes('rubric changes are read-only') &&
      m.includes('will not be pushed')
    )).toBe(true);
  });

  it('does not append the rubric qualifier when the drift is settings-only (FIX E)', async () => {
    const { events } = await applyPullWithRubricDrift({
      local: DEFAULT_LOCAL_RUBRICS,
      remote: [{ name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false }],
      remoteSettings: { session_length: '120' },
      action: 'keep',
    });

    const messages = messagesOf(events);
    const keepMessage = messages.find((m) => m.includes('Keeping local settings'));
    expect(keepMessage).toBeDefined();
    expect(keepMessage).not.toContain('rubric changes are read-only');
    expect(keepMessage).toBe('  Keeping local settings (will push to Vocareum on next publish)');
  });
});

/**
 * Import ORPHAN_1 (one assignment, one part — via enqueueImportResponses)
 * through applyPull, with the rubric fetch for that part resolving to
 * `remoteRubrics`. Returns the config update handed to
 * `session.applyConfigUpdate`.
 */
async function importOrphanWithRubrics(
  remoteRubrics: VocareumRubricResponse[]
): Promise<{ configUpdates: ConfigUpdates }> {
  const { ctx } = makeCtx();
  const { session, applyConfigUpdate } = makeSession();
  const clientMock = { request: vi.fn() };
  (ctx as PullContext & { client: typeof clientMock }).client = clientMock as never;

  enqueueImportResponses(clientMock);
  mockListRubrics.mockResolvedValueOnce(remoteRubrics);

  const resolver = makeStubResolver({
    resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>().mockResolvedValue('import'),
  });

  const inspection: PullInspection = { orphans: [ORPHAN_1], stale: [], settingsDrift: [], contentDrift: [] };
  const req: PullRequest = { batch: false, verbose: false, skipContent: false };
  await applyPull(session, ctx, req, inspection, resolver);

  return { configUpdates: applyConfigUpdate.mock.calls[0][0] as ConfigUpdates };
}

/** Same as `importOrphanWithRubrics`, but the rubric fetch is forbidden. */
async function importOrphanWithForbiddenRubrics(): Promise<{ configUpdates: ConfigUpdates }> {
  const { ctx } = makeCtx();
  const { session, applyConfigUpdate } = makeSession();
  const clientMock = { request: vi.fn() };
  (ctx as PullContext & { client: typeof clientMock }).client = clientMock as never;

  enqueueImportResponses(clientMock);
  mockListRubrics.mockRejectedValueOnce(new ForbiddenError('Access Forbidden', 'part'));

  const resolver = makeStubResolver({
    resolveOrphanAction: vi.fn<[PullIssueOrphan], Promise<OrphanAction>>().mockResolvedValue('import'),
  });

  const inspection: PullInspection = { orphans: [ORPHAN_1], stale: [], settingsDrift: [], contentDrift: [] };
  const req: PullRequest = { batch: false, verbose: false, skipContent: false };
  await applyPull(session, ctx, req, inspection, resolver);

  return { configUpdates: applyConfigUpdate.mock.calls[0][0] as ConfigUpdates };
}

describe('importAssignment — rubrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records each part\'s rubrics on import', async () => {
    const { configUpdates } = await importOrphanWithRubrics([
      { id: '1', name: 'Prompts were run', seqnum: '1', maxscore: '10', auto: true, exclude: false },
      { id: '2', name: 'Models compared', seqnum: '2', maxscore: '5', auto: true, exclude: false },
    ]);

    expect(configUpdates.assignments![0].parts![0].rubrics).toEqual([
      { name: 'Prompts were run', seqnum: '1', maxscore: '10', auto: true, exclude: false },
      { name: 'Models compared', seqnum: '2', maxscore: '5', auto: true, exclude: false },
    ]);
  });

  it('omits the rubrics key for a part with none', async () => {
    const { configUpdates } = await importOrphanWithRubrics([]);

    expect(configUpdates.assignments![0].parts![0]).not.toHaveProperty('rubrics');
  });

  it('imports successfully when rubrics are forbidden', async () => {
    const { configUpdates } = await importOrphanWithForbiddenRubrics();

    expect(configUpdates.assignments![0].parts![0].part_id).toBeDefined();
    expect(configUpdates.assignments![0].parts![0]).not.toHaveProperty('rubrics');
  });
});
