/**
 * Push refuses `asnlib` unless the destination course is positively Elite
 * (spec "Push: `asnlib` on Container courses"; S32-S37, S44, and the
 * "push guard" / "alias, push ..." matrix rows).
 *
 * These run the real reconcile -> planPush -> executePush path against a real
 * workspace on disk. Only the API modules, the uploader and git are faked; the
 * root listing goes through the real `listDirectoryBounded` against a fake
 * client, so the paging, the raw-element checks and the classifier are the
 * shipped ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Config, PublishHistory, Assignment, DirectoryType } from '../../src/types/config';
import type { VocareumClient } from '../../src/api/client';
import type { ServiceEvent } from '../../src/core/services/event-sink';
import type { PushPlan, PushRequest } from '../../src/core/services/types';
import type { PublishResult } from '../../src/types/state';
import type { LockedSession } from '../../src/core/session';
import { NonInteractivePrompter } from '../../src/core/services/context';
import { planPush, executePush } from '../../src/core/services/push-service';
import { reconcile } from '../../src/core/reconciler';
import { calculateDirectoryHash } from '../../src/utils/files';
import { publishExcludePatterns, PUSH_INCOMPLETE_MARKER, INCOMPLETE_PULL_MARKER } from '../../src/core/local-scan';
import { serializePushPlan, pushResultToOutcome } from '../../src/commands/publish';

const m = vi.hoisted(() => ({
  getCourse: vi.fn(),
  updateCourse: vi.fn(),
  listAssignments: vi.fn(),
  getAssignment: vi.fn(),
  copyAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  listParts: vi.fn(),
  getPart: vi.fn(),
  updatePart: vi.fn(),
  listRubrics: vi.fn(),
  createRubrics: vi.fn(),
  updateRubrics: vi.fn(),
  syncDirectory: vi.fn(),
  readDirectory: vi.fn(),
}));

vi.mock('../../src/api/courses', () => ({ getCourse: m.getCourse, updateCourse: m.updateCourse }));
vi.mock('../../src/api/assignments', () => ({
  listAssignments: m.listAssignments,
  getAssignment: m.getAssignment,
  copyAssignment: m.copyAssignment,
  updateAssignment: m.updateAssignment,
}));
vi.mock('../../src/api/parts', () => ({ listParts: m.listParts, getPart: m.getPart, updatePart: m.updatePart }));
vi.mock('../../src/api/rubrics', () => ({
  listRubrics: m.listRubrics, createRubrics: m.createRubrics, updateRubrics: m.updateRubrics,
}));
vi.mock('../../src/core/uploader', () => ({ syncDirectory: m.syncDirectory, readDirectory: m.readDirectory }));
vi.mock('../../src/utils/git', () => ({
  commitChanges: vi.fn(),
  getCommitSha: vi.fn().mockResolvedValue('abc123'),
  getGitUserName: vi.fn().mockResolvedValue('tester'),
}));

const COURSE = 'c1';
const ELITE = ['resource/', 'work/'];
const CONTAINER = ['resource/', 'voc/', 'work/'];
const ALIAS_MESSAGE =
  'this is a Container course, where `asnlib` holds aliases of `docs` and `data`. ' +
  'Uploading it could replace those aliases on Vocareum. vocgit refuses it until this is verified.';
const NO_PART_MESSAGE =
  'no part of this course existed to check; the next push checks the new part and uploads ' +
  '`asnlib` only if this course is Elite';

// ── fake client: answers only the root listing ────────────────────────────────

interface RootRequest { url: string; page: number }
let rootRequests: RootRequest[] = [];
let otherRequests: string[] = [];
/** Body for each page of the root listing; returning [] ends it. */
let rootBody: (url: string, page: number) => unknown = pagesOf(CONTAINER);

function pagesOf(names: unknown[]): (url: string, page: number) => unknown {
  return (_url, page) => (page === 0 ? names : []);
}

const client = {
  request: vi.fn(async (cfg: { url: string; params?: { dir?: string; page?: number } }) => {
    if (cfg.params?.dir === '/') {
      const page = cfg.params.page ?? 0;
      rootRequests.push({ url: cfg.url, page });
      return rootBody(cfg.url, page);
    }
    otherRequests.push(cfg.url);
    throw new Error(`unexpected request ${cfg.url}`);
  }),
} as unknown as VocareumClient;

