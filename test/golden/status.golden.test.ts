// test/golden/status.golden.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const out: string[] = []; const err: string[] = [];
vi.mock('../../src/utils/logger', () => {
  const o = (s = '') => out.push(String(s)); const e = (s = '') => err.push(String(s));
  return { logger: { info: o, success: o, plain: o, newline: () => out.push(''), warn: e, error: e, debug: e } };
});
vi.mock('../../src/utils/env', () => ({ loadDotEnvIfPresent: vi.fn(), isCI: () => false, getAuthModeEnv: () => undefined, getOAuthClientId: () => undefined, getOAuthClientSecret: () => undefined, getCIProvider: () => undefined }));
vi.mock('../../src/utils/git', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  getCommitSha: vi.fn().mockResolvedValue('deadbeef'),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
}));
import { statusCommand } from '../../src/commands/status';
const norm = (ls: string[]) => ls.join('\n').replace(new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<cwd>').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>').replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>');
const FIX = { config: 'test/fixtures/sample-course/vocareum.yaml', root: 'test/fixtures/sample-course' };

describe('golden: status', () => {
  beforeEach(() => { out.length = 0; err.length = 0; });
  it('human output is stable', async () => { await statusCommand({ ...FIX }); expect(norm(out)).toMatchSnapshot(); });
  it('--json emits exactly one valid JSON doc and no human lines', async () => {
    const json: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { json.push(String(s)); return true; });
    await statusCommand({ ...FIX, json: true });
    spy.mockRestore();
    const printed = json.join('');
    expect(() => JSON.parse(printed)).not.toThrow();           // purity
    expect(out.filter((l) => l.trim() !== '')).toEqual([]);    // no human lines on the JSON path
  });
});
