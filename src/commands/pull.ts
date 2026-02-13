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
import { pathExists, ensureDirectory, writeFile } from '../utils/files';
import type { Assignment, Part, DirectoryType, AssignmentSettings, PartSettings, SubmissionFilters } from '../types/config';
import { normalizeSubmissionFilters } from '../types/config';
import type { OrphanedEntity } from '../types/state';
import type { FileMap, VocareumAssignmentResponse, VocareumPartResponse } from '../types/api';

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
  settingsPulled: number;
}

type PullAction = 'import' | 'exclude' | 'skip';
type StaleAction = 'exclude' | 'remove' | 'reset' | 'skip';
type SettingsDriftAction = 'pull' | 'keep' | 'skip';

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
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === undefined) return '(not set)';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Compare assignment settings and return differences
 */
function compareAssignmentSettings(
  localSettings: AssignmentSettings | undefined,
  remoteSettings: NonNullable<AssignmentSettings>
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  const local = localSettings ?? {};

  // All possible assignment setting keys
  const keys: (keyof NonNullable<AssignmentSettings>)[] = [
    'description', 'nosubmit', 'publish', 'publish_grades',
    'auto_submit', 'grading_on_submit', 'noworkarea',
    'exam_mode', 'exam_duration', 'num_attempts',
    'show_end_exam_button', 'copy_startercode', 'uncompressupload',
    'lti_on', 'anonymous_grading', 'grading_visibility',
    'send_webhook', 'live_code_comments',
  ];

  for (const key of keys) {
    const localVal = local[key];
    const remoteVal = remoteSettings[key];

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
  localSettings: PartSettings | undefined,
  remoteSettings: NonNullable<PartSettings>
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  const local = localSettings ?? {};

  // All possible part setting keys
  const keys: (keyof NonNullable<PartSettings>)[] = [
    'submission_filters', 'cloud_labs', 'instant_aws_access',
    'session_length', 'monthly_dollar', 'monthly_time', 'total_time', 'total_dollar',
    'late_penalty_percent', 'late_penalty_percent_rule', 'deadlinedate',
    'endlab', 'labtype', 'container_image', 'number_of_submissions', 'lab_interface',
    'databricks_maxusers', 'tags',
  ];

  for (const key of keys) {
    const localVal = local[key];
    const remoteVal = remoteSettings[key];

    if (key === 'submission_filters') {
      const normalizedLocal = normalizeSubmissionFilters(localVal as SubmissionFilters | undefined);
      const normalizedRemote = normalizeSubmissionFilters(remoteVal as SubmissionFilters | undefined);
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
  config: { assignments: Assignment[]; vocareum: { course_id: string; excluded_assignments?: string[] } },
  client: VocareumClient,
  skipAssignmentIds: Set<string>
): Promise<AssignmentSettingsDrift[]> {
  const driftList: AssignmentSettingsDrift[] = [];

  // Also skip excluded assignments from config
  const excludedIds = new Set(config.vocareum.excluded_assignments ?? []);

  for (const assignment of config.assignments) {
    // Skip assignments without IDs (not yet created in Vocareum)
    if (!assignment.assignment_id) continue;

    // Skip stale assignments (already identified as deleted)
    if (skipAssignmentIds.has(assignment.assignment_id)) continue;

    // Skip excluded assignments
    if (excludedIds.has(assignment.assignment_id)) continue;

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
        if (!configPart.part_id) continue;

        // Find matching remote part
        const remotePart = remoteParts.find(p => p.id === configPart.part_id);
        if (!remotePart) continue;

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
 * Map Vocareum assignment API response to config settings
 */
function mapAssignmentSettings(apiResponse: VocareumAssignmentResponse): NonNullable<AssignmentSettings> {
  const settings: NonNullable<AssignmentSettings> = {};

  // Only include fields that have values
  if (apiResponse.description !== undefined) settings.description = apiResponse.description;
  if (apiResponse.nosubmit !== undefined) settings.nosubmit = apiResponse.nosubmit;
  if (apiResponse.publish !== undefined) settings.publish = apiResponse.publish;
  if (apiResponse.publish_grades !== undefined) settings.publish_grades = apiResponse.publish_grades;
  if (apiResponse.auto_submit !== undefined) settings.auto_submit = apiResponse.auto_submit;
  if (apiResponse.grading_on_submit !== undefined) settings.grading_on_submit = apiResponse.grading_on_submit;
  if (apiResponse.noworkarea !== undefined) settings.noworkarea = apiResponse.noworkarea;
  if (apiResponse.exam_mode !== undefined) settings.exam_mode = apiResponse.exam_mode;
  if (apiResponse.exam_duration !== undefined) settings.exam_duration = apiResponse.exam_duration;
  if (apiResponse.num_attempts !== undefined) settings.num_attempts = apiResponse.num_attempts;
  if (apiResponse.show_end_exam_button !== undefined) settings.show_end_exam_button = apiResponse.show_end_exam_button;
  if (apiResponse.copy_startercode !== undefined) settings.copy_startercode = apiResponse.copy_startercode;
  if (apiResponse.uncompressupload !== undefined) settings.uncompressupload = apiResponse.uncompressupload;
  if (apiResponse.lti_on !== undefined) settings.lti_on = apiResponse.lti_on;
  if (apiResponse.anonymous_grading !== undefined) settings.anonymous_grading = apiResponse.anonymous_grading;
  if (apiResponse.grading_visibility !== undefined) settings.grading_visibility = apiResponse.grading_visibility;
  if (apiResponse.send_webhook !== undefined) settings.send_webhook = apiResponse.send_webhook;
  if (apiResponse.live_code_comments !== undefined) settings.live_code_comments = apiResponse.live_code_comments;

  return settings;
}

/**
 * Map Vocareum part API response to config settings
 */
function mapPartSettings(apiResponse: VocareumPartResponse): NonNullable<PartSettings> {
  const settings: NonNullable<PartSettings> = {};

  // Submission filters - normalize to object format
  const normalizedFilters = normalizeSubmissionFilters(apiResponse.submission_filters);
  if (normalizedFilters !== undefined) {
    settings.submission_filters = normalizedFilters;
  }

  // Cloud/AWS settings
  if (apiResponse.cloud_labs !== undefined) settings.cloud_labs = apiResponse.cloud_labs;
  if (apiResponse.instant_aws_access !== undefined) settings.instant_aws_access = apiResponse.instant_aws_access;

  // Resource budgets
  if (apiResponse.session_length !== undefined) settings.session_length = apiResponse.session_length;
  if (apiResponse.monthly_dollar !== undefined) settings.monthly_dollar = apiResponse.monthly_dollar;
  if (apiResponse.monthly_time !== undefined) settings.monthly_time = apiResponse.monthly_time;
  if (apiResponse.total_time !== undefined) settings.total_time = apiResponse.total_time;
  if (apiResponse.total_dollar !== undefined) settings.total_dollar = apiResponse.total_dollar;

  // Late submission settings
  if (apiResponse.late_penalty_percent !== undefined) settings.late_penalty_percent = apiResponse.late_penalty_percent;
  if (apiResponse.late_penalty_percent_rule !== undefined) settings.late_penalty_percent_rule = apiResponse.late_penalty_percent_rule;
  if (apiResponse.deadlinedate !== undefined) settings.deadlinedate = apiResponse.deadlinedate;

  // Lab settings
  if (apiResponse.endlab !== undefined) settings.endlab = apiResponse.endlab;
  if (apiResponse.labtype !== undefined) settings.labtype = apiResponse.labtype;
  if (apiResponse.container_image !== undefined) settings.container_image = apiResponse.container_image;
  if (apiResponse.number_of_submissions !== undefined) settings.number_of_submissions = apiResponse.number_of_submissions;
  if (apiResponse.lab_interface !== undefined) settings.lab_interface = apiResponse.lab_interface;

  // Other settings
  if (apiResponse.databricks_maxusers !== undefined) settings.databricks_maxusers = apiResponse.databricks_maxusers;
  if (apiResponse.tags !== undefined) settings.tags = apiResponse.tags;

  return settings;
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

    // Detect settings drift (skip stale assignments that are already identified as deleted)
    const staleAssignmentIds = new Set(plan.staleInConfig.map(s => s.assignment_id));
    const settingsDrift = await detectSettingsDrift(config, client, staleAssignmentIds);

    const hasOrphans = plan.orphanedInVocareum.length > 0;
    const hasStale = plan.staleInConfig.length > 0;
    const hasDrift = settingsDrift.length > 0;

    if (!hasOrphans && !hasStale && !hasDrift) {
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
    };

    const newAssignments: Partial<Assignment>[] = [];
    const newExclusions: string[] = [];
    const assignmentsToRemove: string[] = [];  // assignment paths to remove
    const assignmentsToReset: string[] = [];   // assignment paths to reset IDs
    const settingsUpdates: Map<string, { assignmentSettings?: NonNullable<AssignmentSettings>; partSettings?: Map<string, NonNullable<PartSettings>> }> = new Map();

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

    // Process settings drift (local settings differ from Vocareum)
    if (hasDrift) {
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

        if (nonInteractive) {
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

    // Update config if we made any changes
    const hasChanges = newAssignments.length > 0 ||
                       newExclusions.length > 0 ||
                       assignmentsToRemove.length > 0 ||
                       assignmentsToReset.length > 0 ||
                       settingsUpdates.size > 0;

    if (hasChanges) {
      // Build assignment updates for settings that need to be pulled
      const assignmentUpdates: Partial<Assignment>[] = [...newAssignments];

      for (const [assignmentPath, updates] of settingsUpdates) {
        // Find the existing assignment in config to build the update
        const existingAssignment = config.assignments.find(a => a.path === assignmentPath);
        if (!existingAssignment) continue;

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
      });

      logger.info('Updated vocareum.yaml');
    }

    // Print summary
    logger.newline();
    logger.info('Summary:');
    logger.plain(`  Imported:        ${summary.imported}`);
    logger.plain(`  Settings pulled: ${summary.settingsPulled}`);
    logger.plain(`  Excluded:        ${summary.excluded}`);
    logger.plain(`  Removed:         ${summary.removed}`);
    logger.plain(`  Reset:           ${summary.reset}`);
    logger.plain(`  Skipped:         ${summary.skipped}`);

  } catch (error) {
    logger.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
