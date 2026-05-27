/**
 * Reconciler Module
 *
 * Compare local configuration with Vocareum state to determine required actions.
 */

import * as path from 'path';
import type { Config, PublishHistory, DirectoryType, Part, Assignment } from '../types/config';
import { normalizeSubmissionFilters, ELITE_DIRECTORIES, CONTAINER_DIRECTORIES, DEFAULT_PART_DIRECTORIES } from '../types/config';
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
import {
  shouldSyncAssignmentSettings,
  shouldSyncCourseSettings,
  shouldSyncPartSettings,
} from '../utils/settings-sync';

const ACCEPTED_UNVERIFIED_ASSIGNMENT_KEYS = [
  'anonymous_grading',
  'exam_duration',
  'exam_mode',
  'grading_visibility',
  'live_code_comments',
  'num_attempts',
] as const;

const ACCEPTED_UNVERIFIED_PART_KEYS = [
  'deadlinedate',
  'endlab',
  'lab_interface',
  'late_penalty_percent',
  'late_penalty_percent_rule',
  'number_of_submissions',
] as const;

function assignmentSettingStateKey(assignment: Assignment, key: string): string {
  return `assignments/${assignment.path}/settings/${key}`;
}

function partSettingStateKey(assignment: Assignment, part: Part, key: string): string {
  return `assignments/${assignment.path}/parts/${part.path}/settings/${key}`;
}

function hasAcceptedUnverifiedAssignmentChange(
  assignment: Assignment,
  lastPublishHistory?: PublishHistory
): boolean {
  const settings = assignment.settings;
  if (!settings) { return false; }
  const state = lastPublishHistory?.status === 'failed' ? undefined : lastPublishHistory?.settings_state;
  for (const key of ACCEPTED_UNVERIFIED_ASSIGNMENT_KEYS) {
    const value = settings[key];
    if (value === undefined || value === null) { continue; }
    if (!state || !deepEqual(value, state[assignmentSettingStateKey(assignment, key)])) {
      return true;
    }
  }
  return false;
}

