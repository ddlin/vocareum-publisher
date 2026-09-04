/**
 * Settings Mapping Utilities
 *
 * Maps Vocareum API responses to local config settings format.
 * Used by both pull (import) and push (post-create sync) operations.
 */

import type { AssignmentSettings, PartSettings, SubmissionFilters } from '../types/config';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../types/api';
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  OBSERVED_ASSIGNMENT_SETTING_KEYS,
  OBSERVED_PART_SETTING_KEYS,
  partitionApiResponse,
} from './known-settings';
import type { UnknownFieldReporter } from './unknown-field-reporter';

/**
 * Coerce a Vocareum string-or-boolean field to a real boolean. Vocareum is
 * inconsistent: some flag fields (e.g. `lti_on`) come back as "1"/"0" strings
 * while others (e.g. `nosubmit`, `auto_submit`) are real booleans.
 */
function coerceBooleanFlag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value === 'boolean') { return value; }
  if (typeof value === 'string') {
    if (value === '1' || value.toLowerCase() === 'true') { return true; }
    if (value === '0' || value.toLowerCase() === 'false') { return false; }
  }
  if (typeof value === 'number') { return value !== 0; }
  return undefined;
}

function normalizeUpperEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  if (typeof value !== 'string') { return undefined; }
  const normalized = value.toUpperCase() as T;
  return allowed.includes(normalized) ? normalized : undefined;
}

function addObservedSetting(
  observed: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (value !== undefined) {
    observed[key] = value;
  }
}

function unionKeys(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>
): ReadonlySet<string> {
  return new Set([...a, ...b]);
}

/**
 * Map Vocareum assignment API response to config settings
 */
export function mapAssignmentSettings(
  apiResponse: VocareumAssignmentResponse,
  reporter?: UnknownFieldReporter,
  resourceId?: string
): NonNullable<AssignmentSettings> {
  if (reporter && resourceId === undefined) {
    throw new Error('mapAssignmentSettings: resourceId is required when reporter is provided');
  }

  const settings: NonNullable<AssignmentSettings> = {};
  const observedSettings: Record<string, unknown> = {};

  // Only include fields that have values
  addObservedSetting(observedSettings, 'description', apiResponse.description);
  addObservedSetting(observedSettings, 'total_points', apiResponse.total_points);
  if (apiResponse.nosubmit !== undefined) { settings.nosubmit = apiResponse.nosubmit; }
  if (apiResponse.publish !== undefined) { settings.publish = apiResponse.publish; }
  const publishGrades = apiResponse.publish_grades ?? apiResponse.gradespublished;
  if (publishGrades !== undefined) {
    const coerced = coerceBooleanFlag(publishGrades);
    if (coerced !== undefined) { settings.publish_grades = coerced; }
  }
  if (apiResponse.auto_submit !== undefined) { settings.auto_submit = apiResponse.auto_submit; }
  if (apiResponse.grading_on_submit !== undefined) { settings.grading_on_submit = apiResponse.grading_on_submit; }
  if (apiResponse.noworkarea !== undefined) { settings.noworkarea = apiResponse.noworkarea; }
  if (apiResponse.exam_mode !== undefined) {
    const normalized = normalizeUpperEnum(apiResponse.exam_mode, ['NO_EXAM', 'SCHEDULED', 'TIMED', 'TIMED_UNRESTRICTED', 'TIMED_SCHEDULED'] as const);
    if (normalized !== undefined) { settings.exam_mode = normalized; }
  }
  if (apiResponse.exam_duration !== undefined) { settings.exam_duration = apiResponse.exam_duration; }
  if (apiResponse.num_attempts !== undefined) { settings.num_attempts = apiResponse.num_attempts; }
  if (apiResponse.show_end_exam_button !== undefined) { settings.show_end_exam_button = apiResponse.show_end_exam_button; }
  addObservedSetting(observedSettings, 'copy_startercode', apiResponse.copy_startercode);
  addObservedSetting(observedSettings, 'uncompressupload', apiResponse.uncompressupload);
  if (apiResponse.lti_on !== undefined) {
    const coerced = coerceBooleanFlag(apiResponse.lti_on);
    if (coerced !== undefined) { settings.lti_on = coerced; }
  }
  if (apiResponse.anonymous_grading !== undefined) { settings.anonymous_grading = apiResponse.anonymous_grading; }
  if (apiResponse.grading_visibility !== undefined) {
    const normalized = normalizeUpperEnum(apiResponse.grading_visibility, ['ALL', 'ASSIGNED'] as const);
    if (normalized !== undefined) { settings.grading_visibility = normalized; }
  }
  addObservedSetting(observedSettings, 'send_webhook', apiResponse.send_webhook);
  if (apiResponse.live_code_comments !== undefined) { settings.live_code_comments = apiResponse.live_code_comments; }
  if (Object.keys(observedSettings).length > 0) {
    settings._observed_settings = observedSettings;
  }

  // Detect unknown fields the API returned but this mapper does not formally
  // handle. Preserves them for round-trip pass-through and notifies the reporter
  // for the end-of-run summary. Cast: partitionApiResponse takes a generic record;
  // VocareumXResponse is structurally compatible but TS can't prove it.
  const { unknownFields } = partitionApiResponse(
    apiResponse as unknown as Record<string, unknown>,
    unionKeys(KNOWN_ASSIGNMENT_SETTING_KEYS, OBSERVED_ASSIGNMENT_SETTING_KEYS),
    NON_SETTING_FIELDS_ASSIGNMENT
  );
  if (Object.keys(unknownFields).length > 0) {
    settings._unknown_settings = unknownFields;
    if (reporter && resourceId !== undefined) {
      for (const [field, value] of Object.entries(unknownFields)) {
        reporter.record('assignment', field, value, resourceId);
      }
    }
  }

  return settings;
}

