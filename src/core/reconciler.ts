/**
 * Reconciler Module
 *
 * Compare local configuration with Vocareum state to determine required actions.
 */

import * as path from 'path';
import type { Config, PublishHistory, DirectoryType, Part, Assignment } from '../types/config';
import { normalizeSubmissionFilters } from '../types/config';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../types/api';
import type {
  ReconciliationPlan,
  AssignmentAction,
  PartAction,
  OrphanedEntity,
  StaleAssignment,
  CourseAction
} from '../types/state';
import { VocareumClient } from '../api/client';
import { getCourse } from '../api/courses';
import { listAssignments, getAssignment } from '../api/assignments';
import { listParts, getPart } from '../api/parts';
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
  const staleInConfig: StaleAssignment[] = [];
  const excludedAssignments = new Set(config.vocareum.excluded_assignments ?? []);
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
        if (excludedAssignments.has(configAssignment.assignment_id)) {
          assignmentActionType = 'skip';
          assignmentReason = 'Assignment ID is excluded from sync';
        } else {
          // ID exists in config but not in Vocareum -> track as stale
          logger.warn(`Assignment "${configAssignment.name}" (ID: ${configAssignment.assignment_id}) not found in Vocareum - may have been deleted`);
          staleInConfig.push({
            assignment_id: configAssignment.assignment_id,
            name: configAssignment.name,
            path: configAssignment.path,
          });
          assignmentActionType = 'error';
          assignmentReason = 'Assignment ID not found in Vocareum (deleted?)';
        }
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
      // Fetch full assignment details for accurate settings comparison
      const fullAssignment = await getAssignment(client, config.vocareum.course_id, remoteAssignment.id);

      // Check for changes in fields that can be updated via API
      // Working fields: name, description, nosubmit, auto_submit, grading_on_submit, publish, etc.
      // NOT working: due_date, points (return "No valid parameters")
      assignmentMetadataChanged = detectAssignmentSettingsChanged(configAssignment, fullAssignment);

      // Fetch parts list for mapping
      const remoteParts = await listParts(client, config.vocareum.course_id, remoteAssignment.id);

      // Map parts
      try {
        const mappedParts = mapParts(configAssignment.parts, remoteParts);

        for (const mapping of mappedParts) {
          const configPart = mapping.configPart;

          // Update part ID if missing (e.g., after failed create or name-based discovery)
          if (configPart.part_id === undefined || configPart.part_id === null || configPart.part_id === '') {
            configPart.part_id = mapping.apiPartId;
            partIdsDiscovered = true;
          }

          // Check for content changes
          // Use same exclude patterns as publisher for consistent hash comparison
          const excludePatterns = ['.gitkeep', '**/.gitkeep', ...(config.publish_options?.exclude_patterns ?? [])];
          const changedDirs = await detectChangedDirectories(
            configAssignment.path,
            configPart.path,
            configPart.directories ?? ['startercode', 'scripts', 'docs', 'data'],
            lastPublishHistory,
            options.forceAll,
            excludePatterns
          );

          // Fetch full part details for accurate settings comparison
          const fullPart = await getPart(client, config.vocareum.course_id, remoteAssignment.id, mapping.apiPartId);
          const metadataChanged = detectPartSettingsChanged(configPart, fullPart);

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

    const resolvedTemplate = resolveTemplate(configAssignment, config);
    assignments.push({
      type: assignmentActionType,
      assignment: configAssignment,
      parts: partActions,
      willCreate: assignmentActionType === 'create',
      templateId: resolvedTemplate?.id,
      templateCourseId: resolvedTemplate?.courseId,
      idDiscoveredByName,
      partIdsDiscovered,
      assignmentMetadataChanged,
      reason: assignmentReason,
    });
  }

  // 4. Identify Orphans (excluding those in excluded_assignments)
  for (const [id, assignment] of remoteAssignmentMap) {
    if (!excludedAssignments.has(id)) {
      orphanedInVocareum.push({
        type: 'assignment',
        id,
        name: assignment.name,
        message: 'Exists in Vocareum but not in local configuration'
      });
    }
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
    orphanedInVocareum,
    staleInConfig
  };
}

interface ResolvedTemplate {
  id: string;
  courseId: string;
}

function resolveTemplate(assignment: Assignment, config: Config): ResolvedTemplate | undefined {
  const defaultCourseId = config.vocareum.course_id;

  // 1. Per-assignment override takes precedence
  if (assignment.template_assignment_id !== undefined && assignment.template_assignment_id !== '') {
    // Check if this ID corresponds to a named template (to get its course_id)
    const templates = config.vocareum.templates ?? [];
    const matchingTemplate = templates.find(t => t.id === assignment.template_assignment_id);
    return {
      id: assignment.template_assignment_id,
      courseId: matchingTemplate?.course_id ?? defaultCourseId,
    };
  }

  // 2. Named templates array (preferred)
  const templates = config.vocareum.templates ?? [];
  if (templates.length > 0) {
    return {
      id: templates[0].id,
      courseId: templates[0].course_id,
    };
  }

  // 3. Legacy: template_assignment_ids array (assumes same course)
  const templateIds = config.vocareum.template_assignment_ids ?? [];
  if (templateIds.length > 0) {
    return {
      id: templateIds[0],
      courseId: defaultCourseId,
    };
  }

  // 4. Legacy: single template_assignment_id (assumes same course)
  if (config.vocareum.template_assignment_id) {
    return {
      id: config.vocareum.template_assignment_id,
      courseId: defaultCourseId,
    };
  }

  return undefined;
}

