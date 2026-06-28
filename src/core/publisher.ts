/**
 * Publisher Module
 *
 * Execute the reconciliation plan by orchestrating API calls.
 */

import type { Config } from '../types/config';
import {
  labInterfaceToWriteObject,
  normalizeSubmissionFilters,
  nullToUndefined,
} from '../types/config';
import type { PartSettings } from '../types/config';
import type { ApiPartSettings, PartSettingsPayload } from '../types/api';
import type { HistorySettingChange } from '../types/config';
import type { PublishResult, PublishOperationOptions } from '../types/state';
import { VocareumClient } from '../api/client';
import { withSession } from './session';
import { planPush, executePush } from './services/push-service';
import { logger } from '../utils/logger';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { NonInteractivePrompter } from './services/context';
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
  shouldSyncPartSettings,
} from '../utils/settings-sync';

/** All keys that must not be overridden by _unknown_settings for assignment payloads.
 *  Includes '_unknown_settings' itself to prevent nested {_unknown_settings: {_unknown_settings: ...}}
 *  from leaking the literal wrapper key into the outgoing API payload. */
export const RESERVED_ASSIGNMENT_KEYS: ReadonlySet<string> = new Set([
  ...KNOWN_ASSIGNMENT_SETTING_KEYS,
  ...OBSERVED_ASSIGNMENT_SETTING_KEYS,
  ...NON_SETTING_FIELDS_ASSIGNMENT,
  '_unknown_settings',
  '_observed_settings',
]);

/** All keys that must not be overridden by _unknown_settings for part payloads.
 *  See RESERVED_ASSIGNMENT_KEYS for the rationale on '_unknown_settings'. */
export const RESERVED_PART_KEYS: ReadonlySet<string> = new Set([
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
export function filterUnknownSettingsForPayload(
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

export function isHttp400(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) { return false; }
  const maybeError = error as { response?: { status?: number }; statusCode?: number };
  return maybeError.response?.status === 400 || maybeError.statusCode === 400;
}

export function sanitizeSubmissionFilters(
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
export function normalizeTags(
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

export function withoutUndefined<T extends Record<string, unknown>>(payload: T): T {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  ) as T;
}

export function collectSettingsState(config: Config): Record<string, unknown> {
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

export function settingsEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === undefined || a === null) { return b === undefined || b === null; }
  if (b === undefined || b === null) { return false; }
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function hasSettingValue(value: unknown): boolean {
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
 * Internal: executes a push without prompting; confirmation belongs to the CLI wrapper.
 *
 * Compatibility shim — builds a PushContext from legacy parameters, opens one
 * withSession, calls planPush → executePush (no confirm). Callers that need
 * interactive confirmation should use planPush + executePush directly.
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
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  const ctx = {
    persistedConfig: config,
    effectiveConfig: config,
    configPath,
    workspaceRoot,
    events: new LoggerEventSink(),
    prompter: new NonInteractivePrompter(),
    client,
  };

  const req = {
    dryRun: options.dryRun,
    nonInteractive: true, // shim is always non-interactive
    autoCommit: options.autoCommit,
    syncDeletes: options.syncDeletes,
    onMissingId: options.onMissingId,
    abortOnError: options.abortOnError,
    assignment: options.assignment,
    part: options.part,
    forceAll: options.forceAll,
    verbose: options.verbose,
  };

  return withSession(configPath, async (session) => {
    const plan = await planPush(ctx, req);
    return executePush(session, ctx, req, plan, reporter);
  });
}
