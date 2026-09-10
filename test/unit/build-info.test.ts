import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CAPABILITIES, readBuildInfo } from '../../src/core/capabilities';

describe('readBuildInfo', () => {
  it('reports unavailable when the stamp is missing', () => {
    const info = readBuildInfo('/nonexistent/build-info.json');
    expect(info.provenance).toBe('unavailable');
    expect(info.git_sha).toBeNull();
    expect(info.built_at).toBeNull();
  });

  it('never throws on malformed JSON — a version query must not fail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bi-'));
    const bad = join(dir, 'build-info.json');
    writeFileSync(bad, '{ not json');
    expect(() => readBuildInfo(bad)).not.toThrow();
    expect(readBuildInfo(bad).provenance).toBe('unavailable');
  });

  it('keeps built_at when a checkout has no git', () => {
    // A no-git build legitimately stamps git_sha: null. Discarding the whole
    // stamp would throw away built_at, the one fact such a build does have.
    const dir = mkdtempSync(join(tmpdir(), 'bi-nogit-'));
    const stamp = join(dir, 'build-info.json');
    writeFileSync(stamp, JSON.stringify({ git_sha: null, dirty: null, built_at: '2026-09-10T00:00:00.000Z' }));
    const info = readBuildInfo(stamp);
    expect(info.provenance).toBe('stamped');
    expect(info.built_at).toBe('2026-09-10T00:00:00.000Z');
  });

  it('rejects a stamp whose git_sha is the wrong type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bi-bad-'));
    const stamp = join(dir, 'build-info.json');
    writeFileSync(stamp, JSON.stringify({ git_sha: 42 }));
    expect(readBuildInfo(stamp).provenance).toBe('unavailable');
  });

  it('resolves the stamp a real build produces', () => {
    // The default path climbs from dist/core/ to dist/. Getting that wrong is
    // silent -- it reports "unavailable" forever -- so it needs asserting
    // against an actual build rather than a fixture.
    if (!existsSync('dist/build-info.json')) { return; }   // no build in this run
    const { readBuildInfo: fromDist } = require('../../dist/core/capabilities.js') as
      { readBuildInfo: typeof readBuildInfo };
    expect(fromDist().provenance).toBe('stamped');
  });
});

describe('capability list is honest in both directions', () => {
  // The map is the declared contract. Iterating CAPABILITIES alone cannot catch
  // a REMOVAL, because a removed capability is no longer in the list.
  const BACKING: Record<string, string> = {
    'output.json': 'test/unit/report.test.ts',
    'exit-codes.v1': 'test/unit/command-failure.test.ts',
    'diagnostics.v1': 'test/unit/diagnostics.test.ts',
    'pull.rubrics': 'test/unit/rubrics.test.ts',
    'pull.elite-resource-paths': 'test/unit/elite-api-paths.test.ts',
  };

  it('has no duplicates', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it('every declared capability has a backing test file that exists', () => {
    for (const capability of CAPABILITIES) {
      const file = BACKING[capability];
      expect(file, `capability "${capability}" is not in BACKING`).toBeDefined();
      expect(existsSync(file), `backing test ${file} does not exist`).toBe(true);
    }
  });

  it('no capability was added or removed without updating BACKING', () => {
    expect(Object.keys(BACKING).sort()).toEqual([...CAPABILITIES].sort());
  });
});
