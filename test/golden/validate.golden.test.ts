// test/golden/validate.golden.test.ts
//
// Characterization (golden) tests for the `validate` command.
// These tests capture the CURRENT behaviour of the unrefactored code;
// they are the regression net that service-layer refactoring must keep green.
//
// Cases:
//   (a) clean   — sample-course fixture; all paths exist → passes, snapshot output
//   (b) strict-fail — config with a missing part directory run with strict:true
//                     Today validateCommand calls process.exit(1) on strict failures.
//                     Task 11 converts this to `rejects -> CommandFailureError`.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── output capture ────────────────────────────────────────────────────────────
const out: string[] = [];
const err: string[] = [];

// ── logger mock ───────────────────────────────────────────────────────────────
vi.mock('../../src/utils/logger', () => {
  const o = (s: unknown = '') => out.push(String(s));
  const e = (s: unknown = '') => err.push(String(s));
  return {
    logger: {
      info: o,
      success: o,
      plain: o,
      newline: () => out.push(''),
      warn: e,
      error: e,
      debug: vi.fn(),
    },
  };
});

// ── env mock ──────────────────────────────────────────────────────────────────
vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: vi.fn(),
  isCI: vi.fn().mockReturnValue(false),
  getAuthModeEnv: vi.fn().mockReturnValue(undefined),
  getOAuthClientId: vi.fn().mockReturnValue(undefined),
  getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
  getCIProvider: vi.fn().mockReturnValue(undefined),
}));

// ── git mock (keep snapshots deterministic) ───────────────────────────────────
vi.mock('../../src/utils/git', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  getCommitSha: vi.fn().mockResolvedValue('deadbeef'),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
}));

import { validateCommand } from '../../src/commands/validate';
import * as path from 'path';

/** Normalise volatile values so snapshots are deterministic */
const norm = (ls: string[]) =>
  ls
    .join('\n')
    .replace(new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<cwd>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>');

const FIXTURE_ROOT = 'test/fixtures/sample-course';
const FIXTURE_CONFIG = 'test/fixtures/sample-course/vocareum.yaml';

describe('golden: validate', () => {
  beforeEach(() => {
    out.length = 0;
    err.length = 0;
  });

  // ── (a) CLEAN VALIDATE ─────────────────────────────────────────────────────
  it('(a) clean: sample-course passes and output is stable', async () => {
    await validateCommand({
      config: FIXTURE_CONFIG,
      root: FIXTURE_ROOT,
    });

    // Assert that the run succeeded (no error output, success message present)
    expect(norm(out)).toContain('valid');
    expect(norm(err)).toBe('');
    expect(norm(out)).toMatchSnapshot();
  });

  // ── (b) STRICT-FAIL ────────────────────────────────────────────────────────
  //
  // Today validateCommand calls process.exit(1) when validation fails or when
  // --strict is true and there are warnings. In a vitest process, process.exit
  // terminates the runner — we mock it to intercept the call instead.
  //
  // NOTE: Task 11 converts this to `rejects -> CommandFailureError`.
  // At that point this test should be updated: remove the process.exit mock
  // and use `await expect(validateCommand(...)).rejects.toThrow(CommandFailureError)`.
  it('(b) strict-fail: missing part directory calls process.exit(1)', async () => {
    const exitMock = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
      throw new Error(`process.exit called with code ${_code}`);
    });

    try {
      // The sample-course fixture has a part at lab1/part1 which exists.
      // To trigger a structural failure we point to a config whose assignment
      // path does not exist on disk.
      // Use a root that exists but has no matching assignment directory.
      // The config says path:"lab1" but we pass a root where there is no lab1/.
      // We do this by using the project root as workspaceRoot — "lab1" won't exist there.
      const projectRoot = path.resolve(process.cwd());
      // Confirm there's no lab1 in the project root (would make the test invalid)
      // (We use a synthetic fixture config via loadConfig mock below)

      // Instead, leverage the fact that strict:true combined with warnings triggers exit.
      // validateStructure returns warnings for parts whose directories may have drift issues.
      // Simpler approach: use a config whose assignment path does not exist by pointing
      // workspaceRoot to a directory where lab1 doesn't exist.
      // We know process.cwd() is /Users/davidlin/Development/vocgit — no lab1 there.
      await validateCommand({
        config: FIXTURE_CONFIG,
        root: projectRoot,  // lab1 doesn't exist relative to projectRoot
        strict: true,
      });

      // If validateCommand does NOT exit, fail the test
      expect.fail('Expected process.exit(1) to be called');
    } catch (e) {
      // Expected: process.exit throws via our mock
      expect(e instanceof Error && e.message).toMatch(/process\.exit called with code 1/);
    } finally {
      exitMock.mockRestore();
    }

    // Check that errors were logged
    expect(norm(err)).toMatch(/missing_folder|[Ff]ail|[Ee]rror|not exist/);
  });
});
