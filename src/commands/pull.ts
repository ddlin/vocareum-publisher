/**
 * Pull Command
 *
 * Interactively handle orphaned assignments (exist in Vocareum but not in local config).
 * Users can import (download content + add to config) or exclude (add to exclusion list).
 */

import * as path from 'path';
import { loadConfig, updateConfig } from '../core/config';
import { reconcile } from '../core/reconciler';
import { VocareumClient } from '../api/client';
import { listParts } from '../api/parts';
import { downloadContent } from '../api/content';
import { logger } from '../utils/logger';
import { loadDotEnvIfPresent, isCI } from '../utils/env';
import { prompt, promptChoice } from '../utils/prompts';
import { pathExists, ensureDirectory, writeFile } from '../utils/files';
import type { Assignment, Part, DirectoryType } from '../types/config';
import type { OrphanedEntity } from '../types/state';
import type { FileMap } from '../types/api';

export interface PullOptions {
  config?: string;
  nonInteractive?: boolean;
  verbose?: boolean;
}

interface PullSummary {
  imported: number;
  excluded: number;
  skipped: number;
  removed: number;
  reset: number;
}

type PullAction = 'import' | 'exclude' | 'skip';
type StaleAction = 'exclude' | 'remove' | 'reset' | 'skip';

/**
 * Convert assignment name to directory-safe slug
 *
 * @param name - Assignment name
 * @returns Slugified name suitable for directory
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '')       // Trim leading/trailing hyphens
    .replace(/--+/g, '-');         // Collapse multiple hyphens
}

/**
 * Get a unique directory name, appending -2, -3, etc. if needed
 *
 * @param basePath - Base directory path
 * @param desiredName - Desired directory name
 * @returns Unique directory name
 */
export async function getUniqueDirectoryName(basePath: string, desiredName: string): Promise<string> {
  let name = desiredName;
  let suffix = 1;

  while (await pathExists(path.join(basePath, name))) {
    suffix++;
    name = `${desiredName}-${suffix}`;
  }

  return name;
}

/**
 * Import an assignment from Vocareum to local repository
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID
 * @param orphan - Orphaned assignment to import
 * @param localPath - Local directory name for the assignment
 * @param verbose - Enable verbose logging
 * @returns Assignment entry for config
 */
async function importAssignment(
  client: VocareumClient,
  courseId: string,
  orphan: OrphanedEntity,
  localPath: string,
  verbose: boolean
): Promise<Assignment> {
  const assignmentId = orphan.id;

  // Get parts for this assignment
  const parts = await listParts(client, courseId, assignmentId);

  if (verbose) {
    logger.debug(`Found ${parts.length} parts for assignment ${orphan.name}`);
  }

  const configParts: Part[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Download content for this part
    const files = await downloadContent(client, courseId, assignmentId, part.id);
    const fileCount = Object.keys(files).length;

    // Determine part path (use part name or index)
    const partPath = parts.length === 1 ? '.' : `part${i + 1}`;

    // Determine directories to create
    const directories: DirectoryType[] = fileCount > 0
      ? detectDirectories(files)
      : ['startercode', 'scripts', 'docs', 'data'];

    // Write files to local directory if any were downloaded
    if (fileCount > 0) {
      await writeFilesToDirectory(localPath, partPath, files, verbose);
    } else {
      // Create empty directory structure
      await createEmptyPartStructure(localPath, partPath, directories);
    }

    // Create part config entry
    const configPart: Part = {
      part_id: part.id,
      path: partPath,
      name: part.name,
      directories,
      settings: {},
    };

    configParts.push(configPart);

    // Report what was downloaded
    if (fileCount > 0) {
      logger.plain(`  Part ${i + 1}/${parts.length}: downloaded ${fileCount} file${fileCount === 1 ? '' : 's'}`);
    } else {
      logger.plain(`  Part ${i + 1}/${parts.length}: created empty structure`);
    }
  }

  // Create assignment config entry
  const assignment: Assignment = {
    assignment_id: assignmentId,
    name: orphan.name,
    path: localPath,
    create_from_template: false,
    settings: {},
    parts: configParts,
  };

  return assignment;
}

/**
 * Detect which directory types exist in the downloaded files
 */
