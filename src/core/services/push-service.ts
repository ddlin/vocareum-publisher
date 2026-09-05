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
import type { Config, PublishHistory, PartSettings, DirectoryType } from '../../types/config';
import { normalizeSubmissionFilters, nullToUndefined,
  resolveArchitecture,
} from '../../types/config';
import type {
  AssignmentSettingsPayload,
  VocareumAssignmentResponse,
  VocareumPartResponse,
  RubricSyncPlan,
  RemoteRubric,
} from '../../types/api';
import type { HistorySettingChange, HistoryFileChange, HistoryRubricChange, AssignmentSettings } from '../../types/config';
import type { PublishResult, ReconciliationPlan } from '../../types/state';
import { reconcile, displayPlan } from '../reconciler';
import { assertConfinedToWorkspace, publishExcludePatterns } from '../local-scan';
import { calculateDirectoryHash, readFile as readTextFile } from '../../utils/files';
import { copyAssignment, getAssignment, updateAssignment } from '../../api/assignments';
import { updateCourse } from '../../api/courses';
import { getPart, updatePart } from '../../api/parts';
import { createRubrics, updateRubrics } from '../../api/rubrics';
import { projectedPoints } from '../../utils/rubrics';
import { ForbiddenError } from '../../api/client';
import { mapParts } from '../mapper';
import { readDirectory as readLocalDirectory, syncDirectory } from '../uploader';
import { listFiles } from '../../api/content';
import { commitChanges, getCommitSha, getGitUserName } from '../../utils/git';
import { mapAssignmentSettings, mapPartSettings } from '../../utils/settings';
import type { UnknownFieldReporter } from '../../utils/unknown-field-reporter';
import {
  shouldSyncAssignmentSettings,
  shouldSyncCourseSettings,
  shouldSyncPartSettings,
} from '../../utils/settings-sync';
import type { PushContext } from './context';
import type { LockedSession } from '../session';
import type { PushRequest, PushPlan, PushIntent, PushPreconditions, AssignmentIntent, PartIntent } from './types';
import type { EventSink } from './event-sink';
import { semanticFingerprint } from './plan-fingerprint';

/**
 * Render one part's rubric plan into confirmation-facing lines: creates/updates
 * counts, each orphan by name, the projected point total, and the never-deletes
 * reminder. Exported so both plan-display branches in `planPush` (verbose
 * `displayPlan` and the compact "Found:" summary) share one rendering, and so the
 * rename hazard — a renamed criterion reads as a duplicate, inflating the part's
 * points — is visible in the ordinary interactive confirmation, not only
 * `--verbose`/`--dry-run`.
 */
export function emitRubricPlanSummary(
  events: EventSink,
  partLabel: string,
  rubricPlan: RubricSyncPlan,
  remoteRubrics: RemoteRubric[] | undefined,
): void {
  if (rubricPlan.duplicateNames.length > 0) {
    events.emit({
      level: 'warn',
      message:
        `Rubrics for "${partLabel}": duplicate criterion names ` +
        `(${rubricPlan.duplicateNames.join(', ')}); rubrics will not be pushed for this part.`,
    });
    return;
  }

  const criterionWord = rubricPlan.creates.length === 1 ? 'criterion' : 'criteria';
  events.emit({
    level: 'plain',
    message:
      `Rubrics for "${partLabel}": ${rubricPlan.creates.length} rubric ${criterionWord} to create, ` +
      `${rubricPlan.updates.length} to update`,
  });

  for (const orphan of rubricPlan.orphans) {
    events.emit({
      level: 'warn',
      message: `  "${orphan.name}" has no local counterpart and will be left in place`,
    });
  }

  const { before, after, unparseable } = projectedPoints(remoteRubrics ?? [], rubricPlan);
  if (unparseable.length > 0) {
    events.emit({
      level: 'warn',
      message:
        `  Points total could not be computed — unparseable maxscore on: ${unparseable.join(', ')}`,
    });
  } else {
    events.emit({ level: 'plain', message: `  Points would go from ${before} to ${after}` });
  }

  events.emit({ level: 'plain', message: '  Push never deletes rubric criteria.' });
}