// ── workspace ─────────────────────────────────────────────────────────────────

let root: string;
let uploads: { partId: string; dir: string }[] = [];

async function writeFiles(rel: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(root, rel, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-asnlib-guard-')));
  await fs.writeFile(path.join(root, 'vocareum.yaml'), 'placeholder: true\n');
  rootRequests = [];
  otherRequests = [];
  uploads = [];
  rootBody = pagesOf(CONTAINER);
  m.getCourse.mockResolvedValue({ id: COURSE, name: 'Course' });
  m.getAssignment.mockImplementation(async (_c: unknown, _course: string, id: string) => ({ id, name: id, courseid: COURSE }));
  m.getPart.mockImplementation(async (_c: unknown, _course: string, aid: string, pid: string) => (
    { id: pid, name: pid, seqnum: '0', deleted: '0', assignmentid: aid, courseid: COURSE }
  ));
  m.readDirectory.mockResolvedValue({});
  m.listRubrics.mockResolvedValue([]);
  // Reports the local directory's hash, as the real uploader does, so a
  // successful upload leaves stored state equal to local state.
  m.syncDirectory.mockImplementation(async (
    _client: unknown, _course: string, _aid: string, partId: string, local: string, dir: DirectoryType,
    options: { excludePatterns?: string[] },
  ) => {
    uploads.push({ partId, dir });
    return { succeeded: [], failed: [], directoryHash: await calculateDirectoryHash(local, options.excludePatterns ?? []) };
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ── config & remote ───────────────────────────────────────────────────────────

interface Lab {
  path: string;
  assignmentId: string | null;
  partId: string | null;
  dirs?: DirectoryType[];
  template?: string;
}

function makeConfig(labs: Lab[], history?: PublishHistory, extra: Partial<Config['vocareum']> = {}): Config {
  return {
    version: '1.0',
    vocareum: { org_id: '1', course_id: COURSE, api_base_url: 'https://api.vocareum.com', ...extra },
    assignments: labs.map((lab): Assignment => ({
      assignment_id: lab.assignmentId,
      name: lab.path,
      path: lab.path,
      create_from_template: lab.assignmentId === null,
      ...(lab.template !== undefined ? { template_assignment_id: lab.template } : {}),
      parts: [{ part_id: lab.partId, path: 'part1', directories: lab.dirs ?? ['startercode', 'asnlib'] }],
    })) as Assignment[],
    publish_history: history ? [history] : [],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: false,
      abort_on_error: false,
      sync_deletes: false,
      sync_settings: false,
      sync_rubrics: false,
      exclude_patterns: [],
    },
  } as unknown as Config;
}

/** Remote holds exactly the labs that have IDs. */
function remoteFrom(labs: Lab[]): void {
  const existing = labs.filter((l) => l.assignmentId !== null);
  m.listAssignments.mockResolvedValue(existing.map((l) => ({ id: l.assignmentId, name: l.path })));
  m.listParts.mockImplementation(async (_c: unknown, _course: string, aid: string) => {
    const lab = existing.find((l) => l.assignmentId === aid);
    return lab?.partId ? [{ id: lab.partId, seqnum: '0', name: 'Part 1', deleted: '0' }] : [];
  });
}

async function hashOf(config: Config, lab: string, dir: DirectoryType): Promise<string> {
  return calculateDirectoryHash(path.join(root, lab, 'part1', dir), publishExcludePatterns(config));
}

/** History in which every listed directory matches local, except `stale`. */
async function historyFor(
  labs: Lab[], overrides: Record<string, string> = {},
): Promise<PublishHistory> {
  const config = makeConfig(labs);
  const state: Record<string, string> = {};
  for (const lab of labs) {
    for (const dir of lab.dirs ?? ['startercode', 'asnlib']) {
      state[path.join(lab.path, 'part1', dir)] = await hashOf(config, lab.path, dir);
    }
  }
  return {
    timestamp: '2026-11-01T00:00:00Z', commit_sha: 'x', published_by: 't', status: 'success',
    content_state: { ...state, ...overrides },
  } as PublishHistory;
}

interface Run {
  plan: PushPlan;
  result: PublishResult;
  events: ServiceEvent[];
  history: PublishHistory | undefined;
}

async function push(config: Config, req: PushRequest = {}): Promise<Run> {
  const events: ServiceEvent[] = [];
  const ctx = {
    persistedConfig: config,
    effectiveConfig: config,
    configPath: path.join(root, 'vocareum.yaml'),
    workspaceRoot: root,
    events: { emit: (e: ServiceEvent) => { events.push(e); } },
    prompter: new NonInteractivePrompter(),
    client,
  };
  const fullReq: PushRequest = { nonInteractive: true, ...req };
  const plan = await planPush(ctx, fullReq);
  let history: PublishHistory | undefined;
  const session = {
    applyConfigUpdate: vi.fn(async (u: { publish_history?: PublishHistory[] }) => {
      history = u.publish_history?.[0];
    }),
  } as unknown as LockedSession;
  const result = await executePush(session, ctx, fullReq, plan);
  return { plan, result, events, history };
}

const blockedEvents = (events: ServiceEvent[]): ServiceEvent[] =>
  events.filter((e) => e.code === 'directory_blocked');
const asnlibUploads = (): unknown[] => uploads.filter((u) => u.dir === 'asnlib');
const part = (plan: PushPlan, i = 0) => plan.intent.assignments[i].parts[0];

/** One existing lab whose `asnlib` changed since the last push. */
async function changedAsnlibWorld(): Promise<{ labs: Lab[]; config: Config }> {
  const labs: Lab[] = [{ path: 'lab1', assignmentId: 'a1', partId: 'p1' }];
  await writeFiles('lab1/part1', { 'startercode/main.py': 'print(1)\n', 'asnlib/grader.py': 'v1\n' });
  remoteFrom(labs);
  const history = await historyFor(labs, { [path.join('lab1', 'part1', 'asnlib')]: 'old-hash' });
  return { labs, config: makeConfig(labs, history) };
}

// ── S32 ───────────────────────────────────────────────────────────────────────

describe('S32: asnlib changed on an existing part', () => {
  it('S32 Container root: refused as container-asnlib, no upload request names asnlib, marker written, exit 6 (partial)', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = pagesOf(CONTAINER);
    const run = await push(config);

    expect(rootRequests[0]).toEqual({ url: `/courses/${COURSE}/assignments/a1/parts/p1/files`, page: 0 });
    expect(part(run.plan).blockedDirectories).toEqual([{ dir: 'asnlib', reason: 'container-asnlib' }]);
    expect(Object.keys(part(run.plan).contentHashes)).not.toContain('asnlib');
    expect(asnlibUploads()).toEqual([]);

    const [blocked] = blockedEvents(run.events);
    expect(blocked).toMatchObject({
      level: 'error',
      code: 'directory_blocked',
      data: { part_id: 'p1', directory: 'asnlib', reason: 'container-asnlib' },
    });
    expect(blocked.message).toBe(`Not pushing \`lab1/part1/asnlib\`: ${ALIAS_MESSAGE}`);
    expect(run.result.success).toBe(false);
    expect(run.result.failed).toContainEqual(expect.objectContaining({ type: 'file', id: 'lab1/part1/asnlib' }));
    expect(run.history?.status).toBe('failed');
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
    expect(pushResultToOutcome({
      succeeded: run.result.updated.length, failed: run.result.failed.length,
      success: run.result.success, dryRun: false, planned: 1,
    })).toEqual({ result: 'partial', category: 'partial' });
  });

  it('S32 Elite root: uploaded as today', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = pagesOf(ELITE);
    const run = await push(config);

    expect(part(run.plan).blockedDirectories).toBeUndefined();
    expect(asnlibUploads()).toEqual([{ partId: 'p1', dir: 'asnlib' }]);
    expect(blockedEvents(run.events)).toEqual([]);
    expect(run.result.success).toBe(true);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(await hashOf(config, 'lab1', 'asnlib'));
  });

  it('S32 root-listing error: refused, naming the error', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = () => { throw new Error('socket hang up'); };
    const run = await push(config);

    expect(asnlibUploads()).toEqual([]);
    const [blocked] = blockedEvents(run.events);
    expect(blocked.data).toMatchObject({ reason: 'container-asnlib', directory: 'asnlib' });
    expect(blocked.message).toMatch(/^Not pushing `lab1\/part1\/asnlib`: the course root listing failed: .*socket hang up/);
    // A failed listing may be passing: refused this time, checked again next push.
    expect(blocked.message).toMatch(/refused this time\. The next push checks the course root again\./);
    expect(blocked.message).not.toMatch(/every push/);
    expect(blocked.message).not.toMatch(/report this root listing/);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });

  it('S32 empty array: refused', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = pagesOf([]);
    const run = await push(config);
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(run.events)).toHaveLength(1);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });

  it('S32 overload body: refused', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = () => ({ message: 'The server is experiencing heavy traffic, please retry' });
    const run = await push(config);
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(run.events)[0].message).toMatch(/the course root listing failed/);
  });

  it('S32 truncated (over 1,000 names): refused', async () => {
    const { config } = await changedAsnlibWorld();
    const many = ['resource/', 'work/', ...Array.from({ length: 1000 }, (_, i) => `n${i}`)];
    rootBody = pagesOf(many);
    const run = await push(config);
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(run.events)).toHaveLength(1);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });
});

