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
import { getAssignment } from '../api/assignments';
import { listParts, getPart } from '../api/parts';
import { downloadContent } from '../api/content';
import { logger } from '../utils/logger';
import { loadDotEnvIfPresent, isCI } from '../utils/env';
import { prompt, promptChoice } from '../utils/prompts';
import { pathExists, ensureDirectory, writeFile, calculateDirectoryHash, validatePath } from '../utils/files';
import { getCommitSha, getGitUserName } from '../utils/git';
import type { PublishHistory } from '../types/config';
import { mapAssignmentSettings, mapPartSettings } from '../utils/settings';
import { normalizeSubmissionFilters, DEFAULT_PART_DIRECTORIES } from '../types/config';
import type { Assignment, Part, DirectoryType, AssignmentSettings, PartSettings, SubmissionFilters } from '../types/config';
import type { OrphanedEntity } from '../types/state';
import type { FileMap } from '../types/api';

export interface PullOptions {
  config?: string;
  nonInteractive?: boolean;
  /** Batch mode: apply sensible defaults without prompting (import orphans, pull drift, skip stale) */
  batch?: boolean;
  verbose?: boolean;
}

interface PullSummary {
  imported: number;
  excluded: number;
  skipped: number;
  removed: number;
  reset: number;
  settingsPulled: number;
  contentPulled: number;
}

type PullAction = 'import' | 'exclude' | 'skip';
type StaleAction = 'exclude' | 'remove' | 'reset' | 'skip';
type SettingsDriftAction = 'pull' | 'keep' | 'skip';

/** Result from importing an assignment, includes content state for history tracking */
interface ImportResult {
  assignment: Assignment;
  contentState: Record<string, string>;  // path -> hash
}

/** Represents a single setting that differs between local and remote */
interface SettingDiff {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

/** Represents settings drift for a part */
interface PartSettingsDrift {
  partId: string;
  partName: string;
  partPath: string;
  diffs: SettingDiff[];
  remoteSettings: NonNullable<PartSettings>;
}

/** Represents settings drift for an assignment */
interface AssignmentSettingsDrift {
  assignmentId: string;
  assignmentName: string;
  assignmentPath: string;
  assignmentDiffs: SettingDiff[];
  remoteAssignmentSettings: NonNullable<AssignmentSettings>;
  partsDrift: PartSettingsDrift[];
}

/** Represents a file that differs between local and remote */
interface FileDiff {
  filePath: string;
  status: 'modified' | 'added' | 'deleted';
}

/** Represents content drift for a part */
interface PartContentDrift {
  partId: string;
  partName: string;
  partPath: string;
  fileDiffs: FileDiff[];
  remoteFiles: FileMap;
}

/** Represents content drift for an assignment */
interface AssignmentContentDrift {
  assignmentId: string;
  assignmentName: string;
  assignmentPath: string;
  partsDrift: PartContentDrift[];
}

type ContentDriftAction = 'pull' | 'keep' | 'skip';

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
 * Compare two values for equality (handles objects/arrays)
 * @internal Exported for testing
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === undefined || b === undefined) { return false; }
  // Handle string/number comparison (API returns strings for some numbers)
  if (typeof a === 'number' && typeof b === 'string') {
    return a === parseInt(b, 10);
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return parseInt(a, 10) === b;
  }
  if (typeof a !== typeof b) { return false; }
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === undefined) { return '(not set)'; }
  if (value === null) { return 'null'; }
  if (typeof value === 'object') { return JSON.stringify(value); }
  return String(value);
}

/**
 * Compare assignment settings and return differences
 */
