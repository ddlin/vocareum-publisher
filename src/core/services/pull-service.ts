/**
 * Pull Service
 *
 * Service layer for the pull command. Contains inspectPull and applyPull,
 * which detect sync issues and apply resolutions respectively.
 *
 * IMPORTANT: This file MUST NOT import logger. All output goes through EventSink.
 */

import * as path from 'path';
import { assertConfinedToWorkspace } from '../local-scan';
import { reconcile } from '../reconciler';
import { getAssignment } from '../../api/assignments';
import { listParts, getPart } from '../../api/parts';
import { downloadContent } from '../../api/content';
import { pathExists, ensureDirectory, writeFile, writeFileUnderBase, calculateDirectoryHash, validatePath, readDirectory } from '../../utils/files';
import { isPathConfinedToBase } from '../../utils/path-security';
import { getCommitSha, getGitUserName } from '../../utils/git';
import type { PublishHistory } from '../../types/config';
import { mapAssignmentSettings, mapPartSettings } from '../../utils/settings';
import { UnknownFieldReporter } from '../../utils/unknown-field-reporter';
import {
  normalizeSubmissionFilters,
  DEFAULT_PART_DIRECTORIES,
  ELITE_DIRECTORIES,
  CONTAINER_DIRECTORIES,
  resolveArchitecture,
} from '../../types/config';
import type { Assignment, Part, DirectoryType, AssignmentSettings, PartSettings, SubmissionFilters, Rubric } from '../../types/config';
import type { OrphanedEntity, StaleAssignment } from '../../types/state';
import type { FileMap } from '../../types/api';
import type { EventSink } from './event-sink';
import type { VocareumClient } from '../../api/client';
import type { LockedSession } from '../session';
import type { PullContext } from './context';
import type { PullRequest } from './types';
import {
  OBSERVED_ASSIGNMENT_SETTING_KEYS,
  OBSERVED_PART_SETTING_KEYS,
} from '../../utils/known-settings';
import {
  shouldSyncAssignmentSettings,
  shouldSyncPartSettings,
  shouldSyncRubrics,
} from '../../utils/settings-sync';
import { rubricsEqual, describeRubricChanges, type RubricChangeSummary } from '../../utils/rubrics';
import { createRubricFetcher, type RubricFetcher } from './rubric-fetcher';

// ── Re-exported helpers (used by pull.ts resolver) ──────────────────────────

/**
 * Choose a directory name for a part within a multi-part assignment.
 */