function detectDirectories(files: FileMap): DirectoryType[] {
  const dirs = new Set<DirectoryType>();

  for (const filePath of Object.keys(files)) {
    const parts = filePath.split('/');
    if (parts.length > 0) {
      const dir = parts[0] as DirectoryType;
      if (['startercode', 'scripts', 'docs', 'data', 'lib', 'asnlib'].includes(dir)) {
        dirs.add(dir);
      }
    }
  }

  return dirs.size > 0 ? Array.from(dirs) : ['startercode', 'scripts'];
}

/**
 * Create empty directory structure for a part when no content is downloaded
 */
async function createEmptyPartStructure(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[]
): Promise<void> {
  for (const dir of directories) {
    const dirPath = partPath === '.'
      ? path.join(assignmentPath, dir)
      : path.join(assignmentPath, partPath, dir);
    await ensureDirectory(dirPath);

    // Create .gitkeep to ensure empty dirs are tracked
    await writeFile(path.join(dirPath, '.gitkeep'), '');
  }
}

/**
 * Write downloaded files to local directory structure
 */
async function writeFilesToDirectory(
  assignmentPath: string,
  partPath: string,
  files: FileMap,
  verbose: boolean
): Promise<void> {
  const createdDirs = new Set<string>();

  for (const [relativePath, content] of Object.entries(files)) {
    // File path format from downloadContent: "{dirType}/{filePath}"
    // We want: "{assignmentPath}/{partPath}/{dirType}/{filePath}"
    const targetPath = partPath === '.'
      ? path.join(assignmentPath, relativePath)
      : path.join(assignmentPath, partPath, relativePath);

    await ensureDirectory(path.dirname(targetPath));
    await writeFile(targetPath, content);

    // Track created directories for logging
    const dirPath = path.dirname(targetPath);
    if (!createdDirs.has(dirPath)) {
      createdDirs.add(dirPath);
      if (verbose) {
        logger.debug(`Created ${dirPath}/`);
      }
    }
  }
}

/**
 * Execute the pull command
 */