function compareAssignmentSettings(
  localSettings: NonNullable<AssignmentSettings> | undefined,
  remoteSettings: NonNullable<AssignmentSettings>
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  // Cast to Record for safe dynamic key access
  const local: Record<string, unknown> = localSettings ?? {};
  const remote: Record<string, unknown> = remoteSettings;

  // All possible assignment setting keys
  const keys = [
    'description', 'nosubmit', 'publish', 'publish_grades',
    'auto_submit', 'grading_on_submit', 'noworkarea',
    'exam_mode', 'exam_duration', 'num_attempts',
    'show_end_exam_button', 'copy_startercode', 'uncompressupload',
    'lti_on', 'anonymous_grading', 'grading_visibility',
    'send_webhook', 'live_code_comments',
  ];

  for (const key of keys) {
    const localVal = local[key];
    const remoteVal = remote[key];

    // Only report if remote has a value and it differs from local
    if (remoteVal !== undefined && !valuesEqual(localVal, remoteVal)) {
      diffs.push({ key, localValue: localVal, remoteValue: remoteVal });
    }
  }

  return diffs;
}

/**
 * Compare part settings and return differences
 */
function comparePartSettings(
  localSettings: NonNullable<PartSettings> | undefined,
  remoteSettings: NonNullable<PartSettings>
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  // Cast to Record for safe dynamic key access
  const local: Record<string, unknown> = localSettings ?? {};
  const remote: Record<string, unknown> = remoteSettings;

  // All possible part setting keys
  const keys = [
    'submission_filters', 'cloud_labs', 'instant_aws_access',
    'session_length', 'monthly_dollar', 'monthly_time', 'total_time', 'total_dollar',
    'late_penalty_percent', 'late_penalty_percent_rule', 'deadlinedate',
    'endlab', 'labtype', 'container_image', 'number_of_submissions', 'lab_interface',
    'databricks_maxusers', 'tags',
  ];

  for (const key of keys) {
    const localVal = local[key];
    const remoteVal = remote[key];

    if (key === 'submission_filters') {
      const normalizedLocal = normalizeSubmissionFilters(localVal as SubmissionFilters | null | undefined);
      const normalizedRemote = normalizeSubmissionFilters(remoteVal as SubmissionFilters | null | undefined);
      if (!valuesEqual(normalizedLocal, normalizedRemote)) {
        diffs.push({
          key,
          localValue: normalizedLocal,
          remoteValue: normalizedRemote,
        });
      }
      continue;
    }

    // Only report if remote has a value and it differs from local
    if (remoteVal !== undefined && !valuesEqual(localVal, remoteVal)) {
      diffs.push({ key, localValue: localVal, remoteValue: remoteVal });
    }
  }

  return diffs;
}

/**
 * Detect settings drift for all assignments in config
 *
 * @param config - Configuration with assignments
 * @param client - Vocareum API client
 * @param skipAssignmentIds - Assignment IDs to skip (stale or excluded)
 */
async function detectSettingsDrift(
  config: { assignments: Assignment[]; vocareum: { course_id: string; excluded_assignments?: string[]; architecture?: 'elite' | 'container' } },
  client: VocareumClient,
  skipAssignmentIds: Set<string>
): Promise<AssignmentSettingsDrift[]> {
  const driftList: AssignmentSettingsDrift[] = [];

  // Also skip excluded assignments from config
  const excludedIds = new Set(config.vocareum.excluded_assignments ?? []);

  for (const assignment of config.assignments) {
    // Skip assignments without IDs (not yet created in Vocareum)
    if (assignment.assignment_id === undefined || assignment.assignment_id === null || assignment.assignment_id === '') { continue; }

    // Skip stale assignments (already identified as deleted)
    if (skipAssignmentIds.has(assignment.assignment_id)) { continue; }

    // Skip excluded assignments
    if (excludedIds.has(assignment.assignment_id)) { continue; }

    try {
      // Fetch full assignment details
      const remoteAssignment = await getAssignment(client, config.vocareum.course_id, assignment.assignment_id);
      const remoteAssignmentSettings = mapAssignmentSettings(remoteAssignment);

      // Compare assignment settings
      const assignmentDiffs = compareAssignmentSettings(assignment.settings, remoteAssignmentSettings);

      // Check parts
      const partsDrift: PartSettingsDrift[] = [];
      const remoteParts = await listParts(client, config.vocareum.course_id, assignment.assignment_id);

      for (const configPart of assignment.parts) {
        if (configPart.part_id === undefined || configPart.part_id === null || configPart.part_id === '') { continue; }

        // Find matching remote part
        const remotePart = remoteParts.find(p => p.id === configPart.part_id);
        if (!remotePart) { continue; }

        // Fetch full part details
        const fullRemotePart = await getPart(client, config.vocareum.course_id, assignment.assignment_id, configPart.part_id);
        const remotePartSettings = mapPartSettings(fullRemotePart);

        // Compare part settings
        const partDiffs = comparePartSettings(configPart.settings, remotePartSettings);

        if (partDiffs.length > 0) {
          partsDrift.push({
            partId: configPart.part_id,
            partName: configPart.name ?? remotePart.name,
            partPath: configPart.path,
            diffs: partDiffs,
            remoteSettings: remotePartSettings,
          });
        }
      }

      // Only add to drift list if there are differences
      if (assignmentDiffs.length > 0 || partsDrift.length > 0) {
        driftList.push({
          assignmentId: assignment.assignment_id,
          assignmentName: assignment.name,
          assignmentPath: assignment.path,
          assignmentDiffs,
          remoteAssignmentSettings,
          partsDrift,
        });
      }
    } catch (error) {
      // Assignment may have been deleted - handled by stale detection
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn(`Could not fetch settings for assignment "${assignment.name}" (ID: ${assignment.assignment_id}): ${message}`);
      continue;
    }
  }

  return driftList;
}