/**
 * Check if two values are meaningfully different (treating null and undefined as equivalent)
 */
function settingsDiffer(local: unknown, remote: unknown): boolean {
  // Treat null and undefined as equivalent
  const localNorm = local === null ? undefined : local;
  const remoteNorm = remote === null ? undefined : remote;

  // Handle string/number comparison (API returns strings for some numbers)
  if (typeof localNorm === 'number' && typeof remoteNorm === 'string') {
    return localNorm !== parseInt(remoteNorm, 10);
  }
  if (typeof localNorm === 'string' && typeof remoteNorm === 'number') {
    return parseInt(localNorm, 10) !== remoteNorm;
  }

  return localNorm !== remoteNorm;
}

/**
 * Detect if assignment settings have changed between config and remote
 *
 * Working fields (Feb 2026 API probes):
 * - name, description, nosubmit, auto_submit, grading_on_submit, publish, etc.
 *
 * NOT working: points, due_date
 */
function detectAssignmentSettingsChanged(
  configAssignment: Assignment,
  remoteAssignment: VocareumAssignmentResponse
): boolean {
  // Check name
  if (configAssignment.name !== remoteAssignment.name) { return true; }

  const s = configAssignment.settings;
  if (!s) { return false; }

  const remote = remoteAssignment as unknown as Record<string, unknown>;

  // Helper to check if a setting has a real value (not null/undefined)
  const hasValue = (v: unknown): boolean => v !== undefined && v !== null;

  // Check description
  if (hasValue(s.description) && settingsDiffer(s.description, remote.description)) { return true; }

  // Boolean settings
  if (hasValue(s.nosubmit) && settingsDiffer(s.nosubmit, remote.nosubmit)) { return true; }
  if (hasValue(s.publish) && settingsDiffer(s.publish, remote.publish)) { return true; }
  if (hasValue(s.auto_submit) && settingsDiffer(s.auto_submit, remote.auto_submit)) { return true; }
  if (hasValue(s.grading_on_submit) && settingsDiffer(s.grading_on_submit, remote.grading_on_submit)) { return true; }
  if (hasValue(s.noworkarea) && settingsDiffer(s.noworkarea, remote.noworkarea)) { return true; }
  if (hasValue(s.show_end_exam_button) && settingsDiffer(s.show_end_exam_button, remote.show_end_exam_button)) { return true; }
  if (hasValue(s.copy_startercode) && settingsDiffer(s.copy_startercode, remote.copy_startercode)) { return true; }
  if (hasValue(s.uncompressupload) && settingsDiffer(s.uncompressupload, remote.uncompressupload)) { return true; }
  if (hasValue(s.lti_on) && settingsDiffer(s.lti_on, remote.lti_on)) { return true; }
  if (hasValue(s.anonymous_grading) && settingsDiffer(s.anonymous_grading, remote.anonymous_grading)) { return true; }
  if (hasValue(s.send_webhook) && settingsDiffer(s.send_webhook, remote.send_webhook)) { return true; }
  if (hasValue(s.live_code_comments) && settingsDiffer(s.live_code_comments, remote.live_code_comments)) { return true; }

  // String/enum settings
  if (hasValue(s.publish_grades) && settingsDiffer(s.publish_grades, remote.publish_grades)) { return true; }
  if (hasValue(s.exam_mode) && settingsDiffer(s.exam_mode, remote.exam_mode)) { return true; }
  if (hasValue(s.grading_visibility) && settingsDiffer(s.grading_visibility, remote.grading_visibility)) { return true; }

  // Number settings
  if (hasValue(s.exam_duration) && settingsDiffer(s.exam_duration, remote.exam_duration)) { return true; }
  if (hasValue(s.num_attempts) && settingsDiffer(s.num_attempts, remote.num_attempts)) { return true; }

  return false;
}

/**
 * Detect if part settings have changed between config and remote
 *
 * Working fields (Feb 2026 API probes):
 * - name, submission_filters, session_length, monthly_dollar, monthly_time, total_time, total_dollar
 * - late_penalty_percent, late_penalty_percent_rule, deadlinedate, endlab
 * - labtype, container_image, number_of_submissions, lab_interface, databricks_maxusers, tags
 *
 * Conditional fields (require org permissions):
 * - cloud_labs, instant_aws_access
 */