/**
 * Normalize submission_filters from API to config format
 * API can return string array or object, config expects object
 */
export function normalizeSubmissionFilters(
  filters: VocareumPartResponse['submission_filters']
): SubmissionFilters | undefined {
  if (filters === undefined || filters === null) {
    return undefined;
  }

  // If it's an array of strings, treat as include list
  if (Array.isArray(filters)) {
    if (filters.length > 0) {
      return { include: filters };
    }
    return undefined;
  }

  // If it's an object with the expected shape
  if (typeof filters === 'object') {
    const result: SubmissionFilters = {};
    if (Array.isArray(filters.include)) { result.include = filters.include; }
    if (Array.isArray(filters.exclude)) { result.exclude = filters.exclude; }
    if (Array.isArray(filters.list)) { result.list = filters.list; }
    // Only return if we have at least one property
    if (Object.keys(result).length > 0) {
      return result;
    }
  }

  return undefined;
}

/**
 * Map Vocareum part API response to config settings
 */
export function mapPartSettings(
  apiResponse: VocareumPartResponse,
  reporter?: UnknownFieldReporter,
  resourceId?: string
): NonNullable<PartSettings> {
  if (reporter && resourceId === undefined) {
    throw new Error('mapPartSettings: resourceId is required when reporter is provided');
  }

  const settings: NonNullable<PartSettings> = {};
  const observedSettings: Record<string, unknown> = {};

  // Submission filters - normalize to object format
  const normalizedFilters = normalizeSubmissionFilters(apiResponse.submission_filters);
  if (normalizedFilters !== undefined) {
    settings.submission_filters = normalizedFilters;
  }

  // Cloud/AWS settings
  if (apiResponse.cloud_labs !== undefined) { settings.cloud_labs = apiResponse.cloud_labs; }
  if (apiResponse.instant_aws_access !== undefined) { settings.instant_aws_access = apiResponse.instant_aws_access; }

  // Resource budgets
  if (apiResponse.session_length !== undefined) { settings.session_length = apiResponse.session_length; }
  if (apiResponse.monthly_dollar !== undefined) { settings.monthly_dollar = apiResponse.monthly_dollar; }
  if (apiResponse.monthly_time !== undefined) { settings.monthly_time = apiResponse.monthly_time; }
  if (apiResponse.total_time !== undefined) { settings.total_time = apiResponse.total_time; }
  if (apiResponse.total_dollar !== undefined) { settings.total_dollar = apiResponse.total_dollar; }

  addObservedSetting(observedSettings, 'description', apiResponse.description);
  addObservedSetting(observedSettings, 'max_points', apiResponse.max_points);
  if (apiResponse.late_penalty_percent !== undefined) { settings.late_penalty_percent = apiResponse.late_penalty_percent; }
  if (apiResponse.late_penalty_percent_rule !== undefined) { settings.late_penalty_percent_rule = apiResponse.late_penalty_percent_rule; }
  if (apiResponse.deadlinedate !== undefined) { settings.deadlinedate = apiResponse.deadlinedate; }

  // Lab settings
  if (apiResponse.endlab !== undefined) {
    const coerced = coerceBooleanFlag(apiResponse.endlab);
    if (coerced !== undefined) { settings.endlab = coerced; }
  }
  if (apiResponse.labtype !== undefined) { settings.labtype = apiResponse.labtype; }
  if (apiResponse.container_image !== undefined) { settings.container_image = apiResponse.container_image; }
  if (apiResponse.number_of_submissions !== undefined) { settings.number_of_submissions = apiResponse.number_of_submissions; }
  if (apiResponse.lab_interface !== undefined) {
    if (typeof apiResponse.lab_interface === 'string') {
      settings.lab_interface = [apiResponse.lab_interface];
    } else {
      settings.lab_interface = apiResponse.lab_interface;
    }
  }

  // Other settings - coerce databricks_maxusers to number (API returns string)
  if (apiResponse.databricks_maxusers !== undefined) {
    const parsed = typeof apiResponse.databricks_maxusers === 'string'
      ? parseInt(apiResponse.databricks_maxusers, 10)
      : apiResponse.databricks_maxusers;
    if (!isNaN(parsed)) { settings.databricks_maxusers = parsed; }
  }
  if (apiResponse.tags !== undefined) { settings.tags = apiResponse.tags; }
  if (Object.keys(observedSettings).length > 0) {
    settings._observed_settings = observedSettings;
  }

  // Detect unknown fields the API returned but this mapper does not formally
  // handle. Preserves them for round-trip pass-through and notifies the reporter
  // for the end-of-run summary. Cast: partitionApiResponse takes a generic record;
  // VocareumXResponse is structurally compatible but TS can't prove it.
  const { unknownFields } = partitionApiResponse(
    apiResponse as unknown as Record<string, unknown>,
    unionKeys(KNOWN_PART_SETTING_KEYS, OBSERVED_PART_SETTING_KEYS),
    NON_SETTING_FIELDS_PART
  );
  if (Object.keys(unknownFields).length > 0) {
    settings._unknown_settings = unknownFields;
    if (reporter && resourceId !== undefined) {
      for (const [field, value] of Object.entries(unknownFields)) {
        reporter.record('part', field, value, resourceId);
      }
    }
  }

  return settings;
}
