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
import { buildZip } from '../helpers/zip-fixture';

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

/** The part PUT body the uploader sends (`content[].zipcontent`, AGENTS.md #2). */
interface PartPutBody { content: { target: string; zipcontent: string; reset: number }[] }

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
  private readonly rawPuts: { partId: string; body: PartPutBody }[] = [];

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
      const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as PartPutBody;
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

describe('S30 round-trip matrix: added, removed, changed, unchanged via zip', () => {
  it('import via zip: files on disk, hashes in content_state, no zip_not_used', async () => {
    const w = await world();
    const run = await w.import(w.zip());
    expect(run.result.imported).toBe(1);
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(w.tree.requests('start').map((e) => e.path).sort()).toEqual(['/voc/docs', '/voc/startercode']);
    expect(w.tree.requests('fetch')).toEqual([]);
    expect(await w.read('startercode/util/helpers.py')).toBe('def h(): pass\n');
    expect(history(run.config)?.status).toBe('success');
    expect(state(run.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
  });

  it('added: remote gains a file — drift via zip reports added, batch apply writes it and advances the hash', async () => {
    const w = await imported();
    w.tree.file('/voc/startercode/new.txt', 'new\n');
    const before = starts(w);
    const run = await w.drift(w.zip());
    expect(starts(w)).toBeGreaterThan(before);
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([{ filePath: 'startercode/new.txt', status: 'added' }]);
    expect(await w.read('startercode/new.txt')).toBe('new\n');
    expect(state(run.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
    expect(history(run.config)?.status).toBe('success');
  });

  it('removed: remote file deleted — drift via zip reports deleted, batch apply unlinks it', async () => {
    const w = await imported();
    w.tree.remove('/voc/startercode/util/helpers.py');
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([{ filePath: 'startercode/util/helpers.py', status: 'deleted' }]);
    expect(await w.exists('startercode/util/helpers.py')).toBe(false);
    expect(state(run.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
  });

  it('removed: remote directory emptied entirely — no zip, no warning; every local file deleted', async () => {
    const w = await imported();
    w.tree.remove('/voc/startercode/main.py').remove('/voc/startercode/util');
    const before = w.tree.requests('start', '/voc/startercode').length;
    const run = await w.drift(w.zip());
    expect(w.tree.requests('start', '/voc/startercode')).toHaveLength(before);
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([
      { filePath: 'startercode/main.py', status: 'deleted' },
      { filePath: 'startercode/util/helpers.py', status: 'deleted' },
    ]);
    expect(await w.exists('startercode/main.py')).toBe(false);
  });

  it('removed: directory emptied between step 1 and the start — deadline, quarantined, the walk sees it empty', async () => {
    const w = await imported();
    w.tree.intercept = (kind, p) => {
      if (kind === 'start' && p === '/voc/startercode') {
        w.tree.remove('/voc/startercode/main.py').remove('/voc/startercode/util');
      }
      return undefined;
    };
    const run = await w.drift(w.zip(5_000));
    expect(zipNotUsed(run.events)).toEqual(quarantinedAfter({ reason: 'deadline' }));
    expect(diffs(run)).toEqual([
      { filePath: 'startercode/main.py', status: 'deleted' },
      { filePath: 'startercode/util/helpers.py', status: 'deleted' },
    ]);
    expect(await w.exists('startercode/main.py')).toBe(false);
  });

  it('removed: file deleted between step 1 and the zip build — absent from zip and listing, no failure', async () => {
    const w = await imported();
    w.tree.intercept = (kind, p) => {
      if (kind === 'start' && p === '/voc/startercode') { w.tree.remove('/voc/startercode/main.py'); }
      return undefined;
    };
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([{ filePath: 'startercode/main.py', status: 'deleted' }]);
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
  });

  it('removed: asnlib dropped from the part directory set — pull and push stop touching it', async () => {
    const w = await imported(labTree().file('/resource/asnlib/grader.py', 'g\n'));
    expect(await w.read('asnlib/grader.py')).toBe('g\n');
    await w.editConfig((c) => {
      const part = c.assignments[0].parts[0];
      part.directories = (part.directories ?? []).filter((d) => d !== 'asnlib');
    });
    w.tree.file('/resource/asnlib/grader.py', 'g2\n');
    const listedBefore = w.tree.requests('list', '/resource/asnlib').length;
    const run = await w.drift(w.zip());
    expect(w.tree.requests('list', '/resource/asnlib')).toHaveLength(listedBefore);
    expect(diffs(run)).toEqual([]);
    await w.write('asnlib/grader.py', 'local edit\n');
    const pushed = await w.push({ forceAll: true });
    expect(uploadedTargets(w)).not.toContain('asnlib');
    expect(pushed.plan.intent.assignments[0].parts[0].blockedDirectories ?? []).toEqual([]);
  });

  it('changed: remote file content changed — drift via zip reports modified with the new bytes', async () => {
    const w = await imported();
    w.tree.file('/voc/startercode/main.py', 'print(2)\n');
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([{ filePath: 'startercode/main.py', status: 'modified' }]);
    expect(await w.read('startercode/main.py')).toBe('print(2)\n');
    expect(state(run.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
  });

  it('unchanged: nothing changed remotely — zero diffs via zip, nothing written', async () => {
    const w = await imported();
    const historyBefore = (await loadConfig(w.configPath)).publish_history;
    const before = starts(w);
    const run = await w.drift(w.zip());
    expect(starts(w)).toBe(before + 2);
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
    expect(run.config.publish_history).toEqual(historyBefore);
  });
});

describe('S30 round-trip matrix: incomplete', () => {
  /** Imported via zip with one unreadable symlink in startercode. */
  async function incompleteWorld(): Promise<World> {
    const w = await world(labTree().link('/voc/startercode/broken'));
    const run = await w.import(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(run.result.filesNotDownloaded).toBe(1);
    expect(state(run.config)[KEY('startercode')]).toBe(INCOMPLETE_PULL_MARKER);
    expect(state(run.config)[KEY('docs')]).toBe(await w.hash('docs'));
    expect(history(run.config)?.status).toBe('failed');
    expect(history(run.config)?.failed?.map((f) => f.id)).toEqual([path.join(LAB, 'startercode', 'broken')]);
    return w;
  }

  it('incomplete: an unreadable symlink — failure recorded, marker set; push refuses the directory with incomplete-pull', async () => {
    const w = await incompleteWorld();
    await w.write('startercode/main.py', 'print("edited")\n');
    const run = await w.push();
    expect(blocked(run.events)).toEqual([{ part_id: PART, directory: 'startercode', reason: 'incomplete-pull' }]);
    expect(uploadedTargets(w)).not.toContain('startercode');
    expect(run.result.success).toBe(false);
    expect(state(run.config)[KEY('startercode')]).toBe(INCOMPLETE_PULL_MARKER);
  });

  it('incomplete → recovered: the cause is gone, zero file diffs — still drift; apply replaces the marker with a hash', async () => {
    const w = await incompleteWorld();
    w.tree.remove('/voc/startercode/broken');
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([]);
    expect(run.inspection.contentDrift[0].partsDrift[0].incompleteDirectories).toEqual(['startercode']);
    expect(state(run.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
    expect(history(run.config)?.status).toBe('success');
  });

  it('incomplete → still incomplete: a local symlink sits at a destination — not written, the marker stays', async () => {
    const w = await incompleteWorld();
    w.tree.remove('/voc/startercode/broken');
    w.tree.file('/voc/startercode/main.py', 'print(3)\n');
    await fs.rm(w.abs('startercode/main.py'));
    await fs.symlink(w.abs('docs/README.md'), w.abs('startercode/main.py'));
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(run.inspection.contentDrift[0].partsDrift[0].stillIncompleteDirectories).toEqual(['startercode']);
    expect((await fs.lstat(w.abs('startercode/main.py'))).isSymbolicLink()).toBe(true);
    expect(await w.read('docs/README.md')).toBe('# Lab\n');
    expect(state(run.config)[KEY('startercode')]).toBe(INCOMPLETE_PULL_MARKER);
    expect(history(run.config)?.status).toBe('failed');
  });
});

describe('S30 round-trip matrix: managed link', () => {
  it('lib/publicdata: a managed link — never a failure on import, never a deletion on drift', async () => {
    const w = await imported(labTree().file('/resource/lib/util.py', 'x = 1\n').link('/resource/lib/publicdata'));
    const cfg = await loadConfig(w.configPath);
    expect(history(cfg)?.status).toBe('success');
    expect(state(cfg)[KEY('lib')]).toBe(await w.hash('lib'));
    expect(await w.read('lib/util.py')).toBe('x = 1\n');

    await w.write('lib/publicdata/local.csv', 'a,b\n');
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([]);
    expect(await w.read('lib/publicdata/local.csv')).toBe('a,b\n');
  });
});

/** A Container `asnlib` with an alias directory: listable and zipped, refused file by file. */
function aliasTree(): FakeVocareumTree {
  return labTree()
    .file('/resource/asnlib/grader.py', 'grade()\n')
    .dir('/resource/asnlib/public/docs', true)
    .file('/resource/asnlib/public/docs/guide.md', 'guide\n')
    .file('/resource/asnlib/public/docs/extra.md', 'extra\n');
}

describe('S30 round-trip matrix: directory aliases', () => {
  it('alias, added: asnlib pulled with an alias — alias files kept, no marker', async () => {
    const w = await imported(aliasTree());
    const cfg = await loadConfig(w.configPath);
    expect(await w.read('asnlib/public/docs/guide.md')).toBe('guide\n');
    expect(state(cfg)[KEY('asnlib')]).toBe(await w.hash('asnlib'));
    expect(history(cfg)?.status).toBe('success');
  });

  it('alias, removed: remote alias content deleted — drift reports deleted under asnlib/public/docs', async () => {
    const w = await imported(aliasTree());
    w.tree.remove('/resource/asnlib/public/docs/guide.md');
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(diffs(run)).toEqual([{ filePath: 'asnlib/public/docs/guide.md', status: 'deleted' }]);
    expect(await w.exists('asnlib/public/docs/guide.md')).toBe(false);
    expect(await w.read('asnlib/public/docs/extra.md')).toBe('extra\n');
  });

  it('alias, local-only file: local asnlib/notes.txt absent remotely — drift reports deleted; apply removes it', async () => {
    const w = await imported(aliasTree());
    await w.write('asnlib/notes.txt', 'mine\n');
    const run = await w.drift(w.zip());
    expect(diffs(run)).toEqual([{ filePath: 'asnlib/notes.txt', status: 'deleted' }]);
    expect(await w.exists('asnlib/notes.txt')).toBe(false);
  });
});

describe('S30 round-trip matrix: zip turned off after a zip pull', () => {
  it('no alias directory, remote unchanged: the walk agrees with the zip — zero diffs, no zip request', async () => {
    const w = await imported();
    const before = starts(w);
    const run = await w.drift(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(starts(w)).toBe(before);
    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
  });

  it('Container asnlib with aliases, strict: the walk cannot read the alias — drift skips the assignment, nothing deleted', async () => {
    const w = await imported(aliasTree());
    const run = await w.drift(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.contentDriftIncomplete?.map((s) => s.assignmentName)).toEqual(['Lab One']);
    expect(await w.read('asnlib/public/docs/guide.md')).toBe('guide\n');
  });

  it('Container asnlib with aliases, non-strict: the INCOMPLETE marker comes back; push refuses asnlib with incomplete-pull', async () => {
    const w = await world(aliasTree());
    const run = await w.import(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(w.tree.requests('start')).toEqual([]);
    expect(state(run.config)[KEY('asnlib')]).toBe(INCOMPLETE_PULL_MARKER);
    expect(history(run.config)?.status).toBe('failed');

    const pushed = await w.push();
    expect(blocked(pushed.events)).toEqual([{ part_id: PART, directory: 'asnlib', reason: 'incomplete-pull' }]);
    expect(uploadedTargets(w)).not.toContain('asnlib');
  });

  it('alias removed with zip off, alias still holds files: strict throws, no deletion reported', async () => {
    const w = await imported(aliasTree());
    w.tree.remove('/resource/asnlib/public/docs/guide.md');
    const run = await w.drift(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.contentDriftIncomplete?.map((s) => s.assignmentName)).toEqual(['Lab One']);
    expect(await w.read('asnlib/public/docs/guide.md')).toBe('guide\n');
  });

  it('alias removed with zip off, alias now empty: it lists [], drift reports the local alias files deleted', async () => {
    const w = await imported(aliasTree());
    w.tree.remove('/resource/asnlib/public/docs/guide.md').remove('/resource/asnlib/public/docs/extra.md');
    const run = await w.drift(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
    expect(diffs(run)).toEqual([
      { filePath: 'asnlib/public/docs/extra.md', status: 'deleted' },
      { filePath: 'asnlib/public/docs/guide.md', status: 'deleted' },
    ]);
    expect(await w.exists('asnlib/public/docs/guide.md')).toBe(false);
  });
});

describe('S30 round-trip matrix: placeholder and type changes', () => {
  it('unchanged: a zero-byte placeholder stored by an earlier walk — the zip hands the empty directory to the walk; no drift', async () => {
    const w = await world(labTree().dir('/voc/startercode/empty'));
    // This workspace serves the empty directory as a zero-byte downloadable object too.
    w.tree.intercept = (kind, p) => (kind === 'fetch' && p === 'startercode/empty'
      ? { status: 'success', files: [{ filename: p, download_url: `https://files.example/${p}` }] }
      : undefined);
    vi.mocked(axios.get).mockImplementation((async (url: string, cfg?: { maxContentLength?: number }) =>
      (url.endsWith('/startercode/empty') ? { data: Buffer.alloc(0) } : w.tree.download(url, cfg))) as never);

    const walked = await w.import(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(history(walked.config)?.status).toBe('success');
    expect((await fs.stat(w.abs('startercode/empty'))).size).toBe(0);

    const fetchesBefore = w.tree.requests('fetch', 'startercode/empty').length;
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([]);
    expect(w.tree.requests('fetch', 'startercode/empty')).toHaveLength(fetchesBefore + 1);
    expect(run.inspection.contentDrift).toEqual([]);
    expect(run.inspection.contentDriftIncomplete).toEqual([]);
  });

  it.each([
    ['via zip', true],
    ['with zip off (the walk)', false],
  ])('file → directory after the zip was built: the zip file is kept (zip-only deviation); the next pull, %s, corrects it', async (_label, zipOnSecond) => {
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
    expect(state(first.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
    expect(history(first.config)?.status).toBe('success');

    const startsBefore = starts(w);
    const second = await w.drift(zipOnSecond ? w.zip() : w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(starts(w) > startsBefore).toBe(zipOnSecond);
    expect(zipNotUsed(second.events)).toEqual([]);
    expect(diffs(second)).toEqual([
      { filePath: 'startercode/x', status: 'deleted' },
      { filePath: 'startercode/x/y', status: 'added' },
    ]);
    expect(await w.read('startercode/x/y')).toBe('why\n');
    expect(state(second.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
    expect(history(second.config)?.status).toBe('success');
  });

  it.each([
    ['empty' as const, 'name_mismatch'],
    ['400' as const, 'listing_failed'],
  ])('directory → file after the zip was built (a file path lists as %s): %s, walked; the walk fetches the file, as zip off does', async (fileListing, reason) => {
    const w = await imported(new FakeVocareumTree({ fileListing })
      .file('/voc/startercode/main.py', 'print(1)\n')
      .file('/voc/startercode/d/c.txt', 'c\n'));
    w.tree.onWritten = (job) => {
      if (job.dir !== '/voc/startercode') { return; }
      w.tree.remove('/voc/startercode/d').file('/voc/startercode/d', 'now a file\n');
      w.tree.onWritten = () => undefined;
    };
    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual(quarantinedAfter({ reason }));
    // The walk fetched the new file in place of the zip's directory.
    expect(w.tree.requests('download', 'startercode/d').length).toBeGreaterThan(0);
    // Past the download, drift meets a local directory where the remote now
    // has a file, and skips the assignment: reported, never clean, nothing
    // deleted. That is drift's own pre-existing handling of a type change; the
    // walk alone (zip off) ends the same way.
    expect(diffs(run)).toEqual([]);
    expect(run.inspection.contentDriftIncomplete).toEqual([{ assignmentName: 'Lab One', reason: expect.stringContaining('EISDIR') }]);
    expect(await w.read('startercode/d/c.txt')).toBe('c\n');

    const walked = await imported(new FakeVocareumTree({ fileListing })
      .file('/voc/startercode/main.py', 'print(1)\n')
      .file('/voc/startercode/d/c.txt', 'c\n'));
    walked.tree.remove('/voc/startercode/d').file('/voc/startercode/d', 'now a file\n');
    const walkRun = await walked.drift(walked.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(walkRun.inspection.contentDriftIncomplete).toEqual(run.inspection.contentDriftIncomplete);
  });
});

describe('S30 round-trip matrix: settle check and identical zips (service level)', () => {
  /** Answer every poll for `dir` with success at once, before the job's own object lands. */
  function earlySuccess(w: World, dir: string, onStart?: () => void): void {
    w.tree.intercept = (kind, p) => {
      if (kind === 'start' && p === dir) { onStart?.(); }
      if (kind === 'poll' && p === dir) { return { state: 'success', message: w.tree.signedUrl() }; }
      return undefined;
    };
  }

  it('changed: our own job write lands after we pinned an older object — object_settle_changed, quarantined, walked', async () => {
    // Jobs take 3 s, so our write lands between the pin and the settle point (success + 5 s).
    const w = await imported(new FakeVocareumTree({ jobMs: 3_000 })
      .file('/voc/startercode/main.py', 'print(1)\n')
      .file('/voc/startercode/util/helpers.py', 'def h(): pass\n')
      .file('/voc/docs/README.md', '# Lab\n'));
    // The older object: this directory's previous content, same names, never seen in this run.
    const older = w.tree.buildZipFor('/voc/startercode');
    w.tree.file('/voc/startercode/main.py', 'print(2)\n');
    earlySuccess(w, '/voc/startercode', () => { w.tree.writeObject(performance.now(), older); });

    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual(quarantinedAfter({ reason: 'object_settle_changed' }));
    // The older object's bytes were never taken: the walk saw the new main.py.
    expect(diffs(run)).toEqual([{ filePath: 'startercode/main.py', status: 'modified' }]);
    expect(await w.read('startercode/main.py')).toBe('print(2)\n');
    expect(w.tree.requests('start')).toHaveLength(2 + 1);

    // On disk equals the walk's view.
    w.tree.intercept = () => undefined;
    const walk = await w.drift(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(walk.inspection.contentDrift).toEqual([]);
    expect(walk.inspection.contentDriftIncomplete).toEqual([]);
  });

  it("changed: another directory's object pinned, names equal, our write lands before the settle point — rejected at the settle check", async () => {
    const w = await imported(new FakeVocareumTree({ jobMs: 3_000 })
      .file('/voc/startercode/main.py', 'print(1)\n')
      .file('/voc/docs/README.md', '# Lab\n'));
    w.tree.file('/voc/docs/README.md', '# Lab v2\n');
    // Another directory's zip on the shared object, with docs' names but not its bytes.
    const foreign = buildZip([{ name: 'README.md', data: 'some other directory\n' }]);
    earlySuccess(w, '/voc/docs', () => { w.tree.writeObject(performance.now(), foreign); });

    const run = await w.drift(w.zip());
    expect(zipNotUsed(run.events)).toEqual([
      { part_id: PART, directory: 'docs', reason: 'object_settle_changed', quarantined: true },
      ...['data', 'private', 'lib', 'asnlib'].map((directory) => ({ part_id: PART, directory, reason: 'quarantined', quarantined: false })),
    ]);
    expect(diffs(run)).toEqual([{ filePath: 'docs/README.md', status: 'modified' }]);
    expect(await w.read('docs/README.md')).toBe('# Lab v2\n');
    expect(state(run.config)[KEY('docs')]).toBe(await w.hash('docs'));
  });

  it('unchanged: two directories of a part with byte-identical zips — the second is object_stale, quarantined, walked; same files as the walk', async () => {
    const identical = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/README.md', 'same\n')
      .file('/voc/startercode/sub/a.txt', 'a\n')
      .file('/voc/docs/README.md', 'same\n')
      .file('/voc/docs/sub/a.txt', 'a\n');
    const w = await world(identical());
    const run = await w.import(w.zip());
    expect(zipNotUsed(run.events)).toEqual([
      { part_id: PART, directory: 'docs', reason: 'object_stale', quarantined: true },
      ...['data', 'private', 'lib', 'asnlib'].map((directory) => ({ part_id: PART, directory, reason: 'quarantined', quarantined: false })),
    ]);
    // Pin, then 5 retries: six ranged GETs for docs, after startercode's pin and settle.
    expect(w.tree.requests('s3-range').length).toBe(2 + 6);
    // Only docs is walked (the walk tries `sub` as a file first, as always).
    expect(w.tree.requests('fetch').map((e) => e.path).sort()).toEqual(['docs/README.md', 'docs/sub', 'docs/sub/a.txt']);
    expect(history(run.config)?.status).toBe('success');

    const walked = await world(identical());
    const walkRun = await walked.import(walked.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    for (const dir of ['startercode', 'docs']) {
      expect(await w.hash(dir)).toBe(await walked.hash(dir));
      expect(state(run.config)[KEY(dir)]).toBe(state(walkRun.config)[KEY(dir)]);
    }
    expect(await w.read('docs/sub/a.txt')).toBe('a\n');
  });
});

describe('S30 round-trip matrix: push round trip', () => {
  it('import via zip, edit one startercode file, push: the reset upload holds exactly the imported files plus the edit', async () => {
    const w = await imported();
    await w.write('startercode/main.py', 'print("edited")\n');
    const run = await w.push();
    expect(blocked(run.events)).toEqual([]);
    expect(w.puts).toEqual([{
      partId: PART,
      target: 'startercode',
      reset: 1,
      files: { 'main.py': 'print("edited")\n', 'util/helpers.py': 'def h(): pass\n' },
    }]);
    expect(run.result.success).toBe(true);
    expect(state(run.config)[KEY('startercode')]).toBe(await w.hash('startercode'));
  });
});

describe('S30 round-trip matrix: quarantine (service level)', () => {
  it("one directory's start fails: the part's next directory is walked as quarantined; other parts still use zip", async () => {
    const w = await world();
    w.parts = [{ id: PART, name: 'Part 1' }, { id: PART2, name: 'Part 2' }];
    w.tree.intercept = (kind, p, n) => (kind === 'start' && p === '/voc/startercode' && n === 1 ? new Error('start refused') : undefined);
    const run = await w.import(w.zip());
    expect(zipNotUsed(run.events)).toEqual(quarantinedAfter({ reason: 'start_failed' }));
    // Part 1: one start (refused). Part 2: both directories through the zip.
    expect(w.tree.requests('start', '/voc/startercode')).toHaveLength(2);
    expect(w.tree.requests('start', '/voc/docs')).toHaveLength(1);
    for (const partDir of ['part-1', 'part-2']) {
      expect(await w.read(`${partDir}/startercode/util/helpers.py`)).toBe('def h(): pass\n');
      expect(await w.read(`${partDir}/docs/README.md`)).toBe('# Lab\n');
    }
    expect(history(run.config)?.status).toBe('success');
  });

  it('content reject: step 7 rejects one directory, the next is walked as quarantined with no second start', async () => {
    const w = await world();
    w.tree.onWritten = (job) => {
      if (job.dir === '/voc/startercode') { w.tree.remove('/voc/startercode/main.py'); }
    };
    const run = await w.import(w.zip());
    expect(zipNotUsed(run.events)).toEqual(quarantinedAfter({ reason: 'name_mismatch' }));
    expect(w.tree.requests('start')).toHaveLength(1);
    expect(await w.exists('startercode/main.py')).toBe(false);
    expect(await w.read('startercode/util/helpers.py')).toBe('def h(): pass\n');
    expect(history(run.config)?.status).toBe('success');
  });
});

describe('S30 round-trip matrix: switches through the pull service', () => {
  it('switch, off: VOCAREUM_PULL_ZIP=off — no zip request; the walk imports the same files', async () => {
    const zipped = await imported();
    const w = await world();
    const run = await w.import(w.zipFromEnv({ VOCAREUM_PULL_ZIP: 'off' }));
    expect(w.tree.requests('start')).toEqual([]);
    expect(w.tree.requests('poll')).toEqual([]);
    expect(w.tree.requests('s3-range')).toEqual([]);
    expect(zipNotUsed(run.events)).toEqual([]);
    for (const dir of ['startercode', 'docs']) {
      expect(await w.hash(dir)).toBe(await zipped.hash(dir));
    }
  });

  it.each([
    ['VOCAREUM_PULL_ZIP=of', { VOCAREUM_PULL_ZIP: 'of' }],
    ['VOCAREUM_ZIP_TIMEOUT_MS=1e6 with VOCAREUM_PULL_ZIP=off', { VOCAREUM_PULL_ZIP: 'off', VOCAREUM_ZIP_TIMEOUT_MS: '1e6' }],
  ])('switch, invalid (%s): a bare ConfigError (usage, exit 2) before the service sends any request', async (_label, env) => {
    const w = await world();
    let thrown: unknown;
    try { w.zipFromEnv(env); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).not.toBeInstanceOf(CommandFailureError);
    expect(w.tree.log).toEqual([]);
  });
});