function detectPartSettingsChanged(
  configPart: Part,
  remotePart?: VocareumPartResponse
): boolean {
  if (!remotePart) { return false; }

  const configName = configPart.name;
  if (configName !== undefined && configName !== null && configName !== remotePart.name) { return true; }

  const s = configPart.settings;
  if (!s) { return false; }

  const remote = remotePart as unknown as Record<string, unknown>;

  // cloud_labs and instant_aws_access may fail if org doesn't have cloud permissions
  if (s.cloud_labs !== undefined && s.cloud_labs !== null && settingsDiffer(s.cloud_labs, remotePart.cloud_labs)) { return true; }
  if (s.instant_aws_access !== undefined && s.instant_aws_access !== null && settingsDiffer(s.instant_aws_access, remotePart.instant_aws_access)) { return true; }
  if (s.session_length !== undefined && s.session_length !== null && settingsDiffer(s.session_length, remotePart.session_length)) { return true; }
  if (s.monthly_dollar !== undefined && s.monthly_dollar !== null && settingsDiffer(s.monthly_dollar, remotePart.monthly_dollar)) { return true; }
  if (s.monthly_time !== undefined && s.monthly_time !== null && settingsDiffer(s.monthly_time, remotePart.monthly_time)) { return true; }
  if (s.total_time !== undefined && s.total_time !== null && settingsDiffer(s.total_time, remotePart.total_time)) { return true; }
  if (s.total_dollar !== undefined && s.total_dollar !== null && settingsDiffer(s.total_dollar, remotePart.total_dollar)) { return true; }

  // Late penalty settings
  if (s.late_penalty_percent !== undefined && s.late_penalty_percent !== null && settingsDiffer(s.late_penalty_percent, remote.late_penalty_percent)) { return true; }
  if (s.late_penalty_percent_rule !== undefined && s.late_penalty_percent_rule !== null && settingsDiffer(s.late_penalty_percent_rule, remote.late_penalty_percent_rule)) { return true; }
  if (s.deadlinedate !== undefined && s.deadlinedate !== null && settingsDiffer(s.deadlinedate, remote.deadlinedate)) { return true; }

  // Lab settings
  if (s.endlab !== undefined && s.endlab !== null && settingsDiffer(s.endlab, remote.endlab)) { return true; }
  if (s.labtype !== undefined && s.labtype !== null && settingsDiffer(s.labtype, remote.labtype)) { return true; }
  if (s.container_image !== undefined && s.container_image !== null && settingsDiffer(s.container_image, remote.container_image)) { return true; }
  if (s.number_of_submissions !== undefined && s.number_of_submissions !== null && settingsDiffer(s.number_of_submissions, remote.number_of_submissions)) { return true; }
  if (s.databricks_maxusers !== undefined && s.databricks_maxusers !== null && settingsDiffer(s.databricks_maxusers, remote.databricks_maxusers)) { return true; }

  // Compare submission filters (normalize both to object format)
  if (s.submission_filters !== undefined && s.submission_filters !== null) {
    const localFilters = normalizeSubmissionFilters(s.submission_filters);
    const remoteFilters = normalizeSubmissionFilters(remotePart.submission_filters);
    if (!remoteFilters) { return true; } // Config defines filters but remote has none
    if (JSON.stringify(localFilters?.include ?? []) !== JSON.stringify(remoteFilters.include ?? [])) { return true; }
    if (JSON.stringify(localFilters?.exclude ?? []) !== JSON.stringify(remoteFilters.exclude ?? [])) { return true; }
    if (JSON.stringify(localFilters?.list ?? []) !== JSON.stringify(remoteFilters.list ?? [])) { return true; }
  }

  // Compare lab_interface
  if (s.lab_interface !== undefined) {
    const remoteInterface = (remotePart as unknown as Record<string, unknown>).lab_interface as Record<string, unknown> | undefined;
    if (!remoteInterface) { return true; }
    if (JSON.stringify(s.lab_interface) !== JSON.stringify(remoteInterface)) { return true; }
  }

  // Compare tags
  if (s.tags !== undefined) {
    const remoteTags = (remotePart as unknown as Record<string, unknown>).tags as string[] | undefined;
    if (JSON.stringify(s.tags) !== JSON.stringify(remoteTags ?? [])) { return true; }
  }

  return false;
}

/**
 * Detect changed directories by comparing hashes
 *
 * @param excludePatterns - Patterns to exclude from hash calculation (must match publisher)
 */
async function detectChangedDirectories(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[],
  lastPublishHistory?: PublishHistory,
  forceAll: boolean = false,
  excludePatterns: string[] = []
): Promise<DirectoryType[]> {
  if (forceAll) {
    return directories;
  }

  const changed: DirectoryType[] = [];

  if (!lastPublishHistory?.content_state) {
    return directories; // All changed if no history
  }

  for (const dir of directories) {
    const key = path.join(assignmentPath, partPath, dir);

    // Calculate hash with same exclude patterns as publisher to ensure consistency
    const currentHash = await calculateDirectoryHash(key, excludePatterns);
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