function hasAcceptedUnverifiedPartChange(
  assignment: Assignment,
  part: Part,
  lastPublishHistory?: PublishHistory
): boolean {
  const settings = part.settings;
  if (!settings) { return false; }
  const state = lastPublishHistory?.status === 'failed' ? undefined : lastPublishHistory?.settings_state;
  for (const key of ACCEPTED_UNVERIFIED_PART_KEYS) {
    const value = settings[key];
    if (value === undefined || value === null) { continue; }
    if (!state || !deepEqual(value, state[partSettingStateKey(assignment, part, key)])) {
      return true;
    }
  }
  return false;
}

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
  if (shouldSyncCourseSettings(config) && configCourseSettings !== undefined) {
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
      assignmentMetadataChanged = shouldSyncAssignmentSettings(config, configAssignment)
        ? detectAssignmentSettingsChanged(configAssignment, fullAssignment) ||
          hasAcceptedUnverifiedAssignmentChange(configAssignment, lastPublishHistory)
        : false;

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

          let metadataChanged = false;
          if (shouldSyncPartSettings(config, configAssignment, configPart)) {
            const fullPart = await getPart(client, config.vocareum.course_id, remoteAssignment.id, mapping.apiPartId);
            metadataChanged =
              detectPartSettingsChanged(configPart, fullPart) ||
              hasAcceptedUnverifiedPartChange(configAssignment, configPart, lastPublishHistory);
          }

          // Determine directories to sync based on course-level architecture
          // Config-level part override takes precedence, then course architecture, then default
          const archDirs = config.vocareum.architecture === 'elite' ? ELITE_DIRECTORIES
            : config.vocareum.architecture === 'container' ? CONTAINER_DIRECTORIES
            : DEFAULT_PART_DIRECTORIES;
          const effectiveDirs = configPart.directories ?? archDirs;

          // Check for content changes
          // Use same exclude patterns as publisher for consistent hash comparison
          const excludePatterns = ['.gitkeep', '**/.gitkeep', ...(config.publish_options?.exclude_patterns ?? [])];
          const changedDirs = await detectChangedDirectories(
            configAssignment.path,
            configPart.path,
            effectiveDirs,
            lastPublishHistory,
            options.forceAll,
            excludePatterns
          );

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
      // Use course-level architecture; fall back to full union
      const createArchDirs = config.vocareum.architecture === 'elite' ? ELITE_DIRECTORIES
        : config.vocareum.architecture === 'container' ? CONTAINER_DIRECTORIES
        : DEFAULT_PART_DIRECTORIES;
      for (const part of configAssignment.parts) {
        const createDirs = part.directories ?? createArchDirs;
        partActions.push({
          type: 'create',
          part,
          contentChanged: true,
          changedDirectories: createDirs
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
 * Deep equality check for plain JSON values (objects, arrays, primitives).
 * Handles key-order differences in objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === null || a === undefined || b === null || b === undefined) { return a === b; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { return false; }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) { return false; }
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
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
 * Writable fields are based on the draft OpenAPI contract plus live probes.
 * Non-schema/create-only fields may be preserved under _observed_settings but
 * should not trigger push updates.
 */
function detectAssignmentSettingsChanged(
  configAssignment: Assignment,
  remoteAssignment: VocareumAssignmentResponse
): boolean {
  // Check name
  if (configAssignment.name !== remoteAssignment.name) { return true; }

  const s = configAssignment.settings;
  if (!s) { return false; }

  // Helper to check if a setting has a real value (not null/undefined)
  const hasValue = (v: unknown): boolean => v !== undefined && v !== null;

  // Boolean settings
  if (hasValue(s.nosubmit) && settingsDiffer(s.nosubmit, remoteAssignment.nosubmit)) { return true; }
  if (hasValue(s.publish) && settingsDiffer(s.publish, remoteAssignment.publish)) { return true; }
  if (hasValue(s.publish_grades) && settingsDiffer(s.publish_grades, remoteAssignment.publish_grades ?? remoteAssignment.gradespublished)) { return true; }
  if (hasValue(s.auto_submit) && settingsDiffer(s.auto_submit, remoteAssignment.auto_submit)) { return true; }
  if (hasValue(s.grading_on_submit) && settingsDiffer(s.grading_on_submit, remoteAssignment.grading_on_submit)) { return true; }
  if (hasValue(s.noworkarea) && settingsDiffer(s.noworkarea, remoteAssignment.noworkarea)) { return true; }
  if (hasValue(s.show_end_exam_button) && settingsDiffer(s.show_end_exam_button, remoteAssignment.show_end_exam_button)) { return true; }
  if (hasValue(s.lti_on) && settingsDiffer(s.lti_on, remoteAssignment.lti_on)) { return true; }
  if (hasValue(s.anonymous_grading) && remoteAssignment.anonymous_grading !== undefined && settingsDiffer(s.anonymous_grading, remoteAssignment.anonymous_grading)) { return true; }
  if (hasValue(s.live_code_comments) && remoteAssignment.live_code_comments !== undefined && settingsDiffer(s.live_code_comments, remoteAssignment.live_code_comments)) { return true; }

  // String/enum settings
  if (hasValue(s.exam_mode) && remoteAssignment.exam_mode !== undefined && settingsDiffer(s.exam_mode, remoteAssignment.exam_mode)) { return true; }
  if (hasValue(s.grading_visibility) && remoteAssignment.grading_visibility !== undefined && settingsDiffer(s.grading_visibility, remoteAssignment.grading_visibility)) { return true; }

  // Number settings
  if (hasValue(s.exam_duration) && remoteAssignment.exam_duration !== undefined && settingsDiffer(s.exam_duration, remoteAssignment.exam_duration)) { return true; }
  if (hasValue(s.num_attempts) && remoteAssignment.num_attempts !== undefined && settingsDiffer(s.num_attempts, remoteAssignment.num_attempts)) { return true; }

  return false;
}

/**
 * Detect if part settings have changed between config and remote
 *
 * Writable fields are based on the draft OpenAPI contract plus live probes:
 * - name, submission_filters, session_length, monthly_dollar, monthly_time, total_time, total_dollar
 * - late_penalty_percent, late_penalty_percent_rule, deadlinedate, endlab
 * - labtype, container_image, number_of_submissions, lab_interface, databricks_maxusers, tags
 *
 * Conditional fields (require org permissions):
 * - cloud_labs, instant_aws_access
 *
 * Accepted-unverified fields are written when payloads are sent, but absent
 * readback is not treated as drift.
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

  // cloud_labs and instant_aws_access may fail if org doesn't have cloud permissions
  if (s.cloud_labs !== undefined && s.cloud_labs !== null && settingsDiffer(s.cloud_labs, remotePart.cloud_labs)) { return true; }
  if (s.instant_aws_access !== undefined && s.instant_aws_access !== null && settingsDiffer(s.instant_aws_access, remotePart.instant_aws_access)) { return true; }
  if (s.session_length !== undefined && s.session_length !== null && settingsDiffer(s.session_length, remotePart.session_length)) { return true; }
  if (s.monthly_dollar !== undefined && s.monthly_dollar !== null && settingsDiffer(s.monthly_dollar, remotePart.monthly_dollar)) { return true; }
  if (s.monthly_time !== undefined && s.monthly_time !== null && settingsDiffer(s.monthly_time, remotePart.monthly_time)) { return true; }
  if (s.total_time !== undefined && s.total_time !== null && settingsDiffer(s.total_time, remotePart.total_time)) { return true; }
  if (s.total_dollar !== undefined && s.total_dollar !== null && settingsDiffer(s.total_dollar, remotePart.total_dollar)) { return true; }

  // Accepted-unverified fields: compare only when the API echoes a value.
  if (s.late_penalty_percent !== undefined && s.late_penalty_percent !== null && remotePart.late_penalty_percent !== undefined && settingsDiffer(s.late_penalty_percent, remotePart.late_penalty_percent)) { return true; }
  if (s.late_penalty_percent_rule !== undefined && s.late_penalty_percent_rule !== null && remotePart.late_penalty_percent_rule !== undefined && settingsDiffer(s.late_penalty_percent_rule, remotePart.late_penalty_percent_rule)) { return true; }
  if (s.deadlinedate !== undefined && s.deadlinedate !== null && remotePart.deadlinedate !== undefined && settingsDiffer(s.deadlinedate, remotePart.deadlinedate)) { return true; }

  // Lab settings
  if (s.endlab !== undefined && s.endlab !== null && remotePart.endlab !== undefined && settingsDiffer(s.endlab, remotePart.endlab)) { return true; }
  if (s.labtype !== undefined && s.labtype !== null && settingsDiffer(s.labtype, remotePart.labtype)) { return true; }
  if (s.container_image !== undefined && s.container_image !== null && settingsDiffer(s.container_image, remotePart.container_image)) { return true; }
  if (s.number_of_submissions !== undefined && s.number_of_submissions !== null && remotePart.number_of_submissions !== undefined && settingsDiffer(s.number_of_submissions, remotePart.number_of_submissions)) { return true; }
  if (s.databricks_maxusers !== undefined && s.databricks_maxusers !== null && settingsDiffer(s.databricks_maxusers, remotePart.databricks_maxusers)) { return true; }

  // Compare submission filters (normalize both to object format)
  if (s.submission_filters !== undefined && s.submission_filters !== null) {
    const localFilters = normalizeSubmissionFilters(s.submission_filters);
    const remoteFilters = normalizeSubmissionFilters(remotePart.submission_filters);
    if (!remoteFilters) { return true; } // Config defines filters but remote has none
    if (!deepEqual(localFilters?.include ?? [], remoteFilters.include ?? [])) { return true; }
    if (!deepEqual(localFilters?.exclude ?? [], remoteFilters.exclude ?? [])) { return true; }
    if (!deepEqual(localFilters?.list ?? [], remoteFilters.list ?? [])) { return true; }
  }

  // Compare lab_interface
  if (s.lab_interface !== undefined) {
    if (remotePart.lab_interface !== undefined && !deepEqual(s.lab_interface, remotePart.lab_interface)) { return true; }
  }

  // Compare tags (API returns object, config may have array or object)
  if (s.tags !== undefined) {
    if (!deepEqual(s.tags, remotePart.tags ?? {})) { return true; }
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
