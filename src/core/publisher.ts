/**
 * Publisher Module
 *
 * Execute the reconciliation plan by orchestrating API calls.
 */

import * as path from 'path';
import type { Config, PublishHistory } from '../types/config';
import {
  labInterfaceToWriteObject,
  normalizeSubmissionFilters,
  nullToUndefined,
} from '../types/config';
import type { PartSettings } from '../types/config';
import type { ApiPartSettings, AssignmentSettingsPayload, PartSettingsPayload, VocareumAssignmentResponse, VocareumPartResponse } from '../types/api';
import type { HistorySettingChange, HistoryFileChange, AssignmentSettings } from '../types/config';
import type { PublishResult, PublishOperationOptions } from '../types/state';
import { VocareumClient } from '../api/client';
import { reconcile, displayPlan } from './reconciler';
import { copyAssignment, getAssignment, updateAssignment } from '../api/assignments';
import { updateCourse } from '../api/courses';
import { getPart, updatePart } from '../api/parts';
import { mapParts } from './mapper';
import { readDirectory as readLocalDirectory, syncDirectory } from './uploader';
import { updateConfig } from './config';
import { commitChanges, getCommitSha, getGitUserName } from '../utils/git';
import { logger } from '../utils/logger';
import { promptConfirm } from '../utils/prompts';
import { mapAssignmentSettings, mapPartSettings } from '../utils/settings';
import type { UnknownFieldReporter } from '../utils/unknown-field-reporter';
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  OBSERVED_ASSIGNMENT_SETTING_KEYS,
  OBSERVED_PART_SETTING_KEYS,
} from '../utils/known-settings';
import {
  shouldSyncAssignmentSettings,
  shouldSyncCourseSettings,
  shouldSyncPartSettings,
} from '../utils/settings-sync';

/** All keys that must not be overridden by _unknown_settings for assignment payloads.
 *  Includes '_unknown_settings' itself to prevent nested {_unknown_settings: {_unknown_settings: ...}}
 *  from leaking the literal wrapper key into the outgoing API payload. */
const RESERVED_ASSIGNMENT_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_ASSIGNMENT_SETTING_KEYS,
  ...OBSERVED_ASSIGNMENT_SETTING_KEYS,
  ...NON_SETTING_FIELDS_ASSIGNMENT,
  '_unknown_settings',
  '_observed_settings',
]);

/** All keys that must not be overridden by _unknown_settings for part payloads.
 *  See RESERVED_ASSIGNMENT_KEYS for the rationale on '_unknown_settings'. */
const RESERVED_PART_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_PART_SETTING_KEYS,
  ...OBSERVED_PART_SETTING_KEYS,
  ...NON_SETTING_FIELDS_PART,
  '_unknown_settings',
  '_observed_settings',
]);

/**
 * Filter _unknown_settings before spreading into an outgoing payload.
 * Any key that matches a reserved key (known setting, non-setting field,
 * or explicit payload field like `name`) is dropped with a warning so that
 * a user-supplied override cannot silently clobber a formally-supported field.
 */
function filterUnknownSettingsForPayload(
  unknowns: Record<string, unknown> | null | undefined,
  reservedKeys: ReadonlySet<string>,
  scope: 'assignment' | 'part',
  resourceName: string
): Record<string, unknown> {
  if (!unknowns || typeof unknowns !== 'object') { return {}; }
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(unknowns)) {
    if (reservedKeys.has(k)) {
      logger.warn(
        `Ignoring _unknown_settings.${k} on ${scope} "${resourceName}": ` +
        `"${k}" is a recognized ${scope} field and cannot be overridden via _unknown_settings.`
      );
      continue;
    }
    filtered[k] = v;
  }
  return filtered;
}

function isHttp400(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) { return false; }
  const maybeError = error as { response?: { status?: number }; statusCode?: number };
  return maybeError.response?.status === 400 || maybeError.statusCode === 400;
}

function sanitizeSubmissionFilters(
  filters: ReturnType<typeof normalizeSubmissionFilters>
): ApiPartSettings['submission_filters'] | undefined {
  if (!filters) { return undefined; }
  const include = filters.include?.filter((v) => v.length > 0);
  const exclude = filters.exclude?.filter((v) => v.length > 0);
  const list = filters.list?.filter((v) => v.length > 0);
  if ((!include || include.length === 0) && (!exclude || exclude.length === 0) && (!list || list.length === 0)) {
    return undefined;
  }
  return { include, exclude, list };
}