// ── S32a / matrix: recovery ───────────────────────────────────────────────────

describe('S32a / push guard, recovered', () => {
  it('S32a: --force-all refused after a transient root error; the next plain push plans asnlib (marker) and uploads it; the push after does not plan it or list the root', async () => {
    const labs: Lab[] = [{ path: 'lab1', assignmentId: 'a1', partId: 'p1' }];
    await writeFiles('lab1/part1', { 'startercode/main.py': 'print(1)\n', 'asnlib/grader.py': 'v1\n' });
    remoteFrom(labs);
    const unchanged = await historyFor(labs);

    rootBody = () => { throw new Error('ETIMEDOUT'); };
    const first = await push(makeConfig(labs, unchanged), { forceAll: true });
    expect(asnlibUploads()).toEqual([]);
    expect(first.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);

    uploads = [];
    rootRequests = [];
    rootBody = pagesOf(ELITE);
    const second = await push(makeConfig(labs, first.history));
    expect(rootRequests.length).toBeGreaterThan(0);
    expect(asnlibUploads()).toEqual([{ partId: 'p1', dir: 'asnlib' }]);
    expect(second.result.success).toBe(true);
    expect(second.history?.content_state?.['lab1/part1/asnlib']).toBe(await hashOf(makeConfig(labs), 'lab1', 'asnlib'));

    uploads = [];
    rootRequests = [];
    const after = await push(makeConfig(labs, second.history));
    expect(uploads).toEqual([]);
    expect(rootRequests).toEqual([]);
    expect(asnlibUploads()).toEqual([]);
    expect(after.result.success).toBe(true);
  });
});

