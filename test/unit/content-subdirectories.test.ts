/**
 * Subdirectory download — scenario contract for the 1.3.7 field report
 * (NA course 196169): the v2 files API answers `?filename=<a directory>` with
 * HTTP 400 `{"error":{"message":"specified file does not exist <path>"}}`, which
 * vocgit treated as a generic error, dropping every subdirectory (1,386 of 1,393
 * files) while the pull still reported success.
 *
 * The fake API below answers by path, like the real one, so each scenario reads
 * as a remote tree rather than a queue of mocked responses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { downloadContent, type DownloadFailure } from '../../src/api/content';
import { APIError, type VocareumClient } from '../../src/api/client';
import type { ServiceEvent } from '../../src/core/services/event-sink';

vi.mock('axios');

/** Remote tree: API directory path → entry names; file path (no /voc) → content. */
interface FakeTree {
  dirs: Record<string, string[]>;
  files: Record<string, string>;
  /** filename → error the files endpoint throws instead of the default behaviour. */
  fetchErrors?: Record<string, Error>;
  /** API dir path → error the list endpoint throws. */
  listErrors?: Record<string, Error>;
}

const SIGNED = 'https://signed.example.com/';

function fakeClient(tree: FakeTree): { client: VocareumClient; events: ServiceEvent[]; calls: string[] } {
  const events: ServiceEvent[] = [];
  const calls: string[] = [];
  const request = vi.fn(async (cfg: { params: { dir?: string; filename?: string } }) => {
    const { dir, filename } = cfg.params;
    if (dir !== undefined) {
      calls.push(`list ${dir}`);
      const listError = tree.listErrors?.[dir];
      if (listError) { throw listError; }
      const entries = tree.dirs[dir];
      if (entries === undefined) {
        // Real missing-directory answer (matched by missingDirectoryMessageMatches).
        throw new APIError(`Directory ${dir} doesn't exist`, 400);
      }
      return { files: entries.map(path => ({ path, size: 1 })) };
    }
    calls.push(`fetch ${filename}`);
    const fetchError = tree.fetchErrors?.[filename!];
    if (fetchError) { throw fetchError; }
    if (tree.files[filename!] !== undefined) {
      return { status: 'success', files: [{ filename, download_url: `${SIGNED}${filename}` }] };
    }
    // Anything that is not a file — a directory, or nothing at all — is the
    // observed HTTP 400, not a status:"error" body.
    throw new APIError(`specified file does not exist ${filename}`, 400);
  });
  vi.mocked(axios.get).mockImplementation(async (url: string) => {
    const key = url.slice(SIGNED.length);
    return { data: Buffer.from(tree.files[key]) };
  });
  const client = { request, events: { emit: (e: ServiceEvent) => events.push(e) } } as unknown as VocareumClient;
  return { client, events, calls };
}

/** The shape of course 196169: startercode with nested exercise folders. */
function nestedTree(): FakeTree {
  return {
    dirs: {
      '/voc/startercode': ['README.md', 'py3.10-exercises', 'empty-dir'],
      '/voc/startercode/py3.10-exercises': ['ex1.py', 'solutions'],
      '/voc/startercode/py3.10-exercises/solutions': ['ex1_solution.py'],
      '/voc/startercode/empty-dir': [],
      '/voc/data': ['top.csv', 'ec2-setup'],
      '/voc/data/ec2-setup': ['main.tf', 'README.md'],
    },
    files: {
      'startercode/README.md': 'readme',
      'startercode/py3.10-exercises/ex1.py': 'ex1',
      'startercode/py3.10-exercises/solutions/ex1_solution.py': 'sol',
      'data/top.csv': 'a,b',
      'data/ec2-setup/main.tf': 'tf',
      'data/ec2-setup/README.md': 'ec2 readme',
    },
  };
}

const ALL_NESTED_FILES = [
  'data/ec2-setup/README.md',
  'data/ec2-setup/main.tf',
  'data/top.csv',
  'startercode/README.md',
  'startercode/py3.10-exercises/ex1.py',
  'startercode/py3.10-exercises/solutions/ex1_solution.py',
];

