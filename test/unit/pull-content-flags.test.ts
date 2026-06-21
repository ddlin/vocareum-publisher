import { describe, it, expect } from 'vitest';
import { validatePullContentFlags, scopeAssignmentsForContent } from '../../src/commands/pull';
import type { Assignment } from '../../src/types/config';

// part_id and assignment_id are `string | null` in the schema; `settings` is
// omitted because these helpers only read name/id/parts (cast bypasses it).
const asn = (name: string, id: string, partIds: string[]): Assignment => ({
  name,
  path: name,
  assignment_id: id,
  parts: partIds.map((pid, i) => ({ part_id: pid, path: `${name}/p${i}` })),
} as unknown as Assignment);

describe('validatePullContentFlags', () => {
  it('allows bare pull (no flags)', () => {
    expect(() => validatePullContentFlags({})).not.toThrow();
  });
  it('allows --content alone', () => {
    expect(() => validatePullContentFlags({ content: true })).not.toThrow();
  });
  it('allows --content with one --assignment', () => {
    expect(() => validatePullContentFlags({ content: true, assignment: ['lab1'] })).not.toThrow();
  });
  it('allows --content with one --assignment and --part', () => {
    expect(() => validatePullContentFlags({ content: true, assignment: ['lab1'], part: ['p1'] })).not.toThrow();
  });
  it('errors on --assignment without --content', () => {
    expect(() => validatePullContentFlags({ assignment: ['lab1'] })).toThrow(/--content/);
  });
  it('errors on --part without --content', () => {
    expect(() => validatePullContentFlags({ part: ['p1'] })).toThrow(/--content/);
  });
  it('errors on --part without --assignment', () => {
    expect(() => validatePullContentFlags({ content: true, part: ['p1'] })).toThrow(/--part requires --assignment/);
  });
  it('errors on --part with more than one --assignment', () => {
    expect(() => validatePullContentFlags({ content: true, assignment: ['lab1', 'lab2'], part: ['p1'] }))
      .toThrow(/exactly one --assignment/);
  });
});

describe('scopeAssignmentsForContent', () => {
  const all = [asn('lab1', '111', ['p1', 'p2']), asn('lab2', '222', ['p3'])];

  it('returns all assignments and no part filter when no selectors', () => {
    const r = scopeAssignmentsForContent(all, [], []);
    expect(r.assignments).toHaveLength(2);
    expect(r.partIds).toBeUndefined();
  });
  it('scopes to named assignment(s) by name', () => {
    const r = scopeAssignmentsForContent(all, ['lab1'], []);
    expect(r.assignments.map((a) => a.name)).toEqual(['lab1']);
    expect(r.partIds).toBeUndefined();
  });
  it('scopes by assignment_id too', () => {
    const r = scopeAssignmentsForContent(all, ['222'], []);
    expect(r.assignments.map((a) => a.name)).toEqual(['lab2']);
  });
  it('collects repeated assignment selectors', () => {
    const r = scopeAssignmentsForContent(all, ['lab1', 'lab2'], []);
    expect(r.assignments.map((a) => a.name).sort()).toEqual(['lab1', 'lab2']);
  });
  it('scopes parts within the single selected assignment', () => {
    const r = scopeAssignmentsForContent(all, ['lab1'], ['p2']);
    expect(r.assignments.map((a) => a.name)).toEqual(['lab1']);
    expect([...(r.partIds ?? [])]).toEqual(['p2']);
  });
  it('errors on an unknown assignment selector', () => {
    expect(() => scopeAssignmentsForContent(all, ['nope'], [])).toThrow(/nope/);
  });
  it('errors on a part not under the selected assignment', () => {
    expect(() => scopeAssignmentsForContent(all, ['lab1'], ['p3'])).toThrow(/p3/);
  });
});