/**
 * Normalize tags from config format (array or object) to API format (object).
 * Empty arrays are converted to undefined (no tags).
 */
function normalizeTags(
  tags: string[] | Record<string, string | number | boolean> | null | undefined
): Record<string, string | number | boolean> | undefined {
  if (tags === null || tags === undefined) { return undefined; }
  if (Array.isArray(tags)) {
    // Empty array means no tags
    if (tags.length === 0) { return undefined; }
    // Non-empty array: shouldn't happen with current schema, but handle gracefully
    // Convert ["key:value", ...] to {key: value, ...}
    const result: Record<string, string> = {};
    for (const tag of tags) {
      const [key, ...valueParts] = tag.split(':');
      if (key) { result[key] = valueParts.join(':') || ''; }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  // Already an object
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(payload: T): T {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  ) as T;
}

function collectSettingsState(config: Config): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const assignment of config.assignments) {
    const asnSettings = assignment.settings;
    if (asnSettings && shouldSyncAssignmentSettings(config, assignment)) {
      for (const [key, value] of Object.entries(asnSettings)) {
        if (value === undefined || value === null || key.startsWith('_')) { continue; }
        if (!KNOWN_ASSIGNMENT_SETTING_KEYS.has(key)) { continue; }
        state[`assignments/${assignment.path}/settings/${key}`] = value;
      }
    }
    for (const part of assignment.parts) {
      const partSettings = part.settings;
      if (!partSettings) { continue; }
      if (!shouldSyncPartSettings(config, assignment, part)) { continue; }
      for (const [key, value] of Object.entries(partSettings)) {
        if (value === undefined || value === null || key.startsWith('_')) { continue; }
        if (!KNOWN_PART_SETTING_KEYS.has(key)) { continue; }
        state[`assignments/${assignment.path}/parts/${part.path}/settings/${key}`] = value;
      }
    }
  }
  return state;
}

export function buildPartSettingsPayload(
  partName: string,
  partSettings: PartSettings | undefined,
  mode: 'full' | 'safe'
): PartSettingsPayload {
  const normalizedFilters = sanitizeSubmissionFilters(normalizeSubmissionFilters(partSettings?.submission_filters));
  const base: PartSettingsPayload = withoutUndefined({
    name: partName,
    submission_filters: normalizedFilters,
    session_length: nullToUndefined(partSettings?.session_length),
    monthly_dollar: nullToUndefined(partSettings?.monthly_dollar),
    monthly_time: nullToUndefined(partSettings?.monthly_time),
    total_time: nullToUndefined(partSettings?.total_time),
    total_dollar: nullToUndefined(partSettings?.total_dollar),
  });

  if (mode === 'safe') {
    return base;
  }

  const full: PartSettingsPayload = withoutUndefined({
    ...base,
    cloud_labs: nullToUndefined(partSettings?.cloud_labs),
    instant_aws_access: nullToUndefined(partSettings?.instant_aws_access),
    late_penalty_percent: nullToUndefined(partSettings?.late_penalty_percent),
    late_penalty_percent_rule: nullToUndefined(partSettings?.late_penalty_percent_rule),
    deadlinedate: nullToUndefined(partSettings?.deadlinedate),
    endlab: nullToUndefined(partSettings?.endlab),
    labtype: nullToUndefined(partSettings?.labtype),
    container_image: nullToUndefined(partSettings?.container_image),
    number_of_submissions: nullToUndefined(partSettings?.number_of_submissions),
    lab_interface: labInterfaceToWriteObject(partSettings?.lab_interface),
    databricks_maxusers: nullToUndefined(partSettings?.databricks_maxusers),
    tags: normalizeTags(partSettings?.tags),
  });

  // Spread _unknown_settings (NOT the wrapper key) into the top level,
  // filtering out any reserved keys to prevent user-supplied overrides.
  const filtered = filterUnknownSettingsForPayload(
    partSettings?._unknown_settings,
    RESERVED_PART_KEYS,
    'part',
    partName
  );
  if (Object.keys(filtered).length > 0) {
    Object.assign(full, filtered);
  }
  return full;
}

function settingsEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === undefined || a === null) { return b === undefined || b === null; }
  if (b === undefined || b === null) { return false; }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function hasSettingValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function pushSettingChange(
  changes: HistorySettingChange[],
  change: HistorySettingChange
): void {
  // Guard: wrapper buckets are not first-class setting changes. Unknowns are
  // summarized by UnknownFieldReporter; observed settings are pull-only notes.
  if (change.field === '_unknown_settings' || change.field === '_observed_settings') {
    return;
  }
  if (settingsEqual(change.from, change.to)) {
    return;
  }
  changes.push(change);
}

