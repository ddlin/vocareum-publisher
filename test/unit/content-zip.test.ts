/**
 * The zip path inside `downloadContent` (spec "Per directory", steps 1–9), run
 * end to end against one fake Vocareum tree: the real client and scheduler,
 * the real zip job, pin, settle, reader and reconcile, and the real walk for
 * fallback and handoff. Each test is a spec scenario; most also run the walk
 * alone (zip off) on an identical tree and compare.
 */
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadContent,
  type DownloadContentLimits,
  type DownloadFailure,
} from '../../src/api/content';
import type { ServiceEvent } from '../../src/core/services/event-sink';
import type { DirectoryType } from '../../src/types/config';
import type { FileMap } from '../../src/types/api';
import {
  ASSIGNMENT,
  COURSE,
  FakeVocareumTree,
  PART,
  activeSlots,
  install,
  type Installed,
} from '../helpers/fake-vocareum-tree';

interface PullOptions {
  zip?: boolean;
  strict?: boolean;
  limits?: Partial<DownloadContentLimits>;
  timeoutMs?: number;
  /** Pass `zip: { enabled: false }` rather than leaving `zip` out. */
  zipDisabled?: boolean;
}

interface PullOutcome extends Installed {
  files?: FileMap;
  error?: unknown;
  failures: DownloadFailure[];
  managedLinks: string[];
  events: readonly ServiceEvent[];
}

