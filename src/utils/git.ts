/**
 * Git Utilities
 *
 * Git operations using simple-git library.
 */

import { simpleGit, type SimpleGit } from 'simple-git';
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
 * Ambient git variables that still reach git under simple-git 4.
 *
 * simple-git 4 strips every inherited `GIT_*` variable unless it is listed in
 * `allowEnvironment`. That silently changed what an auto-commit does: commits
 * lost a `GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity, and a caller's alternate
 * `GIT_INDEX_FILE` was ignored, so unrelated changes staged in the normal index
 * were committed. These describe identity and which repository/index to use.
 * Nothing that can run a program (`GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EDITOR`,
 * `GIT_EXEC_PATH`, `GIT_CONFIG_*`, ...) is listed, so the guard keeps blocking it.
 */
const PASSTHROUGH_GIT_ENV = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_INDEX_FILE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

/**
 * Get a simple-git instance for a directory
 *
 * @param basePath - Directory path (defaults to cwd)
 */
function getGit(basePath?: string): SimpleGit {
  return simpleGit(basePath ?? process.cwd(), { allowEnvironment: PASSTHROUGH_GIT_ENV });
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
