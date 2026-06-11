/**
 * Root-context E2E: spawns the real CLI from a cwd OUTSIDE the workspace and
 * verifies the root-selection contract end to end:
 * - config not directly inside cwd without --root → actionable failure
 * - --root <ws> → scan/hashes resolve against the workspace, not cwd
 * - --root . with a nested config → cwd-relative semantics preserved
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { calculateDirectoryHash } from '../../src/utils/files';

const CLI = path.resolve(__dirname, '../../src/index.ts');
const TSX = path.resolve(__dirname, '../../node_modules/.bin/tsx');

function runCli(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(TSX, [CLI, ...args], { cwd, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error !== null && typeof (error as { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : error !== null ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe('workspace root context (E2E)', () => {
  let workspace: string;
  let foreignCwd: string;

  beforeAll(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voc-root-ws-')));
    foreignCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voc-root-cwd-')));

    await fs.mkdir(path.join(workspace, 'lab1', 'part1', 'startercode'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'lab1', 'part1', 'startercode', 'main.py'), 'print(1)\n');

    const key = path.join('lab1', 'part1', 'startercode');
    const hash = await calculateDirectoryHash(
      path.join(workspace, key),
      ['.gitkeep', '**/.gitkeep']
    );

    await fs.writeFile(path.join(workspace, 'vocareum.yaml'), `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    parts:
      - part_id: "part-1"
        path: "part1"
        directories: [startercode]
publish_history:
  - timestamp: "2026-06-01T00:00:00Z"
    commit_sha: "abc"
    published_by: "test"
    content_state:
      ${key}: "${hash}"
`);
  });

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(foreignCwd, { recursive: true, force: true });
  });

  it('fails with an actionable error when --config is outside cwd and --root is missing', async () => {
    const result = await runCli(
      ['status', '--json', '--config', path.join(workspace, 'vocareum.yaml')],
      foreignCwd
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--root/);
    expect(result.stderr).toMatch(/workspace root/i);
  });

  it('resolves hashes against --root, not cwd (synced from a foreign cwd)', async () => {
    const result = await runCli(
      ['status', '--json', '--config', path.join(workspace, 'vocareum.yaml'), '--root', workspace],
      foreignCwd
    );

    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout) as {
      assignments: Array<{ path: string; status: string }>;
    };
    // With cwd-based resolution this would be needs_publish (dir looks empty);
    // root-based resolution finds the content and matches the recorded hash.
    expect(doc.assignments[0].status).toBe('synced');
  });

  it('runs unchanged from the workspace root without any flags', async () => {
    const result = await runCli(['status', '--json'], workspace);

    expect(result.code).toBe(0);
    const doc = JSON.parse(result.stdout) as {
      assignments: Array<{ status: string }>;
    };
    expect(doc.assignments[0].status).toBe('synced');
  });

  it('supports --root . for a nested config, preserving cwd-relative paths', async () => {
    await fs.mkdir(path.join(workspace, 'configs'), { recursive: true });
    await fs.copyFile(
      path.join(workspace, 'vocareum.yaml'),
      path.join(workspace, 'configs', 'vocareum.yaml')
    );

    const withoutRoot = await runCli(
      ['status', '--json', '--config', 'configs/vocareum.yaml'],
      workspace
    );
    expect(withoutRoot.code).not.toBe(0);
    expect(withoutRoot.stderr).toMatch(/--root/);

    const withRoot = await runCli(
      ['status', '--json', '--config', 'configs/vocareum.yaml', '--root', '.'],
      workspace
    );
    expect(withRoot.code).toBe(0);
    const doc = JSON.parse(withRoot.stdout) as {
      assignments: Array<{ status: string }>;
    };
    expect(doc.assignments[0].status).toBe('synced');
  });
});
