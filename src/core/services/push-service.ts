/**
 * Push Service
 *
 * Splits the publish workflow into two pure phases:
 *   planPush    — READ-ONLY: reconcile + build PushIntent + compute preconditions
 *   executePush — MUTATING: apply the change set, write state
 *
 * IMPORTANT: This file MUST NOT import logger. All output is emitted via ctx.events.
 * It MUST NOT import from '../publisher' to avoid circular dependencies.
 */

import * as path from 'path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'fs';
import type { Config, PublishHistory, PartSettings } from '../../types/config';
import {
  labInterfaceToWriteObject,
  normalizeSubmissionFilters,
  nullToUndefined,
} from '../../types/config';
import type {
  ApiPartSettings,
  AssignmentSettingsPayload,
  PartSettingsPayload,
  VocareumAssignmentResponse,
  VocareumPartResponse,
} from '../../types/api';
import type { HistorySettingChange, HistoryFileChange, AssignmentSettings } from '../../types/config';
import type { PublishResult } from '../../types/state';
import { reconcile, displayPlan } from '../reconciler';
import { assertConfinedToWorkspace } from '../local-scan';
import { copyAssignment, getAssignment, updateAssignment } from '../../api/assignments';
import { updateCourse } from '../../api/courses';
import { getPart, updatePart } from '../../api/parts';
import { mapParts } from '../mapper';
import { readDirectory as readLocalDirectory, syncDirectory } from '../uploader';
import { commitChanges, getCommitSha, getGitUserName } from '../../utils/git';
import { mapAssignmentSettings, mapPartSettings } from '../../utils/settings';
import type { UnknownFieldReporter } from '../../utils/unknown-field-reporter';
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  OBSERVED_ASSIGNMENT_SETTING_KEYS,
  OBSERVED_PART_SETTING_KEYS,
} from '../../utils/known-settings';
import {
  shouldSyncAssignmentSettings,
  shouldSyncCourseSettings,
  shouldSyncPartSettings,
} from '../../utils/settings-sync';
import type { PushContext } from './context';
import type { LockedSession } from '../session';
import type { PushRequest, PushPlan, PushIntent, PushPreconditions, AssignmentIntent, PartIntent } from './types';
import { semanticFingerprint } from './plan-fingerprint';

// ---------------------------------------------------------------------------
// Inline helpers (mirrors publisher.ts; kept here to avoid circular imports)
// ---------------------------------------------------------------------------

const RESERVED_ASSIGNMENT_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_ASSIGNMENT_SETTING_KEYS,
  ...OBSERVED_ASSIGNMENT_SETTING_KEYS,
  ...NON_SETTING_FIELDS_ASSIGNMENT,
  '_unknown_settings',
  '_observed_settings',
]);

const RESERVED_PART_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_PART_SETTING_KEYS,
  ...OBSERVED_PART_SETTING_KEYS,
  ...NON_SETTING_FIELDS_PART,
  '_unknown_settings',
  '_observed_settings',
]);

function isHttp400(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) { return false; }
  const maybeError = error as { response?: { status?: number }; statusCode?: number };
  return maybeError.response?.status === 400 || maybeError.statusCode === 400;
}

function sanitizeSubmissionFilters(
  filters: ReturnType<typeof normalizeSubmissionFilters>,
): ApiPartSettings['submission_filters'] | undefined {
  if (!filters) { return undefined; }
  const include = filters.include?.filter((v) => v.length > 0);
  const exclude = filters.exclude?.filter((v) => v.length > 0);
  const list = filters.list?.filter((v) => v.length > 0);
  if (
    (!include || include.length === 0) &&
    (!exclude || exclude.length === 0) &&
    (!list || list.length === 0)
  ) {
    return undefined;
  }
  return { include, exclude, list };
}

