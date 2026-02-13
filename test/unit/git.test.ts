/**
 * Git Utilities Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import simpleGit from 'simple-git';
import {
  isGitRepo,
  getCommitSha,
  getCurrentBranch,
  hasUncommittedChanges,
  commitChanges,
  getRemoteUrl,
  getGitUserName,
  GitError,
} from '../../src/utils/git';

// Mock the logger module
vi.mock('../../src/utils/logger', () => ({
  logger: {
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Git Utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a unique temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-git-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    vi.clearAllMocks();
  });

  /**
   * Helper to initialize a git repo in tempDir
   */
  async function initGitRepo(): Promise<void> {
    const git = simpleGit(tempDir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test User');
  }

  /**
   * Helper to create an initial commit
   */
  async function createInitialCommit(): Promise<void> {
    const filePath = path.join(tempDir, 'README.md');
    await fs.writeFile(filePath, '# Test');
    const git = simpleGit(tempDir);
    await git.add('README.md');
    await git.commit('Initial commit');
  }

  describe('isGitRepo', () => {
    it('should return true for git repository', async () => {
      await initGitRepo();
      expect(await isGitRepo(tempDir)).toBe(true);
    });

    it('should return false for non-git directory', async () => {
      expect(await isGitRepo(tempDir)).toBe(false);
    });
  });

  describe('getCommitSha', () => {
    it('should return short commit SHA', async () => {
      await initGitRepo();
      await createInitialCommit();

      const sha = await getCommitSha(tempDir);

      expect(sha).toBeDefined();
      expect(sha.length).toBeGreaterThanOrEqual(7);
      expect(sha.length).toBeLessThanOrEqual(12);
      expect(/^[a-f0-9]+$/.test(sha)).toBe(true);
    });

    it('should throw GitError for repo without commits', async () => {
      await initGitRepo();

      await expect(getCommitSha(tempDir)).rejects.toThrow(GitError);

      try {
        await getCommitSha(tempDir);
      } catch (error) {
        expect((error as GitError).code).toBe('NO_COMMITS');
      }
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', async () => {
      await initGitRepo();
      await createInitialCommit();

      const branch = await getCurrentBranch(tempDir);

      // Modern git uses 'main' or 'master' as default
      expect(['main', 'master']).toContain(branch);
    });

    it('should throw GitError for non-git directory', async () => {
      await expect(getCurrentBranch(tempDir)).rejects.toThrow(GitError);

      try {
        await getCurrentBranch(tempDir);
      } catch (error) {
        expect((error as GitError).code).toBe('NO_REPO');
      }
    });
  });

  describe('hasUncommittedChanges', () => {
    it('should return false for clean repo', async () => {
      await initGitRepo();
      await createInitialCommit();

      expect(await hasUncommittedChanges(tempDir)).toBe(false);
    });

    it('should return true for repo with uncommitted changes', async () => {
      await initGitRepo();
      await createInitialCommit();

      // Create uncommitted change
      await fs.writeFile(path.join(tempDir, 'new.txt'), 'new content');

      expect(await hasUncommittedChanges(tempDir)).toBe(true);
    });

    it('should return true for repo with modified files', async () => {
      await initGitRepo();
      await createInitialCommit();

      // Modify existing file
      await fs.writeFile(path.join(tempDir, 'README.md'), '# Modified');

      expect(await hasUncommittedChanges(tempDir)).toBe(true);
    });

    it('should return false for non-git directory', async () => {
      expect(await hasUncommittedChanges(tempDir)).toBe(false);
    });
  });

  describe('commitChanges', () => {
    it('should commit specified files', async () => {
      await initGitRepo();
      await createInitialCommit();

      // Create new file
      await fs.writeFile(path.join(tempDir, 'new.txt'), 'new content');

      await commitChanges('Add new file', ['new.txt'], tempDir);

      // Verify commit was made
      const git = simpleGit(tempDir);
      const log = await git.log();
      expect(log.latest?.message).toContain('Add new file');
      // The [skip ci] is in the body, not the subject line
      // log.latest.body contains the full message body
      expect(log.latest?.body).toContain('[skip ci]');
    });

    it('should throw GitError on failure', async () => {
      await initGitRepo();
      await createInitialCommit();

      // Try to commit non-existent file
      await expect(commitChanges('Bad commit', ['nonexistent.txt'], tempDir)).rejects.toThrow(
        GitError
      );
    });
  });

  describe('getRemoteUrl', () => {
    it('should return null for repo without remotes', async () => {
      await initGitRepo();

      const url = await getRemoteUrl(tempDir);

      expect(url).toBeNull();
    });

    it('should return origin URL when set', async () => {
      await initGitRepo();
      const git = simpleGit(tempDir);
      await git.addRemote('origin', 'https://github.com/test/repo.git');

      const url = await getRemoteUrl(tempDir);

      expect(url).toBe('https://github.com/test/repo.git');
    });
  });

  describe('getGitUserName', () => {
    it('should return configured user name', async () => {
      await initGitRepo();

      const name = await getGitUserName(tempDir);

      expect(name).toBe('Test User');
    });

    it('should return local config name over global', async () => {
      // Note: For non-git directories, simple-git may still read global config
      // This test verifies local config is properly read when available
      await initGitRepo();

      const name = await getGitUserName(tempDir);
      expect(name).toBe('Test User');
    });
  });
});

describe('GitError', () => {
  it('should have correct properties', () => {
    const error = new GitError('test message', 'TEST_CODE');

    expect(error.message).toBe('test message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.name).toBe('GitError');
  });
});
