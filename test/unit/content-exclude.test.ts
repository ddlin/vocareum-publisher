/**
 * exclude_patterns in the remote walk: an excluded entry is never fetched,
 * listed, charged against the budget, or recorded as a failure. Matching is on
 * the directory-relative path, so `venv` means data/venv, not data/uv-python.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadContent, type DownloadFailure } from '../../src/api/content';
import type { DirectoryType } from '../../src/types/config';
import {
  ASSIGNMENT, COURSE, FakeVocareumTree, PART, install,
} from '../helpers/fake-vocareum-tree';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400_000 && !done; i++) {
    await vi.advanceTimersByTimeAsync(25);
    if (!done) { await new Promise((r) => setImmediate(r)); }
  }
  return p;
}

interface Run {
  files: Record<string, unknown>;
  failures: DownloadFailure[];
  events: ReturnType<ReturnType<typeof install>['events']['drain']>;
}

async function pull(
  tree: FakeVocareumTree,
  excludePatterns?: string[],
  extra: { limits?: { maxFiles: number }; zip?: boolean } = {}
): Promise<Run> {
  const inst = install(tree);
  const failures: DownloadFailure[] = [];
  const { zip: zipOn, ...rest } = extra;
  const zip = zipOn === true
    ? { enabled: true, timeoutMs: 600_000, now: (): number => performance.now(), http: inst.http }
    : undefined;
  const files = await drive(downloadContent(
    inst.client, COURSE, ASSIGNMENT, PART, ['data'] as DirectoryType[], 'container',
    { failures, excludePatterns, zip, ...rest }
  ));
  return { files, failures, events: inst.events.drain() };
}

async function pullStrict(tree: FakeVocareumTree, excludePatterns?: string[]): Promise<unknown> {
  const inst = install(tree);
  const p = downloadContent(
    inst.client, COURSE, ASSIGNMENT, PART, ['data'] as DirectoryType[], 'container',
    { strict: true, excludePatterns }
  );
  const settled = p.then(() => undefined, (e: unknown) => e);
  return drive(settled);
}

const linkTree = (): FakeVocareumTree => new FakeVocareumTree()
  .file('/voc/data/keep.txt', 'keep')
  .link('/voc/data/venv');

describe('downloadContent exclude_patterns', () => {
  it('X1: excluded unreadable link is never fetched or listed and is not a failure', async () => {
    const tree = linkTree();
    const r = await pull(tree, ['venv']);
    expect(Object.keys(r.files)).toEqual(['data/keep.txt']);
    expect(r.failures).toEqual([]);
    expect(tree.log.some((e) => e.path.includes('venv'))).toBe(false);
  });

  it('X1 (venv/**): same result', async () => {
    const tree = linkTree();
    const r = await pull(tree, ['venv/**']);
    expect(Object.keys(r.files)).toEqual(['data/keep.txt']);
    expect(r.failures).toEqual([]);
    expect(tree.log.some((e) => e.path.includes('venv'))).toBe(false);
  });

  it('X2: without a pattern the link is a failure; strict: true throws', async () => {
    const r = await pull(linkTree());
    expect(r.failures.map((f) => f.path)).toEqual(['data/venv']);
    expect(await pullStrict(linkTree())).toBeInstanceOf(Error);
  });

  it('X5: a readable excluded tree is not downloaded', async () => {
    const tree = new FakeVocareumTree()
      .file('/voc/data/keep.txt', 'keep')
      .file('/voc/data/venv/x', 'x');
    const r = await pull(tree, ['venv']);
    expect(Object.keys(r.files)).toEqual(['data/keep.txt']);
    expect(tree.log.some((e) => e.path.includes('venv'))).toBe(false);
  });

  it('X7: removing the pattern brings the failure back', async () => {
    const withPattern = await pull(linkTree(), ['venv']);
    expect(withPattern.failures).toEqual([]);
    const without = await pull(linkTree(), []);
    expect(without.failures.map((f) => f.path)).toEqual(['data/venv']);
    expect(await pullStrict(linkTree(), [])).toBeInstanceOf(Error);
    expect(await pullStrict(linkTree(), ['venv'])).toBeUndefined();
  });

  it('X11: a non-excluded failure is still recorded with exclusions set', async () => {
    const tree = linkTree().link('/voc/data/bad');
    const r = await pull(tree, ['venv']);
    expect(r.failures.map((f) => f.path)).toEqual(['data/bad']);
  });

  it('X12: excluding py313-venv does not exclude uv-python', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/data/keep.txt', 'keep')
      .link('/voc/data/py313-venv/bin/python', '/voc/data/uv-python/bin/python3')
      .file('/voc/data/uv-python/bin/python3', 'py')
      .link('/voc/data/uv-python/lib');
    const one = await pull(make(), ['py313-venv']);
    expect(one.failures.map((f) => f.path)).toEqual(['data/uv-python/lib']);
    const both = await pull(make(), ['py313-venv', 'uv-python']);
    expect(both.failures).toEqual([]);
  });

  it('excluded entry costs no budget', async () => {
    const tree = new FakeVocareumTree()
      .file('/voc/data/keep.txt', 'keep')
      .file('/voc/data/venv/x', 'x');
    const r = await pull(tree, ['venv'], { limits: { maxFiles: 1 } });
    expect(Object.keys(r.files)).toEqual(['data/keep.txt']);
    expect(r.failures).toEqual([]);
  });

  it('zip is never attempted when an exclude pattern is set (defence in depth)', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/data/keep.txt', 'keep')
      .file('/voc/data/sub/b.txt', 'b')
      .file('/voc/data/venv/x', 'x');
    const zipTree = make();
    const withZip = await pull(zipTree, ['venv'], { zip: true });
    expect(zipTree.requests('start')).toEqual([]);
    const walked = await pull(make(), ['venv']);
    expect(withZip.files).toEqual(walked.files);
    expect(withZip.failures).toEqual(walked.failures);
    expect(Object.keys(withZip.files).sort()).toEqual(['data/keep.txt', 'data/sub/b.txt']);
  });

  it('emits one debug line per excluded entry', async () => {
    const r = await pull(linkTree(), ['venv']);
    const lines = r.events.filter((e) => e.level === 'debug' && e.message.includes('data/venv'));
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toContain('exclude_patterns');
  });
});
