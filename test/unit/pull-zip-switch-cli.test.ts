import { spawn } from 'child_process';
import { createServer, Server } from 'http';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules/.bin/tsx');
const CLI = join(process.cwd(), 'src/index.ts');

let server: Server;
let requests = 0;
let baseUrl = '';
let dir = '';
let configPath = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests += 1;
    res.statusCode = 500;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  dir = mkdtempSync(join(tmpdir(), 'vocgit-zip-switch-'));
  configPath = join(dir, 'vocareum.yaml');
  writeFileSync(
    configPath,
    `version: "1.0"\nvocareum:\n  org_id: "1"\n  course_id: "2"\n  api_base_url: "${baseUrl}"\nassignments: []\n`,
  );
});

afterAll(() => {
  server.close();
});

function run(env: Record<string, string>, extra: string[]): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [CLI, 'pull', '--config', configPath, '--root', dir, ...extra], {
      env: { ...process.env, VOCAREUM_API_TOKEN: 'T', VOCAREUM_ALLOW_CUSTOM_BASE_URL: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

describe('S16: an invalid switch fails fast as a usage error, before any request', () => {
  it.each([
    ['VOCAREUM_PULL_ZIP=of', { VOCAREUM_PULL_ZIP: 'of' }],
    ['invalid timeout with zip off', { VOCAREUM_PULL_ZIP: 'off', VOCAREUM_ZIP_TIMEOUT_MS: '999' }],
  ])('%s with --json: exit 2, no request, one usage document', async (_label, env) => {
    const before = requests;
    const { status, stdout } = await run(env, ['--json']);
    expect(status).toBe(2);
    expect(requests).toBe(before);
    const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]) as { result: string; error: { code: string } };
    expect(doc.result).toBe('failed');
    expect(doc.error.code).toBe('usage');
    expect(JSON.stringify(doc.error)).toMatch(/VOCAREUM_(PULL_ZIP|ZIP_TIMEOUT_MS)/);
  });

  it.each([
    ['VOCAREUM_PULL_ZIP=of', { VOCAREUM_PULL_ZIP: 'of' }],
    ['invalid timeout with zip off', { VOCAREUM_PULL_ZIP: 'off', VOCAREUM_ZIP_TIMEOUT_MS: '999' }],
  ])('%s without --json: exit 2, no request, empty stdout', async (_label, env) => {
    const before = requests;
    const { status, stdout } = await run(env, []);
    expect(status).toBe(2);
    expect(requests).toBe(before);
    expect(stdout.trim()).toBe('');
  });

  // Control: proves the harness can see a request, so "no request" above means something.
  it('a valid switch value does reach the API', async () => {
    const before = requests;
    await run({ VOCAREUM_PULL_ZIP: 'off' }, ['--json']);
    expect(requests).toBeGreaterThan(before);
  });
});