// ── S33 ───────────────────────────────────────────────────────────────────────

describe('S33: incomplete-pull and container-asnlib blocks in one part', () => {
  it('S33: each directory gets its own message and directory_blocked with its reason; both failed; partial', async () => {
    const { labs } = await changedAsnlibWorld();
    const history = await historyFor(labs, {
      'lab1/part1/startercode': INCOMPLETE_PULL_MARKER,
      'lab1/part1/asnlib': 'old-hash',
    });
    const run = await push(makeConfig(labs, history));

    expect(part(run.plan).blockedDirectories).toEqual([
      { dir: 'startercode', reason: 'incomplete-pull' },
      { dir: 'asnlib', reason: 'container-asnlib' },
    ]);
    const blocked = blockedEvents(run.events);
    expect(blocked.map((e) => e.data)).toEqual([
      { part_id: 'p1', directory: 'startercode', reason: 'incomplete-pull' },
      { part_id: 'p1', directory: 'asnlib', reason: 'container-asnlib' },
    ]);
    expect(blocked[0].message).toMatch(/^Not pushing lab1\/part1\/startercode: the last pull could not download every file/);
    expect(blocked[1].message).toBe(`Not pushing \`lab1/part1/asnlib\`: ${ALIAS_MESSAGE}`);
    expect(run.result.failed.map((f) => f.id)).toEqual(['lab1/part1/startercode', 'lab1/part1/asnlib']);
    expect(uploads).toEqual([]);
    expect(run.history?.content_state?.['lab1/part1/startercode']).toBe(INCOMPLETE_PULL_MARKER);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });
});

// ── S34: create path ──────────────────────────────────────────────────────────

