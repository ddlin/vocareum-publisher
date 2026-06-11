import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspaceContext, WorkspaceError } from '../../src/core/workspace';

describe('resolveWorkspaceContext', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voc-workspace-')));
    await fs.writeFile(path.join(tempDir, 'vocareum.yaml'), 'version: "1.0"\n');
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('defaults to cwd when the config sits directly inside cwd', () => {
    const ctx = resolveWorkspaceContext({});

    expect(ctx.workspaceRoot).toBe(tempDir);
    expect(ctx.configPath).toBe(path.join(tempDir, 'vocareum.yaml'));
  });

  it('accepts an explicit relative config that resolves into cwd', () => {
    const ctx = resolveWorkspaceContext({ config: './vocareum.yaml' });

    expect(ctx.workspaceRoot).toBe(tempDir);
  });

  it('accepts an absolute config path inside cwd', () => {
    const ctx = resolveWorkspaceContext({ config: path.join(tempDir, 'vocareum.yaml') });

    expect(ctx.workspaceRoot).toBe(tempDir);
  });

  it('rejects a config outside cwd without --root (ambiguous workspace)', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-other-'));
    try {
      await fs.writeFile(path.join(other, 'vocareum.yaml'), 'version: "1.0"\n');

      expect(() => resolveWorkspaceContext({ config: path.join(other, 'vocareum.yaml') }))
        .toThrow(WorkspaceError);
      expect(() => resolveWorkspaceContext({ config: path.join(other, 'vocareum.yaml') }))
        .toThrow(/--root/);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('rejects a config nested below cwd without --root', async () => {
    await fs.mkdir(path.join(tempDir, 'configs'));
    await fs.writeFile(path.join(tempDir, 'configs', 'vocareum.yaml'), 'version: "1.0"\n');

    expect(() => resolveWorkspaceContext({ config: 'configs/vocareum.yaml' }))
      .toThrow(/--root/);
  });

  it('explicit --root wins for an outside config', async () => {
    const other = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voc-other-')));
    try {
      await fs.writeFile(path.join(other, 'vocareum.yaml'), 'version: "1.0"\n');

      const ctx = resolveWorkspaceContext({
        config: path.join(other, 'vocareum.yaml'),
        root: other,
      });

      expect(ctx.workspaceRoot).toBe(other);
      expect(ctx.configPath).toBe(path.join(other, 'vocareum.yaml'));
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it('--root . preserves cwd-relative semantics for a nested config', async () => {
    await fs.mkdir(path.join(tempDir, 'configs'));
    await fs.writeFile(path.join(tempDir, 'configs', 'vocareum.yaml'), 'version: "1.0"\n');

    const ctx = resolveWorkspaceContext({ config: 'configs/vocareum.yaml', root: '.' });

    expect(ctx.workspaceRoot).toBe(tempDir);
    expect(ctx.configPath).toBe(path.join(tempDir, 'configs', 'vocareum.yaml'));
  });

  it('rejects a --root directory that does not exist', () => {
    expect(() => resolveWorkspaceContext({ root: path.join(tempDir, 'missing') }))
      .toThrow(WorkspaceError);
  });
});
