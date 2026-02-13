/**
 * Reconciler Module
 *
 * Compare local configuration with Vocareum state to determine required actions.
 */

import * as path from 'path';
import type { Config, PublishHistory, DirectoryType, Part } from '../types/config';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../types/api';
import type {
  ReconciliationPlan,
  AssignmentAction,
  PartAction,
  OrphanedEntity,
  CourseAction
} from '../types/state';
import { VocareumClient } from '../api/client';
import { getCourse } from '../api/courses';
import { listAssignments } from '../api/assignments';
import { listParts } from '../api/parts';
import { mapParts } from './mapper';
import { calculateDirectoryHash } from '../utils/files';
import { logger } from '../utils/logger';

/**
 * Generate reconciliation plan by comparing local config with Vocareum state
 *
 * @param config - Local configuration
 * @param client - Vocareum API client
 * @param lastPublishHistory - Previous publish history for change detection
 * @returns Reconciliation plan with required actions
 */
export async function reconcile(
  config: Config,
  client: VocareumClient,
  lastPublishHistory?: PublishHistory,
  options: { forceAll?: boolean; onMissingId?: 'skip' | 'abort' } = {}
): Promise<ReconciliationPlan> {
  logger.info('Fetching current state from Vocareum...');

  // 1. Fetch Course and compare settings
  const remoteCourse = await getCourse(client, config.vocareum.course_id);
  let courseAction: CourseAction = { type: 'skip' };

  // Check if course settings need updating
  const configCourseSettings = config.vocareum.course_settings;
  if (configCourseSettings !== undefined) {
    const needsUpdate =
      (configCourseSettings.name !== undefined && configCourseSettings.name !== remoteCourse.name) ||
      (configCourseSettings.description !== undefined && configCourseSettings.description !== remoteCourse.description);

    if (needsUpdate) {
      courseAction = {
        type: 'update',
        reason: 'Course settings differ from config',
      };
    }
  }

  // 2. Fetch Assignments
  const remoteAssignments = await listAssignments(client, config.vocareum.course_id);
  const remoteAssignmentMap = new Map(remoteAssignments.map(a => [a.id, a]));

  // Also map by name for potential lookup if we wanted to match by name, 
  // but we strictly use IDs from config. 
  // If config has no ID, we are creating new.

  const assignments: AssignmentAction[] = [];
  const orphanedInVocareum: OrphanedEntity[] = [];
  const onMissingId = options.onMissingId ?? 'skip';

  // 3. Process Config Assignments
  for (const configAssignment of config.assignments) {
    let assignmentActionType: 'create' | 'update' | 'skip' | 'error' = 'skip';
    let remoteAssignment: VocareumAssignmentResponse | null = null;
    let idDiscoveredByName = false;
    let assignmentMetadataChanged = false;
    let assignmentReason: string | undefined;

    if (configAssignment.assignment_id !== undefined && configAssignment.assignment_id !== null) {
      // Lookup by explicit ID
      remoteAssignment = remoteAssignmentMap.get(configAssignment.assignment_id) ?? null;
      if (remoteAssignment) {
        assignmentActionType = 'update';
        // Remove from map to track orphans
        remoteAssignmentMap.delete(configAssignment.assignment_id);
      } else {
        // ID exists in config but not in Vocareum -> Error or Re-create?
        // Standard behavior: Error, user needs to fix config or clear ID to re-create
        logger.error(`Assignment ${configAssignment.name} has ID ${configAssignment.assignment_id} but not found in Vocareum`);
        assignmentActionType = 'error';
      }
    } else {
      // No ID in config - try name-based lookup first to prevent duplicate creation
      const lookupName = configAssignment.assignment_name_for_lookup ?? configAssignment.name;
      const foundByName = Array.from(remoteAssignmentMap.values()).find(
        (a) => a.name === lookupName
      );

      if (foundByName) {
        logger.info(`Found existing assignment "${lookupName}" (ID: ${foundByName.id}) - will update instead of create`);
        remoteAssignment = foundByName;
        assignmentActionType = 'update';
        idDiscoveredByName = true;
        // Update config object with discovered ID (will be persisted later)
        configAssignment.assignment_id = foundByName.id;
        remoteAssignmentMap.delete(foundByName.id);
      } else {
        if (configAssignment.create_from_template === true) {
          assignmentActionType = 'create';
        } else {
          assignmentActionType = onMissingId === 'abort' ? 'error' : 'skip';
          assignmentReason = `Missing assignment_id and create_from_template is false (on_missing_id=${onMissingId})`;
        }
      }
    }

    const partActions: PartAction[] = [];
    let partIdsDiscovered = false;

    // If we are updating, we need to check parts
    if (assignmentActionType === 'update' && remoteAssignment) {
      assignmentMetadataChanged =
        configAssignment.name !== remoteAssignment.name ||
        (configAssignment.settings?.description !== undefined &&
          configAssignment.settings.description !== remoteAssignment.description) ||
        (configAssignment.settings?.due_date !== undefined &&
          configAssignment.settings.due_date !== remoteAssignment.due_date) ||
        (configAssignment.settings?.points !== undefined &&
          configAssignment.settings.points !== remoteAssignment.points) ||
        (configAssignment.settings?.published !== undefined &&
          configAssignment.settings.published !== (remoteAssignment.published === '1'));

      // Fetch parts
      const remoteParts = await listParts(client, config.vocareum.course_id, remoteAssignment.id);

      // Create map of remote part ID -> remote part for metadata comparison
      const remotePartMap = new Map(remoteParts.map(p => [p.id, p]));

      // Map parts
      try {
        const mappedParts = mapParts(configAssignment.parts, remoteParts);

        for (const mapping of mappedParts) {
          const configPart = mapping.configPart;

          // Update part ID if missing (e.g., after failed create or name-based discovery)
          if (!configPart.part_id) {
            configPart.part_id = mapping.apiPartId;
            partIdsDiscovered = true;
          }

          // Check for content changes
          const changedDirs = await detectChangedDirectories(
            configAssignment.path,
            configPart.path,
            configPart.directories ?? ['startercode', 'scripts', 'docs', 'data'],
            lastPublishHistory,
            options.forceAll
          );

          // Check for metadata/settings changes
          const remotePart = remotePartMap.get(mapping.apiPartId);
          const metadataChanged = detectPartSettingsChanged(configPart, remotePart);

          if (changedDirs.length > 0 || metadataChanged) {
            const reasons: string[] = [];
            if (changedDirs.length > 0) {
              reasons.push(`Content: ${changedDirs.join(', ')}`);
            }
            if (metadataChanged) {
              reasons.push('Settings changed');
            }
            partActions.push({
              type: 'update',
              part: configPart,
              contentChanged: changedDirs.length > 0,
              changedDirectories: changedDirs.length > 0 ? changedDirs : undefined,
              metadataChanged,
              reason: reasons.join('; ')
            });
          } else {
            partActions.push({
              type: 'skip',
              part: configPart,
              contentChanged: false,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown';
        logger.error(`Part mapping failed for ${configAssignment.name}: ${message}`);
        assignmentActionType = 'error';
        assignmentReason = `Part mapping failed: ${message}`;
      }
    } else if (assignmentActionType === 'create') {
      // For creation, we mark all parts as needing creation/upload
      for (const part of configAssignment.parts) {
        partActions.push({
          type: 'create',
          part,
          contentChanged: true,
          changedDirectories: part.directories ?? ['startercode', 'scripts', 'docs', 'data']
        });
      }
    }

    // Determine aggregate assignment action
    // If any part needs update, assignment needs 'update' (conceptually, though API calls are per part)
    // If we are creating, type is create.

    // If we are strictly updating metadata (name, description), checks would go here.
    // For now, assume metadata matches or we enable metadata updates implicitly.

    assignments.push({
      type: assignmentActionType,
      assignment: configAssignment,
      parts: partActions,
      willCreate: assignmentActionType === 'create',
      templateId: config.vocareum.template_assignment_id,
      idDiscoveredByName,
      partIdsDiscovered,
      assignmentMetadataChanged,
      reason: assignmentReason,
    });
  }

  // 4. Identify Orphans
  for (const [id, assignment] of remoteAssignmentMap) {
    orphanedInVocareum.push({
      type: 'assignment',
      id,
      name: assignment.name,
      message: 'Exists in Vocareum but not in local configuration'
    });
  }

  // 5. Calculate Summary
  const summary = {
    coursesToUpdate: courseAction.type === 'update' ? 1 : 0,
    assignmentsToCreate: assignments.filter(a => a.type === 'create').length,
    assignmentsToUpdate: assignments.filter(
      (a) => a.type === 'update' && (a.parts.some(p => p.type !== 'skip') || a.assignmentMetadataChanged === true)
    ).length,
    assignmentsWithDiscoveredIds: assignments.filter(a => a.idDiscoveredByName === true).length,
    assignmentsToSkip: assignments.filter(a => a.type === 'skip' || (a.type === 'update' && a.parts.every(p => p.type === 'skip'))).length,
    partsToCreate: assignments.reduce((sum, a) => sum + (a.willCreate === true ? a.parts.length : 0), 0),
    partsToUpdate: assignments.reduce((sum, a) => sum + a.parts.filter(p => a.willCreate !== true && p.type === 'update').length, 0),
    estimatedApiCalls: 0
  };

  // Rough estimate
  summary.estimatedApiCalls =
    summary.coursesToUpdate * 1 + // Course metadata update
    summary.assignmentsToCreate * (1 + 1) + // Copy + Update Config (approx)
    summary.partsToUpdate * 1; // Uploads handle concurrency but still calls

  return {
    config,
    course: courseAction,
    assignments,
    summary,
    orphanedInVocareum
  };
}

/**
 * Detect whether part settings in config differ from remote state.
 *
 * Only settings explicitly defined in the config are compared; undefined
 * config values are treated as "do not change" and never trigger an update.
 */
function detectPartSettingsChanged(
  configPart: Part,
  remotePart?: VocareumPartResponse
): boolean {
  if (!remotePart) return false;

  const configName = configPart.name ?? configPart.settings?.name;
  if (configName !== undefined && configName !== remotePart.name) return true;

  const s = configPart.settings;
  if (!s) return false;

  if (s.description !== undefined && s.description !== remotePart.description) return true;
  if (s.cloud_labs !== undefined && s.cloud_labs !== remotePart.cloud_labs) return true;
  if (s.instant_aws_access !== undefined && s.instant_aws_access !== remotePart.instant_aws_access) return true;
  if (s.session_length !== undefined && s.session_length !== remotePart.session_length) return true;
  if (s.monthly_dollar !== undefined && s.monthly_dollar !== remotePart.monthly_dollar) return true;
  if (s.monthly_time !== undefined && s.monthly_time !== remotePart.monthly_time) return true;
  if (s.total_time !== undefined && s.total_time !== remotePart.total_time) return true;
  if (s.total_dollar !== undefined && s.total_dollar !== remotePart.total_dollar) return true;

  // Compare submission filters
  if (s.submission_filters !== undefined) {
    const remoteFilters = remotePart.submission_filters;
    if (!remoteFilters) return true; // Config defines filters but remote has none
    if (JSON.stringify(s.submission_filters.include ?? []) !== JSON.stringify(remoteFilters.include ?? [])) return true;
    if (JSON.stringify(s.submission_filters.exclude ?? []) !== JSON.stringify(remoteFilters.exclude ?? [])) return true;
  }

  return false;
}

/**
 * Detect changed directories by comparing hashes
 */
async function detectChangedDirectories(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[],
  lastPublishHistory?: PublishHistory,
  forceAll: boolean = false
): Promise<DirectoryType[]> {
  if (forceAll) {
    return directories;
  }

  const changed: DirectoryType[] = [];

  if (!lastPublishHistory?.content_state) {
    return directories; // All changed if no history
  }

  for (const dir of directories) {
    // Key format must match what we store in publisher/uploader
    // Usually: "{assignmentPath}/{partPath}/{dir}" relative to base
    // We need to ensure we use consistent keys.
    // Let's assume key is relative path from basePath.
    // But config paths are relative to basePath.
    const key = path.join(assignmentPath, partPath, dir);

    // We need to calculate hash of local directory
    // NOTE: This assumes we are running in the correct cwd or we need basePath passed to detectChangedDirectories
    // `assignmentPath` from config is relative. `partPath` is relative.
    // calculateDirectoryHash takes a path. We should pass full path if we have basePath.
    // But `detectChangedDirectories` doesn't have `basePath`.
    // Config paths are relative. 
    // `uploadDirectory` will take `localPath`.
    // We should assume `assignmentPath` and `partPath` are relative to CWD?
    // In `validateStructure` we used `path.join(basePath, ...)`
    // Here we assume CWD is basePath?
    // Let's assume CWD for now or we might need to update signature to take basePath.
    // `reconcile` doesn't take basePath. 
    // `loadConfig` returns config with paths.
    // The CLI usually runs from root.

    // Check if dir exists first? 
    // calculateDirectoryHash returns hash of empty ("empty") if not exists or empty?
    // `calculateDirectoryHash` in `files.ts` calls `readDirectory`. 
    // `readDirectory` checks `pathExists` and returns empty map if not found.
    // So hash will be consistent for empty/missing.

    const currentHash = await calculateDirectoryHash(key); // Relative path from CWD
    const previousHash = lastPublishHistory.content_state[key];

    if (currentHash !== previousHash) {
      changed.push(dir);
    }
  }

  return changed;
}

/**
 * Display reconciliation plan to console
 *
 * @param plan - Plan to display
 */
export function displayPlan(plan: ReconciliationPlan): void {
  logger.info('Reconciliation Plan:');
  logger.plain(`To Create: ${plan.summary.assignmentsToCreate} assignments`);
  logger.plain(`To Update: ${plan.summary.assignmentsToUpdate} assignments`);
  logger.plain(`To Skip:   ${plan.summary.assignmentsToSkip} assignments`);
  if (plan.summary.coursesToUpdate > 0) {
    logger.plain('Course:    metadata update required');
  }
  if (plan.summary.assignmentsWithDiscoveredIds > 0) {
    logger.plain(`ID Sync:   ${plan.summary.assignmentsWithDiscoveredIds} assignment IDs discovered by name`);
  }
  logger.plain(`Orphaned:  ${plan.orphanedInVocareum.length} in Vocareum`);

  if (plan.summary.assignmentsToCreate > 0) {
    logger.newline();
    logger.info('Assignments to Create:');
    plan.assignments.filter(a => a.type === 'create').forEach(a => {
      logger.plain(`  + ${a.assignment.name} (from template)`);
    });
  }

  if (plan.summary.assignmentsToUpdate > 0) {
    logger.newline();
    logger.info('Assignments to Update:');
    plan.assignments.filter(a => a.type === 'update' && a.parts.some(p => p.type !== 'skip')).forEach(a => {
      logger.plain(`  * ${a.assignment.name}`);
      a.parts.filter(p => p.type === 'update').forEach(p => {
        logger.plain(`    - Part ${p.part.name ?? p.part.path}: ${p.reason}`);
      });
    });
  }

  if (plan.orphanedInVocareum.length > 0) {
    logger.newline();
    logger.warn('Orphaned Assignments in Vocareum:');
    plan.orphanedInVocareum.forEach(o => {
      logger.plain(`  ? ${o.name} (${o.id})`);
    });
  }
}