export function resolvePartPath(
  partName: string,
  index: number,
  totalParts: number,
  taken: Set<string>
): string {
  if (totalParts === 1) { return '.'; }

  const slug = slugify(partName);
  if (slug.length > 0 && !taken.has(slug)) {
    taken.add(slug);
    return slug;
  }

  let candidate = `part${index + 1}`;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `part${index + 1}-${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

export function getDownloadPlan(
  architecture: 'elite' | 'container' | undefined,
  labtype: string | null | undefined,
  configuredDirectories?: DirectoryType[]
): { directories: DirectoryType[]; architecture?: 'elite' | 'container' } {
  const resolvedArchitecture = resolveArchitecture(architecture, labtype);

  if (configuredDirectories !== undefined) {
    return { directories: configuredDirectories, architecture: resolvedArchitecture };
  }

  if (resolvedArchitecture === 'elite') {
    return { directories: ELITE_DIRECTORIES, architecture: resolvedArchitecture };
  }
  if (resolvedArchitecture === 'container') {
    return { directories: CONTAINER_DIRECTORIES, architecture: resolvedArchitecture };
  }

  return { directories: DEFAULT_PART_DIRECTORIES, architecture: resolvedArchitecture };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

export async function getUniqueDirectoryName(basePath: string, desiredName: string): Promise<string> {
  let name = desiredName;
  let suffix = 1;

  while (await pathExists(path.join(basePath, name))) {
    suffix++;
    name = `${desiredName}-${suffix}`;
  }

  return name;
}

export async function findExistingImportTarget(
  basePath: string,
  slug: string,
  maxSuffix: number = 100
): Promise<string | null> {
  const candidates: string[] = [slug];
  for (let i = 2; i <= maxSuffix; i++) {
    candidates.push(`${slug}-${i}`);
  }

  for (const name of candidates) {
    const dirPath = path.join(basePath, name);
    if (!(await pathExists(dirPath))) { continue; }
    const files = await readDirectory(dirPath, ['.gitkeep', '**/.gitkeep']);
    if (Object.keys(files).length > 0) {
      return name;
    }
  }

  return null;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === undefined || b === undefined) { return false; }
  if (typeof a === 'number' && typeof b === 'string') {
    return a === parseInt(b, 10);
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return parseInt(a, 10) === b;
  }
  if (typeof a !== typeof b) { return false; }
  if (typeof a === 'object' && a !== null && b !== null) {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((v, i) => valuesEqual(v, (b as unknown[])[i]));
    }
    if (Array.isArray(a) !== Array.isArray(b)) { return false; }
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) { return false; }
    return aKeys.every((k) => valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function validatePullContentFlags(opts: {
  content?: boolean;
  assignment?: string[];
  part?: string[];
}): void {
  const assignmentSel = opts.assignment ?? [];
  const partSel = opts.part ?? [];
  if (!opts.content && (assignmentSel.length > 0 || partSel.length > 0)) {
    throw new Error('--assignment/--part only apply with --content. Add --content or remove the selectors.');
  }
  if (partSel.length > 0 && assignmentSel.length === 0) {
    throw new Error('--part requires --assignment (part selectors are not unique across a course).');
  }
  if (partSel.length > 0 && assignmentSel.length > 1) {
    throw new Error('--part requires exactly one --assignment (part selectors are not unique across assignments).');
  }
}

export function scopeAssignmentsForContent(
  assignments: Assignment[],
  assignmentSelectors: string[],
  partSelectors: string[],
): { assignments: Assignment[]; partIds: Set<string> | undefined } {
  if (assignmentSelectors.length === 0) {
    return { assignments, partIds: undefined };
  }
  const selected: Assignment[] = [];
  for (const sel of assignmentSelectors) {
    const match = assignments.find((a) => a.name === sel || a.assignment_id === sel);
    if (!match) {
      const valid = assignments.map((a) => `${a.name} (${a.assignment_id ?? 'no id'})`).join(', ');
      throw new Error(`Unknown --assignment "${sel}". Valid choices: ${valid || '(none)'}.`);
    }
    if (!selected.includes(match)) { selected.push(match); }
  }
  if (partSelectors.length === 0) {
    return { assignments: selected, partIds: undefined };
  }
  const target = selected[0];
  const validPartIds = new Set((target.parts ?? []).map((p) => p.part_id).filter((id): id is string => id !== null && id !== undefined));
  for (const p of partSelectors) {
    if (!validPartIds.has(p)) {
      const valid = [...validPartIds].join(', ');
      throw new Error(`Unknown --part "${p}" in assignment "${target.name}". Valid parts: ${valid || '(none)'}.`);
    }
  }
  return { assignments: selected, partIds: new Set(partSelectors) };
}

// ── Internal interfaces ──────────────────────────────────────────────────────

/** Result from importing an assignment, includes content state for history tracking */
export interface ImportResult {
  assignment: Assignment;
  contentState: Record<string, string>;
}

/** Represents a single setting that differs between local and remote */
interface SettingDiff {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

/** Rubric differences for a part. Read-only: remote always wins on pull. */
export interface RubricsDrift {
  local: Rubric[];
  remote: Rubric[];
  /** Name-keyed breakdown, for display only — nothing acts on it. */
  changes: RubricChangeSummary;
}

/** Represents settings drift for a part */
export interface PartSettingsDrift {
  partId: string;
  partName: string;
  partPath: string;
  diffs: SettingDiff[];
  remoteSettings: NonNullable<PartSettings>;
  unknownsChanged: boolean;
  observedChanged: boolean;
  /** Present only when the part's rubrics differ from config. */
  rubricsDrift?: RubricsDrift;
}

/** Represents settings drift for an assignment */
export interface AssignmentSettingsDrift {
  assignmentId: string;
  assignmentName: string;
  assignmentPath: string;
  assignmentDiffs: SettingDiff[];
  remoteAssignmentSettings: NonNullable<AssignmentSettings>;
  partsDrift: PartSettingsDrift[];
  unknownsChanged: boolean;
  observedChanged: boolean;
}

/** Represents a file that differs between local and remote */
interface FileDiff {
  filePath: string;
  status: 'modified' | 'added' | 'deleted';
}

/** Represents content drift for a part */
export interface PartContentDrift {
  partId: string;
  partName: string;
  partPath: string;
  fileDiffs: FileDiff[];
  remoteFiles: FileMap;
  /** Configured directories for the part; scaffolded (with .gitkeep when empty) on apply. */
  directories: DirectoryType[];
}

/** Represents content drift for an assignment */
export interface AssignmentContentDrift {
  assignmentId: string;
  assignmentName: string;
  assignmentPath: string;
  partsDrift: PartContentDrift[];
}

// ── Public types ─────────────────────────────────────────────────────────────

export type OrphanAction = 'import' | 'exclude' | 'skip';
export type StaleAction = 'exclude' | 'remove' | 'reset' | 'skip';
export type SettingsDriftAction = 'pull' | 'keep' | 'skip';
export type ContentDriftAction = 'pull' | 'keep' | 'skip';

export interface PullIssueOrphan {
  kind: 'orphan';
  orphan: OrphanedEntity;
  index: number;
  total: number;
}

export interface PullIssueStale {
  kind: 'stale';
  stale: StaleAssignment;
  index: number;
  total: number;
}

export interface PullIssueSettingsDrift {
  kind: 'settings-drift';
  drift: AssignmentSettingsDrift;
  index: number;
  total: number;
}

export interface PullIssueContentDrift {
  kind: 'content-drift';
  drift: AssignmentContentDrift;
  index: number;
  total: number;
}

export type PullIssue = PullIssueOrphan | PullIssueStale | PullIssueSettingsDrift | PullIssueContentDrift;

export interface PullResolver {
  resolveOrphanAction(issue: PullIssueOrphan): Promise<OrphanAction>;
  resolveStaleAction(issue: PullIssueStale): Promise<StaleAction>;
  resolveSettingsDriftAction(issue: PullIssueSettingsDrift): Promise<SettingsDriftAction>;
  resolveContentDriftAction(issue: PullIssueContentDrift): Promise<ContentDriftAction>;
  resolveImportPath(issue: PullIssueOrphan, suggestedPath: string): Promise<string>;
}

export interface PullInspection {
  orphans: OrphanedEntity[];
  stale: StaleAssignment[];
  settingsDrift: AssignmentSettingsDrift[];
  contentDrift: AssignmentContentDrift[];
}

export interface PullResult {
  imported: number;
  excluded: number;
  skipped: number;
  removed: number;
  reset: number;
  settingsPulled: number;
  contentPulled: number;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function formatValue(value: unknown): string {
  if (value === undefined) { return '(not set)'; }
  if (value === null) { return 'null'; }
  switch (typeof value) {
    case 'object': return JSON.stringify(value);
    case 'symbol': return value.toString();
    case 'function': return `<function ${(value as { name?: string }).name || 'anonymous'}>`;
    case 'string': return value;
    case 'number':
    case 'bigint':
    case 'boolean': return value.toString();
    default: return '(unsupported value)';
  }
}

function hasObservedTopLevelSettings(
  settings: NonNullable<AssignmentSettings> | NonNullable<PartSettings> | undefined,
  observedKeys: ReadonlySet<string>
): boolean {
  if (!settings) { return false; }
  const record = settings as Record<string, unknown>;
  return [...observedKeys].some((key) => record[key] !== undefined);
}

function clearObservedTopLevelSettings(
  settings: Record<string, unknown>,
  observedKeys: ReadonlySet<string>
): void {
  for (const key of observedKeys) {
    delete settings[key];
  }
}

function compareAssignmentSettings(
  localSettings: NonNullable<AssignmentSettings> | undefined,
  remoteSettings: NonNullable<AssignmentSettings>
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  const local: Record<string, unknown> = localSettings ?? {};
  const remote: Record<string, unknown> = remoteSettings;

  const keys = [
    'nosubmit', 'publish', 'publish_grades',
    'auto_submit', 'grading_on_submit', 'noworkarea',
    'exam_mode', 'exam_duration', 'num_attempts',
    'show_end_exam_button',
    'lti_on', 'anonymous_grading', 'grading_visibility',
    'live_code_comments',
  ];

  for (const key of keys) {
    const localVal = local[key];
    const remoteVal = remote[key];
    if (remoteVal !== undefined && !valuesEqual(localVal, remoteVal)) {
      diffs.push({ key, localValue: localVal, remoteValue: remoteVal });
    }
  }

  return diffs;
}

function comparePartSettings(
  localSettings: NonNullable<PartSettings> | undefined,
  remoteSettings: NonNullable<PartSettings>
): SettingDiff[] {
  const diffs: SettingDiff[] = [];
  const local: Record<string, unknown> = localSettings ?? {};
  const remote: Record<string, unknown> = remoteSettings;

  const keys = [
    'submission_filters', 'cloud_labs', 'instant_aws_access',
    'session_length', 'monthly_dollar', 'monthly_time', 'total_time', 'total_dollar',
    'endlab', 'labtype', 'container_image', 'lab_interface',
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

    if (remoteVal !== undefined && !valuesEqual(localVal, remoteVal)) {
      diffs.push({ key, localValue: localVal, remoteValue: remoteVal });
    }
  }

  return diffs;
}

function detectDirectories(files: FileMap): DirectoryType[] {
  const dirs = new Set<DirectoryType>();

  for (const filePath of Object.keys(files)) {
    const parts = filePath.split('/');
    if (parts.length > 0) {
      const dir = parts[0] as DirectoryType;
      if ((DEFAULT_PART_DIRECTORIES as readonly string[]).includes(dir)) {
        dirs.add(dir);
      }
    }
  }

  return Array.from(dirs);
}

function mergeDirectories(defaults: DirectoryType[], detected: DirectoryType[]): DirectoryType[] {
  const merged = new Set<DirectoryType>(defaults);
  for (const dir of detected) {
    merged.add(dir);
  }
  return Array.from(merged);
}

async function ensurePartDirectories(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[],
  verbose: boolean,
  events: EventSink
): Promise<void> {
  const fs = await import('fs/promises');

  for (const dir of directories) {
    const dirPath = partPath === '.'
      ? path.join(assignmentPath, dir)
      : path.join(assignmentPath, partPath, dir);

    // Never scaffold through a symlink: writing .gitkeep would follow it and could
    // land outside the workspace. The base is already confined by the caller
    // (assertConfinedToWorkspace) and `dir` is a single path segment, so guarding
    // the final directory component here is sufficient. Skip + warn, mirroring the
    // drift-side symlink policy. Uses lstat (catches broken symlinks too).
    let isSymlink = false;
    try {
      isSymlink = (await fs.lstat(dirPath)).isSymbolicLink();
    } catch { /* ENOENT: doesn't exist yet → safe to create below */ }
    if (isSymlink) {
      events.emit({
        level: 'warn',
        message: `Skipping directory scaffold for "${dir}/": it is a symlink`,
      });
      continue;
    }

    await ensureDirectory(dirPath);

    let isEmpty = true;
    try {
      const entries = await fs.readdir(dirPath);
      isEmpty = entries.length === 0 || (entries.length === 1 && entries[0] === '.gitkeep');
    } catch {
      isEmpty = true;
    }

    if (isEmpty) {
      await writeFile(path.join(dirPath, '.gitkeep'), '');
      if (verbose) {
        events.emit({ level: 'debug', message: `Created ${dirPath}/.gitkeep` });
      }
    }
  }
}

async function writeFilesToDirectory(
  assignmentPath: string,
  partPath: string,
  files: FileMap,
  verbose: boolean,
  events: EventSink
): Promise<void> {
  const createdDirs = new Set<string>();
  const basePath = partPath === '.' ? assignmentPath : path.join(assignmentPath, partPath);

  for (const [relativePath, content] of Object.entries(files)) {
    validatePath(basePath, relativePath);
    await writeFileUnderBase(basePath, relativePath, content);

    const dirPath = path.dirname(path.join(basePath, relativePath));
    if (!createdDirs.has(dirPath)) {
      createdDirs.add(dirPath);
      if (verbose) {
        events.emit({ level: 'debug', message: `Created ${dirPath}/` });
      }
    }
  }
}

async function importAssignment(
  client: VocareumClient,
  courseId: string,
  orphan: OrphanedEntity,
  localPath: string,
  verbose: boolean,
  architecture: 'elite' | 'container' | undefined,
  skipContent: boolean,
  reporter: UnknownFieldReporter | undefined,
  workspaceRoot: string,
  events: EventSink,
  rubricFetcher?: RubricFetcher
): Promise<ImportResult> {
  const assignmentId = orphan.id;
  // localPath is user-typed at the import prompt — confine it before any writes.
  // Must be realpath confinement, not lexical: a lexical check passes for a path
  // under an in-workspace symlink that points outside, letting the import escape.
  await assertConfinedToWorkspace(workspaceRoot, localPath);
  const localAbs = path.resolve(workspaceRoot, localPath);

  const fullAssignment = await getAssignment(client, courseId, assignmentId);
  const assignmentSettings = mapAssignmentSettings(fullAssignment, reporter, fullAssignment.id);

  if (verbose && Object.keys(assignmentSettings).length > 0) {
    events.emit({ level: 'debug', message: `Imported ${Object.keys(assignmentSettings).length} assignment settings` });
  }

  const parts = await listParts(client, courseId, assignmentId);

  if (verbose) {
    events.emit({ level: 'debug', message: `Found ${parts.length} parts for assignment ${orphan.name}` });
  }

  const configParts: Part[] = [];
  const takenPartPaths = new Set<string>();

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    const fullPart = await getPart(client, courseId, assignmentId, part.id);
    const partSettings = mapPartSettings(fullPart, reporter, fullPart.id);

    if (verbose && Object.keys(partSettings).length > 0) {
      events.emit({ level: 'debug', message: `Imported ${Object.keys(partSettings).length} settings for part ${part.name}` });
    }

    const partPath = resolvePartPath(part.name, i, parts.length, takenPartPaths);
    const partDir = partPath === '.' ? localAbs : path.join(localAbs, partPath);

    let files: FileMap = {};
    let usedExistingContent = false;
    if (skipContent) {
      const existing = await readDirectory(partDir, ['.gitkeep', '**/.gitkeep']);
      if (Object.keys(existing).length > 0) {
        files = existing;
        usedExistingContent = true;
      }
    }
    const downloadPlan = getDownloadPlan(architecture, partSettings.labtype);
    if (!usedExistingContent) {
      files = await downloadContent(
        client,
        courseId,
        assignmentId,
        part.id,
        downloadPlan.directories,
        downloadPlan.architecture
      );
    }
    const fileCount = Object.keys(files).length;

    const detectedDirs = fileCount > 0 ? detectDirectories(files) : [];
    const directories = mergeDirectories(downloadPlan.directories, detectedDirs);

    if (fileCount > 0 && !usedExistingContent) {
      await writeFilesToDirectory(localAbs, partPath, files, verbose, events);
    }

    await ensurePartDirectories(localAbs, partPath, directories, verbose, events);

    const configPart: Part = {
      part_id: part.id,
      path: partPath,
      name: part.name,
      directories,
      settings: partSettings,
    };

    // The migration path: an empty target imports through here, so rubrics must
    // be captured at import, not only on later drift detection.
    const rubrics = await rubricFetcher?.fetch(assignmentId, part.id);
    if (rubrics !== undefined && rubrics.length > 0) {
      configPart.rubrics = rubrics;
      if (verbose) {
        events.emit({ level: 'debug', message: `Imported ${rubrics.length} rubric criteria for part ${part.name}` });
      }
    }

    configParts.push(configPart);

    if (usedExistingContent) {
      events.emit({ level: 'plain', message: `  Part ${i + 1}/${parts.length}: reused ${fileCount} existing file${fileCount === 1 ? '' : 's'} (--skip-content)` });
    } else if (fileCount > 0) {
      events.emit({ level: 'plain', message: `  Part ${i + 1}/${parts.length}: downloaded ${fileCount} file${fileCount === 1 ? '' : 's'}` });
    } else {
      events.emit({ level: 'plain', message: `  Part ${i + 1}/${parts.length}: created empty structure` });
    }
  }

  const assignment: Assignment = {
    assignment_id: assignmentId,
    name: orphan.name,
    path: localPath,
    create_from_template: false,
    settings: assignmentSettings,
    parts: configParts,
  };

  const excludePatterns = ['.gitkeep', '**/.gitkeep'];
  const contentState: Record<string, string> = {};
  for (const configPart of configParts) {
    const partPath = configPart.path;
    const directories = configPart.directories ?? DEFAULT_PART_DIRECTORIES;

    for (const dir of directories) {
      const stateKey = partPath === '.'
        ? path.join(localPath, dir)
        : path.join(localPath, partPath, dir);

      const dirPath = path.resolve(workspaceRoot, stateKey);

      try {
        const hash = await calculateDirectoryHash(dirPath, excludePatterns);
        contentState[stateKey] = hash;

        if (verbose) {
          events.emit({ level: 'debug', message: `Content hash for ${stateKey}: ${hash.substring(0, 8)}...` });
        }
      } catch (error) {
        if (verbose) {
          events.emit({ level: 'debug', message: `Could not hash ${dirPath}: ${error instanceof Error ? error.message : 'Unknown'}` });
        }
      }
    }
  }

  return { assignment, contentState };
}

async function detectSettingsDrift(
  config: {
    assignments: Assignment[];
    vocareum: { course_id: string; excluded_assignments?: string[]; architecture?: 'elite' | 'container' };
    publish_options?: { sync_settings?: boolean };
  },
  client: VocareumClient,
  skipAssignmentIds: Set<string>,
  warnFn: (msg: string) => void,
  reporter?: UnknownFieldReporter,
  rubricFetcher?: RubricFetcher
): Promise<AssignmentSettingsDrift[]> {
  const driftList: AssignmentSettingsDrift[] = [];
  const excludedIds = new Set(config.vocareum.excluded_assignments ?? []);

  for (const assignment of config.assignments) {
    if (assignment.assignment_id === undefined || assignment.assignment_id === null || assignment.assignment_id === '') { continue; }
    if (skipAssignmentIds.has(assignment.assignment_id)) { continue; }
    if (excludedIds.has(assignment.assignment_id)) { continue; }

    try {
      const syncAssignmentSettings = shouldSyncAssignmentSettings(config, assignment);
      const syncAnyPartSettings = assignment.parts.some((part) => shouldSyncPartSettings(config, assignment, part));
      if (!syncAssignmentSettings && !syncAnyPartSettings) { continue; }

      let remoteAssignmentSettings: NonNullable<AssignmentSettings> = {};
      let assignmentDiffs: SettingDiff[] = [];
      let asnUnknownsChanged = false;
      let asnObservedChanged = false;
      let asnHasLegacyObservedTopLevel = false;

      if (syncAssignmentSettings) {
        const remoteAssignment = await getAssignment(client, config.vocareum.course_id, assignment.assignment_id);
        remoteAssignmentSettings = mapAssignmentSettings(remoteAssignment, reporter, remoteAssignment.id);

        assignmentDiffs = compareAssignmentSettings(assignment.settings, remoteAssignmentSettings);
        const localAsnUnknowns = assignment.settings?._unknown_settings ?? {};
        const remoteAsnUnknowns = remoteAssignmentSettings._unknown_settings ?? {};
        asnUnknownsChanged = !valuesEqual(
          Object.keys(localAsnUnknowns).length > 0 ? localAsnUnknowns : undefined,
          Object.keys(remoteAsnUnknowns).length > 0 ? remoteAsnUnknowns : undefined
        );
        const localAsnObserved = assignment.settings?._observed_settings ?? {};
        const remoteAsnObserved = remoteAssignmentSettings._observed_settings ?? {};
        asnObservedChanged = !valuesEqual(
          Object.keys(localAsnObserved).length > 0 ? localAsnObserved : undefined,
          Object.keys(remoteAsnObserved).length > 0 ? remoteAsnObserved : undefined
        );
        asnHasLegacyObservedTopLevel = hasObservedTopLevelSettings(
          assignment.settings,
          OBSERVED_ASSIGNMENT_SETTING_KEYS
        );
      }

      const partsDrift: PartSettingsDrift[] = [];
      if (syncAnyPartSettings) {
        const remoteParts = await listParts(client, config.vocareum.course_id, assignment.assignment_id);

        for (const configPart of assignment.parts) {
          if (!shouldSyncPartSettings(config, assignment, configPart)) { continue; }
          if (configPart.part_id === undefined || configPart.part_id === null || configPart.part_id === '') { continue; }

          const remotePart = remoteParts.find(p => p.id === configPart.part_id);
          if (!remotePart) { continue; }

          const fullRemotePart = await getPart(client, config.vocareum.course_id, assignment.assignment_id, configPart.part_id);
          const remotePartSettings = mapPartSettings(fullRemotePart, reporter, fullRemotePart.id);

          // Rubrics live behind their own endpoint and their own optional token
          // scope. The fetcher returns undefined rather than throwing — a throw
          // here would be swallowed by this function's per-assignment catch and
          // would silently discard the assignment's settings drift too.
          let rubricsDrift: RubricsDrift | undefined;
          const remoteRubrics = await rubricFetcher?.fetch(assignment.assignment_id, configPart.part_id);
          if (remoteRubrics !== undefined) {
            const localRubrics = configPart.rubrics ?? [];
            if (!rubricsEqual(localRubrics, remoteRubrics)) {
              rubricsDrift = {
                local: localRubrics,
                remote: remoteRubrics,
                changes: describeRubricChanges(localRubrics, remoteRubrics),
              };
            }
          }

          const partDiffs = comparePartSettings(configPart.settings, remotePartSettings);

          const localPartUnknowns = configPart.settings?._unknown_settings ?? {};
          const remotePartUnknowns = remotePartSettings._unknown_settings ?? {};
          const partUnknownsChanged = !valuesEqual(
            Object.keys(localPartUnknowns).length > 0 ? localPartUnknowns : undefined,
            Object.keys(remotePartUnknowns).length > 0 ? remotePartUnknowns : undefined
          );
          const localPartObserved = configPart.settings?._observed_settings ?? {};
          const remotePartObserved = remotePartSettings._observed_settings ?? {};
          const partObservedChanged = !valuesEqual(
            Object.keys(localPartObserved).length > 0 ? localPartObserved : undefined,
            Object.keys(remotePartObserved).length > 0 ? remotePartObserved : undefined
          );
          const partHasLegacyObservedTopLevel = hasObservedTopLevelSettings(
            configPart.settings,
            OBSERVED_PART_SETTING_KEYS
          );

          if (partDiffs.length > 0 || partUnknownsChanged || partObservedChanged ||
              partHasLegacyObservedTopLevel || rubricsDrift !== undefined) {
            partsDrift.push({
              partId: configPart.part_id,
              partName: configPart.name ?? remotePart.name,
              partPath: configPart.path,
              diffs: partDiffs,
              remoteSettings: remotePartSettings,
              unknownsChanged: partUnknownsChanged,
              observedChanged: partObservedChanged,
              rubricsDrift,
            });
          }
        }
      }

      const hasDrift = assignmentDiffs.length > 0 || asnUnknownsChanged || asnObservedChanged || asnHasLegacyObservedTopLevel ||
        partsDrift.length > 0;

      if (hasDrift) {
        driftList.push({
          assignmentId: assignment.assignment_id,
          assignmentName: assignment.name,
          assignmentPath: assignment.path,
          assignmentDiffs,
          remoteAssignmentSettings,
          partsDrift,
          unknownsChanged: asnUnknownsChanged,
          observedChanged: asnObservedChanged,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      warnFn(`Could not fetch settings for assignment "${assignment.name}" (ID: ${assignment.assignment_id}): ${message}`);
      continue;
    }
  }

  return driftList;
}

export async function detectContentDrift(
  config: { assignments: Assignment[]; vocareum: { course_id: string; excluded_assignments?: string[]; architecture?: 'elite' | 'container' } },
  client: VocareumClient,
  skipAssignmentIds: Set<string>,
  workspaceRoot: string,
  warnFn: (msg: string) => void,
  partIds?: Set<string>,
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
        if (partIds !== undefined && (configPart.part_id === null || configPart.part_id === undefined || !partIds.has(configPart.part_id))) {
          continue;
        }

        const downloadPlan = getDownloadPlan(
          config.vocareum.architecture,
          configPart.settings?.labtype,
          configPart.directories
        );

        const remoteFiles = await downloadContent(
          client,
          config.vocareum.course_id,
          assignment.assignment_id,
          configPart.part_id,
          downloadPlan.directories,
          downloadPlan.architecture,
          { strict: true }
        );

        const fileDiffs: FileDiff[] = [];
        const localBasePath = configPart.path === '.'
          ? assignment.path
          : path.join(assignment.path, configPart.path);

        await assertConfinedToWorkspace(workspaceRoot, localBasePath);
        const localBaseAbs = path.resolve(workspaceRoot, localBasePath);

        // When the whole part directory has been deleted, the base does not exist:
        // there are no local files or symlinks to read through, so every remote
        // file is a fresh add. Skip the per-file confinement/symlink checks in that
        // case — otherwise isPathConfinedToBase's realpath(base) throws ENOENT and
        // every file is falsely reported as an escaping symlink. apply recreates the
        // base via writeFileUnderBase, which confines each individual write.
        const baseExists = await pathExists(localBaseAbs);

        // Remote files whose local path is confined to the part directory. apply
        // writes this map verbatim through writeFileUnderBase (which THROWS on an
        // escape), so escaping entries are excluded here — otherwise apply would
        // abort before restoring the confined files.
        const safeRemoteFiles: FileMap = {};

        for (const [remotePath, remoteContent] of Object.entries(remoteFiles)) {
          validatePath(localBaseAbs, remotePath);
          const localPath = path.join(localBaseAbs, remotePath);
          if (baseExists) {
            if (!await isPathConfinedToBase(localBaseAbs, localPath)) {
              // A single escaping symlink must not abort drift detection for the
              // whole assignment — skip just this file so the rest of the part
              // (including locally-deleted directories that need restoring) is
              // still compared. The write side keeps its own confinement, so
              // nothing is ever materialized through the escaping symlink.
              warnFn(`Skipping "${remotePath}" in content drift check for "${assignment.name}": path escapes the local part directory through a symlink`);
              continue;
            }
            // apply writes this file through writeFileUnderBase, which refuses to
            // write through ANY final symlink target — even one pointing inside the
            // part. Skip such files at detection time (lstat, so broken symlinks are
            // caught too) so a single symlinked file can't abort the whole part's
            // restore; the user resolves the symlink manually.
            const fsp = await import('fs/promises');
            let localIsSymlink = false;
            try {
              localIsSymlink = (await fsp.lstat(localPath)).isSymbolicLink();
            } catch { /* ENOENT (e.g. locally-deleted path) → not a symlink */ }
            if (localIsSymlink) {
              warnFn(`Skipping "${remotePath}" in content drift check for "${assignment.name}": local path is a symlink and cannot be safely overwritten`);
              continue;
            }
          }
          safeRemoteFiles[remotePath] = remoteContent;

          if (baseExists && await pathExists(localPath)) {
            const fs = await import('fs/promises');
            const localContent = await fs.readFile(localPath);
            const remoteBuffer = Buffer.isBuffer(remoteContent)
              ? remoteContent
              : Buffer.from(remoteContent);

            if (!localContent.equals(remoteBuffer)) {
              fileDiffs.push({ filePath: remotePath, status: 'modified' });
            }
          } else {
            fileDiffs.push({ filePath: remotePath, status: 'added' });
          }
        }

        const directories = downloadPlan.directories;
        for (const dir of directories) {
          const localDirPath = path.join(localBaseAbs, dir);
          if (!await pathExists(localDirPath)) { continue; }
          // Never walk a directory that resolves outside the part directory — a
          // 'deleted' diff here would make apply's fs.unlink follow the symlink
          // and remove a file outside the workspace.
          if (!await isPathConfinedToBase(localBaseAbs, localDirPath)) {
            warnFn(`Skipping "${dir}/" in content drift check for "${assignment.name}": path escapes the local part directory through a symlink`);
            continue;
          }

          const fs = await import('fs/promises');
          try {
            const localFilesRaw = await fs.readdir(localDirPath, { recursive: true });
            for (const entry of localFilesRaw) {
              const file = String(entry);
              if (file === '.gitkeep' || file.endsWith('/.gitkeep')) { continue; }

              const relativePath = path.join(dir, file);
              const fullPath = path.join(localDirPath, file);
              // Skip nested entries that resolve outside the part directory
              // (an escaping symlink below a confined dir) for the same reason.
              if (!await isPathConfinedToBase(localBaseAbs, fullPath)) { continue; }
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
            remoteFiles: safeRemoteFiles,
            directories: downloadPlan.directories,
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
      warnFn(`Skipping content drift check for "${assignment.name}": ${message}`);
    }
  }

  return driftList;
}

// ── Public service functions ─────────────────────────────────────────────────

/**
 * Inspect the current pull state: detect orphans, stale assignments,
 * settings drift, and (optionally) content drift.
 */
export async function inspectPull(
  ctx: PullContext,
  req: PullRequest,
  reporter?: UnknownFieldReporter
): Promise<PullInspection> {
  const { effectiveConfig: config, client, workspaceRoot, events } = ctx;
  const warnFn = (msg: string) => events.emit({ level: 'warn', message: msg });

  // Run reconciliation to find orphans and stale assignments.
  // Pass ctx.events so "Fetching current state from Vocareum..." goes through events.
  const plan = await reconcile(config, client, undefined, { workspaceRoot, events });

  const staleAssignmentIds = new Set(plan.staleInConfig.map(s => s.assignment_id));
  const rubricFetcher = createRubricFetcher(
    client,
    config.vocareum.course_id,
    shouldSyncRubrics(config),
    warnFn
  );
  const settingsDrift = await detectSettingsDrift(config, client, staleAssignmentIds, warnFn, reporter, rubricFetcher);

  let contentDrift: AssignmentContentDrift[] = [];
  if (req.content) {
    const scoped = scopeAssignmentsForContent(
      config.assignments,
      req.assignment ?? [],
      req.part ?? [],
    );
    contentDrift = await detectContentDrift(
      { ...config, assignments: scoped.assignments },
      client,
      staleAssignmentIds,
      workspaceRoot,
      warnFn,
      scoped.partIds,
    );
  }

  return {
    orphans: plan.orphanedInVocareum,
    stale: plan.staleInConfig,
    settingsDrift,
    contentDrift,
  };
}

/**
 * Apply resolutions to the detected pull issues, writing config updates
 * through the locked session.
 */
export async function applyPull(
  session: LockedSession,
  ctx: PullContext,
  req: PullRequest,
  inspection: PullInspection,
  resolver: PullResolver,
  reporter?: UnknownFieldReporter
): Promise<PullResult> {
  const { effectiveConfig: config, client, workspaceRoot, events } = ctx;
  const verbose = req.verbose ?? false;
  const skipContent = req.skipContent ?? false;
  const rubricFetcher = createRubricFetcher(
    client,
    config.vocareum.course_id,
    shouldSyncRubrics(config),
    (msg: string) => events.emit({ level: 'warn', message: msg })
  );

  const result: PullResult = {
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
  const assignmentsToRemove: string[] = [];
  const assignmentsToReset: string[] = [];
  const settingsUpdates: Map<string, {
    assignmentSettings?: NonNullable<AssignmentSettings>;
    partSettings?: Map<string, NonNullable<PartSettings>>;
    partRubrics?: Map<string, Rubric[]>;
  }> = new Map();
  const importedContentState: Record<string, string> = {};

  // ── Process orphaned assignments ──────────────────────────────────────────
  if (inspection.orphans.length > 0) {
    events.emit({ level: 'info', message: `Found ${inspection.orphans.length} orphaned assignment(s) in Vocareum.` });
    events.emit({ level: 'newline' });

    for (let i = 0; i < inspection.orphans.length; i++) {
      const orphan = inspection.orphans[i];
      const issue: PullIssueOrphan = { kind: 'orphan', orphan, index: i, total: inspection.orphans.length };

      events.emit({ level: 'plain', message: `[${i + 1}/${inspection.orphans.length}] ${orphan.name} (ID: ${orphan.id})` });

      const action = await resolver.resolveOrphanAction(issue);

      if (action === 'import') {
        const defaultSlug = slugify(orphan.name);

        const reuseName = skipContent
          ? await findExistingImportTarget(workspaceRoot, defaultSlug)
          : null;
        const suggestedName = reuseName ?? await getUniqueDirectoryName(workspaceRoot, defaultSlug);

        const finalDirName = ((req.batch ?? false) || reuseName !== null)
          ? suggestedName
          : await resolver.resolveImportPath(issue, suggestedName);

        try {
          const { assignment, contentState } = await importAssignment(
            client,
            config.vocareum.course_id,
            orphan,
            finalDirName,
            verbose,
            config.vocareum.architecture,
            skipContent,
            reporter,
            workspaceRoot,
            events,
            rubricFetcher
          );

          newAssignments.push(assignment);
          Object.assign(importedContentState, contentState);
          result.imported++;
          events.emit({ level: 'success', message: `Imported "${orphan.name}" to ${finalDirName}/` });
        } catch (error) {
          events.emit({ level: 'error', message: `Failed to import: ${error instanceof Error ? error.message : 'Unknown'}` });
          result.skipped++;
        }
      } else if (action === 'exclude') {
        newExclusions.push(orphan.id);
        result.excluded++;
        events.emit({ level: 'success', message: `Excluded "${orphan.name}" from orphan detection` });
      } else {
        result.skipped++;
        events.emit({ level: 'plain', message: '  Skipped' });
      }

      events.emit({ level: 'newline' });
    }
  }

  // ── Process stale assignments ─────────────────────────────────────────────
  if (inspection.stale.length > 0) {
    events.emit({ level: 'info', message: `Found ${inspection.stale.length} stale assignment(s) in config (deleted from Vocareum).` });
    events.emit({ level: 'newline' });

    for (let i = 0; i < inspection.stale.length; i++) {
      const stale = inspection.stale[i];
      const issue: PullIssueStale = { kind: 'stale', stale, index: i, total: inspection.stale.length };

      events.emit({ level: 'plain', message: `[${i + 1}/${inspection.stale.length}] ${stale.name} (ID: ${stale.assignment_id}, path: ${stale.path})` });

      const action = await resolver.resolveStaleAction(issue);

      if (action === 'reset') {
        assignmentsToReset.push(stale.path);
        result.reset++;
        events.emit({ level: 'success', message: `Reset ID for "${stale.name}" - will be re-created on next publish` });
      } else if (action === 'remove') {
        assignmentsToRemove.push(stale.path);
        result.removed++;
        events.emit({ level: 'success', message: `Removed "${stale.name}" from config` });
      } else if (action === 'exclude') {
        newExclusions.push(stale.assignment_id);
        result.excluded++;
        events.emit({ level: 'success', message: `Excluded "${stale.name}" from sync` });
      } else {
        result.skipped++;
        events.emit({ level: 'plain', message: '  Skipped' });
      }

      events.emit({ level: 'newline' });
    }
  }

  // ── Process settings drift ────────────────────────────────────────────────
  if (inspection.settingsDrift.length > 0) {
    events.emit({ level: 'info', message: `Found ${inspection.settingsDrift.length} assignment(s) with settings drift.` });
    events.emit({ level: 'newline' });

    for (let i = 0; i < inspection.settingsDrift.length; i++) {
      const drift = inspection.settingsDrift[i];
      const issue: PullIssueSettingsDrift = { kind: 'settings-drift', drift, index: i, total: inspection.settingsDrift.length };

      events.emit({ level: 'plain', message: `[${i + 1}/${inspection.settingsDrift.length}] ${drift.assignmentName} (ID: ${drift.assignmentId})` });

      if (drift.assignmentDiffs.length > 0) {
        events.emit({ level: 'plain', message: '  Assignment settings changed in Vocareum:' });
        for (const diff of drift.assignmentDiffs) {
          events.emit({ level: 'plain', message: `    - ${diff.key}: ${formatValue(diff.localValue)} → ${formatValue(diff.remoteValue)}` });
        }
      }
      if (drift.unknownsChanged) {
        events.emit({ level: 'plain', message: '  Unknown settings changed (see end-of-run summary for fields)' });
      }
      if (drift.observedChanged) {
        events.emit({ level: 'plain', message: '  Observed read-only settings changed' });
      }

      for (const partDrift of drift.partsDrift) {
        if (partDrift.diffs.length > 0) {
          events.emit({ level: 'plain', message: `  Part "${partDrift.partName}" settings changed:` });
          for (const diff of partDrift.diffs) {
            events.emit({ level: 'plain', message: `    - ${diff.key}: ${formatValue(diff.localValue)} → ${formatValue(diff.remoteValue)}` });
          }
        }
        if (partDrift.unknownsChanged) {
          events.emit({ level: 'plain', message: `  Part "${partDrift.partName}" unknown settings changed (see end-of-run summary for fields)` });
        }
        if (partDrift.observedChanged) {
          events.emit({ level: 'plain', message: `  Part "${partDrift.partName}" observed read-only settings changed` });
        }
        if (partDrift.rubricsDrift) {
          const { changes, local, remote } = partDrift.rubricsDrift;
          events.emit({
            level: 'plain',
            message: `  Part "${partDrift.partName}" rubrics changed (${local.length} local → ${remote.length} remote):`,
          });
          for (const name of changes.added) {
            events.emit({ level: 'plain', message: `    + ${name} (new on remote)` });
          }
          for (const name of changes.changed) {
            events.emit({ level: 'plain', message: `    ~ ${name} (changed)` });
          }
          for (const name of changes.removed) {
            events.emit({ level: 'plain', message: `    - ${name} (not on remote)` });
          }
          // rubricsEqual compares positionally, so a hand-reordered local list
          // with the same criteria differs by comparison but leaves every
          // describeRubricChanges bucket empty — without this, the header
          // above would be followed by no lines at all.
          if (changes.added.length === 0 && changes.changed.length === 0 && changes.removed.length === 0) {
            events.emit({ level: 'plain', message: '    (order differs)' });
          }
          // Accurate about the limits, not just the mechanism: push can create a
          // criterion missing remotely and update one whose values differ, but it
          // never deletes a remote criterion that's absent locally (an orphan-only
          // drift here — remote has it, local doesn't — is never resolved by push,
          // it will keep showing up on every future pull) and criterion order is
          // immutable server-side (an order-only drift is never resolved either).
          events.emit({ level: 'plain', message: '    (push can create/update criteria from local, but never deletes a remote-only criterion or reorders them)' });
        }
      }

      const action = await resolver.resolveSettingsDriftAction(issue);

      if (action === 'pull') {
        const partSettingsMap = new Map<string, NonNullable<PartSettings>>();
        for (const partDrift of drift.partsDrift) {
          if (partDrift.diffs.length > 0 || partDrift.unknownsChanged || partDrift.observedChanged) {
            partSettingsMap.set(partDrift.partPath, partDrift.remoteSettings);
          }
        }

        const partRubricsMap = new Map<string, Rubric[]>();
        for (const partDrift of drift.partsDrift) {
          if (partDrift.rubricsDrift) {
            partRubricsMap.set(partDrift.partPath, partDrift.rubricsDrift.remote);
          }
        }

        settingsUpdates.set(drift.assignmentPath, {
          assignmentSettings: (drift.assignmentDiffs.length > 0 || drift.unknownsChanged || drift.observedChanged)
            ? drift.remoteAssignmentSettings
            : undefined,
          partSettings: partSettingsMap.size > 0 ? partSettingsMap : undefined,
          partRubrics: partRubricsMap.size > 0 ? partRubricsMap : undefined,
        });

        result.settingsPulled++;
        events.emit({ level: 'success', message: `Will update local settings for "${drift.assignmentName}"` });
      } else if (action === 'keep') {
        // If any part's drift included rubrics, push will create/update criteria
        // to match the kept local config, which can change the part's derived
        // max_points — but push cannot delete a remote-only criterion or reorder
        // criteria, so a kept local deletion or reordering will not be honoured
        // (that drift will keep reappearing on future pulls). Say so explicitly —
        // this is the last message a user sees before that happens.
        const hasRubricsDrift = drift.partsDrift.some((partDrift) => partDrift.rubricsDrift !== undefined);
        const keepMessage = hasRubricsDrift
          ? '  Keeping local settings (will push to Vocareum on next publish; rubric creates/updates apply, but push never deletes a remote-only criterion or reorders them)'
          : '  Keeping local settings (will push to Vocareum on next publish)';
        events.emit({ level: 'plain', message: keepMessage });
      } else {
        result.skipped++;
        events.emit({ level: 'plain', message: '  Skipped' });
      }

      events.emit({ level: 'newline' });
    }
  }

  // ── Process content drift ─────────────────────────────────────────────────
  if (inspection.contentDrift.length > 0) {
    events.emit({ level: 'info', message: `Found ${inspection.contentDrift.length} assignment(s) with content changes on Vocareum.` });
    events.emit({ level: 'newline' });

    for (let i = 0; i < inspection.contentDrift.length; i++) {
      const drift = inspection.contentDrift[i];
      const issue: PullIssueContentDrift = { kind: 'content-drift', drift, index: i, total: inspection.contentDrift.length };

      events.emit({ level: 'plain', message: `[${i + 1}/${inspection.contentDrift.length}] ${drift.assignmentName} (ID: ${drift.assignmentId})` });

      for (const partDrift of drift.partsDrift) {
        const partLabel = partDrift.partPath === '.' ? '' : ` (${partDrift.partName})`;
        events.emit({ level: 'plain', message: `  Content changes${partLabel}:` });

        const modified = partDrift.fileDiffs.filter(f => f.status === 'modified');
        const added = partDrift.fileDiffs.filter(f => f.status === 'added');
        const deleted = partDrift.fileDiffs.filter(f => f.status === 'deleted');

        for (const file of modified) {
          events.emit({ level: 'plain', message: `    ~ ${file.filePath} (modified)` });
        }
        for (const file of added) {
          events.emit({ level: 'plain', message: `    + ${file.filePath} (new on remote)` });
        }
        for (const file of deleted) {
          events.emit({ level: 'plain', message: `    - ${file.filePath} (deleted on remote)` });
        }
      }

      const action = await resolver.resolveContentDriftAction(issue);

      if (action === 'pull') {
        for (const partDrift of drift.partsDrift) {
          const localBasePath = partDrift.partPath === '.'
            ? drift.assignmentPath
            : path.join(drift.assignmentPath, partDrift.partPath);

          await assertConfinedToWorkspace(workspaceRoot, localBasePath);
          const localBaseAbs = path.resolve(workspaceRoot, localBasePath);

          await writeFilesToDirectory(
            path.resolve(workspaceRoot, drift.assignmentPath),
            partDrift.partPath,
            partDrift.remoteFiles,
            verbose,
            events
          );

          for (const fileDiff of partDrift.fileDiffs) {
            if (fileDiff.status === 'deleted') {
              const localFilePath = path.join(localBaseAbs, fileDiff.filePath);
              try {
                const fs = await import('fs/promises');
                await fs.unlink(localFilePath);
                if (verbose) {
                  events.emit({ level: 'debug', message: `Deleted ${localFilePath}` });
                }
              } catch {
                // File may already be gone
              }
            }
          }

          // Scaffold the part's configured directories (parity with import): any
          // declared directory that is empty on the remote — so it received no
          // files above — is created with a .gitkeep, matching what a fresh
          // orphan-import produces. Dirs that received content are left untouched.
          await ensurePartDirectories(
            path.resolve(workspaceRoot, drift.assignmentPath),
            partDrift.partPath,
            partDrift.directories,
            verbose,
            events
          );

          const excludePatterns = ['.gitkeep', '**/.gitkeep'];
          const directories = new Set<DirectoryType>();
          for (const fileDiff of partDrift.fileDiffs) {
            const dir = fileDiff.filePath.split('/')[0] as DirectoryType;
            directories.add(dir);
          }

          for (const dir of directories) {
            const stateKey = path.join(localBasePath, dir);
            const dirPath = path.join(localBaseAbs, dir);
            try {
              const hash = await calculateDirectoryHash(dirPath, excludePatterns);
              importedContentState[stateKey] = hash;
            } catch {
              // Directory may not exist
            }
          }
        }

        result.contentPulled++;
        events.emit({ level: 'success', message: `Pulled content changes for "${drift.assignmentName}"` });
      } else if (action === 'keep') {
        events.emit({ level: 'plain', message: '  Keeping local files (will push to Vocareum on next push)' });
      } else {
        result.skipped++;
        events.emit({ level: 'plain', message: '  Skipped' });
      }

      events.emit({ level: 'newline' });
    }
  }

  // ── Write config updates ──────────────────────────────────────────────────
  const hasChanges = newAssignments.length > 0 ||
    newExclusions.length > 0 ||
    assignmentsToRemove.length > 0 ||
    assignmentsToReset.length > 0 ||
    settingsUpdates.size > 0;

  let newPublishHistory: PublishHistory[] | undefined;
  if (Object.keys(importedContentState).length > 0) {
    const commitSha = await getCommitSha(workspaceRoot).catch(() => 'unknown');
    const gitUserName = await getGitUserName(workspaceRoot).catch(() => null);
    const publishedBy = gitUserName ?? 'pull-command';

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
    const assignmentUpdates: Partial<Assignment>[] = [...newAssignments];

    for (const [assignmentPath, updates] of settingsUpdates) {
      const existingAssignment = config.assignments.find(a => a.path === assignmentPath);
      if (!existingAssignment) { continue; }

      const assignmentUpdate: Partial<Assignment> = {
        path: assignmentPath,
      };

      if (updates.assignmentSettings) {
        const mergedSettings = {
          ...existingAssignment.settings,
          ...updates.assignmentSettings,
        };
        clearObservedTopLevelSettings(mergedSettings, OBSERVED_ASSIGNMENT_SETTING_KEYS);
        if (updates.assignmentSettings._unknown_settings === undefined) {
          delete mergedSettings._unknown_settings;
        }
        if (updates.assignmentSettings._observed_settings === undefined) {
          delete mergedSettings._observed_settings;
        }
        assignmentUpdate.settings = mergedSettings;
      }

      const hasPartUpdates =
        (updates.partSettings?.size ?? 0) > 0 || (updates.partRubrics?.size ?? 0) > 0;

      if (hasPartUpdates) {
        assignmentUpdate.parts = existingAssignment.parts.map(part => {
          let nextPart = part;

          const newPartSettings = updates.partSettings?.get(part.path);
          if (newPartSettings) {
            const mergedPartSettings = {
              ...part.settings,
              ...newPartSettings,
            };
            clearObservedTopLevelSettings(mergedPartSettings, OBSERVED_PART_SETTING_KEYS);
            if (newPartSettings._unknown_settings === undefined) {
              delete mergedPartSettings._unknown_settings;
            }
            if (newPartSettings._observed_settings === undefined) {
              delete mergedPartSettings._observed_settings;
            }
            nextPart = { ...nextPart, settings: mergedPartSettings };
          }

          // An absent map entry means "no rubric drift for this part" (leave
          // it untouched); a present-but-empty array means "remote has none",
          // so the key is removed rather than replaced with [].
          const newRubrics = updates.partRubrics?.get(part.path);
          if (newRubrics) {
            if (newRubrics.length > 0) {
              // Remote is authoritative on pull: replace wholesale, never merge.
              // A merge would resurrect criteria deleted in the Vocareum UI.
              nextPart = { ...nextPart, rubrics: newRubrics };
            } else {
              // Delete on a copy rather than destructuring off a rest sibling:
              // .eslintrc.js sets no-unused-vars with argsIgnorePattern only, which
              // does not cover variables, and ignoreRestSiblings defaults to false —
              // `const { rubrics: _x, ...rest }` would fail `npm run lint`. This also
              // matches how the settings branch above clears keys.
              const partWithoutRubrics = { ...nextPart };
              delete partWithoutRubrics.rubrics;
              nextPart = partWithoutRubrics;
            }
          }

          return nextPart;
        });
      }

      assignmentUpdates.push(assignmentUpdate);
    }

    await session.applyConfigUpdate({
      assignments: assignmentUpdates.length > 0 ? assignmentUpdates : undefined,
      excluded_assignments: newExclusions.length > 0 ? newExclusions : undefined,
      remove_assignments: assignmentsToRemove.length > 0 ? assignmentsToRemove : undefined,
      reset_assignment_ids: assignmentsToReset.length > 0 ? assignmentsToReset : undefined,
      publish_history: newPublishHistory,
    });

    events.emit({ level: 'info', message: 'Updated vocareum.yaml' });
  }

  return result;
}
