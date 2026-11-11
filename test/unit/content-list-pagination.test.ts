/**
 * Directory listings are paged: at most 100 names per request, sorted, with a
 * 0-based `page` parameter (no `page` = page 0; `per_page`/`limit` ignored).
 * Probed on course 215500, 2026-11-11 — a 115-entry directory answered 100
 * names, then 15 on page=1, then none.
 *
 * Reading only page 0 silently dropped every name after the 100th: pull lost
 * the files, drift detection read them as remote deletions, and a `reset: 1`
 * push then deleted them from Vocareum. The fake API here pages exactly like
 * the real one, so each scenario is a directory of a given size.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { downloadContent, listFiles, type DownloadFailure } from '../../src/api/content';
import { APIError, type VocareumClient } from '../../src/api/client';
import type { ServiceEvent } from '../../src/core/services/event-sink';

vi.mock('axios');

// This branch predates the zip download; keep the walk explicit if it lands.
let savedPullZip: string | undefined;
beforeAll(() => { savedPullZip = process.env.VOCAREUM_PULL_ZIP; process.env.VOCAREUM_PULL_ZIP = '0'; });
afterAll(() => {
  if (savedPullZip === undefined) { delete process.env.VOCAREUM_PULL_ZIP; } else { process.env.VOCAREUM_PULL_ZIP = savedPullZip; }
});

const PAGE = 100;
const SIGNED = 'https://signed.example.com/';

/** `n` file names that sort in creation order. */
function names(n: number, prefix = 'f'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}.txt`);
}

interface FakeOptions {
  /** API dir path → names. */
  dirs: Record<string, string[]>;
  /** Serve page 0 for every page (a server that ignores `page`). */
  ignorePage?: boolean;
  /** Repeat the last name of the previous page at the start of the next. */
  overlap?: boolean;
}

function fakeClient(opts: FakeOptions) {
  const events: ServiceEvent[] = [];
  const listCalls: Array<{ dir: string; page: number | undefined }> = [];
  const request = vi.fn(async (cfg: { params: { dir?: string; page?: number; filename?: string } }) => {
    const { dir, page, filename } = cfg.params;
    if (dir !== undefined) {
      listCalls.push({ dir, page });
      const all = opts.dirs[dir];
      if (all === undefined) { throw new APIError(`${dir} doesn't exist`, 400); }
      const p = opts.ignorePage === true ? 0 : (page ?? 0);
      const start = p * PAGE;
      const slice = all.slice(start, start + PAGE);
      const withOverlap = opts.overlap === true && p > 0 && slice.length > 0 ? [all[start - 1], ...slice.slice(0, PAGE - 1)] : slice;
      return { courseid: 'c', directory: dir, files: withOverlap };
    }
    const isFile = Object.entries(opts.dirs).some(([d, ns]) => ns.includes(filename!.split('/').pop()!) && `/voc/${filename}`.startsWith(`${d}/`)
      && opts.dirs[`/voc/${filename}`] === undefined);
    if (isFile) { return { status: 'success', files: [{ filename, download_url: `${SIGNED}${filename}` }] }; }
    throw new APIError(`specified file does not exist ${filename}`, 400);
  });
  vi.mocked(axios.get).mockImplementation(async (url: string) => ({ data: Buffer.from(`content of ${url.slice(SIGNED.length)}`) }));
  const client = { request, events: { emit: (e: ServiceEvent) => events.push(e) } } as unknown as VocareumClient;
  return { client, events, listCalls };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('listFiles reads every page', () => {
  it.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [101, 2],
    [115, 2],
    [200, 3],
    [250, 3],
  ])('%i entries → all of them, in %i request(s)', async (count, requests) => {
    const all = names(count);
    const { client, listCalls } = fakeClient({ dirs: { '/voc/startercode': all } });
    const entries = await listFiles(client, 'c', 'a', 'p', 'startercode', 'container');
    expect(entries.map((e) => e.path)).toEqual(all);
    expect(listCalls).toHaveLength(requests);
    // Page 0 is requested without `page`, exactly as before this fix.
    expect(listCalls[0].page).toBeUndefined();
    expect(listCalls.slice(1).map((c) => c.page)).toEqual(Array.from({ length: requests - 1 }, (_, i) => i + 1));
  });

  it('does not duplicate a name repeated across a page boundary', async () => {
    const all = names(150);
    const { client } = fakeClient({ dirs: { '/voc/startercode': all }, overlap: true });
    const entries = await listFiles(client, 'c', 'a', 'p', 'startercode', 'container');
    expect(new Set(entries.map((e) => e.path)).size).toBe(entries.length);
  });

  it('fails loudly, rather than looping or returning a short list, when the server ignores `page`', async () => {
    const { client, listCalls } = fakeClient({ dirs: { '/voc/startercode': names(250) }, ignorePage: true });
    await expect(listFiles(client, 'c', 'a', 'p', 'startercode', 'container')).rejects.toThrow(/same 100 names/);
    expect(listCalls).toHaveLength(2);
  });

  it('a missing directory is still absent (no paging attempted)', async () => {
    const { client, listCalls } = fakeClient({ dirs: {} });
    expect(await listFiles(client, 'c', 'a', 'p', 'startercode', 'container')).toEqual([]);
    expect(listCalls).toHaveLength(1);
  });
});

describe('downloads past the 100th entry', () => {
  it('pull gets every file in a 150-file directory and in a 120-entry subdirectory', async () => {
    const root = [...names(149), 'sub'];
    const sub = names(120, 's');
    const { client } = fakeClient({ dirs: { '/voc/startercode': root, '/voc/startercode/sub': sub } });
    const failures: DownloadFailure[] = [];
    const files = await downloadContent(client, 'c', 'a', 'p', ['startercode'], 'container', { failures });
    expect(Object.keys(files)).toHaveLength(149 + 120);
    expect(files['startercode/f0148.txt']).toBeDefined();
    expect(files['startercode/sub/s0119.txt']).toBeDefined();
    expect(failures).toEqual([]);
  });

  it('strict mode (drift detection) sees the files after the 100th, so they are not read as remote deletions', async () => {
    const { client } = fakeClient({ dirs: { '/voc/startercode': names(130) } });
    const files = await downloadContent(client, 'c', 'a', 'p', ['startercode'], 'container', { strict: true });
    expect(Object.keys(files)).toHaveLength(130);
    expect(files['startercode/f0129.txt']).toBeDefined();
  });

  it('a subdirectory whose server ignores `page` is recorded as a failure (pull marked incomplete), not silently short', async () => {
    const { client } = fakeClient({ dirs: { '/voc/startercode': ['sub'], '/voc/startercode/sub': names(250, 's') }, ignorePage: true });
    const failures: DownloadFailure[] = [];
    await downloadContent(client, 'c', 'a', 'p', ['startercode'], 'container', { failures });
    expect(failures.map((f) => f.path)).toEqual(['startercode/sub']);
  });
});
