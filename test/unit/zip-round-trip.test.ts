/**
 * S30: the round-trip matrix through the services, not `downloadContent`.
 *
 * Each test runs the real `inspectPull` → `applyPull` (import, and strict
 * content drift with batch apply) and the real `planPush` → `executePush`,
 * against a real `vocareum.yaml` under a real `withSession`, so every step
 * reads the `publish_history` the step before it wrote. The remote is one
 * `FakeVocareumTree` behind the real `VocareumClient`; this file wraps its
 * adapter to also answer the course, assignment and part endpoints and to
 * record each part PUT (the push upload). Only git is mocked.
 *
 * Rows already pinned elsewhere are not repeated: `content-zip.test.ts`
 * (download level) and `push-asnlib-guard.test.ts` (push guard, alias push).
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import yauzl from 'yauzl';
import yaml from 'js-yaml';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectPull, applyPull } from '../../src/core/services/pull-service';
import type { PullInspection, PullResolver, PullResult } from '../../src/core/services/pull-service';
import { planPush, executePush } from '../../src/core/services/push-service';
import type { PushPlan, PushRequest } from '../../src/core/services/types';
import { NonInteractivePrompter } from '../../src/core/services/context';
import type { PullContext } from '../../src/core/services/context';
import type { ServiceEvent } from '../../src/core/services/event-sink';
import { loadConfig, ConfigError } from '../../src/core/config';
import { CommandFailureError } from '../../src/utils/command-failure';
import { withSession } from '../../src/core/session';
import { INCOMPLETE_PULL_MARKER } from '../../src/core/local-scan';
import { calculateDirectoryHash } from '../../src/utils/files';
import { resolvePullZipSettings, type PullZipSettings } from '../../src/utils/zip-switches';
import type { Config, PublishHistory } from '../../src/types/config';
import type { PublishResult } from '../../src/types/state';
import {
  ASSIGNMENT,
  COURSE,
  FakeVocareumTree,
  PART,
  install,
  type Installed,
} from '../helpers/fake-vocareum-tree';

vi.mock('../../src/utils/git', () => ({
  // Plain functions: afterEach's restoreAllMocks must not strip these.
  commitChanges: async () => undefined,
  getCommitSha: async () => 'abc123',
  getGitUserName: async () => 'tester',
}));

const PART2 = '6036047';
const LAB = 'lab-one';
const KEY = (dir: string): string => path.join(LAB, dir);
const EXCLUDE = ['.gitkeep', '**/.gitkeep'];

/** Run a promise to completion while fake time advances; real I/O gets turns too. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400_000 && !done; i++) {
    await vi.advanceTimersByTimeAsync(25);
    if (!done) { await new Promise((r) => setImmediate(r)); }
  }
  return p;
}

const batch: PullResolver = {
  resolveOrphanAction: async () => 'import',
  resolveStaleAction: async () => 'skip',
  resolveSettingsDriftAction: async () => 'pull',
  resolveContentDriftAction: async () => 'pull',
  resolveImportPath: async (_issue, suggested) => suggested,
};

interface Put { partId: string; target: string; reset: number; files: Record<string, string> }

interface RemotePart { id: string; name: string }

interface PullRun {
  inspection: PullInspection;
  result: PullResult;
  events: ServiceEvent[];
  config: Config;
}

interface PushRun {
  plan: PushPlan;
  result: PublishResult;
  events: ServiceEvent[];
  config: Config;
}

/** Every entry of a zip, as `name → utf8 content`. */
function unzip(buf: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err !== null || zf === undefined) { reject(err ?? new Error('no zip')); return; }
      const out: Record<string, string> = {};
      zf.on('entry', (entry: yauzl.Entry) => {
        zf.openReadStream(entry, (e, stream) => {
          if (e !== null || stream === undefined) { reject(e ?? new Error('no stream')); return; }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => { out[entry.fileName] = Buffer.concat(chunks).toString('utf8'); zf.readEntry(); });
        });
      });
      zf.on('end', () => resolve(out));
      zf.on('error', reject);
      zf.readEntry();
    });
  });
}

class World {
  root = '';
  configPath = '';
  readonly tree: FakeVocareumTree;
  readonly inst: Installed;
  readonly puts: Put[] = [];
  parts: RemotePart[] = [{ id: PART, name: 'Part 1' }];
  private readonly rawPuts: { partId: string; body: { content: { target: string; zipcontent: string; reset: number }[] } }[] = [];

  constructor(tree: FakeVocareumTree) {
    this.tree = tree;
    // The Container root signature, so a push that plans asnlib meets the real guard.
    tree.dir('/work');
    this.inst = install(tree);
    const ax = (this.inst.client as unknown as { axios: { defaults: Record<string, unknown> } }).axios;
    ax.defaults.adapter = this.adapter;
  }

