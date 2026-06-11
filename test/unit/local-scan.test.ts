import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanLocalContent, detectChangedDirectories } from '../../src/core/local-scan';
import { calculateDirectoryHash } from '../../src/utils/files';
import type { Config } from '../../src/types/config';

/**
 * The scanner must mirror the push pipeline exactly:
 * - directories: part.directories ?? architecture set (elite/container) ?? default union
 * - excludes: ['.gitkeep', '**\/.gitkeep', ...publish_options.exclude_patterns]
 * - state key: path.join(assignment.path, part.path, dir)
 * - history entry: publish_history[0] (latest, including failed entries)
 */
describe('scanLocalContent', () => {
  let tempDir: string;

  function makeConfig(overrides: Partial<Config> = {}): Config {
    return {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_ids: [],
        templates: [],
        api_base_url: 'https://api.vocareum.com',
        excluded_assignments: [],
      },
      assignments: [
        {
          assignment_id: 'asn-1',
          name: 'Lab 1',
          path: 'lab1',
          create_from_template: false,
          settings: {},
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              directories: ['startercode'],
              settings: {},
            },
          ],
        },
      ],
      publish_history: [],
      ...overrides,
    } as Config;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-local-scan-'));
    await fs.mkdir(path.join(tempDir, 'lab1', 'part1', 'startercode'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'lab1', 'part1', 'startercode', 'main.py'), 'print(1)\n');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('reports unknown when there is no publish history', async () => {
    const result = await scanLocalContent(makeConfig(), tempDir);

    expect(result.assignments[0].status).toBe('unknown');
    expect(result.assignments[0].parts[0].status).toBe('unknown');
    expect(result.assignments[0].parts[0].directories[0]).toMatchObject({
      directory: 'startercode',
      status: 'unknown',
    });
  });

  it('reports synced when the directory hash matches the recorded content_state', async () => {
    const key = path.join('lab1', 'part1', 'startercode');
    const hash = await calculateDirectoryHash(
      path.join(tempDir, key),
      ['.gitkeep', '**/.gitkeep']
    );
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: { [key]: hash },
      }],
    });

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('synced');
    expect(result.assignments[0].parts[0].directories[0].status).toBe('synced');
    expect(result.summary.needs_publish).toBe(0);
  });

  it('reports needs_publish when local content changed after the last publish', async () => {
    const key = path.join('lab1', 'part1', 'startercode');
    const hash = await calculateDirectoryHash(
      path.join(tempDir, key),
      ['.gitkeep', '**/.gitkeep']
    );
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: { [key]: hash },
      }],
    });

    await fs.writeFile(path.join(tempDir, key, 'extra.py'), 'print(2)\n');

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('needs_publish');
    expect(result.assignments[0].parts[0].directories[0].status).toBe('needs_publish');
    expect(result.summary.needs_publish).toBe(1);
  });

  it('honors exclude patterns the same way as the publisher (.gitkeep ignored)', async () => {
    const key = path.join('lab1', 'part1', 'startercode');
    const hash = await calculateDirectoryHash(
      path.join(tempDir, key),
      ['.gitkeep', '**/.gitkeep']
    );
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: { [key]: hash },
      }],
    });

    // .gitkeep additions must not flip the status
    await fs.writeFile(path.join(tempDir, key, '.gitkeep'), '');

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].parts[0].directories[0].status).toBe('synced');
  });

  it('uses the architecture directory set when the part has no override', async () => {
    const config = makeConfig();
    config.vocareum.architecture = 'elite';
    delete (config.assignments[0].parts[0] as { directories?: string[] }).directories;

    const result = await scanLocalContent(config, tempDir);
    const dirs = result.assignments[0].parts[0].directories.map(d => d.directory);

    // ELITE_DIRECTORIES: asnlib, docs, scripts, startercode, lib
    expect(dirs).toEqual(['asnlib', 'docs', 'scripts', 'startercode', 'lib']);
  });

  it('marks ID-less assignments with create_from_template as pending_create', async () => {
    const config = makeConfig();
    config.assignments[0].assignment_id = null;
    config.assignments[0].create_from_template = true;

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('pending_create');
    expect(result.summary.pending_create).toBe(1);
  });

  it('marks ID-less assignments without create_from_template as unlinked (push may link by name, skip, or abort)', async () => {
    const config = makeConfig();
    config.assignments[0].assignment_id = null;
    config.assignments[0].create_from_template = false;

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('unlinked');
    expect(result.summary.unlinked).toBe(1);
    expect(result.summary.pending_create).toBe(0);
  });

  it('isolates an unreadable directory as error without aborting the scan', async (ctx) => {
    if (process.getuid?.() === 0) { ctx.skip(); return; } // root ignores permissions
    const key = path.join('lab1', 'part1', 'startercode');
    const hash = await calculateDirectoryHash(
      path.join(tempDir, key),
      ['.gitkeep', '**/.gitkeep']
    );
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: { [key]: hash },
      }],
    });
    // Second healthy assignment must still be scanned
    config.assignments.push({
      assignment_id: 'asn-2',
      name: 'Lab 2',
      path: 'lab2',
      create_from_template: false,
      settings: {},
      parts: [{ part_id: 'part-2', path: 'part1', directories: ['startercode'], settings: {} }],
    } as Config['assignments'][number]);
    await fs.mkdir(path.join(tempDir, 'lab2', 'part1', 'startercode'), { recursive: true });

    const dirPath = path.join(tempDir, key);
    await fs.chmod(dirPath, 0o000);
    try {
      const result = await scanLocalContent(config, tempDir);

      expect(result.assignments[0].parts[0].directories[0].status).toBe('error');
      expect(result.assignments[0].parts[0].status).toBe('error');
      expect(result.assignments[0].status).toBe('error');
      expect(result.summary.error).toBe(1);
      // The healthy assignment is unaffected
      expect(result.assignments[1].status).not.toBe('error');
    } finally {
      await fs.chmod(dirPath, 0o755);
    }
  });

  it('treats a missing directory as empty content, not an error (matches push)', async () => {
    const config = makeConfig();
    config.assignments[0].parts[0].directories = ['docs']; // does not exist on disk
    config.publish_history = [{
      timestamp: '2026-06-01T00:00:00Z',
      commit_sha: 'abc',
      published_by: 'test',
      status: 'success',
      content_state: {},
    }];

    const result = await scanLocalContent(config, tempDir);

    // Missing dir hashes as 'empty'; no content_state key → needs_publish, NOT error
    expect(result.assignments[0].parts[0].directories[0].status).toBe('needs_publish');
  });

  it('errors when an assignment path escapes the workspace lexically', async () => {
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: {},
      }],
    });
    config.assignments[0].path = '../outside';

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('error');
    expect(result.assignments[0].parts[0].status).toBe('error');
    expect(result.summary.error).toBe(1);
  });

  it('errors on absolute assignment paths', async () => {
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: {},
      }],
    });
    config.assignments[0].path = '/etc';

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('error');
  });

  it('errors when a symlink escapes the workspace even though the lexical path is inside', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
      // ws/lab-link → outside directory; config references lab-link (lexically inside)
      await fs.symlink(outside, path.join(tempDir, 'lab-link'));
      const config = makeConfig({
        publish_history: [{
          timestamp: '2026-06-01T00:00:00Z',
          commit_sha: 'abc',
          published_by: 'test',
          status: 'success',
          content_state: {},
        }],
      });
      config.assignments[0].path = 'lab-link';

      const result = await scanLocalContent(config, tempDir);

      expect(result.assignments[0].status).toBe('error');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('errors when a content directory itself is a symlink out of the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-outside-'));
    try {
      // lab1/part1/startercode exists from beforeEach — replace with escaping symlink
      await fs.rm(path.join(tempDir, 'lab1', 'part1', 'startercode'), { recursive: true });
      await fs.symlink(outside, path.join(tempDir, 'lab1', 'part1', 'startercode'));
      const config = makeConfig({
        publish_history: [{
          timestamp: '2026-06-01T00:00:00Z',
          commit_sha: 'abc',
          published_by: 'test',
          status: 'success',
          content_state: {},
        }],
      });

      const result = await scanLocalContent(config, tempDir);

      expect(result.assignments[0].parts[0].directories[0].status).toBe('error');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('errors on escaping paths even without publish history (extension consumes these paths)', async () => {
    const config = makeConfig(); // no history
    config.assignments[0].path = '../outside';

    const result = await scanLocalContent(config, tempDir);

    expect(result.assignments[0].status).toBe('error');
  });

  it('error takes precedence over pending_create/unlinked so scan problems are never hidden', async (ctx) => {
    if (process.getuid?.() === 0) { ctx.skip(); return; }
    const config = makeConfig({
      publish_history: [{
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: {},
      }],
    });
    config.assignments[0].assignment_id = null;
    config.assignments[0].create_from_template = true;

    const dirPath = path.join(tempDir, 'lab1', 'part1', 'startercode');
    await fs.chmod(dirPath, 0o000);
    try {
      const result = await scanLocalContent(config, tempDir);

      expect(result.assignments[0].status).toBe('error');
      expect(result.summary.error).toBe(1);
      expect(result.summary.pending_create).toBe(0);
    } finally {
      await fs.chmod(dirPath, 0o755);
    }
  });

  it('errors on a zero-part assignment whose path escapes via symlink (no parts loop to catch it)', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-outside-'));
    try {
      await fs.symlink(outside, path.join(tempDir, 'lab-link'));
      const config = makeConfig({
        publish_history: [{
          timestamp: '2026-06-01T00:00:00Z',
          commit_sha: 'abc',
          published_by: 'test',
          status: 'success',
          content_state: {},
        }],
      });
      config.assignments[0].path = 'lab-link';
      config.assignments[0].parts = [];

      const result = await scanLocalContent(config, tempDir);

      expect(result.assignments[0].status).toBe('error');
      expect(result.summary.error).toBe(1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('detectChangedDirectories refuses paths that escape the base directory (push engine)', async () => {
    await expect(detectChangedDirectories(
      '../outside',
      'part1',
      ['startercode'],
      {
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'test',
        status: 'success',
        content_state: {},
      },
      false,
      [],
      tempDir
    )).rejects.toThrow(/escapes/);
  });

  it('detectChangedDirectories refuses escaping paths even with forceAll', async () => {
    await expect(detectChangedDirectories(
      '../outside',
      'part1',
      ['startercode'],
      undefined,
      true,
      [],
      tempDir
    )).rejects.toThrow(/escapes/);
  });

  it('reads content_state from the newest history entry even when it is failed', async () => {
    const key = path.join('lab1', 'part1', 'startercode');
    const hash = await calculateDirectoryHash(
      path.join(tempDir, key),
      ['.gitkeep', '**/.gitkeep']
    );
    const config = makeConfig({
      publish_history: [
        {
          timestamp: '2026-06-02T00:00:00Z',
          commit_sha: 'def',
          published_by: 'test',
          status: 'failed',
          content_state: { [key]: hash },
        },
        {
          timestamp: '2026-06-01T00:00:00Z',
          commit_sha: 'abc',
          published_by: 'test',
          status: 'success',
          content_state: { [key]: 'stale-old-hash' },
        },
      ],
    });

    const result = await scanLocalContent(config, tempDir);

    // The failed entry's content_state is what push retries against
    expect(result.assignments[0].parts[0].directories[0].status).toBe('synced');
  });
});
