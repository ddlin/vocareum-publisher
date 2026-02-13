/**
 * Git Utilities
 *
 * Git operations using simple-git library.
 */

import simpleGit, { SimpleGit } from 'simple-git';
import { logger } from './logger';

/**
 * Error for git operation failures
 */
export class GitError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Get a simple-git instance for a directory
 *
 * @param basePath - Directory path (defaults to cwd)
 */
function getGit(basePath?: string): SimpleGit {
  return simpleGit(basePath ?? process.cwd());
}

/**
 * Check if a directory is a git repository
 *
 * @param basePath - Directory to check (defaults to cwd)
 */
export async function isGitRepo(basePath?: string): Promise<boolean> {
  try {
    const git = getGit(basePath);
    await git.revparse(['--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current commit SHA (short form)
 *
 * @param basePath - Repository path (defaults to cwd)
 */
export async function getCommitSha(basePath?: string): Promise<string> {
  const git = getGit(basePath);
  try {
    const sha = await git.revparse(['--short', 'HEAD']);
    return sha.trim();
  } catch {
    throw new GitError('Not a git repository or no commits yet', 'NO_COMMITS');
  }
}

/**
 * Get the current branch name
 *
 * @param basePath - Repository path (defaults to cwd)
 */
export async function getCurrentBranch(basePath?: string): Promise<string> {
  const git = getGit(basePath);
  try {
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    return branch.trim();
  } catch {
    throw new GitError('Not a git repository', 'NO_REPO');
  }
}

/**
 * Check if there are uncommitted changes
 *
 * @param basePath - Repository path (defaults to cwd)
 */
export async function hasUncommittedChanges(basePath?: string): Promise<boolean> {
  const git = getGit(basePath);
  try {
    const status = await git.status();
    return !status.isClean();
  } catch {
    return false;
  }
}

/**
 * Commit specific files with a message
 * Includes [skip ci] to prevent CI loops
 *
 * @param message - Commit message
 * @param files - Files to stage and commit
 * @param basePath - Repository path (defaults to cwd)
 */
export async function commitChanges(
  message: string,
  files: string[],
  basePath?: string
): Promise<void> {
  const git = getGit(basePath);

  try {
    // Stage specific files
    await git.add(files);

    // Commit with [skip ci] to prevent CI loops
    const fullMessage = `${message}\n\n[skip ci]`;
    await git.commit(fullMessage);

    logger.success('Changes committed');
  } catch (error) {
    throw new GitError(
      `Failed to commit changes: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'COMMIT_FAILED'
    );
  }
}

/**
 * Get the remote URL for origin
 *
 * @param basePath - Repository path (defaults to cwd)
 */
export async function getRemoteUrl(basePath?: string): Promise<string | null> {
  const git = getGit(basePath);
  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return origin?.refs?.fetch ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the user name from git config
 *
 * @param basePath - Repository path (defaults to cwd)
 */
export async function getGitUserName(basePath?: string): Promise<string | null> {
  const git = getGit(basePath);
  try {
    const name = await git.getConfig('user.name');
    return name.value;
  } catch {
    return null;
  }
}