  async init(assignments: unknown[] = []): Promise<void> {
    this.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vocgit-zip-rt-')));
    this.configPath = path.join(this.root, 'vocareum.yaml');
    const yaml = [
      'version: "1.0"',
      'vocareum:',
      '  org_id: "1"',
      `  course_id: "${COURSE}"`,
      '  api_base_url: "https://api.vocareum.com"',
      `assignments: ${JSON.stringify(assignments)}`,
      'publish_options:',
      '  on_missing_id: skip',
      '  auto_commit: false',
      '  abort_on_error: false',
      '  sync_deletes: false',
      '  sync_settings: false',
      '  sync_rubrics: false',
      '  exclude_patterns: []',
      '',
    ].join('\n');
    await fs.writeFile(this.configPath, yaml);
  }

  private adapter = async (config: InternalAxiosRequestConfig): Promise<unknown> => {
    const url = config.url ?? '';
    const ok = (data: unknown): unknown => ({ status: 200, statusText: 'OK', headers: {}, config, data });
    const course = `/courses/${COURSE}`;
    const asn = `${course}/assignments/${ASSIGNMENT}`;
    const part = (p: RemotePart): unknown => ({ id: p.id, name: p.name, seqnum: String(this.parts.indexOf(p)), deleted: '0' });
    if (url.endsWith('/files')) { return this.tree.adapter(config); }
    if ((config.method ?? 'get').toLowerCase() === 'put') {
      const m = /\/parts\/([^/]+)$/.exec(url);
      const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as Put & { content: { target: string; zipcontent: string; reset: number }[] };
      this.rawPuts.push({ partId: m?.[1] ?? '?', body });
      return ok({ status: 'success' });
    }
    if (url === course) { return ok({ courses: [{ id: COURSE, name: 'Course' }] }); }
    if (url === `${course}/assignments`) { return ok({ assignments: [{ id: ASSIGNMENT, name: 'Lab One' }], total_records: 1 }); }
    if (url === asn) { return ok({ assignments: [{ id: ASSIGNMENT, name: 'Lab One' }] }); }
    if (url === `${asn}/parts`) { return ok({ parts: this.parts.map(part) }); }
    const pm = /\/parts\/([^/]+)$/.exec(url);
    const p = this.parts.find((x) => x.id === pm?.[1]);
    if (p !== undefined) { return ok({ parts: [part(p)] }); }
    throw new Error(`zip-round-trip: unexpected request ${config.method} ${url}`);
  };

  zip(timeoutMs = 600_000): PullZipSettings {
    const settings = { enabled: true, timeoutMs, now: () => performance.now(), http: this.inst.http };
    return settings;
  }

  /** The switches as the pull command resolves them, with the fake S3 threaded in. */
  zipFromEnv(env: NodeJS.ProcessEnv): PullZipSettings {
    const settings = { ...resolvePullZipSettings(env), http: this.inst.http };
    return settings;
  }

  private async ctx(): Promise<PullContext> {
    // Separate runs must get distinct history timestamps (history is sorted by them).
    await vi.advanceTimersByTimeAsync(1000);
    const config = await loadConfig(this.configPath);
    return {
      persistedConfig: config,
      effectiveConfig: config,
      configPath: this.configPath,
      workspaceRoot: this.root,
      events: this.inst.events,
      prompter: new NonInteractivePrompter(),
      client: this.inst.client,
    };
  }

  /** `vocgit pull --batch [--content]` through the services. */
  async pull(zip: PullZipSettings | undefined, content: boolean): Promise<PullRun> {
    const ctx = await this.ctx();
    const req = { batch: true, content, zip };
    const run = (async () => withSession(this.configPath, async (session) => {
      const inspection = await inspectPull(ctx, req);
      const result = await applyPull(session, ctx, req, inspection, batch);
      return { inspection, result };
    }))();
    const { inspection, result } = await drive(run);
    return { inspection, result, events: [...this.inst.events.drain()], config: await loadConfig(this.configPath) };
  }

  async import(zip: PullZipSettings | undefined): Promise<PullRun> {
    return this.pull(zip, false);
  }

  async drift(zip: PullZipSettings | undefined): Promise<PullRun> {
    return this.pull(zip, true);
  }

  async push(req: PushRequest = {}): Promise<PushRun> {
    const ctx = await this.ctx();
    const full: PushRequest = { nonInteractive: true, ...req };
    const run = (async () => {
      const plan = await planPush(ctx, full);
      const result = await withSession(this.configPath, (session) => executePush(session, ctx, full, plan));
      return { plan, result };
    })();
    const { plan, result } = await drive(run);
    for (const raw of this.rawPuts.splice(0)) {
      for (const c of raw.body.content) {
        this.puts.push({ partId: raw.partId, target: c.target, reset: c.reset, files: await unzip(Buffer.from(c.zipcontent, 'base64')) });
      }
    }
    return { plan, result, events: [...this.inst.events.drain()], config: await loadConfig(this.configPath) };
  }