function normalizeTags(
  tags: string[] | Record<string, string | number | boolean> | null | undefined,
): Record<string, string | number | boolean> | undefined {
  if (tags === null || tags === undefined) { return undefined; }
  if (Array.isArray(tags)) {
    if (tags.length === 0) { return undefined; }
    const result: Record<string, string> = {};
    for (const tag of tags) {
      const [key, ...valueParts] = tag.split(':');
      if (key) { result[key] = valueParts.join(':') || ''; }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(payload: T): T {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  ) as T;
}

function filterUnknownSettingsForPayload(
  unknowns: Record<string, unknown> | null | undefined,
  reservedKeys: ReadonlySet<string>,
  _scope: 'assignment' | 'part',
  _resourceName: string,
): Record<string, unknown> {
  if (!unknowns || typeof unknowns !== 'object') { return {}; }
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(unknowns)) {
    if (!reservedKeys.has(k)) {
      filtered[k] = v;
    }
    // (warning about reserved-key collisions is not emitted here because
    // push-service must not call logger; push-service callers that want the
    // warning should use publisher.filterUnknownSettingsForPayload instead)
  }
  return filtered;
}

function hasSettingValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function pushSettingChange(
  changes: HistorySettingChange[],
  change: HistorySettingChange,
): void {
  if (change.field === '_unknown_settings' || change.field === '_observed_settings') { return; }
  if (change.from === change.to) { return; }
  if (
    typeof change.from === 'object' && change.from !== null &&
    typeof change.to === 'object' && change.to !== null &&
    JSON.stringify(change.from) === JSON.stringify(change.to)
  ) { return; }
  changes.push(change);
}

function buildPartSettingsPayload(
  partName: string,
  partSettings: PartSettings | undefined,
  mode: 'full' | 'safe',
): PartSettingsPayload {
  const normalizedFilters = sanitizeSubmissionFilters(
    normalizeSubmissionFilters(partSettings?.submission_filters),
  );
  const base: PartSettingsPayload = withoutUndefined({
    name: partName,
    submission_filters: normalizedFilters,
    session_length: nullToUndefined(partSettings?.session_length),
    monthly_dollar: nullToUndefined(partSettings?.monthly_dollar),
    monthly_time: nullToUndefined(partSettings?.monthly_time),
    total_time: nullToUndefined(partSettings?.total_time),
    total_dollar: nullToUndefined(partSettings?.total_dollar),
  });

  if (mode === 'safe') { return base; }

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

  const filtered = filterUnknownSettingsForPayload(
    partSettings?._unknown_settings,
    RESERVED_PART_KEYS,
    'part',
    partName,
  );
  if (Object.keys(filtered).length > 0) {
    Object.assign(full, filtered);
  }
  return full;
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

// ---------------------------------------------------------------------------
// Internal extended plan type (not part of the public PushPlan interface)
// ---------------------------------------------------------------------------

/** Extended plan that carries the reconciliation artefacts planPush needs to pass to executePush */
interface ExtendedPushPlan extends PushPlan {
  /** @internal */
  _reconPlan: Awaited<ReturnType<typeof reconcile>>;
  /** @internal */
  _workingConfig: Config;
  /** @internal */
  _lastHistory: PublishHistory | undefined;
  /** @internal */
  _hasChanges: boolean;
}

// ---------------------------------------------------------------------------
// planPush — READ-ONLY
// ---------------------------------------------------------------------------

/**
 * Plan a push operation: reconcile + build PushIntent + compute preconditions.
 * Performs only GETs. No mutations. No state writes.
 */
export async function planPush(
  ctx: PushContext,
  req: PushRequest,
): Promise<PushPlan> {
  const { persistedConfig, effectiveConfig, configPath, workspaceRoot, events } = ctx;

  const parseCsv = (value?: string): string[] =>
    value
      ?.split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0) ?? [];

  const assignmentFilters = parseCsv(req.assignment);
  const partFilters = parseCsv(req.part);

  // Build working config (filtered copy)
  const workingConfig: Config = {
    ...effectiveConfig,
    assignments: effectiveConfig.assignments.map((assignment) => ({
      ...assignment,
      parts: assignment.parts.map((part) => ({ ...part })),
    })),
  };

  if (assignmentFilters.length > 0) {
    workingConfig.assignments = workingConfig.assignments.filter(
      (assignment) =>
        assignmentFilters.includes(assignment.path) ||
        assignmentFilters.includes(assignment.name) ||
        (assignment.assignment_id !== null && assignmentFilters.includes(assignment.assignment_id)),
    );
  }

  if (partFilters.length > 0) {
    workingConfig.assignments = workingConfig.assignments
      .map((assignment) => ({
        ...assignment,
        parts: assignment.parts.filter(
          (part) =>
            partFilters.includes(part.path) ||
            (part.name !== undefined && partFilters.includes(part.name)) ||
            (part.part_id !== null && partFilters.includes(part.part_id)),
        ),
      }))
      .filter((assignment) => assignment.parts.length > 0);
  }

  const lastHistory = persistedConfig.publish_history?.[0];

  events.emit({ level: 'info', message: 'Analyzing changes...' });

  const reconPlan = await reconcile(workingConfig, ctx.client, lastHistory, {
    forceAll: req.forceAll,
    onMissingId: req.onMissingId,
    workspaceRoot,
  });

  if (assignmentFilters.length > 0 || partFilters.length > 0) {
    reconPlan.orphanedInVocareum = [];
  }

  // Display plan
  const hasDiscoveredIds = reconPlan.assignments.some((a) => a.idDiscoveredByName === true);
  const hasErrorsInPlan = reconPlan.assignments.some((a) => a.type === 'error');
  const hasChanges =
    reconPlan.summary.assignmentsToCreate > 0 ||
    reconPlan.summary.assignmentsToUpdate > 0 ||
    reconPlan.summary.partsToUpdate > 0 ||
    reconPlan.summary.coursesToUpdate > 0 ||
    hasDiscoveredIds ||
    hasErrorsInPlan;

  if ((req.verbose ?? false) || (req.dryRun ?? false)) {
    displayPlan(reconPlan);
  } else if (hasChanges) {
    const extras: string[] = [];
    if (reconPlan.summary.coursesToUpdate > 0) { extras.push('course settings update'); }
    if (hasDiscoveredIds) { extras.push('assignment ID sync'); }
    events.emit({
      level: 'info',
      message:
        `Found: ${reconPlan.summary.assignmentsToCreate} to create, ` +
        `${reconPlan.summary.assignmentsToUpdate} to update, ` +
        `${reconPlan.summary.assignmentsToSkip} unchanged` +
        (extras.length > 0 ? ` (${extras.join(', ')})` : ''),
    });
  }

  // Build the configDigest from the persisted YAML text
  let configDigest = '';
  try {
    const yamlText = await fs.readFile(configPath, 'utf8');
    configDigest = createHash('sha256').update(yamlText).digest('hex');
  } catch {
    // non-fatal; leave empty
  }

  // Build PushIntent from the reconciliation plan
  const intentAssignments: AssignmentIntent[] = [];
  for (const action of reconPlan.assignments) {
    if (action.type === 'error' || action.type === 'skip') { continue; }

    const parts: PartIntent[] = [];
    for (const partAction of action.parts) {
      if (partAction.type === 'skip') { continue; }
      const contentHashes: Record<string, string> = {};
      for (const dir of partAction.changedDirectories ?? []) {
        contentHashes[dir] = '';
      }
      parts.push({
        partId: partAction.part.part_id ?? null,
        path: partAction.part.path,
        contentHashes,
      });
    }

    intentAssignments.push({
      path: action.assignment.path,
      assignmentId: action.assignment.assignment_id ?? null,
      templateAssignmentId: action.templateId,
      action: action.type === 'create' ? 'create' : 'update',
      parts,
    });
  }

  const intent: PushIntent = { assignments: intentAssignments };

  // Preconditions
  const assignmentIds = reconPlan.assignments
    .filter((a) => a.assignment.assignment_id !== null)
    .map((a) => a.assignment.assignment_id as string);
  const partIds = reconPlan.assignments.flatMap((a) =>
    a.assignment.parts
      .filter((p) => p.part_id !== null)
      .map((p) => p.part_id as string),
  );
  const remoteAssumptions = reconPlan.assignments
    .filter((a) => a.type !== 'skip')
    .map((a) => ({
      assignmentPath: a.assignment.path,
      assignmentId: a.assignment.assignment_id ?? null,
      exists: a.type !== 'create',
      partIds: a.assignment.parts.filter((p) => p.part_id !== null).map((p) => p.part_id as string),
    }));

  const preconditions: PushPreconditions = {
    configDigest,
    contentHashes: {},
    assignmentIds,
    partIds,
    remoteAssumptions,
  };

  const fingerprint = semanticFingerprint(intent);

  // Human-readable summary
  const summaryParts: string[] = [];
  if (reconPlan.summary.assignmentsToCreate > 0) { summaryParts.push(`${reconPlan.summary.assignmentsToCreate} to create`); }
  if (reconPlan.summary.assignmentsToUpdate > 0) { summaryParts.push(`${reconPlan.summary.assignmentsToUpdate} to update`); }
  if (reconPlan.summary.assignmentsToSkip > 0) { summaryParts.push(`${reconPlan.summary.assignmentsToSkip} unchanged`); }
  const summary = summaryParts.length > 0 ? summaryParts.join(', ') : 'No changes';

  const plan: ExtendedPushPlan = {
    intent,
    preconditions,
    semanticFingerprint: fingerprint,
    summary,
    _reconPlan: reconPlan,
    _workingConfig: workingConfig,
    _lastHistory: lastHistory,
    _hasChanges: hasChanges,
  };
  return plan;
}

// ---------------------------------------------------------------------------
// executePush — MUTATING
// ---------------------------------------------------------------------------

/**
 * Execute a planned push: apply the change set, write state via session.
 * Emits progress via ctx.events. Does NOT prompt for confirmation.
 */
export async function executePush(
  session: LockedSession,
  ctx: PushContext,
  req: PushRequest,
  plan: PushPlan,
  reporter?: UnknownFieldReporter,
): Promise<PublishResult> {
  const extPlan = plan as ExtendedPushPlan;
  const reconPlan = extPlan._reconPlan;
  const workingConfig = extPlan._workingConfig;
  const lastHistory = extPlan._lastHistory;
  const { workspaceRoot, configPath, events } = ctx;
  const abortOnError = req.abortOnError ?? false;

  // Dry run
  if (req.dryRun === true) {
    events.emit({ level: 'info', message: 'Dry run complete. No changes made.' });
    return {
      success: true,
      created: [],
      updated: [],
      skipped: [],
      failed: [],
      contentState: {},
      summary: 'Dry run complete',
    };
  }

  // No changes
  if (!extPlan._hasChanges) {
    events.emit({ level: 'success', message: 'No changes detected. Everything is up to date.' });
    return {
      success: true,
      created: [],
      updated: [],
      skipped: [],
      failed: [],
      contentState: { ...lastHistory?.content_state },
      summary: 'No changes to push',
    };
  }

  // Git state
  const commitSha = await getCommitSha(workspaceRoot).catch((err: unknown) => {
    events.emit({ level: 'debug', message: `Could not get git commit SHA: ${err instanceof Error ? err.message : String(err)}` });
    return 'unknown';
  });
  const userName =
    (await getGitUserName(workspaceRoot).catch((err: unknown) => {
      events.emit({ level: 'debug', message: `Could not get git user name: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    })) ?? 'unknown';

  events.emit({ level: 'info', message: 'Executing push...' });

  const result: PublishResult = {
    success: true,
    created: [],
    updated: [],
    skipped: [],
    failed: [],
    contentState: { ...lastHistory?.content_state },
    summary: '',
  };

  const configUpdates: Config['assignments'] = [];
  let configChanged = false;
  let shouldAbort = false;
  const settingChanges: HistorySettingChange[] = [];
  const fileChanges: HistoryFileChange[] = [];
  const fileSizeState: Record<string, number> = { ...(lastHistory?.file_size_state ?? {}) };

  // Course updates
  if (
    reconPlan.course.type === 'update' &&
    workingConfig.vocareum.course_settings &&
    shouldSyncCourseSettings(workingConfig)
  ) {
    try {
      events.emit({ level: 'info', message: 'Updating course settings...' });
      await updateCourse(ctx.client, workingConfig.vocareum.course_id, {
        name: workingConfig.vocareum.course_settings.name,
        description: workingConfig.vocareum.course_settings.description,
      });
      events.emit({ level: 'success', message: 'Course settings updated' });
    } catch (error) {
      events.emit({
        level: 'error',
        message: `Failed to update course settings: ${error instanceof Error ? error.message : 'Unknown'}`,
      });
      result.failed.push({ type: 'assignment', id: 'course', error });
      result.success = false;
      if (abortOnError) { shouldAbort = true; }
    }
  }

  assignmentLoop:
  for (const action of reconPlan.assignments) {
    if (shouldAbort) { break assignmentLoop; }

    let currentUpdateEntry: { type: 'assignment'; id: string; parts: string[] } | null = null;

    if (action.type === 'error') {
      result.failed.push({
        type: 'assignment',
        id: action.assignment.assignment_id ?? action.assignment.name,
        error: action.reason ?? 'Assignment reconciliation failed',
      });
      result.success = false;
      if (abortOnError) { shouldAbort = true; break assignmentLoop; }
      continue;
    }

    if (action.type === 'create' && action.willCreate === true) {
      if (!action.templateId) {
        events.emit({ level: 'error', message: `Cannot create assignment "${action.assignment.name}": No template ID configured.` });
        events.emit({ level: 'error', message: '' });
        events.emit({ level: 'error', message: 'To fix, add a template to your vocareum.yaml:' });
        events.emit({ level: 'error', message: '  vocareum:' });
        events.emit({ level: 'error', message: '    templates:' });
        events.emit({ level: 'error', message: '      - id: "YOUR_TEMPLATE_ID"' });
        events.emit({ level: 'error', message: '        name: default' });
        events.emit({ level: 'error', message: '' });
        events.emit({ level: 'error', message: 'Then reference it in your assignment with create_from_template: default' });
        result.failed.push({ type: 'assignment', id: action.assignment.name, error: 'Missing template ID' });
        result.success = false;
        if (abortOnError) { shouldAbort = true; break assignmentLoop; }
        continue;
      }

      try {
        events.emit({ level: 'info', message: `Creating assignment: ${action.assignment.name}` });
        const copyResult = await copyAssignment(
          ctx.client,
          action.templateId,
          action.assignment.name,
          workingConfig.vocareum.course_id,
          action.templateCourseId,
        );
        events.emit({ level: 'success', message: `Created assignment ${action.assignment.name} (${copyResult.assignment_id})` });

        action.assignment.assignment_id = copyResult.assignment_id;
        const mapped = mapParts(
          action.assignment.parts,
          copyResult.parts.map((p) => ({ id: p.part_id, seqnum: p.seqnum })),
        );
        for (const m of mapped) { m.configPart.part_id = m.apiPartId; }

        try {
          const fullAssignment = await getAssignment(ctx.client, workingConfig.vocareum.course_id, copyResult.assignment_id);
          const templateSettings = mapAssignmentSettings(fullAssignment, reporter, copyResult.assignment_id);
          if (Object.keys(templateSettings).length > 0) {
            action.assignment.settings = { ...templateSettings, ...action.assignment.settings };
            events.emit({ level: 'debug', message: `Pulled ${Object.keys(templateSettings).length} settings from template` });
          }
          for (const m of mapped) {
            const fullPart = await getPart(ctx.client, workingConfig.vocareum.course_id, copyResult.assignment_id, m.apiPartId);
            const partSettings = mapPartSettings(fullPart, reporter, m.apiPartId);
            if (Object.keys(partSettings).length > 0) {
              m.configPart.settings = { ...partSettings, ...m.configPart.settings };
            }
          }
        } catch (settingsError) {
          events.emit({ level: 'warn', message: `Could not pull template settings: ${settingsError instanceof Error ? settingsError.message : 'Unknown error'}` });
        }

        result.created.push({ type: 'assignment', id: copyResult.assignment_id, parts: mapped.map((m) => m.apiPartId) });
        configUpdates.push(action.assignment);
        configChanged = true;
      } catch (error) {
        events.emit({ level: 'error', message: `Failed to create assignment ${action.assignment.name}`, data: { error } });
        result.failed.push({ type: 'assignment', id: action.assignment.name, error });
        result.success = false;
        continue;
      }
    } else if (action.type === 'update') {
      const updateId = action.assignment.assignment_id;
      if (!updateId) {
        events.emit({ level: 'error', message: `Update action for "${action.assignment.name}" has no assignment_id - skipping` });
        result.failed.push({ type: 'assignment', id: action.assignment.name, error: 'Missing assignment_id on update' });
        result.success = false;
        if (abortOnError) { shouldAbort = true; break assignmentLoop; }
        continue;
      }

      currentUpdateEntry = { type: 'assignment', id: updateId, parts: [] };
      result.updated.push(currentUpdateEntry);

      if (action.idDiscoveredByName === true || action.partIdsDiscovered === true) {
        configUpdates.push(action.assignment);
        configChanged = true;
      }

      if (
        action.assignmentMetadataChanged === true &&
        shouldSyncAssignmentSettings(workingConfig, action.assignment) &&
        action.assignment.assignment_id !== null &&
        action.assignment.assignment_id !== ''
      ) {
        try {
          const remoteAssignment = await getAssignment(
            ctx.client,
            workingConfig.vocareum.course_id,
            action.assignment.assignment_id,
          );
          if (reporter) {
            mapAssignmentSettings(remoteAssignment, reporter, action.assignment.assignment_id);
          }
          const asnSettings = action.assignment.settings;
          const assignmentKeys: (keyof NonNullable<AssignmentSettings>)[] = [
            'nosubmit', 'publish', 'publish_grades', 'auto_submit', 'grading_on_submit',
            'noworkarea', 'exam_mode', 'exam_duration', 'num_attempts', 'show_end_exam_button',
            'lti_on', 'anonymous_grading', 'grading_visibility', 'live_code_comments',
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

          const filteredAsnUnknowns = filterUnknownSettingsForPayload(
            asnSettings?._unknown_settings,
            RESERVED_ASSIGNMENT_KEYS,
            'assignment',
            action.assignment.name,
          );
          const hasFilteredUnknowns = Object.keys(filteredAsnUnknowns).length > 0;
          const fullAssignmentPayload: AssignmentSettingsPayload = hasFilteredUnknowns
            ? { ...knownAssignmentPayload, ...filteredAsnUnknowns }
            : knownAssignmentPayload;

          try {
            await updateAssignment(
              ctx.client,
              workingConfig.vocareum.course_id,
              action.assignment.assignment_id,
              fullAssignmentPayload,
            );
          } catch (error) {
            if (!isHttp400(error)) { throw error; }
            if (!hasFilteredUnknowns) { throw error; }
            events.emit({
              level: 'warn',
              message: `Assignment settings update failed with HTTP 400 for "${action.assignment.name}" ` +
                '(likely an unrecognized field in _unknown_settings); retrying with known settings only',
            });
            await updateAssignment(
              ctx.client,
              workingConfig.vocareum.course_id,
              action.assignment.assignment_id,
              knownAssignmentPayload,
            );
          }
          events.emit({ level: 'success', message: `Updated assignment metadata: ${action.assignment.name}` });
        } catch (error) {
          events.emit({ level: 'error', message: `Failed to update assignment metadata for ${action.assignment.name}`, data: { error } });
          result.failed.push({ type: 'assignment', id: action.assignment.assignment_id, error });
          result.success = false;
          if (abortOnError) { shouldAbort = true; break assignmentLoop; }
        }
      }
    }

    // Parts & content
    for (const partAction of action.parts) {
      if (shouldAbort) { break assignmentLoop; }

      if (partAction.type === 'skip') {
        result.skipped.push({ type: 'part', id: partAction.part.part_id ?? 'unknown', reason: 'No changes' });
        continue;
      }

      const partId = partAction.part.part_id;
      if (partId === null || partId === '') {
        events.emit({ level: 'error', message: `Part ${partAction.part.name} has no ID, skipping` });
        result.failed.push({ type: 'part', id: partAction.part.name ?? 'unknown', error: 'No Part ID' });
        continue;
      }

      let partWasUpdated = false;

      if (
        partAction.metadataChanged === true &&
        action.willCreate !== true &&
        shouldSyncPartSettings(workingConfig, action.assignment, partAction.part)
      ) {
        const partName = partAction.part.name ?? partAction.part.path;
        const partSettings = partAction.part.settings;
        const assignmentId = action.assignment.assignment_id;
        if (assignmentId === null || assignmentId === '') {
          events.emit({ level: 'error', message: `Cannot update part ${partName}: assignment has no ID` });
          result.failed.push({ type: 'part', id: partId, error: 'Assignment has no ID' });
          continue;
        }
        try {
          events.emit({ level: 'info', message: `Updating part settings: ${partName}` });
          let metadataUpdated = true;
          const remotePart = await getPart(
            ctx.client,
            workingConfig.vocareum.course_id,
            assignmentId,
            partId,
          );
          if (reporter) { mapPartSettings(remotePart, reporter, partId); }

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
              'cloud_labs', 'instant_aws_access', 'session_length', 'monthly_dollar',
              'monthly_time', 'total_time', 'total_dollar', 'late_penalty_percent',
              'late_penalty_percent_rule', 'deadlinedate', 'endlab', 'labtype',
              'container_image', 'number_of_submissions', 'lab_interface',
              'databricks_maxusers', 'tags',
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
            await updatePart(ctx.client, workingConfig.vocareum.course_id, assignmentId, partId, fullPayload);
          } catch (error) {
            if (!isHttp400(error)) { throw error; }
            events.emit({ level: 'warn', message: `Part settings update rejected for ${partId}; retrying with safe subset` });
            const safePayload = buildPartSettingsPayload(partName, partSettings, 'safe');
            try {
              await updatePart(ctx.client, workingConfig.vocareum.course_id, assignmentId, partId, safePayload);
            } catch (retryError) {
              if (!isHttp400(retryError)) { throw retryError; }
              events.emit({ level: 'warn', message: `Safe part settings update rejected for ${partId}; retrying with name only` });
              try {
                await updatePart(ctx.client, workingConfig.vocareum.course_id, assignmentId, partId, { name: partName });
              } catch (nameOnlyError) {
                if (!isHttp400(nameOnlyError)) { throw nameOnlyError; }
                metadataUpdated = false;
                events.emit({ level: 'warn', message: `Skipping part metadata update for ${partId}: API rejected update payload (400)` });
                result.skipped.push({
                  type: 'part',
                  id: partId,
                  reason: 'Settings update rejected by Vocareum API (400)',
                });
              }
            }
          }
          if (metadataUpdated) {
            events.emit({ level: 'success', message: `Updated part ${partName}` });
            partWasUpdated = true;
          }
        } catch (error) {
          events.emit({ level: 'error', message: `Failed to update part settings for ${partId}`, data: { error } });
          result.failed.push({ type: 'part', id: partId, error });
          result.success = false;
          if (abortOnError) { shouldAbort = true; break assignmentLoop; }
        }
      }

      // Upload content
      if (partAction.contentChanged && partAction.changedDirectories) {
        const uploadAssignmentId = action.assignment.assignment_id;
        if (!uploadAssignmentId) {
          events.emit({ level: 'error', message: `Cannot upload content for "${action.assignment.name}": missing assignment ID` });
          result.failed.push({ type: 'part', id: partId, error: 'Assignment has no ID for content upload' });
          result.success = false;
          if (abortOnError) { shouldAbort = true; break assignmentLoop; }
          continue;
        }
        for (const dir of partAction.changedDirectories) {
          try {
            const dirKey = path.join(action.assignment.path, partAction.part.path, dir);
            const localDirPath = path.resolve(workspaceRoot, dirKey);
            await assertConfinedToWorkspace(workspaceRoot, localDirPath);
            const localFiles = await readLocalDirectory(
              localDirPath,
              ['.gitkeep', '**/.gitkeep', ...(ctx.persistedConfig.publish_options?.exclude_patterns ?? [])],
            );
            const uploadRes = await syncDirectory(
              ctx.client,
              workingConfig.vocareum.course_id,
              uploadAssignmentId,
              partId,
              localDirPath,
              dir,
              {
                syncDeletes: req.syncDeletes,
                excludePatterns: ['.gitkeep', '**/.gitkeep', ...(ctx.persistedConfig.publish_options?.exclude_patterns ?? [])],
                architecture: ctx.persistedConfig.vocareum.architecture,
                workspaceRoot,
              },
            );

            if (uploadRes.failed.length > 0) {
              events.emit({ level: 'warn', message: `Some files failed to upload in ${dir}` });
              for (const failedFile of uploadRes.failed) {
                result.failed.push({
                  type: 'file',
                  id: `${partId}/${dir}/${failedFile.path}`,
                  error: failedFile.error,
                });
              }
              result.success = false;
              if (abortOnError) { shouldAbort = true; break assignmentLoop; }
            } else {
              result.contentState[dirKey] = uploadRes.directoryHash;
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
            events.emit({ level: 'error', message: `Failed to upload ${dir} for part ${partId}`, data: { error } });
            result.failed.push({ type: 'file', id: `${partId}/${dir}`, error });
            result.success = false;
            if (abortOnError) { shouldAbort = true; break assignmentLoop; }
          }
        }
      }

      if (partWasUpdated && currentUpdateEntry && !currentUpdateEntry.parts.includes(partId)) {
        currentUpdateEntry.parts.push(partId);
      }
    }
  }

  // Build history entry and write config
  const settingsState = result.success
    ? {
        ...(lastHistory?.settings_state ?? {}),
        ...collectSettingsState({
          ...workingConfig,
          assignments: reconPlan.assignments.map((assignmentAction) => assignmentAction.assignment),
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
    changes:
      settingChanges.length > 0 || fileChanges.length > 0
        ? {
            settings: settingChanges.length > 0 ? settingChanges : undefined,
            files: fileChanges.length > 0 ? fileChanges : undefined,
          }
        : undefined,
    created: result.created.map((c) => ({ assignment: c.id, parts: c.parts ?? [] })),
    updated:
      result.updated.length > 0
        ? result.updated.map((u) => ({ assignment: u.id, parts: u.parts ?? [] }))
        : undefined,
    failed:
      result.failed.length > 0
        ? result.failed.map((f) => ({
            type: f.type,
            id: f.id,
            error: f.error instanceof Error ? f.error.message : String(f.error),
          }))
        : undefined,
  };

  await session.applyConfigUpdate({
    assignments: configChanged ? configUpdates : undefined,
    publish_history: [historyEntry],
  });

  // Auto-commit
  if (
    (req.autoCommit ?? false) &&
    (configChanged || Object.keys(result.contentState).length > 0)
  ) {
    try {
      await commitChanges(
        'chore: update vocareum config [skip ci]',
        [path.resolve(workspaceRoot, configPath)],
        workspaceRoot,
      );
    } catch (error) {
      events.emit({
        level: 'warn',
        message: `Failed to auto-commit config changes: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  result.summary = `Pushed: ${result.created.length} created, ${result.updated.length} updated.`;
  return result;
}