/** Run a promise to completion while fake time advances; real I/O (inflate) gets turns too. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400_000 && !done; i++) {
    await vi.advanceTimersByTimeAsync(25);
    if (!done) { await new Promise((r) => setImmediate(r)); }
  }
  return p;
}

async function pull(tree: FakeVocareumTree, dirs: string[], o: PullOptions = {}): Promise<PullOutcome> {
  const inst = install(tree);
  const failures: DownloadFailure[] = [];
  const managedLinks: string[] = [];
  const zip = o.zipDisabled === true
    ? { enabled: false, timeoutMs: 600_000 }
    : o.zip === false
      ? undefined
      : { enabled: true, timeoutMs: o.timeoutMs ?? 600_000, now: () => performance.now(), http: inst.http };
  const p = downloadContent(
    inst.client, COURSE, ASSIGNMENT, PART, dirs as DirectoryType[], tree.opts.architecture,
    { strict: o.strict, limits: o.limits, failures: o.strict === true ? undefined : failures, managedLinks, zip },
  );
  let files: FileMap | undefined;
  let error: unknown;
  try { files = await drive(p); } catch (e) { error = e; }
  return { ...inst, files, error, failures, managedLinks, events: inst.events.drain() };
}

function zipNotUsed(events: readonly ServiceEvent[]): unknown[] {
  return events.filter((e) => e.code === 'zip_not_used').map((e) => e.data);
}

function codes(events: readonly ServiceEvent[]): string[] {
  return events.map((e) => e.code).filter((c): c is string => c !== undefined);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function s1Tree(explicitDirs: boolean): FakeVocareumTree {
  return new FakeVocareumTree({ explicitDirs })
    .file('/voc/startercode/README.md', 'readme')
    .file('/voc/startercode/empty.txt', '')
    .file('/voc/startercode/sub/a.py', 'print(1)')
    .file('/voc/startercode/sub/deeper/b.txt', 'bee');
}

describe('downloadContent zip path: scenario contract', () => {
  it.each([true, false])('S1: files, nested subdirs, a zero-byte file (explicit dir entries: %s) — same FileMap as the walk', async (explicit) => {
    const tree = s1Tree(explicit);
    const zip = await pull(tree, ['startercode']);
    const walk = await pull(s1Tree(explicit), ['startercode'], { zip: false });

    expect(zip.error).toBeUndefined();
    expect(zip.files).toEqual(walk.files);
    expect(Object.keys(zip.files!).sort()).toEqual([
      'startercode/README.md', 'startercode/empty.txt', 'startercode/sub/a.py', 'startercode/sub/deeper/b.txt',
    ]);
    expect(zipNotUsed(zip.events)).toEqual([]);
    expect(zip.failures).toEqual([]);
    // I2: every byte came from the zip; no single-file request at all.
    expect(tree.requests('fetch')).toEqual([]);
    expect(tree.requests('download')).toEqual([]);
    expect(tree.requests('start')).toHaveLength(1);
  });

  it('S2: empty top-level directory — no zip request, no diagnostic', async () => {
    const tree = new FakeVocareumTree().dir('/voc/startercode');
    const r = await pull(tree, ['startercode']);
    expect(r.files).toEqual({});
    expect(tree.requests('start')).toEqual([]);
    expect(zipNotUsed(r.events)).toEqual([]);
    // One listing, as the walk of an empty directory costs today.
    expect(tree.requests('list', '/voc/startercode')).toHaveLength(1);
  });

  it("S3: missing directory — today's warning, no zip request", async () => {
    const tree = new FakeVocareumTree().dir('/voc/data');
    const r = await pull(tree, ['startercode']);
    expect(r.files).toEqual({});
    expect(tree.requests('start')).toEqual([]);
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(codes(r.events).filter((c) => c === 'directory_unreachable')).toHaveLength(1);
    // Step 1's "doesn't exist" is handed to the walk, which lists again and
    // decides as today (only a page-0 answer means absent).
    expect(tree.requests('list', '/voc/startercode')).toHaveLength(2);
  });

  it('S4: lib/publicdata absent from the zip — a managed link, as with the walk', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/resource/lib/util.py', 'x = 1')
      .link('/resource/lib/publicdata');
    const zip = await pull(make(), ['lib']);
    const walk = await pull(make(), ['lib'], { zip: false });
    expect(zipNotUsed(zip.events)).toEqual([]);
    expect(zip.files).toEqual(walk.files);
    expect(zip.managedLinks).toEqual(['lib/publicdata']);
    expect(zip.failures).toEqual([]);
  });

  it('S5: unreadable symlink absent from the zip — a failure, as with the walk', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/a.txt', 'a')
      .link('/voc/startercode/broken');
    const zip = await pull(make(), ['startercode']);
    const walk = await pull(make(), ['startercode'], { zip: false });
    expect(zipNotUsed(zip.events)).toEqual([]);
    expect(zip.files).toEqual(walk.files);
    expect(zip.failures).toEqual(walk.failures);
    expect(zip.failures).toEqual([
      { path: 'startercode/broken', reason: 'not downloadable as a file and not listable as a directory' },
    ]);
  });

  it('S6: a real file absent from the zip (added after it was built) is fetched by the handoff', async () => {
    const tree = s1Tree(true);
    tree.onWritten = () => { tree.file('/voc/startercode/sub/new.txt', 'late'); };
    const r = await pull(tree, ['startercode']);
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.files!['startercode/sub/new.txt']).toEqual(Buffer.from('late'));
    expect(tree.requests('fetch').map((e) => e.path)).toEqual(['startercode/sub/new.txt']);
  });

  it('S12: count cap with kept files, a missing file, a missing directory with children and a depth-cut directory', async () => {
    const deep = Array.from({ length: 11 }, (_, i) => `d${i + 1}`).join('/');
    const tree = new FakeVocareumTree()
      .file('/voc/startercode/k1.txt', 'one')
      .file('/voc/startercode/k2.txt', 'two')
      .file(`/voc/startercode/${deep}/f.txt`, 'too deep');
    tree.onWritten = () => {
      tree.file('/voc/startercode/m.txt', 'missing file');
      tree.file('/voc/startercode/md/c1.txt', 'c1');
      tree.file('/voc/startercode/md/c2.txt', 'c2');
    };
    // Commit charges 2 files + 10 kept dirs + 1 depth-cut dir = 13. The handoff
    // charges m.txt (14) and md (15), then trips on md/c1.txt (16). If any kept
    // name were charged again it would trip earlier, before m.txt arrived.
    const r = await pull(tree, ['startercode'], { limits: { maxFiles: 15 } });

    expect(zipNotUsed(r.events)).toEqual([]);
    expect(Object.keys(r.files!).sort()).toEqual(['startercode/k1.txt', 'startercode/k2.txt', 'startercode/m.txt']);
    expect(r.failures.map((f) => f.path)).toEqual([`startercode/${deep}`, 'startercode']);
    expect(r.failures[0].reason).toContain('10-level download limit');
    expect(r.failures[1].reason).toContain('more than 15 files while downloading startercode/md/c1.txt');
    expect(codes(r.events)).toContain('download_truncated');
    // The depth-cut directory is never listed.
    expect(tree.requests('list', `/voc/startercode/${deep}`)).toEqual([]);
  });

  it('S13: byte cap, alias content charged twice — caps never exceeded, INCOMPLETE', async () => {
    const tree = new FakeVocareumTree({ deflate: true })
      .file('/voc/docs/README.md', 'a'.repeat(10_000))
      .file('/resource/asnlib/a.txt', 'b'.repeat(5_000))
      .dir('/resource/asnlib/public/docs', true)
      .file('/resource/asnlib/public/docs/README.md', 'a'.repeat(10_000));
    tree.onWritten = (job) => {
      if (job.dir === '/resource/asnlib') { tree.file('/resource/asnlib/m.txt', 'c'.repeat(5_000)); }
    };
    const r = await pull(tree, ['docs', 'asnlib'], { limits: { maxTotalBytes: 27_000 } });

    expect(zipNotUsed(r.events)).toEqual([]);
    expect(Object.keys(r.files!).sort()).toEqual([
      'asnlib/a.txt', 'asnlib/public/docs/README.md', 'docs/README.md',
    ]);
    const total = Object.values(r.files!).reduce((n, b) => n + Buffer.byteLength(b), 0);
    expect(total).toBe(25_000);
    expect(r.failures.map((f) => f.path)).toEqual(['asnlib']);
    expect(r.failures[0].reason).toContain('30000 total bytes (max 27000)');
  });

  it('S14: per-file cap via the declared size — zip_over_budget, quarantined, walked; per-file limit failure', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/big.bin', 'x'.repeat(2_000))
      .file('/voc/startercode/small.txt', 'ok');
    const zip = await pull(make(), ['startercode'], { limits: { maxFileBytes: 1_000 } });
    const walk = await pull(make(), ['startercode'], { zip: false, limits: { maxFileBytes: 1_000 } });
    expect(zipNotUsed(zip.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'zip_over_budget', quarantined: true },
    ]);
    expect(zip.files).toEqual(walk.files);
    expect(zip.failures).toEqual(walk.failures);
    expect(zip.failures[0].path).toBe('startercode/big.bin');
  });

  it('S14: per-file cap via the listed size — listed_size_over_limit at step 1, no start, not quarantined', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree({ listedSizes: true })
      .file('/voc/startercode/big.bin', 'x'.repeat(2_000))
      .file('/voc/startercode/small.txt', 'ok');
    const tree = make();
    const zip = await pull(tree, ['startercode'], { limits: { maxFileBytes: 1_000 } });
    const walk = await pull(make(), ['startercode'], { zip: false, limits: { maxFileBytes: 1_000 } });
    expect(zipNotUsed(zip.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'listed_size_over_limit', quarantined: false },
    ]);
    expect(tree.requests('start')).toEqual([]);
    expect(zip.files).toEqual(walk.files);
    expect(zip.failures).toEqual(walk.failures);
    expect(zip.failures[0].reason).toContain('is listed as 2000 bytes');
  });

  it('S15: strict — zip not used, then the walk fails and throws as today', async () => {
    const tree = new FakeVocareumTree()
      .file('/voc/startercode/a.txt', 'a')
      .link('/voc/startercode/broken');
    tree.intercept = (kind) => (kind === 'start' ? new Error('start refused') : undefined);
    const r = await pull(tree, ['startercode'], { strict: true });
    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'start_failed', quarantined: true },
    ]);
    expect(String(r.error)).toContain('Could not download startercode/broken: not downloadable as a file');
  });

  it('S17 / Review Focus 2: 12 small directories — jobs never overlap; each settle wait ≤ success + 6000 + rt (+ ≤ 1 s rounding)', async () => {
    const dirs = Array.from({ length: 12 }, (_, i) => `d${String(i + 1).padStart(2, '0')}`);
    const make = (): FakeVocareumTree => {
      const t = new FakeVocareumTree();
      for (const d of dirs) { t.file(`/voc/${d}/main.py`, `print("${d}")`).file(`/voc/${d}/sub/x.txt`, d); }
      return t;
    };
    const tree = make();
    const r = await pull(tree, dirs);
    const walk = await pull(make(), dirs, { zip: false });

    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.files).toEqual(walk.files);
    expect(tree.jobs).toHaveLength(12);

    // Requests that name a directory come in contiguous blocks, one per
    // directory, in order: nothing of directory k is sent once k+1 started.
    const owner = (path: string): string | undefined => dirs.find((d) => path === `/voc/${d}` || path.startsWith(`/voc/${d}/`));
    const order: string[] = [];
    for (const e of tree.log) {
      const d = e.kind === 'list' || e.kind === 'start' || e.kind === 'poll' ? owner(e.path) : undefined;
      if (d !== undefined && order[order.length - 1] !== d) { order.push(d); }
    }
    expect(order).toEqual(dirs);

    const rt = tree.opts.s3RoundTrip;
    for (let k = 0; k < 12; k++) {
      const job = tree.jobs[k];
      const nextStart = k + 1 < 12 ? tree.jobs[k + 1].startedAt : Infinity;
      const s3 = tree.log.filter((e) => e.kind.startsWith('s3') && e.t > job.startedAt && e.t < nextStart);
      // pin, full GET, settle GET — all before the next job starts.
      expect(s3.map((e) => e.kind)).toEqual(['s3-range', 's3-get', 's3-range']);
      const settleSend = s3[2].t;
      expect(settleSend - job.successAt!).toBeGreaterThanOrEqual(6_000);
      // The spec's bound plus the ruled round-up to the S3 second (zip-clock settleWaitUntil).
      expect(settleSend - job.successAt!).toBeLessThanOrEqual(6_000 + rt + 1_000);
    }
  });

  it('S18: empty subdirectory — handed to the walk, which ends it as today; charged once', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/a.txt', 'a')
      .dir('/voc/startercode/empty');
    const tree = make();
    // Exactly the walk's count: a.txt and empty. A second charge would trip it.
    const r = await pull(tree, ['startercode'], { limits: { maxFiles: 2 } });
    const walk = await pull(make(), ['startercode'], { zip: false, limits: { maxFiles: 2 } });
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.files).toEqual(walk.files);
    expect(tree.requests('fetch').map((e) => e.path)).toEqual(['startercode/empty']);
  });

  it('S23: a used zip, then a rejected one, then a third directory — I5 for the rejected one; the third walked as quarantined', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/a.txt', 'a')
      .file('/voc/data/x.csv', '1,2')
      .file('/voc/data/y.csv', '3,4')
      .file('/voc/docs/d.md', '# d');
    const tree = make();
    tree.onWritten = (job) => { if (job.dir === '/voc/data') { tree.remove('/voc/data/y.csv'); } };
    // Exactly the final tree's count: a charge left behind by the rejected zip would trip it.
    const r = await pull(tree, ['startercode', 'data', 'docs'], { limits: { maxFiles: 3 } });
    const baseline = make().remove('/voc/data/y.csv');
    const walk = await pull(baseline, ['startercode', 'data', 'docs'], { zip: false, limits: { maxFiles: 3 } });

    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'data', reason: 'name_mismatch', quarantined: true },
      { part_id: PART, directory: 'docs', reason: 'quarantined', quarantined: false },
    ]);
    expect(tree.requests('start').map((e) => e.path)).toEqual(['/voc/startercode', '/voc/data']);
    expect(r.failures).toEqual([]);
    expect(r.files).toEqual(walk.files);
  });

  it('S24: a reconciliation listing error — listing_failed, quarantined; the walk lists again', async () => {
    const tree = s1Tree(true);
    tree.intercept = (kind, path, n) => (kind === 'list' && path === '/voc/startercode/sub' && n === 1
      ? new Error('listing broke') : undefined);
    const r = await pull(tree, ['startercode']);
    const walk = await pull(s1Tree(true), ['startercode'], { zip: false });
    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'listing_failed', quarantined: true },
    ]);
    expect(r.files).toEqual(walk.files);
    expect(r.failures).toEqual([]);
  });

  it('S24: a persistent listing error — the walk records it exactly as today', async () => {
    const failSub = (kind: string, path: string): Error | undefined =>
      (kind === 'list' && path === '/voc/startercode/sub' ? new Error('listing broke') : undefined);
    const tree = s1Tree(true);
    tree.intercept = failSub;
    const r = await pull(tree, ['startercode']);
    const base = s1Tree(true);
    base.intercept = failSub;
    const walk = await pull(base, ['startercode'], { zip: false });
    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'listing_failed', quarantined: true },
    ]);
    expect(r.files).toEqual(walk.files);
    expect(r.failures).toEqual(walk.failures);
    expect(r.failures[0].path).toBe('startercode/sub');
  });

  it("S25: directory alias — the zip's files are kept, no failure (the walk cannot read them)", async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/resource/asnlib/a.txt', 'a')
      .dir('/resource/asnlib/public/docs', true)
      .file('/resource/asnlib/public/docs/README.md', 'docs');
    const zip = await pull(make(), ['asnlib']);
    const walk = await pull(make(), ['asnlib'], { zip: false });
    expect(zipNotUsed(zip.events)).toEqual([]);
    expect(zip.failures).toEqual([]);
    expect(zip.files!['asnlib/public/docs/README.md']).toEqual(Buffer.from('docs'));
    expect(walk.failures.map((f) => f.path)).toEqual(['asnlib/public/docs/README.md']);
  });

  it('S26: a 115-entry directory (listing pages) — zip accepted, all 115 files', async () => {
    const tree = new FakeVocareumTree();
    for (let i = 0; i < 115; i++) { tree.file(`/voc/data/f${String(i).padStart(3, '0')}.csv`, `row ${i}`); }
    const r = await pull(tree, ['data']);
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(Object.keys(r.files!)).toHaveLength(115);
    expect(tree.requests('fetch')).toEqual([]);
    // Step 1 and step 7 both read every page, up to the empty one.
    expect(tree.requests('list', '/voc/data').map((e) => e.page)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('S27: the root gains a name between step 1 and step 7 — found by the re-list, fetched by the handoff', async () => {
    const tree = s1Tree(true);
    tree.onWritten = () => { tree.file('/voc/startercode/late.txt', 'late'); };
    const r = await pull(tree, ['startercode']);
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.files!['startercode/late.txt']).toEqual(Buffer.from('late'));
    expect(tree.requests('fetch').map((e) => e.path)).toEqual(['startercode/late.txt']);
  });

  it("S28: handoff of a missing name that is a directory cycle — the walk's cycle skip fires; nothing else charged again", async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/x/f.txt', 'f')
      .link('/voc/startercode/x/x', '/voc/startercode/x');
    // The walk's own count: x, x/f.txt, x/x, x/x/f.txt, x/x/x.
    const r = await pull(make(), ['startercode'], { limits: { maxFiles: 5 } });
    const walk = await pull(make(), ['startercode'], { zip: false, limits: { maxFiles: 5 } });
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.files).toEqual(walk.files);
    expect(Object.keys(r.files!).sort()).toEqual(['startercode/x/f.txt', 'startercode/x/x/f.txt']);
    expect(r.events.some((e) => e.message.startsWith('Skipping cyclic path startercode/x/x/x'))).toBe(true);
  });

  it('S29a: a lone empty public/ listing [] — handed to the walk, which ends it as today; charged once at the exact cap', async () => {
    const make = (): FakeVocareumTree => new FakeVocareumTree()
      .file('/voc/startercode/a.txt', 'a')
      .dir('/voc/startercode/public');
    const tree = make();
    // The walk's own count: a.txt and public. A second charge would trip the cap.
    const r = await pull(tree, ['startercode'], { limits: { maxFiles: 2 } });
    const walk = await pull(make(), ['startercode'], { zip: false, limits: { maxFiles: 2 } });
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.files).toEqual(walk.files);
    expect(r.files).toEqual({ 'startercode/a.txt': Buffer.from('a') });
    // Step 7 listed public ([]), then the walk tried it as a file and listed it again.
    expect(tree.requests('fetch').map((e) => e.path)).toEqual(['startercode/public']);
    expect(tree.requests('list', '/voc/startercode/public')).toHaveLength(2);
  });

  it('S29a: the same, but public became a file after the zip was built and its listing answers [] — the walk fetches the file; charged once', async () => {
    const tree = new FakeVocareumTree({ fileListing: 'empty' })
      .file('/voc/startercode/a.txt', 'a')
      .dir('/voc/startercode/public');
    tree.onWritten = () => { tree.remove('/voc/startercode/public').file('/voc/startercode/public', 'now a file'); };
    const r = await pull(tree, ['startercode'], { limits: { maxFiles: 2 } });
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.files).toEqual({
      'startercode/a.txt': Buffer.from('a'),
      'startercode/public': Buffer.from('now a file'),
    });
    expect(tree.requests('fetch').map((e) => e.path)).toEqual(['startercode/public']);
  });

  it('S31: a transient walk failure (ECONNRESET) on a file the zip delivers — the zip has it, no failure', async () => {
    const reset = (kind: string, path: string): Error | undefined => (kind === 'download' && path === 'startercode/README.md'
      ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) : undefined);
    const tree = s1Tree(true);
    tree.intercept = reset;
    const r = await pull(tree, ['startercode']);
    const base = s1Tree(true);
    base.intercept = reset;
    const walk = await pull(base, ['startercode'], { zip: false });
    expect(r.failures).toEqual([]);
    expect(r.files!['startercode/README.md']).toEqual(Buffer.from('readme'));
    expect(walk.failures.map((f) => f.path)).toEqual(['startercode/README.md']);
  });
});

describe('downloadContent zip path: review focus', () => {
  it('Review Focus 1: abort mid-inflate — no FileMap or budget change, no active slots; walked', async () => {
    const make = (): FakeVocareumTree => {
      const t = new FakeVocareumTree({ deflate: true });
      for (let i = 0; i < 6; i++) { t.file(`/voc/startercode/f${i}.txt`, `${i}`.repeat(50_000)); }
      return t;
    };
    const realInflate = zlib.createInflateRaw.bind(zlib);
    let inflates = 0;
    vi.spyOn(zlib, 'createInflateRaw').mockImplementation((...args: Parameters<typeof zlib.createInflateRaw>) => {
      inflates += 1;
      // Second entry starting: the first one is already staged. Run the
      // deadline's timer out now, so the signal fires mid-inflate.
      if (inflates === 2) { vi.advanceTimersByTime(60_000); }
      return realInflate(...args);
    });
    // Exactly the walk's count: a charge left behind by the aborted zip would trip it.
    const r = await pull(make(), ['startercode'], { timeoutMs: 60_000, limits: { maxFiles: 6 } });
    vi.mocked(zlib.createInflateRaw).mockRestore();
    const walk = await pull(make(), ['startercode'], { zip: false, limits: { maxFiles: 6 } });

    expect(inflates).toBe(2);
    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'deadline', quarantined: true },
    ]);
    expect(r.failures).toEqual([]);
    expect(r.files).toEqual(walk.files);
    expect(activeSlots(r.scheduler)).toBe(0);
  });

  it('Review Focus 5: ECONNRESET on the full GET — object_download_failed, quarantined, FileMap equal to the walk', async () => {
    const make = (): FakeVocareumTree => s1Tree(true).file('/voc/data/x.csv', '1,2');
    const tree = make();
    tree.s3Intercept = (kind) => (kind === 's3-get' ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) : undefined);
    const r = await pull(tree, ['startercode', 'data']);
    const walk = await pull(make(), ['startercode', 'data'], { zip: false });
    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'object_download_failed', quarantined: true },
      { part_id: PART, directory: 'data', reason: 'quarantined', quarantined: false },
    ]);
    expect(tree.requests('start')).toHaveLength(1);
    expect(r.files).toEqual(walk.files);
    expect(r.failures).toEqual(walk.failures);
  });
});

describe('downloadContent zip path: robustness', () => {
  it('an unexpected throw in steps 2–8 quarantines the part, emits one zip_not_used and walks (I5)', async () => {
    const make = (): FakeVocareumTree => s1Tree(true).file('/voc/data/x.csv', '1,2');
    const tree = make();
    // A response whose header accessor throws: no step catches this one.
    tree.s3Intercept = (kind, n) => (kind === 's3-range' && n === 1
      ? { status: 206, headers: { get: () => { throw new Error('header accessor exploded'); } }, data: Readable.from([Buffer.from('x')]) }
      : undefined);
    // Exactly the walk's count: a charge left behind would trip it.
    const walk = await pull(make(), ['startercode', 'data'], { zip: false });
    const count = Object.keys(walk.files!).length + 2; // + sub, sub/deeper
    const r = await pull(tree, ['startercode', 'data'], { limits: { maxFiles: count } });
    expect(r.error).toBeUndefined();
    expect(zipNotUsed(r.events)).toEqual([
      { part_id: PART, directory: 'startercode', reason: 'zip_invalid', quarantined: true },
      { part_id: PART, directory: 'data', reason: 'quarantined', quarantined: false },
    ]);
    expect(r.files).toEqual(walk.files);
    expect(r.failures).toEqual([]);
    expect(tree.requests('start')).toHaveLength(1);
  });

  it('an unexpected throw is reported as a debug event, sanitised: no signed-URL query reaches it', async () => {
    const signed = 'https://bucket.s3.amazonaws.com/u1.zip?X-Amz-Credential=CREDSECRET&X-Amz-Signature=SIGSECRET';
    // An S3 axios error carries the signed URL in config.url; one message also quotes it.
    const viaConfig = new AxiosError('timeout of 30000ms exceeded', 'ECONNABORTED', { url: signed } as never);
    const viaMessage = new Error(`request to ${signed} failed`);
    for (const thrown of [viaConfig, viaMessage]) {
      const tree = s1Tree(true);
      tree.s3Intercept = (kind, n) => (kind === 's3-range' && n === 1
        ? { status: 206, headers: { get: () => { throw thrown; } }, data: Readable.from([Buffer.from('x')]) }
        : undefined);
      const r = await pull(tree, ['startercode']);
      expect(zipNotUsed(r.events)).toEqual([
        { part_id: PART, directory: 'startercode', reason: 'zip_invalid', quarantined: true },
      ]);
      const debug = r.events.filter((e) => e.level === 'debug' && e.message.includes('failed unexpectedly'));
      expect(debug).toHaveLength(1);
      expect(debug[0].message).toContain(thrown === viaConfig ? 'timeout of 30000ms exceeded' : 'request to https://bucket.s3.amazonaws.com/u1.zip');
      const text = JSON.stringify(debug[0]);
      expect(text).not.toContain('X-Amz-');
      expect(text).not.toContain('SECRET');
      if (thrown === viaConfig) { expect(text).not.toContain('?'); }
    }
  });

  it('the deadline timer is disposed once a used directory is done; none is left pending', async () => {
    const r = await pull(s1Tree(true), ['startercode']);
    expect(zipNotUsed(r.events)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the deadline timer is disposed after a fallback too', async () => {
    const tree = s1Tree(true);
    tree.intercept = (kind) => (kind === 'start' ? new Error('start refused') : undefined);
    const r = await pull(tree, ['startercode']);
    expect(zipNotUsed(r.events)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('downloadContent zip path: switch off', () => {
  it('S42: zip disabled — no zip request, the walk exactly as with no zip option', async () => {
    const tree = s1Tree(true);
    const off = await pull(tree, ['startercode'], { zipDisabled: true });
    const none = await pull(s1Tree(true), ['startercode'], { zip: false });
    expect(tree.requests('start')).toEqual([]);
    expect(zipNotUsed(off.events)).toEqual([]);
    expect(off.files).toEqual(none.files);
    expect(tree.log.map((e) => `${e.kind} ${e.path}`)).toEqual(
      expect.arrayContaining(['fetch startercode/README.md']),
    );
  });
});
