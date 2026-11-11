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
import { downloadContent, resolveMaxDownloadFiles, type DownloadFailure } from '../../src/api/content';
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
  /** Serve directories as downloadable zero-byte objects (some workspaces do). */
  placeholders?: boolean;
}

const SIGNED = 'https://signed.example.com/';

function fakeClient(tree: FakeTree): { client: VocareumClient; events: ServiceEvent[]; calls: string[] } {
  const events: ServiceEvent[] = [];
  const calls: string[] = [];
  const request = vi.fn(async (cfg: { params: { dir?: string; filename?: string; page?: number } }) => {
    const { dir, filename, page } = cfg.params;
    // Every listing here fits one page; later pages are empty, as on the real API.
    if (dir !== undefined && page !== undefined && page >= 1) { return { files: [] }; }
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
    if (tree.files[filename!] !== undefined || (tree.placeholders === true && tree.dirs[`/voc/${filename}`] !== undefined)) {
      return { status: 'success', files: [{ filename, download_url: `${SIGNED}${filename}` }] };
    }
    // Anything that is not a file — a directory, or nothing at all — is the
    // observed HTTP 400, not a status:"error" body.
    throw new APIError(`specified file does not exist ${filename}`, 400);
  });
  vi.mocked(axios.get).mockImplementation(async (url: string) => {
    const key = url.slice(SIGNED.length);
    return { data: Buffer.from(tree.files[key] ?? '') };
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
    const { client, calls } = fakeClient(tree);
    // The specific classification, not just any error naming the path: master
    // also threw (the raw HTTP 400) without ever trying to list the entry.
    await expect(downloadContent(client, 'c', 'a', 'p', ['startercode', 'data'], 'container', { strict: true }))
      .rejects.toThrow('Could not download startercode/dangling-link: not downloadable as a file and not listable as a directory');
    expect(calls).toContain('list /voc/startercode/dangling-link');
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

describe('every way a walk can stop short is accounted for (review round 1)', () => {
  /** A chain of distinct directories `levels` deep under data/, ending in deep.txt. */
  function chain(levels: number, placeholders: boolean): FakeTree {
    const tree: FakeTree = { dirs: { '/voc/startercode': [] }, files: {}, placeholders };
    let dir = '/voc/data';
    let rel = 'data';
    for (let i = 0; i < levels; i++) {
      tree.dirs[dir] = [`d${i}`];
      dir = `${dir}/d${i}`;
      rel = `${rel}/d${i}`;
    }
    tree.dirs[dir] = ['deep.txt'];
    tree.files[`${rel}/deep.txt`] = 'deep';
    return tree;
  }

  it('a real folder whose name repeats (data/a/a/a) is walked, not skipped as a cycle', async () => {
    const tree: FakeTree = {
      dirs: {
        '/voc/startercode': [],
        '/voc/data': ['a'],
        '/voc/data/a': ['a'],
        '/voc/data/a/a': ['a', 'mid.txt'],
        '/voc/data/a/a/a': ['lost.txt'],
      },
      files: { 'data/a/a/mid.txt': 'mid', 'data/a/a/a/lost.txt': 'found' },
    };
    for (const strict of [false, true]) {
      const { files, failures } = await pull(tree, strict);
      expect(files['data/a/a/a/lost.txt'].toString()).toBe('found');
      expect(failures).toEqual([]);
    }
  });

  it('a genuine link cycle (lists the same entries as its parent) is skipped quietly', async () => {
    // data/x/self -> data/x: every level lists ['self', 'f.txt'].
    const tree: FakeTree = {
      dirs: {
        '/voc/startercode': [],
        '/voc/data': ['x'],
        '/voc/data/x': ['self', 'f.txt'],
        '/voc/data/x/self': ['self', 'f.txt'],
        '/voc/data/x/self/self': ['self', 'f.txt'],
        '/voc/data/x/self/self/self': ['self', 'f.txt'],
      },
      files: { 'data/x/f.txt': 'f', 'data/x/self/f.txt': 'f', 'data/x/self/self/f.txt': 'f' },
    };
    for (const strict of [false, true]) {
      const { files, failures, warnings } = await pull(tree, strict);
      expect(files['data/x/f.txt'].toString()).toBe('f');
      expect(Object.keys(files).some(k => k.startsWith('data/x/self/self/self/'))).toBe(false);
      expect(failures).toEqual([]);
      expect(warnings).toEqual([]);
    }
  });

  it('a zero-byte placeholder folder past the depth limit is a recorded failure, not an empty file', async () => {
    const tree = chain(12, true);
    const { files, failures } = await pull(tree);
    expect(Object.values(files).every(c => c.length > 0)).toBe(true); // no placeholder kept as a file
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/download limit/);
    await expect(pull(tree, true)).rejects.toThrow(/download limit/);
  });

  it('a zero-byte placeholder tree within the limit is fully walked, each folder listed once', async () => {
    const { files, failures, calls } = await pull(chain(4, true));
    expect(files['data/d0/d1/d2/d3/deep.txt'].toString()).toBe('deep');
    expect(failures).toEqual([]);
    const lists = calls.filter(c => c.startsWith('list '));
    expect(lists.length).toBe(new Set(lists).size);
    expect(lists).toContain('list /voc/data/d0/d1/d2/d3');
  });
});

describe('download safety limits keep what arrived (non-strict); strict still throws', () => {
  function wide(): FakeTree {
    // startercode: 3 files; data: 2 files. Walk order is startercode, then data.
    return {
      dirs: { '/voc/startercode': ['a.txt', 'b.txt', 'c.txt'], '/voc/data': ['d.txt', 'e.txt'] },
      files: { 'startercode/a.txt': 'a', 'startercode/b.txt': 'b', 'startercode/c.txt': 'c', 'data/d.txt': 'd', 'data/e.txt': 'e' },
    };
  }

  async function pullWith(tree: FakeTree, limits: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number }, strict = false) {
    const { client, events } = fakeClient(tree);
    const failures: DownloadFailure[] = [];
    const files = await downloadContent(client, 'c', 'a', 'p', ['startercode', 'data'], 'container', { strict, failures, limits });
    return { files, failures, warnings: events.filter(e => e.level === 'warn').map(e => e.message) };
  }

  it('the file-count cap stops the walk but keeps the files already downloaded', async () => {
    const { files, failures } = await pullWith(wide(), { maxFiles: 2 });
    expect(Object.keys(files).sort()).toEqual(['startercode/a.txt', 'startercode/b.txt']);
    // The directory where the cap tripped, and every directory not reached, are named.
    expect(failures.map(f => f.path)).toEqual(['startercode', 'data']);
    expect(failures[0].reason).toMatch(/more than 2 files.*VOCAREUM_MAX_DOWNLOAD_FILES.*rest of this directory was NOT downloaded/);
    expect(failures[1].reason).toMatch(/download limit was reached earlier/);
  });

  it('the total-bytes cap behaves the same way', async () => {
    const { files, failures } = await pullWith(wide(), { maxTotalBytes: 2 });
    expect(Object.keys(files).sort()).toEqual(['startercode/a.txt', 'startercode/b.txt']);
    expect(failures.map(f => f.path)).toEqual(['startercode', 'data']);
  });

  it('one oversized file is recorded and skipped; the walk continues', async () => {
    const tree = wide();
    tree.files['startercode/b.txt'] = 'too large';
    const { files, failures } = await pullWith(tree, { maxFileBytes: 3 });
    expect(Object.keys(files).sort()).toEqual(['data/d.txt', 'data/e.txt', 'startercode/a.txt', 'startercode/c.txt']);
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe('startercode/b.txt');
  });

  it('strict mode (drift) still throws on any limit', async () => {
    await expect(pullWith(wide(), { maxFiles: 2 }, true)).rejects.toThrow(/Download limit exceeded/);
    const tree = wide();
    tree.files['startercode/b.txt'] = 'too large';
    await expect(pullWith(tree, { maxFileBytes: 3 }, true)).rejects.toThrow(/Download limit exceeded/);
  });
});

describe('VOCAREUM_MAX_DOWNLOAD_FILES', () => {
  it('defaults to 5,000', () => {
    expect(resolveMaxDownloadFiles({})).toBe(5000);
    expect(resolveMaxDownloadFiles({ VOCAREUM_MAX_DOWNLOAD_FILES: '  ' })).toBe(5000);
  });

  it('raises the cap', () => {
    expect(resolveMaxDownloadFiles({ VOCAREUM_MAX_DOWNLOAD_FILES: '50000' })).toBe(50000);
  });

  it('rejects junk, zero, and absurd values', () => {
    expect(() => resolveMaxDownloadFiles({ VOCAREUM_MAX_DOWNLOAD_FILES: 'lots' })).toThrow(/positive integer/);
    expect(() => resolveMaxDownloadFiles({ VOCAREUM_MAX_DOWNLOAD_FILES: '-5' })).toThrow(/positive integer/);
    expect(() => resolveMaxDownloadFiles({ VOCAREUM_MAX_DOWNLOAD_FILES: '0' })).toThrow(/between 1 and/);
    expect(() => resolveMaxDownloadFiles({ VOCAREUM_MAX_DOWNLOAD_FILES: '99999999' })).toThrow(/between 1 and/);
  });

  it('is what downloadContent uses when no explicit limit is passed', async () => {
    const saved = process.env.VOCAREUM_MAX_DOWNLOAD_FILES;
    process.env.VOCAREUM_MAX_DOWNLOAD_FILES = '1';
    try {
      const tree: FakeTree = { dirs: { '/voc/startercode': ['a.txt', 'b.txt'], '/voc/data': [] }, files: { 'startercode/a.txt': 'a', 'startercode/b.txt': 'b' } };
      const { files, failures } = await pull(tree);
      expect(Object.keys(files)).toEqual(['startercode/a.txt']);
      expect(failures[0].reason).toMatch(/more than 1 files/);
    } finally {
      if (saved === undefined) { delete process.env.VOCAREUM_MAX_DOWNLOAD_FILES; } else { process.env.VOCAREUM_MAX_DOWNLOAD_FILES = saved; }
    }
  });
});


describe("Vocareum's course-wide publicdata link (seen 2026-11-10, test course 215500)", () => {
  // lib/ (Elite) is the course-wide tree; Vocareum puts a root-owned link
  // publicdata -> /mnt/.../course<id>/data at its top. The API lists it but can
  // neither fetch nor list it, and an upload cannot remove it.
  function libTree(): FakeTree {
    return {
      dirs: { '/resource/lib': ['public', 'publicdata', 'helper.py'], '/resource/lib/public': [] },
      files: { 'lib/helper.py': 'h' },
    };
  }
  async function pullLib(tree: FakeTree, strict = false) {
    const { client, events } = fakeClient(tree);
    const failures: DownloadFailure[] = [];
    const files = await downloadContent(client, 'c', 'a', 'p', ['lib'], 'elite', { strict, failures });
    return { files, failures, warnings: events.filter(e => e.level === 'warn').map(e => e.message) };
  }

  it('top-level lib/publicdata is skipped: no failure, no warning, so lib/ is not marked incomplete', async () => {
    const { files, failures, warnings } = await pullLib(libTree());
    expect(Object.keys(files)).toEqual(['lib/helper.py']);
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('strict mode (drift detection) skips it too instead of throwing', async () => {
    const { files } = await pullLib(libTree(), true);
    expect(Object.keys(files)).toEqual(['lib/helper.py']);
  });

  it('only that exact entry: a nested publicdata, or one in another directory, is still a failure', async () => {
    const tree = libTree();
    tree.dirs['/resource/lib/public'] = ['publicdata'];
    const { failures } = await pullLib(tree);
    expect(failures.map(f => f.path)).toEqual(['lib/public/publicdata']);

    const data = nestedTree();
    data.dirs['/voc/data'].push('publicdata');
    const { failures: dataFailures } = await pull(data);
    expect(dataFailures.map(f => f.path)).toEqual(['data/publicdata']);
  });
});

describe('an upload target the course does not have (seen 2026-11-10)', () => {
  it('turns Vocareum\'s "Invalid target (lib)" into a config fix', async () => {
    const { invalidTargetMessage } = await import('../../src/api/content');
    const raw = new APIError('Invalid target (lib) for content update. Valid targets: [course, data, docs, scripts, startercode, private]', 400);
    const msg = invalidTargetMessage(raw, 'lib');
    expect(msg).toContain('Vocareum does not accept "lib/"');
    expect(msg).toContain('Valid targets: [course, data, docs, scripts, startercode, private]');
    expect(msg).toContain("from this part's `directories`");
    expect(msg).not.toContain('vocareum.architecture');
    expect(invalidTargetMessage(new APIError('specified file does not exist x', 400), 'lib')).toBeUndefined();
  });
});