/**
 * Execute publish workflow
 *
 * @param config - Configuration to publish
 * @param client - Vocareum API client
 * @param options - Publish options
 * @returns Publish result
 */
export async function publish(
  config: Config,
  client: VocareumClient,
  options: PublishOperationOptions,
  reporter?: UnknownFieldReporter
): Promise<PublishResult> {
  const configPath = options.configPath ?? 'vocareum.yaml';
  const abortOnError = options.abortOnError ?? false;

  const parseCsv = (value?: string): string[] =>
    value
      ?.split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0) ?? [];

  const assignmentFilters = parseCsv(options.assignment);
  const partFilters = parseCsv(options.part);

  const workingConfig: Config = {
    ...config,
    assignments: config.assignments.map((assignment) => ({
      ...assignment,
      parts: assignment.parts.map((part) => ({ ...part })),
    })),
  };

  if (assignmentFilters.length > 0) {
    workingConfig.assignments = workingConfig.assignments.filter((assignment) =>
      assignmentFilters.includes(assignment.path) ||
      assignmentFilters.includes(assignment.name) ||
      (assignment.assignment_id !== null && assignment.assignment_id !== undefined && assignmentFilters.includes(assignment.assignment_id))
    );
  }

  if (partFilters.length > 0) {
    workingConfig.assignments = workingConfig.assignments
      .map((assignment) => ({
        ...assignment,
        parts: assignment.parts.filter((part) =>
          partFilters.includes(part.path) ||
          (part.name !== undefined && partFilters.includes(part.name)) ||
          (part.part_id !== null && part.part_id !== undefined && partFilters.includes(part.part_id))
        ),
      }))
      .filter((assignment) => assignment.parts.length > 0);
  }

  // 0. Get current git state for history
  const commitSha = await getCommitSha().catch((err: unknown) => {
    logger.debug(`Could not get git commit SHA: ${err instanceof Error ? err.message : String(err)}`);
    return 'unknown';
  });
  const userName = (await getGitUserName().catch((err: unknown) => {
    logger.debug(`Could not get git user name: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  })) ?? 'unknown';

  // 1. Reconcile
  const lastHistory = config.publish_history?.[0]; // Get most recent

  logger.info('Analyzing changes...');
  const plan = await reconcile(workingConfig, client, lastHistory, {
    forceAll: options.forceAll,
    onMissingId: options.onMissingId,
  });

  if (assignmentFilters.length > 0 || partFilters.length > 0) {
    // Orphans are not meaningful for scoped publish operations.
    plan.orphanedInVocareum = [];
  }

  // 2. Display Plan (always show summary, verbose shows details)
  const hasDiscoveredIds = plan.assignments.some((a) => a.idDiscoveredByName === true);
  const hasErrorsInPlan = plan.assignments.some((a) => a.type === 'error');
  const hasChanges = plan.summary.assignmentsToCreate > 0 ||
    plan.summary.assignmentsToUpdate > 0 ||
    plan.summary.partsToUpdate > 0 ||
    plan.summary.coursesToUpdate > 0 ||
    hasDiscoveredIds ||
    hasErrorsInPlan;

  if ((options.verbose ?? false) || (options.dryRun ?? false)) {
    displayPlan(plan);
  } else if (hasChanges) {
    // Show brief summary even without verbose
    const extras: string[] = [];
    if (plan.summary.coursesToUpdate > 0) {
      extras.push('course settings update');
    }
    if (hasDiscoveredIds) {
      extras.push('assignment ID sync');
    }
    logger.info(
      `Found: ${plan.summary.assignmentsToCreate} to create, ${plan.summary.assignmentsToUpdate} to update, ${plan.summary.assignmentsToSkip} unchanged` +
      (extras.length > 0 ? ` (${extras.join(', ')})` : '')
    );
  }

  // 3. Dry Run Check
  if (options.dryRun === true) {
    logger.info('Dry run complete. No changes made.');
    return {
      success: true,
      created: [],
      updated: [],
      skipped: [],
      failed: [],
      contentState: {}, // Empty for dry run
      summary: 'Dry run complete'
    };
  }

  // 4. No changes check
  if (!hasChanges) {
    logger.success('No changes detected. Everything is up to date.');
    return {
      success: true,
      created: [],
      updated: [],
      skipped: [],
      failed: [],
      contentState: { ...lastHistory?.content_state },
      summary: 'No changes to push'
    };
  }

  // 5. Interactive confirmation (unless --non-interactive or CI)
  if (options.nonInteractive !== true) {
    logger.newline();
    const confirmed = await promptConfirm('Proceed with push?', true);
    if (!confirmed) {
      logger.warn('Push cancelled by user.');
      return {
        success: true,
        created: [],
        updated: [],
        skipped: [],
        failed: [],
        contentState: { ...lastHistory?.content_state },
        summary: 'Cancelled by user'
      };
    }
  }

  logger.info('Executing push...');

  const result: PublishResult = {
    success: true,
    created: [],
    updated: [],
    skipped: [],
    failed: [],
    contentState: { ...lastHistory?.content_state }, // Start with previous state
    summary: ''
  };

  const configUpdates: Config['assignments'] = [];
  let configChanged = false;
  let shouldAbort = false;
  const settingChanges: HistorySettingChange[] = [];
  const fileChanges: HistoryFileChange[] = [];
  const fileSizeState: Record<string, number> = { ...(lastHistory?.file_size_state ?? {}) };

  // 4. Course Updates
  if (
    plan.course.type === 'update' &&
    workingConfig.vocareum.course_settings &&
    shouldSyncCourseSettings(workingConfig)
  ) {
    try {
      logger.info('Updating course settings...');
      await updateCourse(client, workingConfig.vocareum.course_id, {
        name: workingConfig.vocareum.course_settings.name,
        description: workingConfig.vocareum.course_settings.description,
      });
      logger.success('Course settings updated');
    } catch (error) {
      logger.error(`Failed to update course settings: ${error instanceof Error ? error.message : 'Unknown'}`);
      result.failed.push({ type: 'assignment', id: 'course', error });
      result.success = false;
      if (abortOnError) {
        shouldAbort = true;
      }
    }
  }

  assignmentLoop:
  // 5. Creation (Assignments)
  for (const action of plan.assignments) {
    if (shouldAbort) {
      break assignmentLoop;
    }

    // Track updated parts for this assignment (only used for update actions)
    let currentUpdateEntry: { type: 'assignment'; id: string; parts: string[] } | null = null;

    if (action.type === 'error') {
      result.failed.push({
        type: 'assignment',
        id: action.assignment.assignment_id ?? action.assignment.name,
        error: action.reason ?? 'Assignment reconciliation failed',
      });
      result.success = false;
      if (abortOnError) {
        shouldAbort = true;
        break assignmentLoop;
      }
      continue;
    }

    if (action.type === 'create' && action.willCreate === true) {
      if (action.templateId === undefined || action.templateId === null || action.templateId === '') {
        logger.error(`Cannot create assignment "${action.assignment.name}": No template ID configured.`);
        logger.error('');
        logger.error('To fix, add a template to your vocareum.yaml:');
        logger.error('  vocareum:');
        logger.error('    templates:');
        logger.error('      - id: "YOUR_TEMPLATE_ID"');
        logger.error('        name: default');
        logger.error('');
        logger.error('Then reference it in your assignment with create_from_template: default');
        result.failed.push({ type: 'assignment', id: action.assignment.name, error: 'Missing template ID' });
        result.success = false;
        if (abortOnError) {
          shouldAbort = true;
          break assignmentLoop;
        }
        continue;
      }

      try {
        logger.info(`Creating assignment: ${action.assignment.name}`);
        const copyResult = await copyAssignment(
          client,
          action.templateId,
          action.assignment.name,
          workingConfig.vocareum.course_id,
          action.templateCourseId
        );

        logger.success(`Created assignment ${action.assignment.name} (${copyResult.assignment_id})`);

        // Persist the new assignment ID back to the working config object so it
        // can be saved to vocareum.yaml and used for content uploads below.
        action.assignment.assignment_id = copyResult.assignment_id;

        // Map config parts to the newly copied API parts (matched by seqnum order).
        // Updates each configPart.part_id in place so subsequent uploads have IDs.
        const mapped = mapParts(action.assignment.parts, copyResult.parts.map(p => ({ id: p.part_id, seqnum: p.seqnum })));

        for (const m of mapped) {
          m.configPart.part_id = m.apiPartId;
        }

        // Pull settings from the newly created assignment (inherited from template)
        // This ensures the next push doesn't detect false drift
        try {
          const fullAssignment = await getAssignment(client, workingConfig.vocareum.course_id, copyResult.assignment_id);
          const templateSettings = mapAssignmentSettings(fullAssignment, reporter, copyResult.assignment_id);
          if (Object.keys(templateSettings).length > 0) {
            // Merge: template settings as base, local settings override
            action.assignment.settings = { ...templateSettings, ...action.assignment.settings };
            logger.debug(`Pulled ${Object.keys(templateSettings).length} settings from template`);
          }

          // Pull part settings too
          for (const m of mapped) {
            const fullPart = await getPart(client, workingConfig.vocareum.course_id, copyResult.assignment_id, m.apiPartId);
            const partSettings = mapPartSettings(fullPart, reporter, m.apiPartId);
            if (Object.keys(partSettings).length > 0) {
              // Merge: template settings as base, local settings override
              m.configPart.settings = { ...partSettings, ...m.configPart.settings };
            }
          }
        } catch (settingsError) {
          // Non-fatal - just log and continue
          logger.warn(`Could not pull template settings: ${settingsError instanceof Error ? settingsError.message : 'Unknown error'}`);
        }

        result.created.push({ type: 'assignment', id: copyResult.assignment_id, parts: mapped.map(m => m.apiPartId) });
        configUpdates.push(action.assignment);
        configChanged = true;

        // Part uploads proceed in the shared parts loop below.
        // configPart.part_id was set above so syncDirectory has valid IDs.

      } catch (error) {
        logger.error(`Failed to create assignment ${action.assignment.name}`, { error });
        result.failed.push({ type: 'assignment', id: action.assignment.name, error });
        result.success = false;
        continue;
      }
    }
    else if (action.type === 'update') {
      const updateId = action.assignment.assignment_id;
      if (!updateId) {
        logger.error(`Update action for "${action.assignment.name}" has no assignment_id - skipping`);
        result.failed.push({ type: 'assignment', id: action.assignment.name, error: 'Missing assignment_id on update' });
        result.success = false;
        if (abortOnError) { shouldAbort = true; break assignmentLoop; }
        continue;
      }
      // Track this assignment and its parts for history
      currentUpdateEntry = { type: 'assignment', id: updateId, parts: [] };
      result.updated.push(currentUpdateEntry);

      // If IDs were discovered (assignment or parts), persist to config
      if (action.idDiscoveredByName === true || action.partIdsDiscovered === true) {
        configUpdates.push(action.assignment);
        configChanged = true;
      }

      if (
        action.assignmentMetadataChanged === true &&
        shouldSyncAssignmentSettings(workingConfig, action.assignment) &&
        (action.assignment.assignment_id !== undefined && action.assignment.assignment_id !== null && action.assignment.assignment_id !== '')
      ) {
        try {
          const remoteAssignment = await getAssignment(
            client,
            workingConfig.vocareum.course_id,
            action.assignment.assignment_id
          );
          // Side effect: report unknown fields seen in the update-path read.
          if (reporter) {
            mapAssignmentSettings(remoteAssignment, reporter, action.assignment.assignment_id);
          }
          const asnSettings = action.assignment.settings;
          const assignmentKeys: (keyof NonNullable<AssignmentSettings>)[] = [
            'nosubmit',
            'publish',
            'publish_grades',
            'auto_submit',
            'grading_on_submit',
            'noworkarea',
            'exam_mode',
            'exam_duration',
            'num_attempts',
            'show_end_exam_button',
            'lti_on',
            'anonymous_grading',
            'grading_visibility',
            'live_code_comments',
          ];

          pushSettingChange(settingChanges, {
            scope: 'assignment',
            assignment_id: action.assignment.assignment_id,
            assignment_name: action.assignment.name,
            field: 'name',
            from: remoteAssignment.name,
            to: action.assignment.name,
          });
          for (const key of assignmentKeys) {
            const toValue = asnSettings?.[key];
            if (!hasSettingValue(toValue)) { continue; }
            const fromValue = remoteAssignment[key as keyof VocareumAssignmentResponse];
            pushSettingChange(settingChanges, {
              scope: 'assignment',
              assignment_id: action.assignment.assignment_id,
              assignment_name: action.assignment.name,
              field: key,
              from: fromValue,
              to: toValue,
            });
          }

          // Build payloads inline (no mode variants, unlike parts which use buildPartSettingsPayload).
          const knownAssignmentPayload: AssignmentSettingsPayload = withoutUndefined({
            name: action.assignment.name,
            nosubmit: nullToUndefined(asnSettings?.nosubmit),
            publish: nullToUndefined(asnSettings?.publish),
            publish_grades: nullToUndefined(asnSettings?.publish_grades),
            auto_submit: nullToUndefined(asnSettings?.auto_submit),
            grading_on_submit: nullToUndefined(asnSettings?.grading_on_submit),
            noworkarea: nullToUndefined(asnSettings?.noworkarea),
            exam_mode: nullToUndefined(asnSettings?.exam_mode),
            exam_duration: nullToUndefined(asnSettings?.exam_duration),
            num_attempts: nullToUndefined(asnSettings?.num_attempts),
            show_end_exam_button: nullToUndefined(asnSettings?.show_end_exam_button),
            lti_on: nullToUndefined(asnSettings?.lti_on),
            anonymous_grading: nullToUndefined(asnSettings?.anonymous_grading),
            grading_visibility: nullToUndefined(asnSettings?.grading_visibility),
            live_code_comments: nullToUndefined(asnSettings?.live_code_comments),
          });

          const unknownAsn = asnSettings?._unknown_settings;
          const filteredAsnUnknowns = filterUnknownSettingsForPayload(
            unknownAsn,
            RESERVED_ASSIGNMENT_KEYS,
            'assignment',
            action.assignment.name
          );
          const hasFilteredUnknowns = Object.keys(filteredAsnUnknowns).length > 0;
          const fullAssignmentPayload: AssignmentSettingsPayload = hasFilteredUnknowns
            ? { ...knownAssignmentPayload, ...filteredAsnUnknowns }
            : knownAssignmentPayload;

          try {
            await updateAssignment(
              client,
              workingConfig.vocareum.course_id,
              action.assignment.assignment_id,
              fullAssignmentPayload
            );
          } catch (error) {
            // Non-400 errors are genuine failures; let the outer catch record them.
            if (!isHttp400(error)) { throw error; }
            // 400 without filtered unknowns means the known payload is itself rejected — no point retrying.
            if (!hasFilteredUnknowns) { throw error; }
            // 400 with filtered unknowns present: retry using the known-only payload.
            logger.warn(
              `Assignment settings update failed with HTTP 400 for "${action.assignment.name}" (likely an unrecognized field in _unknown_settings); retrying with known settings only`
            );
            await updateAssignment(
              client,
              workingConfig.vocareum.course_id,
              action.assignment.assignment_id,
              knownAssignmentPayload
            );
          }
          logger.success(`Updated assignment metadata: ${action.assignment.name}`);
        } catch (error) {
          logger.error(`Failed to update assignment metadata for ${action.assignment.name}`, { error });
          result.failed.push({ type: 'assignment', id: action.assignment.assignment_id, error });
          result.success = false;
          if (abortOnError) {
            shouldAbort = true;
            break assignmentLoop;
          }
        }
      }
    }

    // 5. Parts & Content
    for (const partAction of action.parts) {
      if (shouldAbort) {
        break assignmentLoop;
      }

      if (partAction.type === 'skip') {
        result.skipped.push({ type: 'part', id: partAction.part.part_id ?? 'unknown', reason: 'No changes' });
        continue;
      }

      // If we just created the assignment, we mutated `partAction.part.part_id`.
      // If we are updating, it already had ID.

      const partId = partAction.part.part_id;
      if (partId === undefined || partId === null || partId === '') {
        logger.error(`Part ${partAction.part.name} has no ID, skipping`);
        result.failed.push({ type: 'part', id: partAction.part.name ?? 'unknown', error: 'No Part ID' });
        continue;
      }

      // Track if this part was successfully updated (metadata or content)
      let partWasUpdated = false;

      // Update part metadata/settings if needed
      if (
        partAction.metadataChanged === true &&
        action.willCreate !== true &&
        shouldSyncPartSettings(workingConfig, action.assignment, partAction.part)
      ) {
        // name is REQUIRED for part updates
        const partName = partAction.part.name ?? partAction.part.path;
        const partSettings = partAction.part.settings;
        const assignmentId = action.assignment.assignment_id;
        if (assignmentId === undefined || assignmentId === null || assignmentId === '') {
          logger.error(`Cannot update part ${partName}: assignment has no ID`);
          result.failed.push({ type: 'part', id: partId, error: 'Assignment has no ID' });
          continue;
        }
        try {
          logger.info(`Updating part settings: ${partName}`);
          let metadataUpdated = true;
          const remotePart = await getPart(client, workingConfig.vocareum.course_id, assignmentId, partId);
          // Side effect: report unknown fields seen in the update-path read.
          if (reporter) {
            mapPartSettings(remotePart, reporter, partId);
          }
          pushSettingChange(settingChanges, {
            scope: 'part',
            assignment_id: assignmentId,
            assignment_name: action.assignment.name,
            part_id: partId,
            part_name: partName,
            field: 'name',
            from: remotePart.name,
            to: partName,
          });
          const toPartSettings = partSettings;
          if (toPartSettings) {
            const partKeys: (keyof NonNullable<PartSettings>)[] = [
              'cloud_labs',
              'instant_aws_access',
              'session_length',
              'monthly_dollar',
              'monthly_time',
              'total_time',
              'total_dollar',
              'late_penalty_percent',
              'late_penalty_percent_rule',
              'deadlinedate',
              'endlab',
              'labtype',
              'container_image',
              'number_of_submissions',
              'lab_interface',
              'databricks_maxusers',
              'tags',
            ];
            const normalizedToFilters = sanitizeSubmissionFilters(normalizeSubmissionFilters(toPartSettings.submission_filters));
            const normalizedFromFilters = sanitizeSubmissionFilters(normalizeSubmissionFilters(remotePart.submission_filters));
            if (hasSettingValue(normalizedToFilters)) {
              pushSettingChange(settingChanges, {
                scope: 'part',
                assignment_id: assignmentId,
                assignment_name: action.assignment.name,
                part_id: partId,
                part_name: partName,
                field: 'submission_filters',
                from: normalizedFromFilters,
                to: normalizedToFilters,
              });
            }
            for (const key of partKeys) {
              const toValue = toPartSettings[key];
              if (!hasSettingValue(toValue)) { continue; }
              const fromValue = remotePart[key as keyof VocareumPartResponse];
              pushSettingChange(settingChanges, {
                scope: 'part',
                assignment_id: assignmentId,
                assignment_name: action.assignment.name,
                part_id: partId,
                part_name: partName,
                field: key,
                from: fromValue,
                to: toValue,
              });
            }
          }

          const fullPayload = buildPartSettingsPayload(partName, partSettings, 'full');
          try {
            await updatePart(client, workingConfig.vocareum.course_id, assignmentId, partId, fullPayload);
          } catch (error) {
            if (!isHttp400(error)) {
              throw error;
            }
            logger.warn(`Part settings update rejected for ${partId}; retrying with safe subset`);
            const safePayload = buildPartSettingsPayload(partName, partSettings, 'safe');
            try {
              await updatePart(client, workingConfig.vocareum.course_id, assignmentId, partId, safePayload);
            } catch (retryError) {
              if (!isHttp400(retryError)) {
                throw retryError;
              }
              logger.warn(`Safe part settings update rejected for ${partId}; retrying with name only`);
              try {
                await updatePart(client, workingConfig.vocareum.course_id, assignmentId, partId, { name: partName });
              } catch (nameOnlyError) {
                if (!isHttp400(nameOnlyError)) {
                  throw nameOnlyError;
                }
                metadataUpdated = false;
                logger.warn(`Skipping part metadata update for ${partId}: API rejected update payload (400)`);
                result.skipped.push({
                  type: 'part',
                  id: partId,
                  reason: 'Settings update rejected by Vocareum API (400)',
                });
              }
            }
          }
          if (metadataUpdated) {
            logger.success(`Updated part ${partName}`);
            partWasUpdated = true;
          }
        } catch (error) {
          logger.error(`Failed to update part settings for ${partId}`, { error });
          result.failed.push({ type: 'part', id: partId, error });
          result.success = false;
          if (abortOnError) {
            shouldAbort = true;
            break assignmentLoop;
          }
        }
      }

      // Upload Content
      if (partAction.contentChanged && partAction.changedDirectories) {
        const uploadAssignmentId = action.assignment.assignment_id;
        if (!uploadAssignmentId) {
          logger.error(`Cannot upload content for "${action.assignment.name}": missing assignment ID`);
          result.failed.push({ type: 'part', id: partId, error: 'Assignment has no ID for content upload' });
          result.success = false;
          if (abortOnError) { shouldAbort = true; break assignmentLoop; }
          continue;
        }
        for (const dir of partAction.changedDirectories) {
          try {
            const localDirPath = path.join(action.assignment.path, partAction.part.path, dir);
            const localFiles = await readLocalDirectory(
              localDirPath,
              ['.gitkeep', '**/.gitkeep', ...(config.publish_options?.exclude_patterns ?? [])]
            );
            const uploadRes = await syncDirectory(
              client,
              workingConfig.vocareum.course_id,
              uploadAssignmentId,
              partId,
              localDirPath, // Local path
              dir, // Directory type
              {
                syncDeletes: options.syncDeletes,
                excludePatterns: ['.gitkeep', '**/.gitkeep', ...(config.publish_options?.exclude_patterns ?? [])],
                architecture: config.vocareum.architecture,
              }
            );

            if (uploadRes.failed.length > 0) {
              logger.warn(`Some files failed to upload in ${dir}`);
              for (const failedFile of uploadRes.failed) {
                result.failed.push({
                  type: 'file',
                  id: `${partId}/${dir}/${failedFile.path}`,
                  error: failedFile.error
                });
              }
              result.success = false;
              if (abortOnError) {
                shouldAbort = true;
                break assignmentLoop;
              }
            } else {
              // Only advance stored hash when this directory upload succeeded.
              const key = path.join(action.assignment.path, partAction.part.path, dir);
              result.contentState[key] = uploadRes.directoryHash;
              partWasUpdated = true;

              for (const [relativePath, content] of Object.entries(localFiles)) {
                const fileKey = path.join(action.assignment.path, partAction.part.path, dir, relativePath);
                const currentSize = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
                const previousSize = fileSizeState[fileKey] ?? 0;
                fileChanges.push({
                  path: fileKey,
                  part_id: partId,
                  directory: dir,
                  previous_size: previousSize,
                  current_size: currentSize,
                  delta: currentSize - previousSize,
                });
                fileSizeState[fileKey] = currentSize;
              }
              if (uploadRes.deleted) {
                for (const deletedPath of uploadRes.deleted) {
                  const fileKey = path.join(action.assignment.path, partAction.part.path, dir, deletedPath);
                  const previousSize = fileSizeState[fileKey] ?? 0;
                  fileChanges.push({
                    path: fileKey,
                    part_id: partId,
                    directory: dir,
                    previous_size: previousSize,
                    current_size: 0,
                    delta: -previousSize,
                  });
                  delete fileSizeState[fileKey];
                }
              }
            }
          } catch (error) {
            logger.error(`Failed to upload ${dir} for part ${partId}`, { error });
            result.failed.push({ type: 'file', id: `${partId}/${dir}`, error });
            result.success = false;
            if (abortOnError) {
              shouldAbort = true;
              break assignmentLoop;
            }
          }
        }
      }

      // Track this part as updated if any operation succeeded
      if (partWasUpdated && currentUpdateEntry && !currentUpdateEntry.parts.includes(partId)) {
        currentUpdateEntry.parts.push(partId);
      }
    }
  }

  // 6. Update Config (IDs) and History
  const settingsState = result.success
    ? {
      ...(lastHistory?.settings_state ?? {}),
      ...collectSettingsState({
        ...workingConfig,
        assignments: plan.assignments.map((assignmentAction) => assignmentAction.assignment),
      }),
    }
    : lastHistory?.settings_state;

  const historyEntry: PublishHistory = {
    timestamp: new Date().toISOString(),
    commit_sha: commitSha,
    published_by: userName,
    status: result.success ? 'success' : 'failed',
    content_state: result.contentState,
    settings_state: settingsState,
    file_size_state: fileSizeState,
    changes: settingChanges.length > 0 || fileChanges.length > 0
      ? {
        settings: settingChanges.length > 0 ? settingChanges : undefined,
        files: fileChanges.length > 0 ? fileChanges : undefined,
      }
      : undefined,
    created: result.created.map(c => ({
      assignment: c.id,
      parts: c.parts ?? []
    })),
    updated: result.updated.length > 0
      ? result.updated.map(u => ({
        assignment: u.id,
        parts: u.parts ?? []
      }))
      : undefined,
    failed: result.failed.length > 0
      ? result.failed.map((f) => ({
        type: f.type,
        id: f.id,
        error: f.error instanceof Error ? f.error.message : String(f.error),
      }))
      : undefined,
  };

  await updateConfig(configPath, {
    assignments: configChanged ? configUpdates : undefined,
    publish_history: [historyEntry] // Add this entry
  });

  // 7. Auto-Commit
  if ((options.autoCommit ?? false) && (configChanged || Object.keys(result.contentState).length > 0)) {
    try {
      await commitChanges(
        `chore: update vocareum config [skip ci]`,
        [configPath]
      );
    } catch (error) {
      logger.warn(`Failed to auto-commit config changes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  result.summary = `Pushed: ${result.created.length} created, ${result.updated.length} updated.`;
  return result;
}