/** Emit `emitRubricPlanSummary` for every part in the plan that carries a rubricPlan. */
function emitRubricPlanSummaries(reconPlan: ReconciliationPlan, events: EventSink): void {
  for (const assignmentAction of reconPlan.assignments) {
    if (assignmentAction.type === 'error' || assignmentAction.type === 'skip') { continue; }
    for (const partAction of assignmentAction.parts) {
      if (partAction.type === 'skip' || partAction.rubricPlan === undefined) { continue; }
      emitRubricPlanSummary(
        events,
        partAction.part.name ?? partAction.part.path,
        partAction.rubricPlan,
        partAction.remoteRubrics,
      );
    }
  }
}

function validateExecutableIntent(plan: PushPlan): void {
  const actionableAssignments = plan.execution.reconciliation.assignments.filter(
    (action) => action.type === 'create' || action.type === 'update',
  );
  const actionsByPath = new Map(
    actionableAssignments.map((action) => [action.assignment.path, action]),
  );

  if (actionsByPath.size !== plan.intent.assignments.length) {
    throw new Error('Push intent does not match the planned assignment mutation set');
  }

  for (const assignmentIntent of plan.intent.assignments) {
    const action = actionsByPath.get(assignmentIntent.path);
    if (action === undefined) {
      throw new Error(`Push intent does not match assignment "${assignmentIntent.path}"`);
    }
    if (action.type !== assignmentIntent.action) {
      throw new Error(`Push intent does not match assignment "${assignmentIntent.path}"`);
    }
    if (action.assignment.name !== assignmentIntent.name) {
      throw new Error(`Push intent assignment name changed for "${assignmentIntent.path}"`);
    }
    if (
      assignmentIntent.action === 'update' &&
      action.assignment.assignment_id !== assignmentIntent.assignmentId
    ) {
      throw new Error(`Push intent assignment ID changed for "${assignmentIntent.path}"`);
    }

    const actionableParts = action.parts.filter((partAction) => partAction.type !== 'skip');
    const partActionsByPath = new Map(
      actionableParts.map((partAction) => [partAction.part.path, partAction]),
    );
    if (partActionsByPath.size !== assignmentIntent.parts.length) {
      throw new Error(`Push intent does not match parts for "${assignmentIntent.path}"`);
    }
    for (const partIntent of assignmentIntent.parts) {
      const partAction = partActionsByPath.get(partIntent.path);
      if (partAction === undefined) {
        throw new Error(
          `Push intent does not match part "${assignmentIntent.path}/${partIntent.path}"`
        );
      }
      if (
        assignmentIntent.action === 'update' &&
        partAction.part.part_id !== partIntent.partId
      ) {
        throw new Error(
          `Push intent part ID changed for "${assignmentIntent.path}/${partIntent.path}"`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers — imported from payload-helpers (no cycle: push-service ← payload-helpers)
// ---------------------------------------------------------------------------

import {
  RESERVED_ASSIGNMENT_KEYS,
  isHttp400,
  describeApiError,
  sanitizeSubmissionFilters,
  filterUnknownSettingsForPayload,
  hasSettingValue,
  pushSettingChange,
  buildPartSettingsPayload,
  omitPlatformKeysForUpdate,
  findPlatformFieldDrift,
  collectSettingsState,
  withoutUndefined,
} from '../payload-helpers';
import { writePartSettingsWithFallback } from './part-settings-writer';

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
    events,
    planRubrics: true,
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
    displayPlan(reconPlan, events);
    emitRubricPlanSummaries(reconPlan, events);
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
    // The rename hazard (a renamed criterion re-creates as a duplicate and
    // inflates the part's points) must be visible here too — this compact
    // branch, not displayPlan's --verbose/--dry-run form, is the summary the
    // ordinary interactive user confirms from.
    emitRubricPlanSummaries(reconPlan, events);
  }

  // Build the configDigest from the persisted YAML text.
  // Fail-closed: a plan whose config precondition can't be captured must not
  // be executed or cached — an empty-string sentinel would let stale-plan
  // detection pass on garbage in Stage 1b.
  // Uses readTextFile (from utils/files) so test mocks intercept the read.
  let configDigest: string;
  try {
    const yamlText = await readTextFile(configPath);
    configDigest = createHash('sha256').update(yamlText).digest('hex');
  } catch (err) {
    throw new Error(
      `Cannot compute push preconditions: failed to read config file "${configPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Effective exclude patterns — same set the reconciler/uploader use so hashes
  // computed here agree with the hashes recorded after execution.
  const effectiveExcludePatterns = publishExcludePatterns(workingConfig);

  // Build PushIntent from the reconciliation plan.
  //
  // The intent is the authoritative mutation contract. The reconciliation
  // snapshot is retained only as plain-data context for persistence, reporting,
  // and mapping IDs returned by assignment creation.
  const intentAssignments: AssignmentIntent[] = [];
  // Accumulate local directory hashes for preconditions (same values as intent contentHashes).
  const preconditionContentHashes: Record<string, string> = {};

  for (const action of reconPlan.assignments) {
    if (action.type === 'error' || action.type === 'skip') { continue; }

    // Build assignment-level settings payload (mirrors executePush ~line 506-534).
    let assignmentSettingsPayload: Record<string, unknown> | undefined;
    if (
      action.type === 'update' &&
      action.assignmentMetadataChanged === true &&
      shouldSyncAssignmentSettings(workingConfig, action.assignment)
    ) {
      const asnSettings = action.assignment.settings;
      const knownPayload: Record<string, unknown> = { name: action.assignment.name };
      if (asnSettings) {
        const asnKeys = [
          'nosubmit', 'publish', 'publish_grades', 'auto_submit', 'grading_on_submit',
          'noworkarea', 'exam_mode', 'exam_duration', 'num_attempts', 'show_end_exam_button',
          'lti_on', 'anonymous_grading', 'grading_visibility', 'live_code_comments',
        ] as const;
        for (const key of asnKeys) {
          const v = asnSettings[key];
          if (v !== undefined && v !== null) { knownPayload[key] = v; }
        }
        const filteredUnknowns = filterUnknownSettingsForPayload(
          asnSettings._unknown_settings,
          RESERVED_ASSIGNMENT_KEYS,
          'assignment',
          action.assignment.name,
        );
        if (Object.keys(filteredUnknowns).length > 0) {
          Object.assign(knownPayload, filteredUnknowns);
        }
      }
      assignmentSettingsPayload = knownPayload;
    }

    const parts: PartIntent[] = [];
    for (const partAction of action.parts) {
      if (partAction.type === 'skip') { continue; }

      // Per-directory content hashes — real values using the same exclude
      // patterns the uploader will use, so plan-hash == post-upload hash.
      // When the reconciler already computed the hash during change detection
      // (partAction.dirHashes), reuse it directly to avoid a second filesystem
      // traversal. For create actions (no reconciler hash) the hash is computed
      // here for the first time.
      const contentHashes: Record<string, string> = {};
      for (const dir of partAction.changedDirectories ?? []) {
        const dirKey = path.join(action.assignment.path, partAction.part.path, dir);
        const localDirPath = path.resolve(workspaceRoot, dirKey);
        // Fail-closed: a plan with an unreadable directory has uncapturable
        // preconditions and must not be executed or cached.
        let hash: string;
        if (partAction.dirHashes?.[dir] !== undefined) {
          // Reuse the hash the reconciler already computed — same excludePatterns,
          // same calculateDirectoryHash call, so the value is identical.
          hash = partAction.dirHashes[dir];
        } else {
          try {
            hash = await calculateDirectoryHash(localDirPath, effectiveExcludePatterns);
          } catch (err) {
            throw new Error(
              `Cannot compute push preconditions: failed to hash directory "${dirKey}": ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        contentHashes[dir] = hash;
        preconditionContentHashes[dirKey] = hash;
      }

      // Part-level settings payload (mirrors executePush ~line 660).
      let partSettingsPayload: Record<string, unknown> | undefined;
      if (
        partAction.metadataChanged === true &&
        action.willCreate !== true &&
        shouldSyncPartSettings(workingConfig, action.assignment, partAction.part)
      ) {
        partSettingsPayload = omitPlatformKeysForUpdate(
          buildPartSettingsPayload(
            partAction.part.name ?? partAction.part.path,
            partAction.part.settings,
            'full',
          ),
        );
      }

      // Existing parts get an exact approved deletion set. New assignments have
      // no remote part yet, so the intent records the directories whose delete
      // sets must be reconciled after creation.
      let deletePaths: string[] | undefined;
      let reconcileDeleteDirectories: string[] | undefined;
      if (
        req.syncDeletes === true &&
        (partAction.changedDirectories?.length ?? 0) > 0
      ) {
        const allDirsToCheck = partAction.changedDirectories ?? [];
        if (action.willCreate === true || req.deferDeleteResolution === true) {
          reconcileDeleteDirectories = [...allDirsToCheck];
        } else if (
          action.assignment.assignment_id !== null &&
          action.assignment.assignment_id !== undefined &&
          partAction.part.part_id !== null &&
          partAction.part.part_id !== undefined
        ) {
          deletePaths = [];
          for (const dir of allDirsToCheck) {
            const dirKey = path.join(action.assignment.path, partAction.part.path, dir);
            const localDirPath = path.resolve(workspaceRoot, dirKey);
            let remoteFiles: Awaited<ReturnType<typeof listFiles>>;
            let localFiles: Awaited<ReturnType<typeof readLocalDirectory>>;
            try {
              [remoteFiles, localFiles] = await Promise.all([
                listFiles(
                  ctx.client,
                  workingConfig.vocareum.course_id,
                  action.assignment.assignment_id,
                  partAction.part.part_id,
                  dir,
                  // Fall back to the part's labtype: no real config sets
                  // vocareum.architecture, and without this an Elite part is
                  // listed at /voc paths that cannot exist there.
                  resolveArchitecture(
                    workingConfig.vocareum.architecture,
                    partAction.part.settings?.labtype,
                  ),
                ),
                readLocalDirectory(localDirPath, effectiveExcludePatterns),
              ]);
            } catch (err) {
              throw new Error(
                `Cannot compute push intent: failed to resolve deletions for "${dirKey}": ${err instanceof Error ? err.message : String(err)}`
              );
            }
            const localFileSet = new Set(Object.keys(localFiles));
            for (const remoteFile of remoteFiles) {
              if (!localFileSet.has(remoteFile.path)) {
                deletePaths.push(path.posix.join(dir, remoteFile.path.replace(/\\/g, '/')));
              }
            }
          }
        }
      }

      parts.push({
        partId: partAction.part.part_id ?? null,
        path: partAction.part.path,
        contentHashes,
        ...(partSettingsPayload !== undefined ? { settingsPayload: partSettingsPayload } : {}),
        ...(deletePaths !== undefined ? { deletePaths } : {}),
        ...(reconcileDeleteDirectories !== undefined ? { reconcileDeleteDirectories } : {}),
        rubricPlan: partAction.rubricPlan,
        rubricReadFailed: partAction.rubricReadFailed,
      });
    }

    intentAssignments.push({
      path: action.assignment.path,
      name: action.assignment.name,
      assignmentId: action.assignment.assignment_id ?? null,
      templateAssignmentId: action.templateId,
      ...(action.templateCourseId !== undefined ? { templateCourseId: action.templateCourseId } : {}),
      action: action.type === 'create' ? 'create' : 'update',
      ...(assignmentSettingsPayload !== undefined ? { settingsPayload: assignmentSettingsPayload } : {}),
      parts,
    });
  }

  // Course-settings intent: encode what executePush will send so a change in
  // course settings shifts the fingerprint.
  let courseSettingsPayload: Record<string, unknown> | undefined;
  if (
    reconPlan.course.type === 'update' &&
    workingConfig.vocareum.course_settings &&
    reconPlan.summary.coursesToUpdate > 0 &&
    shouldSyncCourseSettings(workingConfig)
  ) {
    courseSettingsPayload = {
      name: workingConfig.vocareum.course_settings.name,
      description: workingConfig.vocareum.course_settings.description,
    };
  }

  const intent: PushIntent = {
    assignments: intentAssignments,
    ...(courseSettingsPayload !== undefined ? { courseSettings: courseSettingsPayload } : {}),
  };

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
    // Local directory hashes the plan was computed from — same real values
    // recorded in intent.contentHashes so preconditions match the intent.
    contentHashes: preconditionContentHashes,
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

  const plan: PushPlan = {
    intent,
    preconditions,
    semanticFingerprint: fingerprint,
    summary,
    hasChanges,
    execution: {
      reconciliation: reconPlan,
      workingConfig,
      ...(lastHistory !== undefined ? { lastHistory } : {}),
    },
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
  if (semanticFingerprint(plan.intent) !== plan.semanticFingerprint) {
    throw new Error('Push plan intent changed after confirmation; refusing to execute');
  }
  validateExecutableIntent(plan);
  const reconPlan = plan.execution.reconciliation;
  const workingConfig = plan.execution.workingConfig;
  const lastHistory = plan.execution.lastHistory;
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
  if (!plan.hasChanges) {
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
  // Once a 403 is hit, the token lacks the rubrics scope for the rest of this
  // run — every subsequently planned rubric write must be recorded as failed,
  // never silently skipped (rule: a 403 fails the run, it does not degrade).
  let rubricsAvailable = true;
  const settingChanges: HistorySettingChange[] = [];
  const fileChanges: HistoryFileChange[] = [];
  const rubricChanges: HistoryRubricChange[] = [];
  const fileSizeState: Record<string, number> = { ...(lastHistory?.file_size_state ?? {}) };
  const intentAssignmentsByPath = new Map(
    plan.intent.assignments.map((assignmentIntent) => [assignmentIntent.path, assignmentIntent]),
  );

  // Course updates
  if (plan.intent.courseSettings !== undefined) {
    try {
      events.emit({ level: 'info', message: 'Updating course settings...' });
      await updateCourse(ctx.client, workingConfig.vocareum.course_id, {
        name: typeof plan.intent.courseSettings.name === 'string'
          ? plan.intent.courseSettings.name
          : undefined,
        description: typeof plan.intent.courseSettings.description === 'string'
          ? plan.intent.courseSettings.description
          : undefined,
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

    const assignmentIntent = intentAssignmentsByPath.get(action.assignment.path);
    if (action.type === 'skip') {
      for (const partAction of action.parts) {
        result.skipped.push({
          type: 'part',
          id: partAction.part.part_id ?? 'unknown',
          reason: 'No changes',
        });
      }
      continue;
    }
    if (assignmentIntent === undefined) {
      throw new Error(`Push intent is missing assignment "${action.assignment.path}"`);
    }

    if (assignmentIntent.action === 'create') {
      if (assignmentIntent.templateAssignmentId === undefined) {
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
          assignmentIntent.templateAssignmentId,
          assignmentIntent.name,
          workingConfig.vocareum.course_id,
          assignmentIntent.templateCourseId,
        );
        events.emit({ level: 'success', message: `Created assignment ${action.assignment.name} (${copyResult.assignment_id})` });

        if ((action.assignment.parts ?? []).some((part) => part.rubrics !== undefined)) {
          events.emit({
            level: 'warn',
            message:
              `Rubrics for "${action.assignment.name}" were not reconciled: it was created ` +
              `in this run and carries its template's criteria. Run push again to reconcile ` +
              `them against vocareum.yaml.`,
          });
        }

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
    } else if (assignmentIntent.action === 'update') {
      const updateId = assignmentIntent.assignmentId;
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

      if (assignmentIntent.settingsPayload !== undefined) {
        try {
          const remoteAssignment = await getAssignment(
            ctx.client,
            workingConfig.vocareum.course_id,
            updateId,
          );
          if (reporter) {
            mapAssignmentSettings(remoteAssignment, reporter, updateId);
          }
          const asnSettings = action.assignment.settings;
          const assignmentKeys: (keyof NonNullable<AssignmentSettings>)[] = [
            'nosubmit', 'publish', 'publish_grades', 'auto_submit', 'grading_on_submit',
            'noworkarea', 'exam_mode', 'exam_duration', 'num_attempts', 'show_end_exam_button',
            'lti_on', 'anonymous_grading', 'grading_visibility', 'live_code_comments',
          ];

          pushSettingChange(settingChanges, {
            scope: 'assignment',
            assignment_id: updateId,
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
              assignment_id: updateId,
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
            events,
          );
          const hasFilteredUnknowns = Object.keys(filteredAsnUnknowns).length > 0;
          const fullAssignmentPayload =
            assignmentIntent.settingsPayload as AssignmentSettingsPayload;

          try {
            await updateAssignment(
              ctx.client,
              workingConfig.vocareum.course_id,
              updateId,
              fullAssignmentPayload,
            );
          } catch (error) {
            if (!isHttp400(error)) { throw error; }
            if (!hasFilteredUnknowns) { throw error; }
            events.emit({
              level: 'warn',
              message: `Assignment settings update rejected (400) for "${action.assignment.name}" ` +
                `[API: ${describeApiError(error)}]; retrying with known settings only`,
            });
            await updateAssignment(
              ctx.client,
              workingConfig.vocareum.course_id,
              updateId,
              knownAssignmentPayload,
            );
          }
          events.emit({ level: 'success', message: `Updated assignment metadata: ${action.assignment.name}` });
        } catch (error) {
          events.emit({ level: 'error', message: `Failed to update assignment metadata for ${action.assignment.name}`, data: { error } });
          result.failed.push({ type: 'assignment', id: updateId, error });
          result.success = false;
          if (abortOnError) { shouldAbort = true; break assignmentLoop; }
        }
      }
    }

    const partIntentsByPath = new Map(
      assignmentIntent.parts.map((partIntent) => [partIntent.path, partIntent]),
    );

    // Parts & content
    for (const partAction of action.parts) {
      if (shouldAbort) { break assignmentLoop; }

      const partIntent = partIntentsByPath.get(partAction.part.path);
      if (partIntent === undefined && partAction.type === 'skip') {
        result.skipped.push({ type: 'part', id: partAction.part.part_id ?? 'unknown', reason: 'No changes' });
        continue;
      }
      if (partIntent === undefined) {
        throw new Error(
          `Push intent is missing part "${action.assignment.path}/${partAction.part.path}"`
        );
      }

      const partId = partIntent.partId ?? partAction.part.part_id;
      if (partId === null || partId === '') {
        events.emit({ level: 'error', message: `Part ${partAction.part.name} has no ID, skipping` });
        result.failed.push({ type: 'part', id: partAction.part.name ?? 'unknown', error: 'No Part ID' });
        continue;
      }

      let partWasUpdated = false;

      if (partIntent.settingsPayload !== undefined && assignmentIntent.action !== 'create') {
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

          // labtype/container_image are stripped from update payloads because the
          // write API rejects them. The reconciler still sees the drift, so without
          // this the user gets a green "Updated part" for a write that changed
          // nothing, forever. Say so instead.
          for (const drift of findPlatformFieldDrift(toPartSettings, remotePart)) {
            events.emit({
              level: 'warn',
              message:
                `Part ${partName}: ${drift.key} differs from Vocareum ` +
                `("${drift.remote}" -> "${drift.desired}") but is never sent on ` +
                `updates — the write API rejects it. Change it in the Vocareum UI, or run ` +
                `\`vocgit pull\` to adopt the remote value.`,
            });
          }

          const fullPayload = omitPlatformKeysForUpdate(partIntent.settingsPayload);
          const writeResult = await writePartSettingsWithFallback(
            (payload) => updatePart(ctx.client, workingConfig.vocareum.course_id, assignmentId, partId, payload),
            partName,
            partSettings,
            fullPayload,
            events,
          );
          if (writeResult.outcome === 'none') {
            metadataUpdated = false;
            result.skipped.push({
              type: 'part',
              id: partId,
              reason: 'Settings update rejected by Vocareum API (400)',
            });
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

      const rubricPlan = partIntent.rubricPlan;

      if (partIntent.rubricReadFailed !== undefined) {
        // The plan-time read failed (403, body-encoded failure, pagination shortfall,
        // etc.) — rubricPlan stayed undefined so content/settings detection for this part
        // wasn't lost, but that must not read as success here. A green push that silently
        // migrated no points is exactly the failure this feature exists to prevent.
        const message = `Could not read rubrics for "${partAction.part.name ?? partAction.part.path}": ${partIntent.rubricReadFailed}`;
        events.emit({ level: 'error', message });
        result.failed.push({ type: 'part', id: partId, error: message });
        result.success = false;
        rubricChanges.push({
          assignment_id: action.assignment.assignment_id ?? 'unknown',
          part_id: partId,
          held: 'read-failed',
        });
        if (abortOnError) { shouldAbort = true; break assignmentLoop; }
      }

      if (rubricPlan !== undefined && assignmentIntent.action !== 'create' && !rubricsAvailable) {
        // The scope was lost earlier in this run. Record every subsequently skipped part —
        // the spec requires skipped writes to be recorded, and a silent skip would hide how
        // much of the migration did not happen.
        const message = `Rubrics not pushed for "${partAction.part.name ?? partAction.part.path}": token lacks rubric write permission.`;
        events.emit({ level: 'warn', message });
        result.failed.push({ type: 'part', id: partId, error: message });
        result.success = false;
        rubricChanges.push({
          assignment_id: action.assignment.assignment_id ?? 'unknown',
          part_id: partId,
          held: 'no-scope',
        });
        if (abortOnError) { shouldAbort = true; break assignmentLoop; }
      } else if (rubricPlan !== undefined && assignmentIntent.action !== 'create' && rubricsAvailable) {
        const partLabel = partAction.part.name ?? partAction.part.path;
        // `courseId` does not exist in executePush — the surrounding code reads
        // workingConfig.vocareum.course_id directly. And assignment_id is `string | null`
        // (config.ts), so it must be narrowed before the string-typed API calls.
        const courseId = workingConfig.vocareum.course_id;
        const assignmentId = action.assignment.assignment_id;
        if (assignmentId === null || assignmentId === '') {
          events.emit({ level: 'warn', message: `Skipping rubrics for "${partLabel}": assignment has no id yet.` });
        } else {
          if (rubricPlan.duplicateNames.length > 0) {
            // Name matching is undefined against duplicates; guessing risks updating the
            // wrong row's points.
            const message =
              `Part "${partLabel}" has duplicate rubric criterion names ` +
              `(${rubricPlan.duplicateNames.join(', ')}); rubrics not pushed for this part.`;
            events.emit({ level: 'error', message });
            result.failed.push({ type: 'part', id: partId, error: message });
            result.success = false;
            rubricChanges.push({
              assignment_id: assignmentId,
              part_id: partId,
              held: 'duplicate-names',
            });
            if (abortOnError) { shouldAbort = true; break assignmentLoop; }
          } else {
            // Both conditions matter: a part with orphans but nothing to create has
            // nothing for non-interactive mode to withhold — its updates should proceed
            // normally, not be marked failed/held over an orphan alone.
            const holdCreates =
              req.nonInteractive === true &&
              rubricPlan.orphans.length > 0 &&
              rubricPlan.creates.length > 0;
            // Collected rather than pushed to result.failed immediately: a part that hits
            // both the orphan hold and a later write failure previously recorded two
            // result.failed entries for the same part id, splitting one story across the
            // array. One entry naming every reason instead.
            const failureMessages: string[] = [];
            if (holdCreates) {
              const message =
                `Part "${partLabel}" has ${rubricPlan.orphans.length} remote rubric ` +
                `criterion(s) with no local counterpart; creating in non-interactive mode ` +
                `could duplicate a renamed criterion and inflate the part's points. ` +
                `Creates held — re-run interactively to confirm.`;
              events.emit({ level: 'error', message });
              failureMessages.push(message);
            }

            let createdOk = false;
            let updatedOk = false;
            let writeFailed = false;
            try {
              if (!holdCreates && rubricPlan.creates.length > 0) {
                await createRubrics(ctx.client, courseId, assignmentId, partId, rubricPlan.creates);
                events.emit({ level: 'success', message: `Created ${rubricPlan.creates.length} rubric criteria on "${partLabel}"` });
                createdOk = true;
              }
              if (rubricPlan.updates.length > 0) {
                await updateRubrics(ctx.client, courseId, assignmentId, partId, rubricPlan.updates);
                events.emit({ level: 'success', message: `Updated ${rubricPlan.updates.length} rubric criteria on "${partLabel}"` });
                updatedOk = true;
              }
              if (createdOk || updatedOk) { partWasUpdated = true; }
            } catch (error) {
              if (error instanceof ForbiddenError) {
                // Unlike the read side, this does NOT degrade to a warning: the write was the
                // point. A green push that silently left grading points unmigrated is the
                // failure this feature exists to prevent.
                rubricsAvailable = false;
                events.emit({
                  level: 'error',
                  message:
                    'Rubric writes are not permitted with this API token; rubric sync is ' +
                    'disabled for the rest of this run. Regenerate the token with the rubrics ' +
                    'POST and PUT permissions enabled.',
                });
              } else {
                events.emit({ level: 'error', message: `Rubric write failed for "${partLabel}": ${describeApiError(error)}` });
              }
              failureMessages.push(describeApiError(error));
              writeFailed = true;
            }

            if (failureMessages.length > 0) {
              result.failed.push({ type: 'part', id: partId, error: failureMessages.join('; ') });
              result.success = false;
            }

            // Record what actually happened to this part's rubrics — the criteria written
            // (by name), the resulting point delta, and the hold reason when creates were
            // withheld, the write itself failed, or a write succeeded and a later one then
            // failed. Only the applied portion of the plan (not the full plan) feeds the
            // point projection, so a held create doesn't get counted as though it landed.
            const partialWrite = writeFailed && (createdOk || updatedOk);
            const heldReason = partialWrite
              // Something was written and something then failed: the entry must not read as
              // a clean success with a point delta while result.failed records a failure —
              // the true total is unknown.
              ? 'partial-write'
              : holdCreates
                ? (writeFailed ? 'orphans-held+write-failed' : 'orphans-held')
                : (writeFailed ? 'write-failed' : undefined);
            if (createdOk || updatedOk || heldReason !== undefined) {
              const appliedPlan: RubricSyncPlan = {
                creates: createdOk ? rubricPlan.creates : [],
                updates: updatedOk ? rubricPlan.updates : [],
                orphans: rubricPlan.orphans,
                duplicateNames: [],
              };
              const { before, after, unparseable } = projectedPoints(partAction.remoteRubrics ?? [], appliedPlan);
              const remoteNameById = new Map((partAction.remoteRubrics ?? []).map((r) => [r.id, r.name]));
              // Omit the point projection whenever the total written is not fully known:
              // a write failure, a partial write, or an unparseable maxscore would otherwise
              // misleadingly read as a confirmed total. 'orphans-held' alone (no write
              // failure) still gets a delta — only the withheld creates are excluded from
              // appliedPlan above, so the projection reflects exactly what was written.
              const pointsKnown =
                unparseable.length === 0 &&
                heldReason !== 'write-failed' &&
                heldReason !== 'partial-write' &&
                heldReason !== 'orphans-held+write-failed';
              rubricChanges.push({
                assignment_id: assignmentId,
                part_id: partId,
                created: createdOk ? rubricPlan.creates.map((c) => c.name) : undefined,
                updated: updatedOk
                  ? rubricPlan.updates.map((u) => u.name ?? remoteNameById.get(u.id) ?? u.id)
                  : undefined,
                ...(pointsKnown ? { points_before: before, points_after: after } : {}),
                ...(heldReason !== undefined ? { held: heldReason } : {}),
              });
            }
            if (abortOnError && failureMessages.length > 0) { shouldAbort = true; break assignmentLoop; }
          }
        }
      }

      // Upload exactly the directories represented by the confirmed intent.
      const contentDirectories = Object.keys(partIntent.contentHashes) as DirectoryType[];
      if (contentDirectories.length > 0) {
        const uploadAssignmentId = assignmentIntent.action === 'create'
          ? action.assignment.assignment_id
          : assignmentIntent.assignmentId;
        if (!uploadAssignmentId) {
          events.emit({ level: 'error', message: `Cannot upload content for "${action.assignment.name}": missing assignment ID` });
          result.failed.push({ type: 'part', id: partId, error: 'Assignment has no ID for content upload' });
          result.success = false;
          if (abortOnError) { shouldAbort = true; break assignmentLoop; }
          continue;
        }
        for (const dir of contentDirectories) {
          try {
            const dirKey = path.join(action.assignment.path, partAction.part.path, dir);
            const localDirPath = path.resolve(workspaceRoot, dirKey);
            await assertConfinedToWorkspace(workspaceRoot, localDirPath);
            // Use the effective (working) config exclude patterns so org-level
            // patterns added via hierarchy apply to both hashing and upload.
            const effectiveExcludePatterns = publishExcludePatterns(workingConfig);
            const localFiles = await readLocalDirectory(
              localDirPath,
              effectiveExcludePatterns,
            );
            const deletePrefix = `${dir}/`;
            const plannedDeletePaths = partIntent.deletePaths?.filter(
              (deletePath) => deletePath.startsWith(deletePrefix),
            ).map((deletePath) => deletePath.slice(deletePrefix.length));
            const reconcileDeletes =
              partIntent.reconcileDeleteDirectories?.includes(dir) === true;
            const syncDeletes = plannedDeletePaths !== undefined || reconcileDeletes;

            const uploadRes = await syncDirectory(
              ctx.client,
              workingConfig.vocareum.course_id,
              uploadAssignmentId,
              partId,
              localDirPath,
              dir,
              {
                syncDeletes,
                ...(plannedDeletePaths !== undefined ? { plannedDeletePaths } : {}),
                excludePatterns: effectiveExcludePatterns,
                architecture: resolveArchitecture(
                  ctx.persistedConfig.vocareum.architecture,
                  partAction.part.settings?.labtype,
                ),
                workspaceRoot,
              },
              events,
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
      settingChanges.length > 0 || fileChanges.length > 0 || rubricChanges.length > 0
        ? {
            settings: settingChanges.length > 0 ? settingChanges : undefined,
            files: fileChanges.length > 0 ? fileChanges : undefined,
            rubrics: rubricChanges.length > 0 ? rubricChanges : undefined,
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
