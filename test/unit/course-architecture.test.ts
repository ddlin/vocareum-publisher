import { describe, it, expect, vi } from 'vitest';
import {
  classifyCourseRoot,
  resolveCourseRootEvidence,
  type RootEvidence,
} from '../../src/core/course-architecture';

const kind = (pages: unknown[][], complete = true): string => classifyCourseRoot(pages, complete).kind;

describe('classifyCourseRoot', () => {
  it('classifies exactly {resource, work} as elite', () => {
    expect(kind([['resource', 'work']])).toBe('elite');
    expect(kind([['work', 'resource']])).toBe('elite');
  });
  it('treats duplicates as one name (set semantics)', () => {
    expect(kind([['resource', 'work', 'work']])).toBe('elite');
  });
  it('classifies exactly {resource, voc, work} as container, paged', () => {
    expect(kind([['resource', 'work'], ['voc']])).toBe('container');
  });
  it('voc/ gives container (one trailing slash stripped)', () => {
    expect(kind([['resource/', 'voc/', 'work/']])).toBe('container');
  });
  it('accepts object elements by path ?? filename ?? name', () => {
    expect(kind([[{ path: 'resource' }, { filename: 'work' }, { name: 'voc' }]])).toBe('container');
    expect(kind([[{ path: 'resource', name: 'resource' }, { name: 'work' }]])).toBe('elite');
  });
  it.each([
    ['empty array', [[]]],
    ['no pages', []],
    ['["resource"]', [['resource']]],
    ['["work"]', [['work']]],
    ['Voc', [['resource', 'Voc', 'work']]],
    ['/voc', [['resource', '/voc', 'work']]],
    ['extra name', [['resource', 'work', 'extra']]],
    ['resource+voc+work+extra', [['resource', 'voc', 'work', 'extra']]],
    ['double slash', [['resource', 'work//']]],
    ['empty path with name', [[{ path: '', name: 'voc' }, 'resource', 'work']]],
    ['non-string path', [[{ path: 17, name: 'voc' }, 'resource', 'work']]],
    ['disagreeing fields', [[{ path: 'resource', name: 'voc' }, 'work']]],
    ['disagreeing filename', [[{ name: 'resource', filename: 'x' }, 'work']]],
    ['no name field', [[{ size: 3 }, 'resource', 'work']]],
    ['null element', [[null, 'resource', 'work']]],
    ['number element', [[7, 'resource', 'work']]],
    ['array element', [[['voc'], 'resource', 'work']]],
    ['empty string element', [['', 'resource', 'work']]],
  ])('refuses %s', (_n, pages) => {
    expect(kind(pages as unknown[][])).toBe('unknown');
  });
  it('refuses an incomplete listing even if the names fit', () => {
    expect(kind([['resource', 'work']], false)).toBe('unknown');
  });
  it('refuses more than 1,000 names', () => {
    const names = Array.from({ length: 1001 }, (_, i) => `n${i}`);
    expect(kind([names])).toBe('unknown');
    const split = [names.slice(0, 500), names.slice(500)];
    expect(kind(split)).toBe('unknown');
  });
  it('detail is human readable and has no URL', () => {
    const r = classifyCourseRoot([['resource', 'extra']], true);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.detail).toContain('extra');
      expect(r.detail).not.toMatch(/https?:/);
    }
  });
});

describe('resolveCourseRootEvidence', () => {
  it('caches one lookup per course', async () => {
    const list = vi.fn().mockResolvedValue({ rawPages: [['resource', 'work']], complete: true });
    const cache = new Map<string, RootEvidence>();
    expect((await resolveCourseRootEvidence(list, 'p1', cache, 'c1')).kind).toBe('elite');
    expect((await resolveCourseRootEvidence(list, 'p2', cache, 'c1')).kind).toBe('elite');
    expect(list).toHaveBeenCalledTimes(1);
    await resolveCourseRootEvidence(list, 'p3', cache, 'c2');
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('turns a throw into cached unknown with a sanitised message', async () => {
    const list = vi.fn().mockRejectedValue(new Error('boom https://u:pw@host/x?Signature=abc123&Expires=1'));
    const cache = new Map<string, RootEvidence>();
    const r = await resolveCourseRootEvidence(list, 'p1', cache, 'c1');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.detail).toMatch(/^the course root listing failed: boom/);
      expect(r.detail).not.toContain('abc123');
      expect(r.detail).not.toContain('pw@');
    }
    await resolveCourseRootEvidence(list, 'p1', cache, 'c1');
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('no evidence part gives the exact detail and does not list', async () => {
    const list = vi.fn();
    const r = await resolveCourseRootEvidence(list, undefined, new Map(), 'c1');
    expect(r).toEqual({ kind: 'unknown', detail: 'no part of this course existed to check' });
    expect(list).not.toHaveBeenCalled();
  });
});
