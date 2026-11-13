/**
 * Reconciler Module
 *
 * Compare local configuration with Vocareum state to determine required actions.
 */

import * as path from 'path';
import type { Config, PublishHistory, Part, Assignment, DirectoryType } from '../types/config';
import { detectArchitecture, normalizeSubmissionFilters } from '../types/config';
import { detectChangedDirectories, directoriesForPart, publishExcludePatterns, INCOMPLETE_PULL_MARKER } from './local-scan';
import type { VocareumAssignmentResponse, VocareumPartResponse, RubricSyncPlan, RemoteRubric } from '../types/api';
import type {
  ReconciliationPlan,
  AssignmentAction,
  PartAction,
  OrphanedEntity,
  StaleAssignment,
  CourseAction,
  BlockedDirectory,
} from '../types/state';
import { VocareumClient } from '../api/client';
import { listDirectoryBounded } from '../api/content';
import { resolveCourseRootEvidence, ROOT_LISTING_FAILED, type RootEvidence } from './course-architecture';
import { getCourse } from '../api/courses';
import { listAssignments, getAssignment } from '../api/assignments';
import { listParts, getPart } from '../api/parts';
import { listRubrics } from '../api/rubrics';
import { mapParts } from './mapper';
import { LoggerEventSink } from '../utils/logger-event-sink';
import type { EventSink } from './services/event-sink';
import {
  shouldSyncAssignmentSettings,
  shouldSyncCourseSettings,
  shouldSyncPartSettings,
  shouldSyncRubrics,
} from '../utils/settings-sync';
import { mapRubrics, planRubricSync } from '../utils/rubrics';
import { deepEqual } from '../utils/deep-equal';
import { mapPeerReviewSettings } from '../utils/settings';
import { coercedPeerDependents, peerReviewPayload } from './payload-helpers';

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

/** Local cleanup_time is set and differs numerically from what Vocareum returns. */
function cleanupTimeDiffers(configPart: Part, remotePart: VocareumPartResponse | undefined): boolean {
  const local = configPart.settings?.cleanup_time;
  if (local === undefined || local === null || remotePart?.cleanup_time === undefined) { return false; }
  const remote = Number(remotePart.cleanup_time);
  return !Number.isFinite(remote) || remote !== local;
}

/**
 * Vocareum stores cleanup_time only on container labs. On an Elite-architecture
 * part (Vocareum Standard and friends) a PUT is accepted and the field reads
 * back 0, so a non-zero local value would be re-sent on every push. Probed
 * 2026-11-10 (Standard part 5441304: sent 30, read 0).
 *
 * Decided from the part's own labtype and the readback, never from history: a
 * container lab whose value was changed in the UI must still be corrected.
 *
 * @internal Exported for testing
 */
export function cleanupTimeIgnoredByServer(part: Part, remotePart: VocareumPartResponse | undefined): boolean {
  if (!cleanupTimeDiffers(part, remotePart)) { return false; }
  const readback = remotePart?.cleanup_time;
  const readsZero = readback === 0 || (typeof readback === 'string' && readback.trim() === '0');
  return detectArchitecture(remotePart?.labtype) === 'elite' && readsZero;
}

/** Root listing cap: more names than this is not evidence (spec "Check"). */
const ROOT_LISTING_CAP = 1000;

/** What the asnlib push guard needs for one reconcile run. */
interface AsnlibGuardState {
  client: VocareumClient;
  courseId: string;
  /** One root lookup per course per run, failures included. */
  cache: Map<string, RootEvidence>;
}

/** A part of the destination course whose root can be listed. */
interface EvidencePart {
  assignmentId: string;
  partId: string;
  /** Workspace path of the part (assignment path / part path), for the refusal message. */
  label: string;
}

/**
 * The first part in config order, across every assignment of vocareum.yaml,
 * that already has both IDs. Used on create: a new assignment has no part of
 * its own yet, and its template may live in another course, so only a part
 * already in the destination course is evidence.
 */