describe('S34: create path', () => {
  async function createWorld(): Promise<Lab[]> {
    await writeFiles('lab1/part1', { 'startercode/main.py': 'a\n', 'asnlib/g.py': 'a\n' });
    await writeFiles('lab2/part1', { 'startercode/main.py': 'b\n', 'asnlib/g.py': 'b\n' });
    m.copyAssignment.mockResolvedValue({ assignment_id: 'a2', parts: [{ part_id: 'p2', seqnum: '0' }] });
    // lab1 exists and is unchanged; lab2 is new.
    return [
      { path: 'lab1', assignmentId: 'a1', partId: 'p1' },
      { path: 'lab2', assignmentId: null, partId: null, template: 'tmpl-9' },
    ];
  }

  it('S34: another configured part on Container decides: refused, never uploaded', async () => {
    const labs = await createWorld();
    remoteFrom(labs);
    const history = await historyFor([labs[0]]);
    rootBody = pagesOf(CONTAINER);
    const run = await push(makeConfig(labs, history, { template_assignment_id: 'tmpl-9' }));

    expect(rootRequests.filter((r) => r.page === 0).map((r) => r.url))
      .toEqual([`/courses/${COURSE}/assignments/a1/parts/p1/files`]);
    // intent[0] is lab1 (an assignment-level update with no part work); lab2 is the create.
    expect(part(run.plan, 1).blockedDirectories).toEqual([{ dir: 'asnlib', reason: 'container-asnlib' }]);
    expect(uploads).toEqual([{ partId: 'p2', dir: 'startercode' }]);
    expect(blockedEvents(run.events)[0].data).toEqual({ part_id: 'p2', directory: 'asnlib', reason: 'container-asnlib' });
    expect(run.history?.content_state?.['lab2/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });

  it('S34: another configured part on Elite decides: uploaded', async () => {
    const labs = await createWorld();
    remoteFrom(labs);
    rootBody = pagesOf(ELITE);
    const run = await push(makeConfig(labs, await historyFor([labs[0]])));
    expect(part(run.plan, 1).blockedDirectories).toBeUndefined();
    expect(uploads).toEqual([{ partId: 'p2', dir: 'startercode' }, { partId: 'p2', dir: 'asnlib' }]);
    expect(run.result.success).toBe(true);
  });

  it('S34: template in a different course is never listed; the destination part decides', async () => {
    const labs = await createWorld();
    remoteFrom(labs);
    rootBody = pagesOf(ELITE);
    const config = makeConfig(labs, await historyFor([labs[0]]), {
      templates: [{ id: 'tmpl-9', name: 'default', course_id: 'other-course' }],
    } as Partial<Config['vocareum']>);
    await push(config);
    expect(rootRequests.length).toBeGreaterThan(0);
    for (const r of rootRequests) {
      expect(r.url).toBe(`/courses/${COURSE}/assignments/a1/parts/p1/files`);
      expect(r.url).not.toContain('tmpl-9');
      expect(r.url).not.toContain('other-course');
    }
  });

  async function firstPushWorld(): Promise<{ labs: Lab[]; first: Run }> {
    await writeFiles('lab1/part1', { 'startercode/main.py': 'a\n', 'asnlib/g.py': 'a\n' });
    m.copyAssignment.mockResolvedValue({ assignment_id: 'a1', parts: [{ part_id: 'p1', seqnum: '0' }] });
    const fresh: Lab[] = [{ path: 'lab1', assignmentId: null, partId: null, template: 'tmpl-9' }];
    remoteFrom(fresh);
    const first = await push(makeConfig(fresh));
    return { labs: [{ path: 'lab1', assignmentId: 'a1', partId: 'p1' }], first };
  }

  it('S34 / create first: no configured part: refused with the no-part message, marker written, no root listed', async () => {
    const { first } = await firstPushWorld();
    expect(rootRequests).toEqual([]);
    expect(asnlibUploads()).toEqual([]);
    expect(uploads).toEqual([{ partId: 'p1', dir: 'startercode' }]);
    const [blocked] = blockedEvents(first.events);
    expect(blocked.message).toBe(`Not pushing \`lab1/part1/asnlib\`: ${NO_PART_MESSAGE}.`);
    expect(first.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });

  it('S34: no configured part, then a second push on an Elite course: uploaded', async () => {
    const { labs, first } = await firstPushWorld();
    remoteFrom(labs);
    uploads = [];
    rootBody = pagesOf(ELITE);
    const second = await push(makeConfig(labs, first.history));
    expect(rootRequests.filter((r) => r.page === 0).map((r) => r.url))
      .toEqual([`/courses/${COURSE}/assignments/a1/parts/p1/files`]);
    expect(asnlibUploads()).toEqual([{ partId: 'p1', dir: 'asnlib' }]);
    expect(second.result.success).toBe(true);
  });

  it('S34: no configured part, then a second push on a Container course: refused again with the alias message, never uploaded', async () => {
    const { labs, first } = await firstPushWorld();
    remoteFrom(labs);
    uploads = [];
    rootBody = pagesOf(CONTAINER);
    const second = await push(makeConfig(labs, first.history));
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(second.events)[0].message).toBe(`Not pushing \`lab1/part1/asnlib\`: ${ALIAS_MESSAGE}`);
    expect(second.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });
});

// ── S36 ───────────────────────────────────────────────────────────────────────

describe('S36: dry-run and the plan summary', () => {
  it('S36: --dry-run shows {dir, reason} in the plan, writes nothing, and is reported (exit 5 with --json)', async () => {
    const { config } = await changedAsnlibWorld();
    const run = await push(config, { dryRun: true });

    const serialized = JSON.parse(JSON.stringify(serializePushPlan(run.plan))) as {
      intent: { assignments: { parts: { blockedDirectories?: unknown[] }[] }[] };
    };
    expect(serialized.intent.assignments[0].parts[0].blockedDirectories)
      .toEqual([{ dir: 'asnlib', reason: 'container-asnlib' }]);
    expect(run.result).toMatchObject({ success: true, failed: [], contentState: {} });
    expect(run.history).toBeUndefined();
    expect(blockedEvents(run.events)).toEqual([]);
    expect(uploads).toEqual([]);
    expect(pushResultToOutcome({
      succeeded: 0, failed: 0, success: true, dryRun: true, planned: run.plan.hasChanges ? 1 : 0,
    })).toEqual({ result: 'reported', category: 'findings' });
  });

  it('S36: without --verbose, planPush itself lists the block with its reason (so it is on screen before "Proceed with push?")', async () => {
    const { config } = await changedAsnlibWorld();
    const events: ServiceEvent[] = [];
    await planPush({
      persistedConfig: config, effectiveConfig: config,
      configPath: path.join(root, 'vocareum.yaml'), workspaceRoot: root,
      events: { emit: (e: ServiceEvent) => { events.push(e); } },
      prompter: new NonInteractivePrompter(), client,
    }, { verbose: false, dryRun: false });
    const line = events.find((e) => /container-asnlib/.test(e.message ?? ''));
    expect(line).toBeDefined();
    expect(line?.message).toContain('lab1/part1/asnlib');
    expect(line?.message).toContain(ALIAS_MESSAGE);
    // Not a diagnostic: the execute-time directory_blocked is the one diagnostic.
    expect(line?.code).toBeUndefined();
  });
});

// ── S37 ───────────────────────────────────────────────────────────────────────

describe('S37: --abort-on-error', () => {
  it('S37: a refused asnlib before another part stops after the part\'s blocked pass', async () => {
    const labs: Lab[] = [
      { path: 'lab1', assignmentId: 'a1', partId: 'p1' },
      { path: 'lab2', assignmentId: 'a2', partId: 'p2' },
    ];
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'asnlib/g.py': '1\n' });
    await writeFiles('lab2/part1', { 'startercode/main.py': '2\n', 'asnlib/g.py': '2\n' });
    remoteFrom(labs);
    const history = await historyFor(labs, {
      'lab1/part1/asnlib': 'old', 'lab1/part1/startercode': 'old', 'lab2/part1/startercode': 'old-2',
    });
    const run = await push(makeConfig(labs, history), { abortOnError: true });

    expect(uploads).toEqual([]);
    expect(run.result.failed.map((f) => f.id)).toEqual(['lab1/part1/asnlib']);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
    expect(run.history?.content_state?.['lab1/part1/startercode']).toBe('old');
    expect(run.history?.content_state?.['lab2/part1/startercode']).toBe('old-2');
  });

  it('S37 / push guard, abort: incomplete-pull listed before asnlib in the same part: both recorded, asnlib marker, incomplete-pull kept; next plain push plans asnlib', async () => {
    const labs: Lab[] = [{ path: 'lab1', assignmentId: 'a1', partId: 'p1', dirs: ['startercode', 'scripts', 'asnlib'] }];
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'scripts/run.sh': 'x\n', 'asnlib/g.py': '1\n' });
    remoteFrom(labs);
    const history = await historyFor(labs, {
      'lab1/part1/startercode': INCOMPLETE_PULL_MARKER,
      'lab1/part1/scripts': 'old-scripts',
      'lab1/part1/asnlib': 'old-asnlib',
    });
    const run = await push(makeConfig(labs, history), { abortOnError: true });

    expect(blockedEvents(run.events).map((e) => (e.data as { directory: string }).directory))
      .toEqual(['startercode', 'asnlib']);
    expect(run.result.failed.map((f) => f.id)).toEqual(['lab1/part1/startercode', 'lab1/part1/asnlib']);
    expect(uploads).toEqual([]);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
    expect(run.history?.content_state?.['lab1/part1/startercode']).toBe(INCOMPLETE_PULL_MARKER);
    expect(run.history?.content_state?.['lab1/part1/scripts']).toBe('old-scripts');

    // The marker makes the next plain push plan asnlib again (and refuse it again).
    rootRequests = [];
    const next = await push(makeConfig(labs, run.history));
    expect(rootRequests.length).toBeGreaterThan(0);
    expect(part(next.plan).blockedDirectories).toContainEqual({ dir: 'asnlib', reason: 'container-asnlib' });
  });

  it('markers first: an earlier abort (a failing assignment before it) still leaves the refused asnlib marked', async () => {
    const labs: Lab[] = [
      { path: 'lab0', assignmentId: 'gone', partId: 'p0', dirs: ['startercode'] },
      { path: 'lab1', assignmentId: 'a1', partId: 'p1' },
    ];
    await writeFiles('lab0/part1', { 'startercode/main.py': '0\n' });
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'asnlib/g.py': '1\n' });
    remoteFrom([labs[1]]); // lab0's assignment was deleted remotely: an 'error' action
    const history = await historyFor(labs, { 'lab1/part1/asnlib': 'old' });
    const run = await push(makeConfig(labs, history), { abortOnError: true });

    expect(run.result.failed.map((f) => f.id)).toEqual(['gone']);
    expect(blockedEvents(run.events)).toEqual([]);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });
});

