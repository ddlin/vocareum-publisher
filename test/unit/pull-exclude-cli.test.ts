/**
 * X1-X12 (command level): `vocgit pull` through the real CLI against a local
 * HTTP server serving one `FakeVocareumTree`, with `publish_options.exclude_patterns`.
 * They pin what service tests cannot see: exit codes, history markers, the
 * command's apply gate (hash refresh alone applies) and push planning.
 * Customer shape: `data/a.txt` plus `data/py313-venv/bin/python`, an unreadable link.
 */
import { spawn } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import * as yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSIGNMENT, COURSE, FakeVocareumTree, PART } from '../helpers/fake-vocareum-tree';
import { calculateDirectoryHash } from '../../src/utils/files';
import { detectChangedDirectories, publishExcludePatterns } from '../../src/core/local-scan';
import type { Config, DirectoryType } from '../../src/types/config';

const TSX = join(process.cwd(), 'node_modules/.bin/tsx');
const CLI = join(process.cwd(), 'src/index.ts');

interface Served {
  server: Server;
  baseUrl: string;
  tree: FakeVocareumTree;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Serve `tree` as the Vocareum v2 API for one course, one assignment, one part. */
async function serve(tree: FakeVocareumTree): Promise<Served> {
  const served = { tree, baseUrl: '' } as Served;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname.replace(/^\/api\/v2/, '');
    if (p.startsWith('/download/')) {
      const r = tree.resolve(tree.fileApiPath(decodeURIComponent(p.slice('/download/'.length))));
      if (r?.node.kind !== 'file') { res.statusCode = 404; res.end(); return; }
      res.end(r.node.data);
      return;
    }
    if (p.endsWith('/files')) {
      const params: Record<string, unknown> = {};
      for (const [k, v] of url.searchParams) {
        params[k] = k === 'list' ? v === 'true' : k === 'page' ? Number(v) : v;
      }
      try {
        const out = await tree.adapter({ params, url: p, headers: {} } as unknown as InternalAxiosRequestConfig) as { data: unknown };
        const data = out.data as { files?: { filename: string; download_url: string }[] };
        // The walk's signed download comes back to this server, never the internet.
        if (typeof params.filename === 'string' && Array.isArray(data.files)) {
          for (const f of data.files) { f.download_url = `${served.baseUrl}/download/${encodeURIComponent(f.filename)}`; }
        }
        send(res, 200, data);
      } catch (error) {
        if (error instanceof AxiosError && error.response !== undefined) {
          send(res, error.response.status, error.response.data);
        } else {
          send(res, 500, { error: { message: String(error) } });
        }
      }
      return;
    }
    const course = `/courses/${COURSE}`;
    const asn = `${course}/assignments/${ASSIGNMENT}`;
    const part = { id: PART, name: 'Part 1', seqnum: '0', deleted: '0' };
    if (p === course) { send(res, 200, { courses: [{ id: COURSE, name: 'Course' }] }); return; }
    if (p === `${course}/assignments`) { send(res, 200, { assignments: [{ id: ASSIGNMENT, name: 'Lab One' }], total_records: 1 }); return; }
    if (p === asn) { send(res, 200, { assignments: [{ id: ASSIGNMENT, name: 'Lab One' }] }); return; }
    if (p === `${asn}/parts`) { send(res, 200, { parts: [part] }); return; }
    if (p === `${asn}/parts/${PART}`) { send(res, 200, { parts: [part] }); return; }
    send(res, 404, { error: { message: `not served: ${p}` } });
  };
  served.server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => served.server.listen(0, '127.0.0.1', resolve));
  const addr = served.server.address();
  served.baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  // A zip job, if one were ever started, would "succeed" with an http: URL that step 3 rejects.
  tree.intercept = (kind) => (kind === 'poll'
    ? { state: 'success', message: `${served.baseUrl}/s3/u1_p${PART}.zip?X-Amz-Signature=SIGSECRET-X` }
    : undefined);
  return served;
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) { c(); }
  cleanups = [];
});


const VENV = 'py313-venv';