export async function pullCommand(options: PullOptions): Promise<void> {
  const configPath = options.config ?? 'vocareum.yaml';
  const nonInteractive = options.nonInteractive ?? isCI();
  const verbose = options.verbose ?? false;

  try {
    loadDotEnvIfPresent();
    const config = await loadConfig(configPath);

    // API Key - support both env var names
    const apiKey = process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN;
    if (apiKey === undefined || apiKey === '') {
      logger.error('VOCAREUM_API_KEY (or VOCAREUM_API_TOKEN) environment variable is required.');
      process.exit(1);
    }

    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

    logger.info('Scanning for assignment sync issues...');

    // Run reconciliation to find orphans and stale assignments
    const plan = await reconcile(config, client);

    const hasOrphans = plan.orphanedInVocareum.length > 0;
    const hasStale = plan.staleInConfig.length > 0;

    if (!hasOrphans && !hasStale) {
      logger.success('No sync issues found.');
      return;
    }

    // Track what we do
    const summary: PullSummary = {
      imported: 0,
      excluded: 0,
      skipped: 0,
      removed: 0,
      reset: 0,
    };

    const newAssignments: Partial<Assignment>[] = [];
    const newExclusions: string[] = [];
    const assignmentsToRemove: string[] = [];  // assignment paths to remove
    const assignmentsToReset: string[] = [];   // assignment paths to reset IDs

    // Process orphaned assignments (exist in Vocareum but not in config)
    if (hasOrphans) {
      logger.info(`Found ${plan.orphanedInVocareum.length} orphaned assignment(s) in Vocareum.`);
      logger.newline();

      for (let i = 0; i < plan.orphanedInVocareum.length; i++) {
        const orphan = plan.orphanedInVocareum[i];

        logger.plain(`[${i + 1}/${plan.orphanedInVocareum.length}] ${orphan.name} (ID: ${orphan.id})`);

        let action: PullAction = 'skip';

        if (nonInteractive) {
          action = 'skip';
          logger.plain('  Skipped (non-interactive mode)');
        } else {
          const choice = await promptChoice('What would you like to do?', [
            'Import to local repository',
            'Exclude (hide from future scans)',
            'Skip (do nothing)',
          ]);

          if (choice === 'Import to local repository') {
            action = 'import';
          } else if (choice === 'Exclude (hide from future scans)') {
            action = 'exclude';
          } else {
            action = 'skip';
          }
        }

        if (action === 'import') {
          const defaultSlug = slugify(orphan.name);
          const suggestedName = await getUniqueDirectoryName('.', defaultSlug);

          const dirName = await prompt('Local directory name:', suggestedName);
          const finalDirName = await getUniqueDirectoryName('.', dirName || suggestedName);

          try {
            const assignment = await importAssignment(
              client,
              config.vocareum.course_id,
              orphan,
              finalDirName,
              verbose
            );

            newAssignments.push(assignment);
            summary.imported++;
            logger.success(`Imported "${orphan.name}" to ${finalDirName}/`);
          } catch (error) {
            logger.error(`Failed to import: ${error instanceof Error ? error.message : 'Unknown'}`);
            summary.skipped++;
          }
        } else if (action === 'exclude') {
          newExclusions.push(orphan.id);
          summary.excluded++;
          logger.success(`Excluded "${orphan.name}" from orphan detection`);
        } else {
          summary.skipped++;
          logger.plain('  Skipped');
        }

        logger.newline();
      }
    }

    // Process stale assignments (exist in config but deleted from Vocareum)
    if (hasStale) {
      logger.info(`Found ${plan.staleInConfig.length} stale assignment(s) in config (deleted from Vocareum).`);
      logger.newline();

      for (let i = 0; i < plan.staleInConfig.length; i++) {
        const stale = plan.staleInConfig[i];

        logger.plain(`[${i + 1}/${plan.staleInConfig.length}] ${stale.name} (ID: ${stale.assignment_id}, path: ${stale.path})`);

        let action: StaleAction = 'skip';

        if (nonInteractive) {
          action = 'skip';
          logger.plain('  Skipped (non-interactive mode)');
        } else {
          const choice = await promptChoice('This assignment was deleted from Vocareum. What would you like to do?', [
            'Reset ID (allow re-creation from template)',
            'Remove from config',
            'Exclude (keep in config but skip during sync)',
            'Skip (do nothing)',
          ]);

          if (choice === 'Reset ID (allow re-creation from template)') {
            action = 'reset';
          } else if (choice === 'Remove from config') {
            action = 'remove';
          } else if (choice === 'Exclude (keep in config but skip during sync)') {
            action = 'exclude';
          } else {
            action = 'skip';
          }
        }

        if (action === 'reset') {
          assignmentsToReset.push(stale.path);
          summary.reset++;
          logger.success(`Reset ID for "${stale.name}" - will be re-created on next publish`);
        } else if (action === 'remove') {
          assignmentsToRemove.push(stale.path);
          summary.removed++;
          logger.success(`Removed "${stale.name}" from config`);
        } else if (action === 'exclude') {
          newExclusions.push(stale.assignment_id);
          summary.excluded++;
          logger.success(`Excluded "${stale.name}" from sync`);
        } else {
          summary.skipped++;
          logger.plain('  Skipped');
        }

        logger.newline();
      }
    }

    // Update config if we made any changes
    const hasChanges = newAssignments.length > 0 ||
                       newExclusions.length > 0 ||
                       assignmentsToRemove.length > 0 ||
                       assignmentsToReset.length > 0;

    if (hasChanges) {
      await updateConfig(configPath, {
        assignments: newAssignments.length > 0 ? newAssignments : undefined,
        excluded_assignments: newExclusions.length > 0 ? newExclusions : undefined,
        remove_assignments: assignmentsToRemove.length > 0 ? assignmentsToRemove : undefined,
        reset_assignment_ids: assignmentsToReset.length > 0 ? assignmentsToReset : undefined,
      });

      logger.info('Updated vocareum.yaml');
    }

    // Print summary
    logger.newline();
    logger.info('Summary:');
    logger.plain(`  Imported: ${summary.imported}`);
    logger.plain(`  Excluded: ${summary.excluded}`);
    logger.plain(`  Removed:  ${summary.removed}`);
    logger.plain(`  Reset:    ${summary.reset}`);
    logger.plain(`  Skipped:  ${summary.skipped}`);

  } catch (error) {
    logger.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