function firstConfiguredPart(assignments: Assignment[]): EvidencePart | undefined {
  for (const assignment of assignments) {
    const assignmentId = assignment.assignment_id;
    if (assignmentId === null || assignmentId === undefined || assignmentId === '') { continue; }
    for (const part of assignment.parts) {
      const partId = part.part_id;
      if (partId !== null && partId !== undefined && partId !== '') {
        return { assignmentId, partId, label: path.join(assignment.path, part.path) };
      }
    }
  }
  return undefined;
}

/**
 * Decides whether `asnlib` may be uploaded. Returns undefined when the course
 * root is positively Elite, otherwise the refusal message for this directory.
 *
 * Positive evidence only: a Container root, an unrecognised root, a failed or
 * truncated listing and the absence of any part to list all refuse, because an
 * upload with reset:1 to a Container `asnlib` could replace the `docs`/`data`
 * aliases it holds, and that is unprobed.
 */
async function asnlibRefusal(
  guard: AsnlibGuardState,
  evidence: EvidencePart | undefined,
  dirKey: string,
): Promise<string | undefined> {
  // Only an uncached miss means "nothing to check": a cached answer from an
  // earlier part of this run is real evidence about the same course.
  const noPart = evidence === undefined && !guard.cache.has(guard.courseId);
  const result = await resolveCourseRootEvidence(
    (partId) => listDirectoryBounded(
      guard.client, guard.courseId, evidence?.assignmentId ?? '', partId, '/', { remaining: ROOT_LISTING_CAP },
    ),
    evidence?.partId,
    guard.cache,
    guard.courseId,
    evidence?.label,
  );
  if (result.kind === 'elite') { return undefined; }
  const head = `Not pushing \`${dirKey}\``;
  if (result.kind === 'container') {
    return `${head}: this is a Container course, where \`asnlib\` holds aliases of \`docs\` and \`data\`. ` +
      'Uploading it could replace those aliases on Vocareum. vocgit refuses it until this is verified.';
  }
  if (noPart) {
    return `${head}: no part of this course existed to check; the next push checks the new part ` +
      'and uploads `asnlib` only if this course is Elite.';
  }
  const risk = 'On a Container course `asnlib` holds aliases of `docs` and `data`, and uploading it could replace them on Vocareum, ';
  // A failed listing may be passing (network, overload): the evidence is
  // cached for this run only, so the next push lists the root again.
  if (result.detail.startsWith(ROOT_LISTING_FAILED)) {
    return `${head}: ${result.detail}, so vocgit cannot confirm this course is Elite. ${risk}` +
      'so it is refused this time. The next push checks the course root again.';
  }
  return `${head}: ${result.detail}, so vocgit cannot confirm this course is Elite. ${risk}` +
    'so it is refused on every push until vocgit recognises this course root. ' +
    'Please report this root listing to the vocgit maintainers.';
}

/**
 * Removes `asnlib` from a part's planned directories when the course is not
 * positively Elite, and records it as a `container-asnlib` block. Runs before
 * content hashes, sync-delete planning and promotion are decided, since what
 * uploads is built from `changedDirectories`; the blocked pass alone never
 * prevents an upload. No request is made unless `asnlib` is planned.
 */
