/**
 * Workspace Context
 *
 * Resolves the two absolute paths every command operates on:
 * - configPath: the vocareum.yaml to load
 * - workspaceRoot: the directory all assignment/part paths resolve against,
 *   the confinement boundary, and the base for git/.env/auto-commit
 *
 * Root-selection contract (fail-closed — never guess):
 * 1. Explicit --root wins.
 * 2. If the config sits DIRECTLY inside cwd, the workspace root is cwd.
 * 3. Otherwise (--config outside or nested below cwd without --root) the
 *    command fails with an actionable error. Guessing here is how state
 *    corruption happened historically: hashes recorded against the wrong
 *    base directory make every directory look empty-but-synced.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceContext {
  /** Absolute path to vocareum.yaml */
  configPath: string;
  /** Absolute directory that assignment/part paths resolve against */
  workspaceRoot: string;
}

export class WorkspaceError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceOptions {
  /** --config value (default vocareum.yaml) */
  config?: string;
  /** --root value: explicit workspace root */
  root?: string;
}

export function resolveWorkspaceContext(options: WorkspaceOptions): WorkspaceContext {
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, options.config ?? 'vocareum.yaml');

  if (options.root !== undefined && options.root !== '') {
    const workspaceRoot = path.resolve(cwd, options.root);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(workspaceRoot);
    } catch {
      throw new WorkspaceError(
        `--root directory does not exist: ${workspaceRoot}`,
        'ROOT_NOT_FOUND'
      );
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError(
        `--root is not a directory: ${workspaceRoot}`,
        'ROOT_NOT_FOUND'
      );
    }
    return { configPath, workspaceRoot };
  }

  if (path.dirname(configPath) === cwd) {
    return { configPath, workspaceRoot: cwd };
  }

  throw new WorkspaceError(
    `Cannot determine the workspace root: the config file is not directly inside the current directory.\n\n` +
    `  config: ${configPath}\n` +
    `  cwd:    ${cwd}\n\n` +
    `Assignment paths in vocareum.yaml resolve against the workspace root, and guessing it can corrupt sync state.\n` +
    `Pass it explicitly:\n` +
    `  vocgit --config ${options.config ?? 'vocareum.yaml'} --root <workspace-dir>\n` +
    `Use --root . to keep paths relative to the current directory.`,
    'AMBIGUOUS_WORKSPACE_ROOT'
  );
}
