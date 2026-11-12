/**
 * Spec steps 6-7: the staging filter (dotfiles, depth cut, ancestor closure,
 * cycle pattern) and the reconcile plan against listings read after the zip.
 * Both are pure, so every scenario here is a table of names in and sets out.
 */
import { describe, it, expect } from 'vitest';
import { filterStaging, planReconcile } from '../../src/api/zip-reconcile';
import type { StagingSet } from '../../src/api/zip-reader';

function staging(files: string[], dirs: string[] = []): StagingSet {
  return {
    files: new Map(files.map(f => [f, Buffer.from(f)])),
    dirs: new Set(dirs),
  };
}

/** A path of `n` segments: s1/s2/.../sn. */
function deep(n: number, leaf = 'f'): string {
  const segs = Array.from({ length: n - 1 }, (_, i) => `d${i + 1}`);
  return [...segs, leaf].join('/');
}

function listings(entries: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(entries));
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('filterStaging', () => {
  it('S19: drops every path with a segment starting with "."', () => {
    const out = filterStaging(staging(
      ['.env', 'a/.secret', 'a/b.txt', '.git/config', 'x/.cache/y/z'],
      ['.git', 'x/.cache', 'x/.cache/y']
    ));
    expect(sorted(out.files.keys())).toEqual(['a/b.txt']);
    expect(sorted(out.keptDirs)).toEqual(['a']);
    expect(out.depthCut.size).toBe(0);
  });

  it('foo/.hidden/file alone does not keep foo (filters before closure)', () => {
    const out = filterStaging(staging(['foo/.hidden/file']));
    expect(out.files.size).toBe(0);
    expect(out.keptDirs.size).toBe(0);
  });

  it('S21: an 11-segment file is kept with its 10 ancestors', () => {
    const path = deep(11);
    const out = filterStaging(staging([path]));
    expect(sorted(out.files.keys())).toEqual([path]);
    expect(out.keptDirs.size).toBe(10);
    expect(out.keptDirs.has(deep(10, 'd10'))).toBe(true);
    expect(out.depthCut.size).toBe(0);
  });

  it('S21: a 10-segment directory is kept; an 11-segment directory is depth-cut, not kept', () => {
    const d10 = deep(10, 'd10');
    const d11 = deep(11, 'd11');
    const out = filterStaging(staging([], [d10, d11]));
    expect(out.keptDirs.has(d10)).toBe(true);
    expect(out.keptDirs.has(d11)).toBe(false);
    expect(sorted(out.depthCut)).toEqual([d11]);
  });

  it('S21: a 12-segment file does not keep its 11-segment ancestor', () => {
    const path = deep(12);
    const d11 = deep(11, 'd11');
    const out = filterStaging(staging([path]));
    expect(out.files.size).toBe(0);
    expect(out.keptDirs.has(d11)).toBe(false);
    // The walk lists the 10-segment directory and records d11 as cut off.
    expect(sorted(out.depthCut)).toEqual([d11]);
    expect(out.keptDirs.has(deep(10, 'd10'))).toBe(true);
    expect(out.keptDirs.size).toBe(10);
  });

  it('S21: entries below a depth-cut directory are not kept', () => {
    const d11 = deep(11, 'd11');
    const out = filterStaging(staging([`${d11}/a`, `${d11}/b/c`], [d11, `${d11}/b`]));
    expect(out.files.size).toBe(0);
    expect(sorted(out.depthCut)).toEqual([d11]);
    for (const k of out.keptDirs) {
      expect(k.split('/').length).toBeLessThanOrEqual(10);
    }
  });

  it('never includes the root in keptDirs', () => {
    const out = filterStaging(staging(['top.txt']));
    expect(out.keptDirs.size).toBe(0);
    expect(out.keptDirs.has('')).toBe(false);
  });

  it('S22: a directory matching the cycle pattern is flagged', () => {
    expect(filterStaging(staging(['lib/p/p/p/x.txt'])).cyclePattern).toBe(true);
    expect(filterStaging(staging([], ['p/p/p'])).cyclePattern).toBe(true);
  });

  it('S22: two repeats, or a repeated file name, are not the cycle pattern', () => {
    expect(filterStaging(staging(['p/p/x.txt'])).cyclePattern).toBe(false);
    // Only directory paths count, as in the walk's descend.
    expect(filterStaging(staging(['p/p/p'])).cyclePattern).toBe(false);
  });

  it('S22: a cycle hidden under a dotfile segment is not seen (the walk never sees it)', () => {
    expect(filterStaging(staging(['.p/p/p/p/x'])).cyclePattern).toBe(false);
  });

  it('S29: public/ dir entry and an implied public are one kept directory', () => {
    const out = filterStaging(staging(['public/docs/README.md', 'public/a.txt'], ['public']));
    expect(sorted(out.keptDirs)).toEqual(['public', 'public/docs']);
  });

  it('S29: only a/b/ keeps a as an implied directory', () => {
    const out = filterStaging(staging([], ['a/b']));
    expect(sorted(out.keptDirs)).toEqual(['a', 'a/b']);
  });
});