async function guardAsnlib(
  guard: AsnlibGuardState | undefined,
  changedDirs: DirectoryType[],
  blocked: BlockedDirectory[],
  evidence: () => EvidencePart | undefined,
  dirKey: string,
): Promise<{ changedDirs: DirectoryType[]; refusal?: string }> {
  if (guard === undefined || !changedDirs.includes('asnlib')) { return { changedDirs }; }
  const refusal = await asnlibRefusal(guard, evidence(), dirKey);
  if (refusal === undefined) { return { changedDirs }; }
  blocked.push({ dir: 'asnlib', reason: 'container-asnlib' });
  return { changedDirs: changedDirs.filter((dir) => dir !== 'asnlib'), refusal };
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
  options: {
    forceAll?: boolean;
    onMissingId?: 'skip' | 'abort';
    workspaceRoot?: string;
    events?: EventSink;
    /**
     * Fetch and diff each part's rubrics against config. Only `push` needs this
     * plan; `pull`'s inspection never reads `rubricPlan`/`remoteRubrics` off
     * the resulting PartAction, so leaving this off there saves a GET per
     * rubric-managed part (on top of the GETs pull's own settings-drift and
     * orphan-import fetchers already make) and avoids a second, unlatched
     * "could not read rubrics" warning path outside push's guarantees.
     */
    planRubrics?: boolean;
    /**
     * Refuse `asnlib` unless the destination course root is positively Elite
     * (spec "Push: `asnlib` on Container courses"). Only push sets this: the
     * guard lists a course root, which pull's inspection has no use for.
     * `courseAssignments` is every assignment of vocareum.yaml, unfiltered, so a
     * created assignment can borrow the first configured part as evidence even
     * under `--assignment`.
     */
    asnlibGuard?: { courseAssignments: Assignment[] };
  } = {}
): Promise<ReconciliationPlan> {
  const events: EventSink = options.events ?? new LoggerEventSink();
  const guard: AsnlibGuardState | undefined = options.asnlibGuard !== undefined
    ? { client, courseId: config.vocareum.course_id, cache: new Map() }
    : undefined;
  const courseAssignments = options.asnlibGuard?.courseAssignments ?? [];
  events.emit({ level: 'info', message: 'Fetching current state from Vocareum...' });

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
    let remotePeerReviewToggle: boolean | undefined;
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
          events.emit({ level: 'warn', message: `Assignment "${configAssignment.name}" (ID: ${configAssignment.assignment_id}) not found in Vocareum - may have been deleted` });
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
        events.emit({ level: 'info', message: `Found existing assignment "${lookupName}" (ID: ${foundByName.id}) - will update instead of create` });
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
      const remotePeerForToggle: Record<string, unknown> = {};
      mapPeerReviewSettings(fullAssignment, remotePeerForToggle);
      if (typeof remotePeerForToggle.peer_review_toggle === 'boolean') {
        remotePeerReviewToggle = remotePeerForToggle.peer_review_toggle;
      }

      // Check for changes in fields that can be updated via API
      // Working fields: name, description, nosubmit, auto_submit, grading_on_submit, publish, etc.
      // NOT working: due_date, points (return "No valid parameters")
      if (shouldSyncAssignmentSettings(config, configAssignment)) {
        // Warn whenever a configured true cannot take effect, even when the
        // server is already false (no PUT): otherwise the intent is silently
        // unapplied and push reports the assignment as in sync.
        const coerced = coercedPeerDependents(configAssignment.settings, { remoteToggle: remotePeerReviewToggle });
        if (coerced.length > 0) {
          events.emit({
            level: 'warn',
            message: `"${configAssignment.name}": ${coerced.join(', ')} ${coerced.length === 1 ? 'is' : 'are'} true in vocareum.yaml but peer review is off, so ${coerced.length === 1 ? 'it is' : 'they are'} sent as false (Vocareum rejects true). Set peer_review_toggle: true to enable ${coerced.length === 1 ? 'it' : 'them'}, or set ${coerced.length === 1 ? 'it' : 'them'} to false.`,
          });
        }
      }
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
          let cleanupIgnored = false;
          if (shouldSyncPartSettings(config, configAssignment, configPart)) {
            const fullPart = await getPart(client, config.vocareum.course_id, remoteAssignment.id, mapping.apiPartId);
            cleanupIgnored = cleanupTimeIgnoredByServer(configPart, fullPart);
            if (cleanupIgnored) {
              events.emit({
                level: 'warn',
                message: `Part "${configPart.name ?? configPart.path}" of "${configAssignment.name}": cleanup_time ${String(configPart.settings?.cleanup_time)} is not sent. Vocareum stores it only on container labs, and this part is ${String(fullPart.labtype)}.`,
              });
            }
            metadataChanged =
              detectPartSettingsChanged(configPart, fullPart, { ignoreCleanupTime: cleanupIgnored }) ||
              hasAcceptedUnverifiedPartChange(configAssignment, configPart, lastPublishHistory);
          }

          // Rubric drift is a third change signal alongside content and settings. Without
          // it a part whose files and settings already match produces no action at all,
          // and a rubrics-only migration plans as "No changes" and does nothing.
          let rubricPlan: RubricSyncPlan | undefined;
          let remoteRubrics: RemoteRubric[] | undefined;
          let rubricReadFailed: string | undefined;
          // The spec distinguishes these deliberately: `rubrics: []` means "no local
          // criteria", so every remote row is an orphan to report; an ABSENT `rubrics` key
          // means "this part is not managed here" and is skipped without a fetch.
          const wantsRubrics = configPart.rubrics !== undefined;

          // Only push needs a rubric plan at reconcile time; pull's inspection never
          // reads rubricPlan/remoteRubrics off a PartAction (see the option's doc
          // comment on `reconcile`), so gate the whole fetch-and-diff block behind it.
          if (options.planRubrics === true && wantsRubrics && shouldSyncRubrics(config)) {
            if (!shouldSyncPartSettings(config, configAssignment, configPart)) {
              // Silence here would reproduce the original bug in a new place: the user has
              // sync_rubrics on, expects a migration, and gets nothing.
              events.emit({
                level: 'warn',
                message:
                  `Part "${configPart.name ?? configPart.path}" has rubrics in config but ` +
                  `settings sync is disabled for it, so rubrics will not be pushed. ` +
                  `Set sync_settings: true for this part to migrate them.`,
              });
            } else {
              try {
                const rows = await listRubrics(client, config.vocareum.course_id, remoteAssignment.id, mapping.apiPartId);
                remoteRubrics = mapRubrics(rows).map((r, i) => ({ ...r, id: String(rows[i].id) }));
                const planned = planRubricSync(configPart.rubrics ?? [], remoteRubrics);
                const hasWork =
                  planned.creates.length > 0 || planned.updates.length > 0 ||
                  planned.orphans.length > 0 || planned.duplicateNames.length > 0;
                if (hasWork) { rubricPlan = planned; }
              } catch (error) {
                // Leave rubricPlan undefined — "unknown", not "nothing to do". Content and
                // settings detection for this part must not be lost to a rubric read: the
                // part is still promoted to 'update' below (via rubricReadFailed) so the
                // failure reaches execute, but content/settings diffing proceeds normally.
                const message = error instanceof Error ? error.message : 'Unknown error';
                rubricReadFailed = message;
                events.emit({
                  level: 'warn',
                  message: `Could not read rubrics for part ${mapping.apiPartId}: ${message}`,
                });
              }
            }
          }

          const effectiveDirs = directoriesForPart(config, configPart);

          const excludePatterns = publishExcludePatterns(config);
          const detected = await detectChangedDirectories(
            configAssignment.path,
            configPart.path,
            effectiveDirs,
            lastPublishHistory,
            options.forceAll,
            excludePatterns,
            options.workspaceRoot ?? process.cwd()
          );
          const dirHashes = detected.hashes;
          const blockedDirs: BlockedDirectory[] = detected.blockedDirs.map(
            (dir): BlockedDirectory => ({ dir, reason: 'incomplete-pull' }),
          );
          const remoteAssignmentId = remoteAssignment.id;
          const { changedDirs, refusal: asnlibRefusalMessage } = await guardAsnlib(
            guard,
            detected.changedDirs,
            blockedDirs,
            // On update the part itself is the evidence.
            () => ({
              assignmentId: remoteAssignmentId,
              partId: mapping.apiPartId,
              label: path.join(configAssignment.path, configPart.path),
            }),
            path.join(configAssignment.path, configPart.path, 'asnlib'),
          );
          if (asnlibRefusalMessage !== undefined) {
            // Its hash must not travel with the plan: nothing may read it as uploadable.
            delete dirHashes.asnlib;
          }

          const rubricsChanged = rubricPlan !== undefined;

          // A blocked directory alone still promotes the part: push must report
          // it as failed, not finish green having silently skipped it.
          if (changedDirs.length > 0 || metadataChanged || rubricsChanged || rubricReadFailed !== undefined || blockedDirs.length > 0) {
            const reasons: string[] = [];
            if (changedDirs.length > 0) {
              reasons.push(`Content: ${changedDirs.join(', ')}`);
            }
            if (blockedDirs.length > 0) {
              reasons.push(`Content blocked: ${blockedDirs.map((b) => `${b.dir} (${b.reason})`).join(', ')}`);
            }
            if (metadataChanged) {
              reasons.push('Settings changed');
            }
            if (rubricReadFailed !== undefined) {
              // A part with no other drift would otherwise stay 'skip' and this failure
              // would never reach execute — promote it so the run reports it as failed
              // instead of exiting green having migrated no points (see FIX 3).
              reasons.push(`Rubrics: could not read (${rubricReadFailed})`);
            }
            if (rubricPlan) {
              // Compose from whatever actually drove the promotion. Creates/updates are
              // the common case; duplicateNames is mutually exclusive with the other three
              // (planRubricSync short-circuits to it), so it gets its own message rather
              // than reading as "0 to create, 0 to update" when it's the sole reason.
              if (rubricPlan.duplicateNames.length > 0) {
                reasons.push(`Rubrics: duplicate criterion names (${rubricPlan.duplicateNames.join(', ')})`);
              } else {
                const segments: string[] = [];
                if (rubricPlan.creates.length > 0) { segments.push(`${rubricPlan.creates.length} to create`); }
                if (rubricPlan.updates.length > 0) { segments.push(`${rubricPlan.updates.length} to update`); }
                if (rubricPlan.orphans.length > 0) {
                  segments.push(`${rubricPlan.orphans.length} orphan${rubricPlan.orphans.length === 1 ? '' : 's'}`);
                }
                reasons.push(`Rubrics: ${segments.join(', ')}`);
              }
            }
            partActions.push({
              type: 'update',
              part: configPart,
              contentChanged: changedDirs.length > 0,
              changedDirectories: changedDirs.length > 0 ? changedDirs : undefined,
              // Carry the hashes computed during change detection so planPush
              // can read them directly instead of recomputing (Stage 1a Fix 3).
              dirHashes: Object.keys(dirHashes).length > 0 ? dirHashes : undefined,
              metadataChanged,
              ...(cleanupIgnored ? { cleanupTimeIgnored: true } : {}),
              rubricPlan,
              remoteRubrics,
              rubricReadFailed,
              blockedDirectories: blockedDirs.length > 0 ? blockedDirs : undefined,
              ...(asnlibRefusalMessage !== undefined ? { asnlibRefusal: asnlibRefusalMessage } : {}),
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
        events.emit({ level: 'error', message: `Part mapping failed for ${configAssignment.name}: ${message}` });
        assignmentActionType = 'error';
        assignmentReason = `Part mapping failed: ${message}`;
      }
    } else if (assignmentActionType === 'create') {
      // For creation, we mark all parts as needing creation/upload
      for (const part of configAssignment.parts) {
        // A directory a partial pull marked is never planned, on create as on
        // update (detectChangedDirectories): the template copy is complete,
        // and a reset:1 upload of the partial local tree would delete what
        // the pull missed and clear the marker that protects it.
        const blocked: BlockedDirectory[] = [];
        const planned: DirectoryType[] = [];
        for (const dir of directoriesForPart(config, part)) {
          const key = path.join(configAssignment.path, part.path, dir);
          if (lastPublishHistory?.content_state?.[key] === INCOMPLETE_PULL_MARKER) {
            blocked.push({ dir, reason: 'incomplete-pull' });
          } else {
            planned.push(dir);
          }
        }
        // On create every other directory is planned, so the guard applies here
        // too. The template is never evidence: it may live in another course.
        const { changedDirs: createDirs, refusal } = await guardAsnlib(
          guard,
          planned,
          blocked,
          () => firstConfiguredPart(courseAssignments),
          path.join(configAssignment.path, part.path, 'asnlib'),
        );
        partActions.push({
          type: 'create',
          part,
          contentChanged: createDirs.length > 0,
          changedDirectories: createDirs,
          ...(blocked.length > 0 ? { blockedDirectories: blocked } : {}),
          ...(refusal !== undefined ? { asnlibRefusal: refusal } : {}),
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
      remotePeerReviewToggle,
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
 * Writable fields are based on the draft OpenAPI contract plus live probes.
 * Non-schema/create-only fields may be preserved under _observed_settings but
 * should not trigger push updates.
 */
/** @internal Exported for testing */
export function detectAssignmentSettingsChanged(
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

  // Peer review (field report #5). Compare what push would SEND (see
  // peerReviewPayload: off-toggle dependents as false, null dates as clears)
  // with the remote run through the same mapper pull uses, so case, numeric
  // strings and "1"/"0" flags compare like for like. A key the server does not
  // return (or returns in a form the mapper cannot read) is not drift — older
  // tenants or plans may not expose peer review at all.
  const remotePeer: Record<string, unknown> = {};
  mapPeerReviewSettings(remoteAssignment, remotePeer);
  const remoteToggle = typeof remotePeer.peer_review_toggle === 'boolean' ? remotePeer.peer_review_toggle : undefined;
  for (const [key, local] of Object.entries(peerReviewPayload(s, { remoteToggle }))) {
    if (remotePeer[key] !== undefined && !deepEqual(local, remotePeer[key])) { return true; }
  }

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
/** @internal Exported for testing */
export function detectPartSettingsChanged(
  configPart: Part,
  remotePart?: VocareumPartResponse,
  options: { ignoreCleanupTime?: boolean } = {}
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
  // cleanup_time: whole numbers, so compare numerically (the API echoes a string).
  // A value Vocareum ignored (Standard labs read back 0) is handled by the
  // caller against the last push, not here.
  if (options.ignoreCleanupTime !== true && cleanupTimeDiffers(configPart, remotePart)) { return true; }

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
 * Display reconciliation plan to console
 *
 * @param plan - Plan to display
 * @param events - Optional EventSink (defaults to LoggerEventSink)
 */
export function displayPlan(plan: ReconciliationPlan, events: EventSink = new LoggerEventSink()): void {
  events.emit({ level: 'info', message: 'Reconciliation Plan:' });
  events.emit({ level: 'plain', message: `To Create: ${plan.summary.assignmentsToCreate} assignments` });
  events.emit({ level: 'plain', message: `To Update: ${plan.summary.assignmentsToUpdate} assignments` });
  events.emit({ level: 'plain', message: `To Skip:   ${plan.summary.assignmentsToSkip} assignments` });
  if (plan.summary.coursesToUpdate > 0) {
    events.emit({ level: 'plain', message: 'Course:    metadata update required' });
  }
  if (plan.summary.assignmentsWithDiscoveredIds > 0) {
    events.emit({ level: 'plain', message: `ID Sync:   ${plan.summary.assignmentsWithDiscoveredIds} assignment IDs discovered by name` });
  }
  events.emit({ level: 'plain', message: `Orphaned:  ${plan.orphanedInVocareum.length} in Vocareum` });

  if (plan.summary.assignmentsToCreate > 0) {
    events.emit({ level: 'newline' });
    events.emit({ level: 'info', message: 'Assignments to Create:' });
    plan.assignments.filter(a => a.type === 'create').forEach(a => {
      events.emit({ level: 'plain', message: `  + ${a.assignment.name} (from template)` });
    });
  }

  if (plan.summary.assignmentsToUpdate > 0) {
    events.emit({ level: 'newline' });
    events.emit({ level: 'info', message: 'Assignments to Update:' });
    plan.assignments.filter(a => a.type === 'update' && a.parts.some(p => p.type !== 'skip')).forEach(a => {
      events.emit({ level: 'plain', message: `  * ${a.assignment.name}` });
      a.parts.filter(p => p.type === 'update').forEach(p => {
        events.emit({ level: 'plain', message: `    - Part ${p.part.name ?? p.part.path}: ${p.reason}` });
      });
    });
  }

  if (plan.orphanedInVocareum.length > 0) {
    events.emit({ level: 'newline' });
    events.emit({ level: 'warn', message: 'Orphaned Assignments in Vocareum:' });
    plan.orphanedInVocareum.forEach(o => {
      events.emit({ level: 'plain', message: `  ? ${o.name} (${o.id})` });
    });
  }
}
