/**
 * Regression test: push does not double-acquire the config lock.
 *
 * Before the fix, publishCommand wrapped publishCommandLocked in a withConfigLock,
 * and publishCommandLocked also called withSession → withConfigLock on the same
 * path.  Because withConfigLock is NON-REENTRANT (fs.writeFile with flag:'wx'
 * throws EEXIST → CONFIG_LOCKED), every real push threw CONFIG_LOCKED.
 *
 * This test uses the REAL withConfigLock (not mocked) against a temp config
 * file, so it would fail pre-fix with CONFIG_LOCKED and must pass post-fix.
 */

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Config } from '../../src/types/config';
import type { AxiosRequestConfig } from 'axios';

// --- Real config/session (NOT mocked) ---
// We only mock loadConfig (to return our fixture) and updateConfig (no-op).
// withConfigLock and withSession are left real so the lock machinery is exercised.
const { loadConfigMock, updateConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  updateConfigMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/config')>();
  return {
    ...real,                     // keep withConfigLock REAL
    loadConfig: loadConfigMock,  // override just the loader
    updateConfig: updateConfigMock,
  };
});

// Mock the rest of the stack so no real network calls happen
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), success: vi.fn(), error: vi.fn(), warn: vi.fn(),
    debug: vi.fn(), newline: vi.fn(), plain: vi.fn(),
  },
}));

vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: vi.fn(),
  isCI: vi.fn().mockReturnValue(true),
  getApiKeyOrThrow: vi.fn().mockReturnValue('test-api-key'),
  getOAuthClientId: vi.fn().mockReturnValue(undefined),
  getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
  getAuthModeEnv: vi.fn().mockReturnValue(undefined),
  getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
  getOAuthTokenUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3/oauth/token'),
}));

vi.mock('../../src/utils/git', () => ({
  getCommitSha: vi.fn().mockResolvedValue('abc123'),
  getGitUserName: vi.fn().mockResolvedValue('tester'),
  commitChanges: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/prompts', () => ({
  promptConfirm: vi.fn().mockResolvedValue(true),
}));

const mockRequest = vi.fn();
vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    VocareumClient: vi.fn().mockImplementation(() => ({ request: mockRequest })),
  };
});

import { publishCommand } from '../../src/commands/publish';

const FIXTURE_CONFIG: Config = {
  vocareum: {
    course_id: 'course-lock-test',
    api_base_url: 'https://api.vocareum.com',
    org_id: 'org-lock-test',
  },
  assignments: [
    {
      path: 'a1',
      name: 'Assignment 1',
      assignment_id: 'asn-lock',
      parts: [
        { path: 'p1', name: 'Part 1', part_id: 'part-lock', directories: ['startercode'] },
      ],
    },
  ],
};

describe('push lock regression — no double-lock', () => {
  let tmpDir: string;
  let configPath: string;
  let lockPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vocgit-lock-test-'));
    configPath = path.join(tmpDir, 'vocareum.yaml');
    lockPath = `${configPath}.lock`;
    // Write a minimal YAML so readFile succeeds for the configDigest hash
    await fsp.writeFile(configPath, 'vocareum:\n  course_id: course-lock-test\n', 'utf8');
    loadConfigMock.mockResolvedValue(FIXTURE_CONFIG);

    // API mocks for a dry-run with no content changes
    mockRequest.mockImplementation(async (config: AxiosRequestConfig) => {
      const url: string = config.url ?? '';
      const method = config.method?.toUpperCase();
      if (url.includes('/courses/') && method === 'GET') {
        return { courses: [{ id: 'course-lock-test', name: 'Lock Test Course', org_id: 'org-lock-test' }] };
      }
      if (url.endsWith('/assignments') && method === 'GET') {
        return { assignments: [{ id: 'asn-lock', name: 'Assignment 1' }] };
      }
      if (url.includes('/assignments/asn-lock') && method === 'GET') {
        return { assignments: [{ id: 'asn-lock', name: 'Assignment 1', parts: [{ id: 'part-lock', name: 'Part 1' }] }] };
      }
      if (url.includes('/parts') && method === 'GET') {
        return { parts: [{ id: 'part-lock', name: 'Part 1', seqnum: 1 }] };
      }
      if (url.includes('/parts/part-lock') && method === 'GET') {
        return { parts: [{ id: 'part-lock', name: 'Part 1' }] };
      }
      return {};
    });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('completes a dry-run without throwing CONFIG_LOCKED', async () => {
    // Should NOT throw
    await expect(
      publishCommand({ dryRun: true, config: configPath, root: tmpDir }),
    ).resolves.not.toThrow();
  });

  it('releases the lock file after a dry-run', async () => {
    await publishCommand({ dryRun: true, config: configPath, root: tmpDir });
    // Lock file must not remain after a clean run
    await expect(fsp.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