describe('planReconcile', () => {
  it('S29: matching names, nothing handed off, every directory charged', () => {
    const f = filterStaging(staging(
      ['public/x.txt', 'a/b/c.txt', 'top.txt'],
      ['public', 'a/b']
    ));
    const plan = planReconcile(f, listings({
      '': ['public', 'a', 'top.txt'],
      public: ['x.txt'],
      a: ['b'],
      'a/b': ['c.txt'],
    }));
    expect(plan.mismatch).toBe(false);
    expect(plan.listedOverLimit).toBe(false);
    expect(plan.missing.size).toBe(0);
    expect(plan.handoffEmpty.size).toBe(0);
    expect(sorted(plan.keptDirsToCharge)).toEqual(['a', 'a/b', 'public']);
  });

  it('S29a: a lone empty public/ with an empty listing is handed to the root', () => {
    const f = filterStaging(staging([], ['public']));
    const plan = planReconcile(f, listings({ '': ['public'], public: [] }));
    expect(plan.mismatch).toBe(false);
    expect(plan.keptDirsToCharge.size).toBe(0);
    expect(sorted(plan.handoffEmpty.get('') ?? [])).toEqual(['public']);
    expect(plan.missing.size).toBe(0);
  });

  it('S29a: an empty nested kept directory is handed to its parent, parent still charged', () => {
    const f = filterStaging(staging([], ['a/b']));
    const plan = planReconcile(f, listings({ '': ['a'], a: ['b'], 'a/b': [] }));
    expect(sorted(plan.keptDirsToCharge)).toEqual(['a']);
    expect(sorted(plan.handoffEmpty.get('a') ?? [])).toEqual(['b']);
    expect(plan.handoffEmpty.has('')).toBe(false);
  });

  it('a kept directory with no zip children but a non-empty listing stays kept; its names are missing', () => {
    const f = filterStaging(staging([], ['public']));
    const plan = planReconcile(f, listings({ '': ['public'], public: ['new.txt'] }));
    expect(sorted(plan.keptDirsToCharge)).toEqual(['public']);
    expect(plan.handoffEmpty.size).toBe(0);
    expect(sorted(plan.missing.get('public') ?? [])).toEqual(['new.txt']);
  });

  it('S27: a root name added after the zip is missing', () => {
    const f = filterStaging(staging(['a.txt']));
    const plan = planReconcile(f, listings({ '': ['a.txt', 'added.txt'] }));
    expect(plan.mismatch).toBe(false);
    expect(sorted(plan.missing.get('') ?? [])).toEqual(['added.txt']);
  });

  it('S19: a dotfile the listing shows is missing, so the handoff fetches it', () => {
    const f = filterStaging(staging(['.env', 'a.txt']));
    const plan = planReconcile(f, listings({ '': ['.env', 'a.txt'] }));
    expect(plan.mismatch).toBe(false);
    expect(sorted(plan.missing.get('') ?? [])).toEqual(['.env']);
  });

  it('S10: another directory\'s zip names give a mismatch', () => {
    const f = filterStaging(staging(['other.py', 'sub/x.py']));
    const plan = planReconcile(f, listings({ '': ['main.py', 'sub'], sub: ['x.py'] }));
    expect(plan.mismatch).toBe(true);
  });

  it('S10: a kept directory absent from its parent listing is a mismatch', () => {
    const f = filterStaging(staging([], ['gone']));
    const plan = planReconcile(f, listings({ '': [], gone: [] }));
    expect(plan.mismatch).toBe(true);
  });

  it('a depth-cut directory absent from its parent listing is a mismatch', () => {
    const d11 = deep(11, 'd11');
    const f = filterStaging(staging([], [d11]));
    const l: Record<string, string[]> = { '': ['d1'] };
    for (let n = 1; n <= 10; n++) {
      const dir = deep(n, `d${n}`);
      l[dir] = n < 10 ? [`d${n + 1}`] : [];
    }
    expect(planReconcile(f, listings(l)).mismatch).toBe(true);
  });

  it('a kept directory with no listing supplied is treated as empty (its zip children mismatch)', () => {
    const f = filterStaging(staging(['a/x.txt']));
    const plan = planReconcile(f, listings({ '': ['a'] }));
    expect(plan.mismatch).toBe(true);
  });

  it('listedOverLimit: a listed size over maxFileBytes trips it; at the limit does not', () => {
    const f = filterStaging(staging(['a.txt', 'sub/b.txt']));
    const l = listings({ '': ['a.txt', 'sub'], sub: ['b.txt'] });
    const at = new Map([['', new Map([['a.txt', 100]])], ['sub', new Map([['b.txt', 100]])]]);
    expect(planReconcile(f, l, { sizes: at, maxFileBytes: 100 }).listedOverLimit).toBe(false);
    const over = new Map([['', new Map([['a.txt', 100]])], ['sub', new Map([['b.txt', 101]])]]);
    expect(planReconcile(f, l, { sizes: over, maxFileBytes: 100 }).listedOverLimit).toBe(true);
  });

  it('listedOverLimit: a missing name over the limit also trips it', () => {
    const f = filterStaging(staging(['a.txt']));
    const l = listings({ '': ['a.txt', 'big.bin'] });
    const sizes = new Map([['', new Map([['big.bin', 5000]])]]);
    expect(planReconcile(f, l, { sizes, maxFileBytes: 4096 }).listedOverLimit).toBe(true);
  });

  it('listedOverLimit stays false without sizes', () => {
    const f = filterStaging(staging(['a.txt']));
    expect(planReconcile(f, listings({ '': ['a.txt'] })).listedOverLimit).toBe(false);
  });

  it('S12: kept, missing, handed-off and depth-cut entries are disjoint, each counted once; depth-cut ones are handed off', () => {
    const d11 = deep(11, 'd11');
    const d10 = deep(10, 'd10');
    const f = filterStaging(staging(
      ['k1.txt', 'k2.txt', 'kd/k3.txt', `${d11}/deep.txt`],
      ['kd', 'empty']
    ));
    const l: Record<string, string[]> = {
      '': ['k1.txt', 'k2.txt', 'kd', 'empty', 'gone.txt', 'newdir', 'd1'],
      kd: ['k3.txt'],
      empty: [],
    };
    for (let n = 1; n <= 10; n++) {
      l[deep(n, `d${n}`)] = n < 10 ? [`d${n + 1}`] : ['d11'];
    }
    const plan = planReconcile(f, listings(l));
    expect(plan.mismatch).toBe(false);

    const keptFiles = sorted(f.files.keys());
    expect(keptFiles).toEqual(['k1.txt', 'k2.txt', 'kd/k3.txt']);
    expect(sorted(f.depthCut)).toEqual([d11]);
    expect(plan.keptDirsToCharge.has('kd')).toBe(true);
    expect(plan.keptDirsToCharge.has(d10)).toBe(true);
    expect(plan.keptDirsToCharge.has('empty')).toBe(false);
    expect(sorted(plan.missing.get('') ?? [])).toEqual(['gone.txt', 'newdir']);
    expect(sorted(plan.handoffEmpty.get('') ?? [])).toEqual(['empty']);
    // The depth-cut directory is never missing: it is handed to the walk at
    // its parent, which charges it (never the commit).
    expect(plan.missing.has(d10)).toBe(false);
    expect(sorted(plan.handoffDepthCut.get(d10) ?? [])).toEqual(['d11']);
    expect(plan.keptDirsToCharge.has(d11)).toBe(false);

    const full = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);
    const groups: string[][] = [
      keptFiles,
      [...plan.keptDirsToCharge],
      [...plan.handoffDepthCut].flatMap(([d, ns]) => [...ns].map(n => full(d, n))),
      [...plan.missing].flatMap(([d, ns]) => [...ns].map(n => full(d, n))),
      [...plan.handoffEmpty].flatMap(([d, ns]) => [...ns].map(n => full(d, n))),
    ];
    const all = groups.flat();
    expect(new Set(all).size).toBe(all.length);
    // Every listed name is in exactly one group.
    const listed = [...Object.entries(l)].flatMap(([d, ns]) => ns.map(n => full(d, n)));
    expect(sorted(all)).toEqual(sorted(listed));
  });
});