/** Customer shape: one readable file and a venv whose interpreter is an unreadable link. */
function customerTree(): FakeVocareumTree {
  return new FakeVocareumTree()
    .file('/voc/data/a.txt', 'alpha\n')
    .link(`/voc/data/${VENV}/bin/python`);
}

interface Setup {
  /** Local files under `lab-one/data/`. Present only when the assignment is already in the config. */
  local?: Record<string, string>;
  /** True: the assignment is in vocareum.yaml (a drift pull); false: pull imports it. */
  configured?: boolean;
  patterns?: string[];
  history?: Record<string, string>;
}

function workspace(baseUrl: string, setup: Setup): string {
  const dir = mkdtempSync(join(tmpdir(), 'vocgit-exclude-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(setup.local ?? {})) {
    const file = join(dir, 'lab-one', 'data', name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  const doc: Record<string, unknown> = {
    version: '1.0',
    vocareum: { org_id: '1', course_id: COURSE, api_base_url: baseUrl },
    assignments: setup.configured === true
      ? [{
        assignment_id: ASSIGNMENT,
        name: 'Lab One',
        path: 'lab-one',
        create_from_template: false,
        parts: [{ part_id: PART, path: '.', name: 'Part 1', directories: ['data'] }],
      }]
      : [],
    publish_options: {
      sync_settings: false,
      sync_rubrics: false,
      ...(setup.patterns !== undefined ? { exclude_patterns: setup.patterns } : {}),
    },
    ...(setup.history !== undefined
      ? { publish_history: [{ timestamp: '2026-01-01T00:00:00.000Z', commit_sha: 'abc', published_by: 'test', status: 'success', content_state: setup.history }] }
      : {}),
  };
  writeFileSync(join(dir, 'vocareum.yaml'), yaml.dump(doc));
  return dir;
}

interface CliRun { status: number | null; stdout: string; stderr: string }

function pull(dir: string, extraArgs: string[] = [], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, 'pull', ...(extraArgs.includes('--batch') ? [] : ['--non-interactive']), '--content', ...extraArgs, '--config', join(dir, 'vocareum.yaml'), '--root', dir], {
      env: {
        ...process.env,
        VOCAREUM_API_TOKEN: 'T',
        VOCAREUM_ALLOW_CUSTOM_BASE_URL: '1',
        VOCAREUM_PULL_ZIP: 'off',
        VOCAREUM_ZIP_TIMEOUT_MS: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

interface Envelope {
  result: string;
  diagnostics: { code: string }[];
  payload: {
    applied: { hashesRefreshed: number };
    inspection: { hashRefresh?: Record<string, unknown>[] };
  };
}

function oneEnvelope(run: CliRun): Envelope {
  const lines = run.stdout.split('\n').filter((l) => l.trim().length > 0);
  expect(lines, run.stderr).toHaveLength(1);
  return JSON.parse(lines[0]) as Envelope;
}

function readConfig(dir: string): Config {
  return yaml.load(readFileSync(join(dir, 'vocareum.yaml'), 'utf8')) as Config;
}

/** Serve `tree`, build the workspace and run one pull. */
async function scenario(
  tree: FakeVocareumTree,
  setup: Setup,
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): Promise<{ run: CliRun; dir: string; served: Served; config: Config }> {
  const served = await serve(tree);
  cleanups.push(() => served.server.close());
  const dir = workspace(served.baseUrl, setup);
  // An orphan import needs --batch: --non-interactive (and --json) skip imports.
  const args = setup.configured === true ? extraArgs : ['--batch', ...extraArgs];
  const run = await pull(dir, args, env);
  return { run, dir, served, config: readConfig(dir) };
}

/** Every file under `root`, relative and sorted. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) { return []; }
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      if (statSync(p).isDirectory()) { walk(p, r); } else { out.push(r); }
    }
  };
  walk(root, '');
  return out.sort();
}

function importedDataDir(dir: string, config: Config): string {
  const asn = config.assignments[0];
  return join(dir, asn.path, 'data');
}

function stateOf(config: Config): Record<string, string> {
  return config.publish_history?.[0]?.content_state ?? {};
}

const LOCAL = { 'a.txt': 'alpha\n', [`${VENV}/bin/python`]: '#!local\n' };
const STATE_KEY = 'lab-one/data';
const BASE_EXCLUDES = ['.gitkeep', '**/.gitkeep'];

describe('X: pull with exclude_patterns through the CLI', () => {
  it('X1: pull --non-interactive --content with ["py313-venv"] -> exit 0, no incomplete-pull marker, history status success', async () => {
    const { run, config, dir } = await scenario(customerTree(), { patterns: [VENV] });
    expect(run.status, run.stderr).toBe(0);
    const state = stateOf(config);
    expect(Object.values(state)).not.toContain('incomplete-pull');
    expect(config.publish_history?.[0]?.status).toBe('success');
    expect(filesUnder(importedDataDir(dir, config))).toEqual(['a.txt']);
  }, 60_000);

  it('X2: same course, no pattern -> exit 6, content_state[asn/data] === "incomplete-pull" after an import', async () => {
    const { run, config } = await scenario(customerTree(), {});
    expect(run.status, run.stderr).toBe(6);
    const key = Object.keys(stateOf(config)).find((k) => k.endsWith('/data'));
    expect(key).toBeDefined();
    expect(stateOf(config)[key as string]).toBe('incomplete-pull');
  }, 60_000);

  it('X11: an unrelated unreadable link data/bad with the pattern set -> exit 6', async () => {
    const tree = customerTree().link('/voc/data/bad');
    const { run } = await scenario(tree, { patterns: [VENV] });
    expect(run.status, run.stderr).toBe(6);
  }, 60_000);

  it('X12: data/uv-python/lib unreadable, only py313-venv excluded -> exit 6; both excluded -> exit 0', async () => {
    const make = (): FakeVocareumTree => customerTree().link('/voc/data/uv-python/lib');
    const one = await scenario(make(), { patterns: [VENV] });
    expect(one.run.status, one.run.stderr).toBe(6);
    const both = await scenario(make(), { patterns: [VENV, 'uv-python'] });
    expect(both.run.status, both.run.stderr).toBe(0);
  }, 120_000);

  it('X6: stored hash includes the venv -> applied, hashesRefreshed 1, exclusion-aware hash written, push plans no upload of data/', async () => {
    const tree = customerTree();
    const served = await serve(tree);
    cleanups.push(() => served.server.close());
    const dir = workspace(served.baseUrl, { configured: true, patterns: [VENV], local: LOCAL });
    const dataDir = join(dir, 'lab-one', 'data');
    const stale = await calculateDirectoryHash(dataDir, BASE_EXCLUDES);
    // Rewrite the config with the venv-inclusive hash as the stored state.
    const seeded = readConfig(dir) as unknown as Record<string, unknown>;
    seeded.publish_history = [{ timestamp: '2026-01-01T00:00:00.000Z', commit_sha: 'abc', published_by: 'test', status: 'success', content_state: { [STATE_KEY]: stale } }];
    writeFileSync(join(dir, 'vocareum.yaml'), yaml.dump(seeded));

    const run = await pull(dir);
    expect(run.status, run.stderr).toBe(0);
    const config = readConfig(dir);
    const expected = await calculateDirectoryHash(dataDir, publishExcludePatterns(config));
    expect(expected).not.toBe(stale);
    expect(stateOf(config)[STATE_KEY]).toBe(expected);

    const part = config.assignments[0].parts[0];
    const planned = await detectChangedDirectories(
      config.assignments[0].path, part.path, part.directories as DirectoryType[],
      config.publish_history?.[0], false, publishExcludePatterns(config), dir,
    );
    expect(planned.changedDirs).toEqual([]);
    expect(planned.blockedDirs).toEqual([]);

    // The result is "applied" and counts one refresh (re-seed and use --json).
    writeFileSync(join(dir, 'vocareum.yaml'), yaml.dump(seeded));
    const json = await pull(dir, ['--json']);
    expect(json.status, json.stderr).toBe(0);
    const doc = oneEnvelope(json);
    expect(doc.result).toBe('applied');
    expect(doc.payload.applied.hashesRefreshed).toBe(1);
    expect(doc.payload.inspection.hashRefresh).toHaveLength(1);
    // Never the absolute directory or the hash.
    expect(Object.keys((doc.payload.inspection.hashRefresh as Record<string, unknown>[])[0]).sort()).toEqual(['assignmentName', 'stateKey']);
    expect(json.stdout).not.toContain(stale);
    expect(json.stdout).not.toContain(expected);
    expect(json.stdout).not.toContain(dir);

    // X6 unchanged row: a second identical pull changes nothing.
    const before = readFileSync(join(dir, 'vocareum.yaml'));
    const again = await pull(dir, ['--json']);
    expect(again.status, again.stderr).toBe(0);
    expect(oneEnvelope(again).result).toBe('no-op');
    expect(readFileSync(join(dir, 'vocareum.yaml')).equals(before)).toBe(true);
  }, 120_000);

  it('X6d: stored incomplete-pull, identical content -> the marker is replaced by the hash; push no longer blocks data', async () => {
    const served = await serve(customerTree());
    cleanups.push(() => served.server.close());
    const dir = workspace(served.baseUrl, { configured: true, patterns: [VENV], local: LOCAL, history: { [STATE_KEY]: 'incomplete-pull' } });
    const run = await pull(dir);
    expect(run.status, run.stderr).toBe(0);
    const config = readConfig(dir);
    const expected = await calculateDirectoryHash(join(dir, 'lab-one', 'data'), publishExcludePatterns(config));
    expect(stateOf(config)[STATE_KEY]).toBe(expected);
    const part = config.assignments[0].parts[0];
    const planned = await detectChangedDirectories(
      config.assignments[0].path, part.path, part.directories as DirectoryType[],
      config.publish_history?.[0], false, publishExcludePatterns(config), dir,
    );
    expect(planned.blockedDirs).toEqual([]);
    expect(planned.changedDirs).toEqual([]);
  }, 60_000);

  it('X8: VOCAREUM_PULL_ZIP on, pattern set -> no zip start request, no zip_not_used, same files as X1 (venv and venv/**)', async () => {
    const zipOn = { VOCAREUM_PULL_ZIP: 'on' };
    // Drift check (--json): the pattern keeps the zip off at the drift call site.
    const drift = await scenario(customerTree(), { configured: true, patterns: [VENV], local: LOCAL }, ['--json'], zipOn);
    expect(drift.run.status, drift.run.stderr).toBe(0);
    expect(drift.served.tree.requests('start')).toHaveLength(0);
    expect(oneEnvelope(drift.run).diagnostics.map((d) => d.code)).not.toContain('zip_not_used');
    // Import: no zip job either, and both spellings of the exclusion pull the same files.
    const files: string[][] = [];
    for (const patterns of [[VENV], [VENV, `${VENV}/**`]]) {
      const { run, served, dir, config } = await scenario(customerTree(), { patterns }, [], zipOn);
      expect(run.status, run.stderr).toBe(0);
      expect(served.tree.requests('start')).toHaveLength(0);
      expect(run.stderr).not.toContain('zip_not_used');
      files.push(filesUnder(importedDataDir(dir, config)));
    }
    expect(files[0]).toEqual(['a.txt']);
    expect(files[1]).toEqual(files[0]);
  }, 120_000);

  it('reporting: --json document and human summary carry no excluded-path count', async () => {
    const json = await scenario(customerTree(), { configured: true, patterns: [VENV], local: LOCAL }, ['--json']);
    expect(json.run.status, json.run.stderr).toBe(0);
    // `applied.excluded` is the pre-existing excluded-assignments counter, not a path count.
    expect(json.run.stdout).not.toContain(VENV);
    expect(json.run.stdout).not.toMatch(/exclude_patterns|excludedPath|excludedFile/i);
    expect((oneEnvelope(json.run).payload.applied as Record<string, unknown>).excluded).toBe(0);
    const human = await scenario(customerTree(), { patterns: [VENV] });
    expect(human.run.status, human.run.stderr).toBe(0);
    // "Excluded:" is the pre-existing excluded-assignments counter; no path or pattern is named.
    expect(`${human.run.stdout}${human.run.stderr}`).not.toContain(VENV);
    expect(`${human.run.stdout}${human.run.stderr}`).not.toMatch(/excluded (path|file|director)/i);
  }, 120_000);
});