async function pull(tree: FakeTree, strict = false) {
  const { client, events, calls } = fakeClient(tree);
  const failures: DownloadFailure[] = [];
  const files = await downloadContent(
    client, 'c', 'a', 'p', ['startercode', 'data'], 'container', { strict, failures }
  );
  const warnings = events.filter(e => e.level === 'warn').map(e => e.message);
  return { files, failures, warnings, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('subdirectories answered with HTTP 400 are walked, not dropped', () => {
  it('downloads every file at every depth (the 196169 shape)', async () => {
    const { files, failures, warnings } = await pull(nestedTree());
    expect(Object.keys(files).sort()).toEqual(ALL_NESTED_FILES);
    expect(files['startercode/py3.10-exercises/solutions/ex1_solution.py'].toString()).toBe('sol');
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('strict mode (drift detection) walks the same tree instead of throwing on the first subdirectory', async () => {
    const { files } = await pull(nestedTree(), true);
    expect(Object.keys(files).sort()).toEqual(ALL_NESTED_FILES);
  });

  it('an empty subdirectory is neither a failure nor a file', async () => {
    const { files, failures, warnings, calls } = await pull(nestedTree());
    expect(calls).toContain('list /voc/startercode/empty-dir');
    expect(Object.keys(files).some(k => k.startsWith('startercode/empty-dir'))).toBe(false);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('the "specified source does not exist" wording (seen on lib/) is treated the same way', async () => {
    const tree = nestedTree();
    tree.fetchErrors = {
      'data/ec2-setup': new APIError('specified source does not exist data/ec2-setup', 400),
    };
    const { files, failures } = await pull(tree);
    expect(files['data/ec2-setup/main.tf'].toString()).toBe('tf');
    expect(failures).toEqual([]);
  });

  it('lists each recursed directory once (no duplicate list request)', async () => {
    const { calls } = await pull(nestedTree());
    const lists = calls.filter(c => c.startsWith('list ')).sort();
    expect(lists).toEqual([
      'list /voc/data',
      'list /voc/data/ec2-setup',
      'list /voc/startercode',
      'list /voc/startercode/empty-dir',
      'list /voc/startercode/py3.10-exercises',
      'list /voc/startercode/py3.10-exercises/solutions',
    ]);
  });
});

describe('entries that cannot be retrieved are reported, never silently dropped', () => {
  it('an entry that is neither a file nor a listable directory is a recorded failure; siblings still arrive', async () => {
    const tree = nestedTree();
    tree.dirs['/voc/startercode'].push('dangling-link'); // listed, but fetch 400 and list "doesn't exist"
    const { files, failures, warnings } = await pull(tree);
    expect(Object.keys(files).sort()).toEqual(ALL_NESTED_FILES);
    expect(failures).toEqual([{
      path: 'startercode/dangling-link',
      reason: 'not downloadable as a file and not listable as a directory',
    }]);
    expect(warnings.join('\n')).toContain('Failed to download startercode/dangling-link');
  });

  it('strict mode throws on that entry instead of returning a map that is missing it', async () => {
    const tree = nestedTree();
    tree.dirs['/voc/startercode'].push('dangling-link');
    await expect(pull(tree, true)).rejects.toThrow(/startercode\/dangling-link/);
  });

  it('a 400 with a different message is not mistaken for a directory', async () => {
    const tree = nestedTree();
    tree.fetchErrors = { 'data/top.csv': new APIError('Invalid parameter filename', 400) };
    const { files, failures, calls } = await pull(tree);
    expect(files['data/top.csv']).toBeUndefined();
    expect(failures).toEqual([{ path: 'data/top.csv', reason: 'Invalid parameter filename' }]);
    expect(calls).not.toContain('list /voc/data/top.csv');
  });

  it('a subdirectory whose listing fails is a recorded failure and does not abort the rest of the part', async () => {
    const tree = nestedTree();
    tree.listErrors = { '/voc/startercode/py3.10-exercises': new APIError('Internal error', 500) };
    const { files, failures } = await pull(tree);
    expect(files['startercode/README.md'].toString()).toBe('readme');
    expect(files['data/ec2-setup/main.tf'].toString()).toBe('tf');
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe('startercode/py3.10-exercises');
    expect(failures[0].reason).toMatch(/could not be listed as a directory: Internal error/);
  });

  it('a directory nested past the depth limit is a recorded failure, and strict mode throws', async () => {
    // 12 levels: deeper than MAX_DOWNLOAD_DEPTH, with distinct names (not a cycle).
    const tree: FakeTree = { dirs: {}, files: {} };
    let dir = '/voc/startercode';
    let rel = 'startercode';
    for (let i = 0; i < 12; i++) {
      tree.dirs[dir] = [`level${i}`];
      dir = `${dir}/level${i}`;
      rel = `${rel}/level${i}`;
    }
    tree.dirs[dir] = ['deep.txt'];
    tree.files[`${rel}/deep.txt`] = 'deep';
    tree.dirs['/voc/data'] = [];

    const { files, failures, warnings } = await pull(tree);
    expect(files).toEqual({});
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/download limit/);
    expect(warnings.join('\n')).toMatch(/NOT downloaded/);

    await expect(pull(tree, true)).rejects.toThrow(/download limit/);
  });
});
