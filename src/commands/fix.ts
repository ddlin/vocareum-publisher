/**
 * Fix Command
 *
 * Interactively fix validation issues.
 */


import * as path from 'path';
import { loadConfig } from '../core/config';
import { assertConfinedToWorkspace } from '../core/local-scan';
import { validateStructure } from '../core/validator';
import { resolveWorkspaceContext } from '../core/workspace';
import { ensureDirectory } from '../utils/files';
import { logger } from '../utils/logger';
import { promptConfirm } from '../utils/prompts';

export interface FixOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  nonInteractive?: boolean;
}

/**
 * Execute the fix command
 */
export async function fixCommand(options: FixOptions): Promise<void> {
  const { configPath, workspaceRoot } = resolveWorkspaceContext({
    config: options.config,
    root: options.root,
  });

  try {
    const config = await loadConfig(configPath);
    logger.info('Analyzing structure...');

    // We pass config and basePath.
    // validateStructure(config, basePath) - ensure validator.ts signature matches
    const result = await validateStructure(config, workspaceRoot);

    if (result.valid) {
      logger.success('No issues found to fix.');
      return;
    }

    const missingFolders = result.errors.filter(e => e.type === 'missing_folder');

    if (missingFolders.length === 0) {
      logger.info('No missing folders to fix.');
      // Could handle orphans or other types here
      return;
    }

    logger.info(`Found ${missingFolders.length} missing folders.`);

    for (const error of missingFolders) {
      // Fix: "Run: vocgit new ..." or "Create directory: ..."
      // The error object has a 'fix' message, but we want to ACT on it.
      // We can infer the path from `error.path`.

      // Error structure from validator.ts:
      // { type: 'missing_folder', path: 'assignment/part', ... }
      // The `path` in error is relative path.

      const folderPath = error.path;
      // Validator paths are workspace-relative — create under the workspace
      // root, and never outside it (defense in depth: the validator already
      // refuses to classify escaping paths as missing_folder).
      await assertConfinedToWorkspace(workspaceRoot, folderPath);
      const folderAbs = path.resolve(workspaceRoot, folderPath);

      if (options.nonInteractive === true) {
        logger.info(`Creating ${folderPath}...`);
        await ensureDirectory(folderAbs);
      } else {
        const create = await promptConfirm(`Create missing folder "${folderPath}"?`);
        if (create) {
          await ensureDirectory(folderAbs);
          logger.success(`Created ${folderPath}`);
        }
      }
    }

    logger.success('Fix operations completed.');

  } catch (error) {
    logger.error(`Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

