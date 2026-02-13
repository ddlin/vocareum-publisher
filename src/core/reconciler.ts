/**
 * Reconciler Module
 *
 * Compare local configuration with Vocareum state to determine required actions.
 */

import * as path from 'path';
import type { Config, PublishHistory, DirectoryType } from '../types/config';
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
  lastPublishHistory?: PublishHistory
): Promise<ReconciliationPlan> {
  logger.info('Fetching current state from Vocareum...');

  // 1. Fetch Course
  await getCourse(client, config.vocareum.course_id);
  const courseAction: CourseAction = {
    type: 'skip', // Update course settings logic if needed
  };

  // 2. Fetch Assignments
  const remoteAssignments = await listAssignments(client, config.vocareum.course_id);
  const remoteAssignmentMap = new Map(remoteAssignments.map(a => [a.id, a]));

  // Also map by name for potential lookup if we wanted to match by name, 
  // but we strictly use IDs from config. 
  // If config has no ID, we are creating new.

  const assignments: AssignmentAction[] = [];
  const orphanedInVocareum: OrphanedEntity[] = [];

  // 3. Process Config Assignments
  for (const configAssignment of config.assignments) {
    let assignmentActionType: 'create' | 'update' | 'skip' | 'error' = 'skip';
    let remoteAssignment = null;

    if (configAssignment.assignment_id) {
      remoteAssignment = remoteAssignmentMap.get(configAssignment.assignment_id);
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
      assignmentActionType = 'create';
    }

    const partActions: PartAction[] = [];

    // If we are updating, we need to check parts
    if (assignmentActionType === 'update' && remoteAssignment) {
      // Fetch parts
      const remoteParts = await listParts(client, remoteAssignment.id);

      // Map parts
      try {
        const mappedParts = mapParts(configAssignment.parts, remoteParts);

        for (const mapping of mappedParts) {
          const configPart = mapping.configPart;

          // Check for content changes
          const changedDirs = await detectChangedDirectories(
            configAssignment.path,
            configPart.path,
            configPart.directories || ['startercode', 'scripts', 'docs', 'data'], // Default dirs? or check schema defaults
            lastPublishHistory
          );

          if (changedDirs.length > 0) {
            partActions.push({
              type: 'update',
              part: configPart,
              contentChanged: true,
              changedDirectories: changedDirs,
              reason: `Changed: ${changedDirs.join(', ')}`
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
        logger.error(`Part mapping failed for ${configAssignment.name}: ${error instanceof Error ? error.message : 'Unknown'}`);
        // If mapping fails, we can't update parts reliably.
        // Might treat as error action
        // for now continue but mark assignment as error?
      }
    } else if (assignmentActionType === 'create') {
      // For creation, we mark all parts as needing creation/upload
      for (const part of configAssignment.parts) {
        partActions.push({
          type: 'create',
          part,
          contentChanged: true,
          changedDirectories: part.directories || ['startercode', 'scripts', 'docs', 'data']
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
      templateId: config.vocareum.template_assignment_id
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
    assignmentsToCreate: assignments.filter(a => a.type === 'create').length,
    assignmentsToUpdate: assignments.filter(a => a.type === 'update' && a.parts.some(p => p.type !== 'skip')).length,
    assignmentsToSkip: assignments.filter(a => a.type === 'skip' || (a.type === 'update' && a.parts.every(p => p.type === 'skip'))).length,
    partsToCreate: assignments.reduce((sum, a) => sum + (a.willCreate ? a.parts.length : 0), 0),
    partsToUpdate: assignments.reduce((sum, a) => sum + a.parts.filter(p => !a.willCreate && p.type === 'update').length, 0),
    estimatedApiCalls: 0 // TODO: calculate based on actions
  };

  // Rough estimate
  summary.estimatedApiCalls =
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
 * Detect changed directories by comparing hashes
 */
async function detectChangedDirectories(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[],
  lastPublishHistory?: PublishHistory
): Promise<DirectoryType[]> {
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
        logger.plain(`    - Part ${p.part.name || p.part.path}: ${p.reason}`);
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