  /** Hand-edit vocareum.yaml, as a user would. */
  async editConfig(edit: (config: Config) => void): Promise<void> {
    const config = await loadConfig(this.configPath);
    edit(config);
    await fs.writeFile(this.configPath, yaml.dump(config, { lineWidth: -1, noRefs: true }));
  }

  abs(rel: string): string {
    return path.join(this.root, LAB, rel);
  }

  async read(rel: string): Promise<string> {
    return fs.readFile(this.abs(rel), 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    return fs.lstat(this.abs(rel)).then(() => true, () => false);
  }

  async write(rel: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fs.writeFile(this.abs(rel), data);
  }

  async hash(dir: string): Promise<string> {
    return calculateDirectoryHash(this.abs(dir), EXCLUDE);
  }

  async cleanup(): Promise<void> {
    if (this.root !== '') { await fs.rm(this.root, { recursive: true, force: true }); }
  }
}

const zipNotUsed = (events: ServiceEvent[]): unknown[] =>
  events.filter((e) => e.code === 'zip_not_used').map((e) => e.data);
const history = (config: Config): PublishHistory | undefined => config.publish_history?.[0];
const state = (config: Config): Record<string, string> => history(config)?.content_state ?? {};
const diffs = (run: PullRun): { filePath: string; status: string }[] =>
  run.inspection.contentDrift.flatMap((a) => a.partsDrift.flatMap((p) => p.fileDiffs))
    .map((d) => ({ filePath: d.filePath, status: d.status }))
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

/** A tree with only `startercode` and `docs` present; every other directory is missing remotely. */
function labTree(): FakeVocareumTree {
  return new FakeVocareumTree()
    .file('/voc/startercode/main.py', 'print(1)\n')
    .file('/voc/startercode/util/helpers.py', 'def h(): pass\n')
    .file('/voc/docs/README.md', '# Lab\n');
}

let worlds: World[] = [];
async function world(tree: FakeVocareumTree = labTree()): Promise<World> {
  const w = new World(tree);
  await w.init();
  worlds.push(w);
  return w;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const w of worlds) { await w.cleanup(); }
  worlds = [];
});

/** A world whose assignment was imported through the zip path, with nothing rejected. */
async function imported(tree: FakeVocareumTree = labTree()): Promise<World> {
  const w = await world(tree);
  const run = await w.import(w.zip());
  expect(run.result.imported).toBe(1);
  expect(zipNotUsed(run.events)).toEqual([]);
  return w;
}

/**
 * The directories after `startercode` in an imported part, in pull order. A
 * quarantined part reports every later directory, missing ones included:
 * quarantine is checked before step 1, so their absence is never learned.
 */
const LATER_DIRS = ['scripts', 'docs', 'data', 'private', 'lib', 'asnlib'];
const quarantinedAfter = (first: Record<string, unknown>): unknown[] => [
  { part_id: PART, directory: 'startercode', quarantined: true, ...first },
  ...LATER_DIRS.map((directory) => ({ part_id: PART, directory, reason: 'quarantined', quarantined: false })),
];

const starts = (w: World): number => w.tree.requests('start').length;
const blocked = (events: ServiceEvent[]): unknown[] =>
  events.filter((e) => e.code === 'directory_blocked').map((e) => e.data);
const uploadedTargets = (w: World): string[] => w.puts.map((p) => p.target);

describe('S30 round-trip matrix: placeholder and type changes', () => {
  it('file → directory after the zip was built: the zip file is kept (zip-only deviation); the next pull corrects it', async () => {
    const w = await imported(labTree().file('/voc/startercode/x', 'v1\n'));
    w.tree.file('/voc/startercode/x', 'v2\n');
    w.tree.onWritten = (job) => {
      if (job.dir !== '/voc/startercode') { return; }
      w.tree.remove('/voc/startercode/x').file('/voc/startercode/x/y', 'why\n');
      w.tree.onWritten = () => undefined;
    };
    const first = await w.drift(w.zip());
    expect(zipNotUsed(first.events)).toEqual([]);
    expect(diffs(first)).toEqual([{ filePath: 'startercode/x', status: 'modified' }]);
    expect(await w.read('startercode/x')).toBe('v2\n');

    const second = await w.drift(w.zip());
    expect(zipNotUsed(second.events)).toEqual([]);
    expect(diffs(second)).toEqual([
      { filePath: 'startercode/x', status: 'deleted' },
      { filePath: 'startercode/x/y', status: 'added' },
    ]);
    expect(await w.read('startercode/x/y')).toBe('why\n');
  });
});
