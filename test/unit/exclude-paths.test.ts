import { describe, it, expect } from 'vitest';
import { compileExcludedPathMatcher, compileExcludedSubtreeMatcher } from '../../src/utils/files';
import { userExcludePatterns, hasUserExcludePatterns, pullZipFor } from '../../src/core/local-scan';
import { ConfigSchema } from '../../src/types/config';

const m = (p: string[]) => compileExcludedPathMatcher(p);
const sub = (p: string[]) => compileExcludedSubtreeMatcher(p);

describe('exclusion helpers', () => {
  it('bare name excludes itself and descendants', () => {
    expect(m(['venv'])('venv')).toBe(true);
    expect(m(['venv'])('venv/bin/python')).toBe(true);
    expect(m(['venv'])('venvx/a')).toBe(false);
    expect(m(['venv'])('a/venv')).toBe(false);
  });
  it('venv/** excludes venv and descendants', () => {
    expect(m(['venv/**'])('venv')).toBe(true);
    expect(m(['venv/**'])('venv/bin/python')).toBe(true);
  });
  it('**/venv excludes a nested venv tree', () => {
    expect(m(['**/venv'])('a/b/venv/bin/python')).toBe(true);
  });
  it('subtree matcher protects a directory that holds excluded content', () => {
    expect(m(['venv/*'])('venv')).toBe(false);
    expect(sub(['venv/*'])('venv')).toBe(true);
    expect(sub(['venv/bin/**'])('venv')).toBe(true);
    expect(sub(['**/venv'])('anything')).toBe(true);
    expect(sub(['venv'])('old.txt')).toBe(false);
    expect(sub(['venv/*'])('other')).toBe(false);
  });
  it('H1: empty pattern matches nothing', () => {
    expect(m([''])('a')).toBe(false);
    expect(sub([''])('a')).toBe(false);
    expect(userExcludePatterns({ publish_options: { exclude_patterns: ['', '/'] } } as never)).toEqual([]);
    expect(hasUserExcludePatterns({ publish_options: { exclude_patterns: ['/'] } } as never)).toBe(false);
  });
  it('H2: ** excludes everything', () => {
    expect(m(['**'])('any/path')).toBe(true);
  });
  it('H3: leading, trailing, repeated slashes are ignored', () => {
    for (const p of ['/venv', 'venv/', '//venv']) { expect(m([p])('venv/x')).toBe(true); }
  });
  it('H4: backslashes are separators', () => {
    expect(m(['sub\\venv'])('sub/venv/x')).toBe(true);
    expect(m(['venv'])('venv\\bin\\python')).toBe(true);
    expect(userExcludePatterns({ publish_options: { exclude_patterns: ['\\'] } } as never)).toEqual([]);
  });
  it('H5: .. and C: are literal segments', () => {
    expect(m(['..'])('a')).toBe(false);
    expect(m(['..'])('../a')).toBe(true);
    expect(m(['C:'])('C:/x')).toBe(true);
  });
  it('H7: non-string items are rejected', () => {
    const publishOptions = ConfigSchema.shape.publish_options;
    const ok = publishOptions.safeParse({ exclude_patterns: ['a'] });
    const bad = publishOptions.safeParse({ exclude_patterns: [1] });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
  it('pullZipFor turns zip off only for an effective user pattern', () => {
    const zip = { enabled: true, timeoutMs: 1 };
    expect(pullZipFor(zip, { publish_options: { exclude_patterns: [] } } as never)).toBe(zip);
    expect(pullZipFor(zip, { publish_options: { exclude_patterns: [''] } } as never)).toBe(zip);
    expect(pullZipFor(zip, { publish_options: { exclude_patterns: ['venv'] } } as never)).toBeUndefined();
    expect(pullZipFor(undefined, { publish_options: { exclude_patterns: [] } } as never)).toBeUndefined();
  });
});