// ── S44 ───────────────────────────────────────────────────────────────────────

describe('S44: block objects through every consumer', () => {
  it('S44: marker key is lab/part/asnlib, never [object Object]; the reconciler reason text names asnlib', async () => {
    const { config } = await changedAsnlibWorld();
    const run = await push(config);
    const keys = Object.keys(run.history?.content_state ?? {});
    expect(keys).toContain('lab1/part1/asnlib');
    expect(keys.some((k) => k.includes('[object Object]'))).toBe(false);
    expect(run.result.failed.some((f) => f.id.includes('[object Object]'))).toBe(false);
    const reason = run.plan.execution.reconciliation.assignments[0].parts[0].reason ?? '';
    expect(reason).toContain('asnlib');
    expect(reason).toContain('container-asnlib');
    expect(reason).not.toContain('[object Object]');
  });
});

// ── matrix rows ───────────────────────────────────────────────────────────────

describe('matrix: alias, push ... / push guard ...', () => {
  it('alias, push unchanged: asnlib hash matches, so no root listing and nothing uploaded', async () => {
    const labs: Lab[] = [{ path: 'lab1', assignmentId: 'a1', partId: 'p1' }];
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'asnlib/public/docs/a.md': 'x\n' });
    remoteFrom(labs);
    const run = await push(makeConfig(labs, await historyFor(labs)));
    expect(rootRequests).toEqual([]);
    expect(uploads).toEqual([]);
    expect(run.result.success).toBe(true);
  });

  it('alias, push changed: other directories upload and advance; asnlib refused and marked', async () => {
    const labs: Lab[] = [{ path: 'lab1', assignmentId: 'a1', partId: 'p1' }];
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'asnlib/g.py': '1\n' });
    remoteFrom(labs);
    const history = await historyFor(labs, { 'lab1/part1/asnlib': 'old', 'lab1/part1/startercode': 'old' });
    const run = await push(makeConfig(labs, history));
    expect(uploads).toEqual([{ partId: 'p1', dir: 'startercode' }]);
    expect(run.history?.content_state?.['lab1/part1/startercode']).toBe(await hashOf(makeConfig(labs), 'lab1', 'startercode'));
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
    expect(run.result.success).toBe(false);
  });

  it('alias, push again: after a refusal with nothing else changed, asnlib is planned (marker) and refused again', async () => {
    const { labs, config } = await changedAsnlibWorld();
    const first = await push(config);
    rootRequests = [];
    const again = await push(makeConfig(labs, first.history));
    expect(rootRequests.length).toBeGreaterThan(0);
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(again.events)).toHaveLength(1);
    expect(again.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });

  it('push guard, emptied local: an emptied asnlib is refused before any (empty) upload; marker written', async () => {
    const labs: Lab[] = [{ path: 'lab1', assignmentId: 'a1', partId: 'p1' }];
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'asnlib/g.py': '1\n' });
    remoteFrom(labs);
    const history = await historyFor(labs);
    await fs.rm(path.join(root, 'lab1/part1/asnlib/g.py'));
    const run = await push(makeConfig(labs, history));
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(run.events)).toHaveLength(1);
    expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
  });

  it('push guard, only change: the part stays update (not skip), refused, failed; dry-run is reported', async () => {
    const { config } = await changedAsnlibWorld();
    const dry = await push(config, { dryRun: true });
    const partAction = dry.plan.execution.reconciliation.assignments[0].parts[0];
    expect(partAction.type).toBe('update');
    expect(partAction.changedDirectories).toBeUndefined();
    expect(partAction.contentChanged).toBe(false);
    expect(dry.plan.hasChanges).toBe(true);
    expect(dry.result.success).toBe(true);

    const run = await push(config);
    expect(run.result.success).toBe(false);
    expect(run.result.failed).toHaveLength(1);
  });

  it('push guard, unknown root: {resource, work, extra} is refused every push, asks to report the listing, marker each time', async () => {
    const { labs, config } = await changedAsnlibWorld();
    rootBody = pagesOf(['resource/', 'work/', 'extra/']);
    const first = await push(config);
    const second = await push(makeConfig(labs, first.history));
    for (const run of [first, second]) {
      expect(asnlibUploads()).toEqual([]);
      const [blocked] = blockedEvents(run.events);
      expect(blocked.message).toMatch(/"extra"/);
      expect(blocked.message).toMatch(/refused on every push until vocgit recognises this course root/);
      expect(blocked.message).toMatch(/Please report this root listing to the vocgit maintainers\./);
      expect(blocked.message).not.toMatch(/next push checks/);
      expect(blocked.message).not.toMatch(/this time/);
      expect(run.history?.content_state?.['lab1/part1/asnlib']).toBe(PUSH_INCOMPLETE_MARKER);
    }
  });

  it('push guard, no evidence: {resource} alone is refused', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = pagesOf(['resource/']);
    const run = await push(config);
    expect(asnlibUploads()).toEqual([]);
    expect(blockedEvents(run.events)[0].message).toMatch(/"resource"/);
  });

  it('alias, push Elite: an edit under asnlib on an Elite course uploads as today', async () => {
    const { config } = await changedAsnlibWorld();
    rootBody = pagesOf(['resource', 'work']);
    const run = await push(config);
    expect(asnlibUploads()).toEqual([{ partId: 'p1', dir: 'asnlib' }]);
  });

  it('the root is listed once per course per run, however many parts plan asnlib', async () => {
    const labs: Lab[] = [
      { path: 'lab1', assignmentId: 'a1', partId: 'p1' },
      { path: 'lab2', assignmentId: 'a2', partId: 'p2' },
    ];
    await writeFiles('lab1/part1', { 'startercode/main.py': '1\n', 'asnlib/g.py': '1\n' });
    await writeFiles('lab2/part1', { 'startercode/main.py': '2\n', 'asnlib/g.py': '2\n' });
    remoteFrom(labs);
    await push(makeConfig(labs, await historyFor(labs, { 'lab1/part1/asnlib': 'o', 'lab2/part1/asnlib': 'o' })));
    expect(rootRequests.filter((r) => r.page === 0)).toHaveLength(1);
  });

  it('the guard runs only for push: reconcile without it (pull) never lists the root', async () => {
    const { config } = await changedAsnlibWorld();
    const plan = await reconcile(config, client, config.publish_history?.[0], { workspaceRoot: root });
    expect(rootRequests).toEqual([]);
    expect(plan.assignments[0].parts[0].changedDirectories).toContain('asnlib');
    expect(otherRequests).toEqual([]);
  });
});
