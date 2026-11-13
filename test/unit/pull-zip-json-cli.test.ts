/**
 * S38: `vocgit pull --content --json` through the real CLI, with the zip path
 * on and one zip rejection. The CLI is spawned against a local HTTP server
 * that serves one `FakeVocareumTree` (its own adapter answers every `/files`
 * request) plus the course, assignment and part endpoints.
 *
 * The rejection is `url_rejected`: the poll reports a signed URL on `http:`,
 * which step 3 refuses, so nothing ever leaves the machine. stdout must carry
 * exactly one envelope with exactly one `zip_not_used`, and the exit code is
 * whatever the walk's result decides (spec "Diagnostics and `--json`").
 */
import { spawn } from 'child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSIGNMENT, COURSE, FakeVocareumTree, PART } from '../helpers/fake-vocareum-tree';

const TSX = join(process.cwd(), 'node_modules/.bin/tsx');
const CLI = join(process.cwd(), 'src/index.ts');
const SIGNATURE = 'SIGSECRET-S38';

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
  // The job "succeeds" with a signed URL on http:, which step 3 rejects.
  tree.intercept = (kind) => (kind === 'poll'
    ? { state: 'success', message: `${served.baseUrl}/s3/u1_p${PART}.zip?X-Amz-Signature=${SIGNATURE}` }
    : undefined);
  return served;
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) { c(); }
  cleanups = [];
});

/** A workspace whose `lab-one/startercode` holds `local`, configured for the served course. */
function workspace(baseUrl: string, local: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vocgit-zip-json-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(local)) {
    const file = join(dir, 'lab-one', 'startercode', name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(join(dir, 'vocareum.yaml'), [
    'version: "1.0"',
    'vocareum:',
    '  org_id: "1"',
    `  course_id: "${COURSE}"`,
    `  api_base_url: "${baseUrl}"`,
    'assignments:',
    `  - assignment_id: "${ASSIGNMENT}"`,
    '    name: Lab One',
    '    path: lab-one',
    '    create_from_template: false',
    '    parts:',
    `      - part_id: "${PART}"`,
    '        path: "."',
    '        name: Part 1',
    '        directories: [startercode]',
    'publish_options:',
    '  sync_settings: false',
    '  sync_rubrics: false',
    '',
  ].join('\n'));
  return dir;
}

interface CliRun { status: number | null; stdout: string; stderr: string }

function pull(dir: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, 'pull', '--content', '--json', '--config', join(dir, 'vocareum.yaml'), '--root', dir], {
      env: {
        ...process.env,
        VOCAREUM_API_TOKEN: 'T',
        VOCAREUM_ALLOW_CUSTOM_BASE_URL: '1',
        VOCAREUM_PULL_ZIP: 'on',
        VOCAREUM_ZIP_TIMEOUT_MS: '',
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
  diagnostics: { code: string; severity: string; count: number; data?: Record<string, unknown> }[];
}

function oneEnvelope(run: CliRun): Envelope {
  const lines = run.stdout.split('\n').filter((l) => l.trim().length > 0);
  expect(lines, run.stderr).toHaveLength(1);
  return JSON.parse(lines[0]) as Envelope;
}

async function scenario(remote: (tree: FakeVocareumTree) => void, local: Record<string, string>): Promise<{ run: CliRun; doc: Envelope; served: Served }> {
  const tree = new FakeVocareumTree()
    .file('/voc/startercode/main.py', 'print(1)\n')
    .file('/voc/startercode/util/helpers.py', 'def h(): pass\n');
  remote(tree);
  const served = await serve(tree);
  cleanups.push(() => served.server.close());
  const run = await pull(workspace(served.baseUrl, local));
  return { run, doc: oneEnvelope(run), served };
}

const LOCAL = { 'main.py': 'print(1)\n', 'util/helpers.py': 'def h(): pass\n' };
const ZIP_REJECTED = { part_id: PART, directory: 'startercode', reason: 'url_rejected', quarantined: true };

describe('S38: pull --content --json with one zip rejection', () => {
  it('remote equals local: one envelope, one zip_not_used (quarantined), the walk finds nothing — exit 0', async () => {
    const { run, doc, served } = await scenario(() => undefined, LOCAL);
    expect(served.tree.requests('start')).toHaveLength(1);
    expect(doc.diagnostics.filter((d) => d.code === 'zip_not_used')).toEqual([
      expect.objectContaining({ severity: 'warn', count: 1, data: ZIP_REJECTED }),
    ]);
    expect(doc.result).toBe('no-op');
    expect(run.status).toBe(0);
    // The signed URL's query string never reaches stdout or stderr.
    expect(run.stdout).not.toContain(SIGNATURE);
    expect(run.stderr).not.toContain(SIGNATURE);
  }, 60_000);

  it('the walk finds a remote change: still one zip_not_used; reported, exit 5', async () => {
    const { run, doc } = await scenario((tree) => { tree.file('/voc/startercode/main.py', 'print(2)\n'); }, LOCAL);
    expect(doc.diagnostics.filter((d) => d.code === 'zip_not_used').map((d) => d.data)).toEqual([ZIP_REJECTED]);
    expect(doc.result).toBe('reported');
    expect(run.status).toBe(5);
  }, 60_000);

  it('an incomplete pull through the zip path: the strict walk meets an unreadable link — partial, exit 6', async () => {
    const { run, doc } = await scenario((tree) => { tree.link('/voc/startercode/broken'); }, LOCAL);
    expect(doc.diagnostics.filter((d) => d.code === 'zip_not_used').map((d) => d.data)).toEqual([ZIP_REJECTED]);
    expect(doc.result).toBe('partial');
    expect(run.status).toBe(6);
  }, 60_000);
});