/**
 * Detect content drift between local files and Vocareum
 *
 * Compares local files against remote files and identifies:
 * - Modified files (exist both locally and remotely but content differs)
 * - Added files (exist remotely but not locally)
 * - Deleted files (exist locally but not remotely)
 *
 * @param config - Configuration with assignments
 * @param client - Vocareum API client
 * @param skipAssignmentIds - Assignment IDs to skip (stale or excluded)
 * @param verbose - Enable verbose logging
 */
async function detectContentDrift(
  config: { assignments: Assignment[]; vocareum: { course_id: string; excluded_assignments?: string[]; architecture?: 'elite' | 'container' } },
  client: VocareumClient,
  skipAssignmentIds: Set<string>,
  verbose: boolean
): Promise<AssignmentContentDrift[]> {
  const driftList: AssignmentContentDrift[] = [];
  const excludedIds = new Set(config.vocareum.excluded_assignments ?? []);

  for (const assignment of config.assignments) {
    if (!assignment.assignment_id) { continue; }
    if (skipAssignmentIds.has(assignment.assignment_id)) { continue; }
    if (excludedIds.has(assignment.assignment_id)) { continue; }

    try {
      const partsDrift: PartContentDrift[] = [];

      for (const configPart of assignment.parts) {
        if (!configPart.part_id) { continue; }

        // Download remote content for this part
        const remoteFiles = await downloadContent(
          client,
          config.vocareum.course_id,
          assignment.assignment_id,
          configPart.part_id,
          undefined, // use default directories
          config.vocareum.architecture
        );

        const fileDiffs: FileDiff[] = [];
        const localBasePath = configPart.path === '.'
          ? assignment.path
          : path.join(assignment.path, configPart.path);

        // Compare remote files with local files
        for (const [remotePath, remoteContent] of Object.entries(remoteFiles)) {
          // Validate path to prevent traversal attacks from malicious remote paths
          validatePath(localBasePath, remotePath);
          const localPath = path.join(localBasePath, remotePath);

          if (await pathExists(localPath)) {
            // File exists locally - check if content differs
            const fs = await import('fs/promises');
            const localContent = await fs.readFile(localPath);
            const remoteBuffer = Buffer.isBuffer(remoteContent)
              ? remoteContent
              : Buffer.from(remoteContent);

            if (!localContent.equals(remoteBuffer)) {
              fileDiffs.push({ filePath: remotePath, status: 'modified' });
            }
          } else {
            // File exists remotely but not locally
            fileDiffs.push({ filePath: remotePath, status: 'added' });
          }
        }

        // Check for files that exist locally but not remotely (deleted on remote)
        const directories = configPart.directories ?? DEFAULT_PART_DIRECTORIES;
        for (const dir of directories) {
          const localDirPath = path.join(localBasePath, dir);
          if (!await pathExists(localDirPath)) { continue; }

          const fs = await import('fs/promises');
          try {
            // Read directory recursively and check for files not on remote
            const localFilesRaw = await fs.readdir(localDirPath, { recursive: true });
            for (const entry of localFilesRaw) {
              const file = String(entry);
              if (file === '.gitkeep' || file.endsWith('/.gitkeep')) { continue; }

              const relativePath = path.join(dir, file);
              const fullPath = path.join(localDirPath, file);
              const stat = await fs.stat(fullPath);
              if (stat.isFile() && remoteFiles[relativePath] === undefined) {
                fileDiffs.push({ filePath: relativePath, status: 'deleted' });
              }
            }
          } catch {
            // Directory doesn't exist or can't be read
          }
        }

        if (fileDiffs.length > 0) {
          partsDrift.push({
            partId: configPart.part_id,
            partName: configPart.name ?? 'Part',
            partPath: configPart.path,
            fileDiffs,
            remoteFiles,
          });
        }
      }

      if (partsDrift.length > 0) {
        driftList.push({
          assignmentId: assignment.assignment_id,
          assignmentName: assignment.name,
          assignmentPath: assignment.path,
          partsDrift,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (verbose) {
        logger.warn(`Could not check content for "${assignment.name}": ${message}`);
      }
    }
  }

  return driftList;
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
  verbose: boolean,
  architecture?: 'elite' | 'container'
): Promise<ImportResult> {
  const assignmentId = orphan.id;

  // Get full assignment details including settings
  const fullAssignment = await getAssignment(client, courseId, assignmentId);
  const assignmentSettings = mapAssignmentSettings(fullAssignment);

  if (verbose && Object.keys(assignmentSettings).length > 0) {
    logger.debug(`Imported ${Object.keys(assignmentSettings).length} assignment settings`);
  }

  // Get parts for this assignment
  const parts = await listParts(client, courseId, assignmentId);

  if (verbose) {
    logger.debug(`Found ${parts.length} parts for assignment ${orphan.name}`);
  }

  const configParts: Part[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Get full part details including settings
    const fullPart = await getPart(client, courseId, assignmentId, part.id);
    const partSettings = mapPartSettings(fullPart);

    if (verbose && Object.keys(partSettings).length > 0) {
      logger.debug(`Imported ${Object.keys(partSettings).length} settings for part ${part.name}`);
    }

    // Download content for this part
    const files = await downloadContent(client, courseId, assignmentId, part.id, undefined, architecture);
    const fileCount = Object.keys(files).length;

    // Determine part path (use part name or index)
    const partPath = parts.length === 1 ? '.' : `part${i + 1}`;

    // Always include default directories, plus any detected from downloaded files
    const detectedDirs = fileCount > 0 ? detectDirectories(files) : [];
    const directories = mergeDirectories(DEFAULT_PART_DIRECTORIES, detectedDirs);

    // Write files to local directory if any were downloaded
    if (fileCount > 0) {
      await writeFilesToDirectory(localPath, partPath, files, verbose);
    }

    // Always create the full directory structure (including empty directories with .gitkeep)
    await ensurePartDirectories(localPath, partPath, directories, verbose);

    // Create part config entry with settings
    const configPart: Part = {
      part_id: part.id,
      path: partPath,
      name: part.name,
      directories,
      settings: partSettings,
    };

    configParts.push(configPart);

    // Report what was downloaded
    if (fileCount > 0) {
      logger.plain(`  Part ${i + 1}/${parts.length}: downloaded ${fileCount} file${fileCount === 1 ? '' : 's'}`);
    } else {
      logger.plain(`  Part ${i + 1}/${parts.length}: created empty structure`);
    }
  }

  // Create assignment config entry with settings
  const assignment: Assignment = {
    assignment_id: assignmentId,
    name: orphan.name,
    path: localPath,
    create_from_template: false,
    settings: assignmentSettings,
    parts: configParts,
  };

  // Calculate content hashes for each directory in each part
  // Key format must match reconciler: assignmentPath/partPath/directory
  // IMPORTANT: Must exclude .gitkeep files to match reconciler behavior
  const excludePatterns = ['.gitkeep', '**/.gitkeep'];
  const contentState: Record<string, string> = {};
  for (const configPart of configParts) {
    const partPath = configPart.path;
    const directories = configPart.directories ?? DEFAULT_PART_DIRECTORIES;

    for (const dir of directories) {
      // Build the directory path and state key to match reconciler format
      const dirPath = partPath === '.'
        ? path.join(localPath, dir)
        : path.join(localPath, partPath, dir);

      const stateKey = partPath === '.'
        ? path.join(localPath, dir)
        : path.join(localPath, partPath, dir);

      try {
        const hash = await calculateDirectoryHash(dirPath, excludePatterns);
        contentState[stateKey] = hash;

        if (verbose) {
          logger.debug(`Content hash for ${stateKey}: ${hash.substring(0, 8)}...`);
        }
      } catch (error) {
        // Directory might not exist - skip it
        if (verbose) {
          logger.debug(`Could not hash ${dirPath}: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
      }
    }
  }

  return { assignment, contentState };
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
      // Note: 'course' excluded - shared course-wide files not synced to avoid update loops
      if ((DEFAULT_PART_DIRECTORIES as readonly string[]).includes(dir)) {
        dirs.add(dir);
      }
    }
  }

  return Array.from(dirs);
}

/**
 * Merge default directories with detected directories, removing duplicates
 */
function mergeDirectories(defaults: DirectoryType[], detected: DirectoryType[]): DirectoryType[] {
  const merged = new Set<DirectoryType>(defaults);
  for (const dir of detected) {
    merged.add(dir);
  }
  return Array.from(merged);
}

/**
 * Ensure all directories exist for a part, creating .gitkeep in empty ones
 */
async function ensurePartDirectories(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[],
  verbose: boolean
): Promise<void> {
  const fs = await import('fs/promises');

  for (const dir of directories) {
    const dirPath = partPath === '.'
      ? path.join(assignmentPath, dir)
      : path.join(assignmentPath, partPath, dir);

    await ensureDirectory(dirPath);

    // Check if directory is empty (no files other than .gitkeep)
    let isEmpty = true;
    try {
      const entries = await fs.readdir(dirPath);
      isEmpty = entries.length === 0 || (entries.length === 1 && entries[0] === '.gitkeep');
    } catch {
      // Directory doesn't exist yet or can't be read - treat as empty
      isEmpty = true;
    }

    if (isEmpty) {
      // Create .gitkeep to ensure empty dirs are tracked in git
      await writeFile(path.join(dirPath, '.gitkeep'), '');
      if (verbose) {
        logger.debug(`Created ${dirPath}/.gitkeep`);
      }
    }
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

  // Compute base path for validation
  const basePath = partPath === '.' ? assignmentPath : path.join(assignmentPath, partPath);

  for (const [relativePath, content] of Object.entries(files)) {
    // Validate path to prevent traversal attacks from malicious remote paths
    validatePath(basePath, relativePath);

    // File path format from downloadContent: "{dirType}/{filePath}"
    // We want: "{assignmentPath}/{partPath}/{dirType}/{filePath}"
    const targetPath = path.join(basePath, relativePath);

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
  const batch = options.batch ?? false;
  const nonInteractive = !batch && (options.nonInteractive ?? isCI());
  const verbose = options.verbose ?? false;

  try {
    loadDotEnvIfPresent();
    const config = await loadConfig(configPath);

    // API Key - support both env var names
    const apiKey = process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN;
    if (apiKey === undefined || apiKey === '') {
      logger.error('VOCAREUM_API_KEY environment variable is required.');
      logger.error('');
      logger.error('To fix:');
      logger.error('  1. Generate a token at Vocareum: Profile > Settings > Personal Access Tokens');
      logger.error('  2. Set it using one of these methods:');
      logger.error('     - Create a .env file with: VOCAREUM_API_KEY=your_token');
      logger.error('     - Export in shell: export VOCAREUM_API_KEY=your_token');
      process.exit(1);
    }

    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

    logger.info('Scanning for assignment sync issues...');

    // Run reconciliation to find orphans and stale assignments
    const plan = await reconcile(config, client);

    // Detect settings drift (skip stale assignments that are already identified as deleted)
    const staleAssignmentIds = new Set(plan.staleInConfig.map(s => s.assignment_id));
    const settingsDrift = await detectSettingsDrift(config, client, staleAssignmentIds);

    // Detect content drift (files changed on Vocareum)
    const contentDrift = await detectContentDrift(config, client, staleAssignmentIds, verbose);

    const hasOrphans = plan.orphanedInVocareum.length > 0;
    const hasStale = plan.staleInConfig.length > 0;
    const hasSettingsDrift = settingsDrift.length > 0;
    const hasContentDrift = contentDrift.length > 0;

    if (!hasOrphans && !hasStale && !hasSettingsDrift && !hasContentDrift) {
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
      settingsPulled: 0,
      contentPulled: 0,
    };

    const newAssignments: Partial<Assignment>[] = [];
    const newExclusions: string[] = [];
    const assignmentsToRemove: string[] = [];  // assignment paths to remove
    const assignmentsToReset: string[] = [];   // assignment paths to reset IDs
    const settingsUpdates: Map<string, { assignmentSettings?: NonNullable<AssignmentSettings>; partSettings?: Map<string, NonNullable<PartSettings>> }> = new Map();
    const importedContentState: Record<string, string> = {};  // Accumulated content hashes from imports

    // Process orphaned assignments (exist in Vocareum but not in config)
    if (hasOrphans) {
      logger.info(`Found ${plan.orphanedInVocareum.length} orphaned assignment(s) in Vocareum.`);
      logger.newline();

      for (let i = 0; i < plan.orphanedInVocareum.length; i++) {
        const orphan = plan.orphanedInVocareum[i];

        logger.plain(`[${i + 1}/${plan.orphanedInVocareum.length}] ${orphan.name} (ID: ${orphan.id})`);

        let action: PullAction = 'skip';

        if (batch) {
          action = 'import';
          logger.plain('  Importing (batch mode)');
        } else if (nonInteractive) {
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

          const finalDirName = batch
            ? suggestedName
            : await getUniqueDirectoryName('.', (await prompt('Local directory name:', suggestedName)) || suggestedName);

          try {
            const { assignment, contentState } = await importAssignment(
              client,
              config.vocareum.course_id,
              orphan,
              finalDirName,
              verbose,
              config.vocareum.architecture
            );

            newAssignments.push(assignment);
            // Merge content state for publish history tracking
            Object.assign(importedContentState, contentState);
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

        if (batch) {
          action = 'skip';
          logger.plain('  Skipped (batch mode)');
        } else if (nonInteractive) {
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

    // Process settings drift (local settings differ from Vocareum)
    if (hasSettingsDrift) {
      logger.info(`Found ${settingsDrift.length} assignment(s) with settings drift.`);
      logger.newline();

      for (let i = 0; i < settingsDrift.length; i++) {
        const drift = settingsDrift[i];

        logger.plain(`[${i + 1}/${settingsDrift.length}] ${drift.assignmentName} (ID: ${drift.assignmentId})`);

        // Show assignment-level diffs
        if (drift.assignmentDiffs.length > 0) {
          logger.plain('  Assignment settings changed in Vocareum:');
          for (const diff of drift.assignmentDiffs) {
            logger.plain(`    - ${diff.key}: ${formatValue(diff.localValue)} → ${formatValue(diff.remoteValue)}`);
          }
        }

        // Show part-level diffs
        for (const partDrift of drift.partsDrift) {
          logger.plain(`  Part "${partDrift.partName}" settings changed:`);
          for (const diff of partDrift.diffs) {
            logger.plain(`    - ${diff.key}: ${formatValue(diff.localValue)} → ${formatValue(diff.remoteValue)}`);
          }
        }

        let action: SettingsDriftAction = 'skip';

        if (batch) {
          action = 'pull';
          logger.plain('  Pulling settings (batch mode)');
        } else if (nonInteractive) {
          action = 'skip';
          logger.plain('  Skipped (non-interactive mode)');
        } else {
          const choice = await promptChoice('What would you like to do?', [
            'Pull settings from Vocareum (update local config)',
            'Keep local settings (will overwrite Vocareum on next publish)',
            'Skip (do nothing for now)',
          ]);

          if (choice === 'Pull settings from Vocareum (update local config)') {
            action = 'pull';
          } else if (choice === 'Keep local settings (will overwrite Vocareum on next publish)') {
            action = 'keep';
          } else {
            action = 'skip';
          }
        }

        if (action === 'pull') {
          // Store settings to update
          const partSettingsMap = new Map<string, NonNullable<PartSettings>>();
          for (const partDrift of drift.partsDrift) {
            partSettingsMap.set(partDrift.partPath, partDrift.remoteSettings);
          }

          settingsUpdates.set(drift.assignmentPath, {
            assignmentSettings: drift.assignmentDiffs.length > 0 ? drift.remoteAssignmentSettings : undefined,
            partSettings: partSettingsMap.size > 0 ? partSettingsMap : undefined,
          });

          summary.settingsPulled++;
          logger.success(`Will update local settings for "${drift.assignmentName}"`);
        } else if (action === 'keep') {
          logger.plain('  Keeping local settings (will push to Vocareum on next publish)');
        } else {
          summary.skipped++;
          logger.plain('  Skipped');
        }

        logger.newline();
      }
    }

    // Process content drift (files changed on Vocareum)
    if (hasContentDrift) {
      logger.info(`Found ${contentDrift.length} assignment(s) with content changes on Vocareum.`);
      logger.newline();

      for (let i = 0; i < contentDrift.length; i++) {
        const drift = contentDrift[i];

        logger.plain(`[${i + 1}/${contentDrift.length}] ${drift.assignmentName} (ID: ${drift.assignmentId})`);

        // Show file changes per part
        for (const partDrift of drift.partsDrift) {
          const partLabel = partDrift.partPath === '.' ? '' : ` (${partDrift.partName})`;
          logger.plain(`  Content changes${partLabel}:`);

          // Group by status
          const modified = partDrift.fileDiffs.filter(f => f.status === 'modified');
          const added = partDrift.fileDiffs.filter(f => f.status === 'added');
          const deleted = partDrift.fileDiffs.filter(f => f.status === 'deleted');

          for (const file of modified) {
            logger.plain(`    ~ ${file.filePath} (modified)`);
          }
          for (const file of added) {
            logger.plain(`    + ${file.filePath} (new on remote)`);
          }
          for (const file of deleted) {
            logger.plain(`    - ${file.filePath} (deleted on remote)`);
          }
        }

        let action: ContentDriftAction = 'skip';

        if (batch) {
          action = 'pull';
          logger.plain('  Pulling content (batch mode)');
        } else if (nonInteractive) {
          action = 'skip';
          logger.plain('  Skipped (non-interactive mode)');
        } else {
          const choice = await promptChoice('What would you like to do?', [
            'Pull remote files (overwrite local)',
            'Keep local files (will overwrite remote on next push)',
            'Skip (do nothing for now)',
          ]);

          if (choice === 'Pull remote files (overwrite local)') {
            action = 'pull';
          } else if (choice === 'Keep local files (will overwrite remote on next push)') {
            action = 'keep';
          } else {
            action = 'skip';
          }
        }

        if (action === 'pull') {
          // Write remote files to local
          for (const partDrift of drift.partsDrift) {
            const localBasePath = partDrift.partPath === '.'
              ? drift.assignmentPath
              : path.join(drift.assignmentPath, partDrift.partPath);

            // Write the remote files
            await writeFilesToDirectory(drift.assignmentPath, partDrift.partPath, partDrift.remoteFiles, verbose);

            // Handle deleted files (files that exist locally but not remotely)
            for (const fileDiff of partDrift.fileDiffs) {
              if (fileDiff.status === 'deleted') {
                const localFilePath = path.join(localBasePath, fileDiff.filePath);
                try {
                  const fs = await import('fs/promises');
                  await fs.unlink(localFilePath);
                  if (verbose) {
                    logger.debug(`Deleted ${localFilePath}`);
                  }
                } catch {
                  // File may already be gone
                }
              }
            }

            // Update content state for these directories
            const excludePatterns = ['.gitkeep', '**/.gitkeep'];
            const directories = new Set<DirectoryType>();
            for (const fileDiff of partDrift.fileDiffs) {
              const dir = fileDiff.filePath.split('/')[0] as DirectoryType;
              directories.add(dir);
            }

            for (const dir of directories) {
              const dirPath = path.join(localBasePath, dir);
              const stateKey = path.join(localBasePath, dir);
              try {
                const hash = await calculateDirectoryHash(dirPath, excludePatterns);
                importedContentState[stateKey] = hash;
              } catch {
                // Directory may not exist
              }
            }
          }

          summary.contentPulled++;
          logger.success(`Pulled content changes for "${drift.assignmentName}"`);
        } else if (action === 'keep') {
          logger.plain('  Keeping local files (will push to Vocareum on next push)');
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
      assignmentsToReset.length > 0 ||
      settingsUpdates.size > 0;

    // Create publish_history entry for imported assignments to prevent accidental re-push
    // CRITICAL: Merge with previous content_state to preserve hashes for existing assignments
    let newPublishHistory: PublishHistory[] | undefined;
    if (Object.keys(importedContentState).length > 0) {
      const commitSha = await getCommitSha().catch(() => 'unknown');
      const gitUserName = await getGitUserName().catch(() => null);
      const publishedBy = gitUserName ?? 'pull-command';

      // Merge previous content_state with newly imported state
      const previousContentState = config.publish_history?.[0]?.content_state ?? {};
      const mergedContentState = {
        ...previousContentState,
        ...importedContentState,
      };

      const historyEntry: PublishHistory = {
        timestamp: new Date().toISOString(),
        commit_sha: commitSha,
        published_by: publishedBy,
        status: 'success',
        content_state: mergedContentState,
      };

      newPublishHistory = [historyEntry];
    }

    if (hasChanges || newPublishHistory) {
      // Build assignment updates for settings that need to be pulled
      const assignmentUpdates: Partial<Assignment>[] = [...newAssignments];

      for (const [assignmentPath, updates] of settingsUpdates) {
        // Find the existing assignment in config to build the update
        const existingAssignment = config.assignments.find(a => a.path === assignmentPath);
        if (!existingAssignment) { continue; }

        const assignmentUpdate: Partial<Assignment> = {
          path: assignmentPath,
        };

        // Update assignment settings if changed
        if (updates.assignmentSettings) {
          assignmentUpdate.settings = {
            ...existingAssignment.settings,
            ...updates.assignmentSettings,
          };
        }

        // Update part settings if changed
        if (updates.partSettings && updates.partSettings.size > 0) {
          assignmentUpdate.parts = existingAssignment.parts.map(part => {
            const newPartSettings = updates.partSettings?.get(part.path);
            if (newPartSettings) {
              return {
                ...part,
                settings: {
                  ...part.settings,
                  ...newPartSettings,
                },
              };
            }
            return part;
          });
        }

        assignmentUpdates.push(assignmentUpdate);
      }

      await updateConfig(configPath, {
        assignments: assignmentUpdates.length > 0 ? assignmentUpdates : undefined,
        excluded_assignments: newExclusions.length > 0 ? newExclusions : undefined,
        remove_assignments: assignmentsToRemove.length > 0 ? assignmentsToRemove : undefined,
        reset_assignment_ids: assignmentsToReset.length > 0 ? assignmentsToReset : undefined,
        publish_history: newPublishHistory,
      });

      logger.info('Updated vocareum.yaml');
    }

    // Print summary
    logger.newline();
    logger.info('Summary:');
    logger.plain(`  Imported:        ${summary.imported}`);
    logger.plain(`  Settings pulled: ${summary.settingsPulled}`);
    logger.plain(`  Content pulled:  ${summary.contentPulled}`);
    logger.plain(`  Excluded:        ${summary.excluded}`);
    logger.plain(`  Removed:         ${summary.removed}`);
    logger.plain(`  Reset:           ${summary.reset}`);
    logger.plain(`  Skipped:         ${summary.skipped}`);

  } catch (error) {
    logger.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
