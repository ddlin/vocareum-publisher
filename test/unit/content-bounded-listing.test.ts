import { describe, expect, it, vi } from 'vitest';
import { listDirectoryBounded, NotAFileListingError } from '../../src/api/content';
import { OverloadError, type VocareumClient } from '../../src/api/client';

/** Pages of entries per dir; an unlisted page answers an empty listing. */
function fake(pages: Record<string, unknown[][]>) {
  const calls: Array<{ dir: string; page: number }> = [];
  const request = vi.fn(async (cfg: { params: { dir: string; page?: number } }) => {
    const page = cfg.params.page ?? 0;
    calls.push({ dir: cfg.params.dir, page });
    return { files: pages[cfg.params.dir]?.[page] ?? [] };
  });
  return { client: { request, events: { emit: vi.fn() } } as unknown as VocareumClient, calls, request };
}
const nm = (n: number, p = 'f') => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe('listDirectoryBounded', () => {
  it('reads through a short page to the empty page, with sizes and raw pages', async () => {
    const { client, calls } = fake({ '/d': [[{ name: 'a', size: 5 }, 'b/'], ['c'], []] });
    const r = await listDirectoryBounded(client, 'c', 'a', 'p', '/d', { remaining: 100 });
    expect(r.names).toEqual(['a', 'b/', 'c']);
    expect(r.complete).toBe(true);
    expect(r.sizes.get('a')).toBe(5);
    expect(r.sizes.get('b/')).toBe(0);
    expect(r.rawPages).toEqual([[{ name: 'a', size: 5 }, 'b/'], ['c']]);
    expect(calls.map(c => c.page)).toEqual([0, 1, 2]);
  });

  it('S40: stops early and does not request pages after the cut', async () => {
    const { client, calls } = fake({ '/d': [nm(100), nm(100, 'g'), nm(100, 'h')] });
    const counter = { remaining: 150 };
    const r = await listDirectoryBounded(client, 'c', 'a', 'p', '/d', counter);
    expect(r.complete).toBe(false);
    expect(r.names).toHaveLength(150);
    expect(calls.map(c => c.page)).toEqual([0, 1]);
  });

  it('S41: the counter is shared across listings and stops at the aggregate', async () => {
    const { client } = fake({ '/a': [nm(40, 'a')], '/b': [nm(40, 'b')], '/c': [nm(40, 'c')] });
    const counter = { remaining: 100 };
    const r1 = await listDirectoryBounded(client, 'c', 'a', 'p', '/a', counter);
    const r2 = await listDirectoryBounded(client, 'c', 'a', 'p', '/b', counter);
    const r3 = await listDirectoryBounded(client, 'c', 'a', 'p', '/c', counter);
    expect([r1.complete, r2.complete, r3.complete]).toEqual([true, true, false]);
    expect(counter.remaining).toBeLessThan(0);
  });

  it('exactly spending the budget is still complete', async () => {
    const { client } = fake({ '/d': [nm(3)] });
    const r = await listDirectoryBounded(client, 'c', 'a', 'p', '/d', { remaining: 3 });
    expect(r.complete).toBe(true);
  });

  it('propagates NotAFileListingError', async () => {
    const { client } = fake({ '/d': [[{ error: 'x' }]] });
    await expect(listDirectoryBounded(client, 'c', 'a', 'p', '/d', { remaining: 9 })).rejects.toBeInstanceOf(NotAFileListingError);
  });

  it('propagates OverloadError', async () => {
    const { client, request } = fake({});
    request.mockRejectedValueOnce(new OverloadError('busy'));
    await expect(listDirectoryBounded(client, 'c', 'a', 'p', '/d', { remaining: 9 })).rejects.toBeInstanceOf(OverloadError);
  });
});
