/**
 * Settings Mapping Utilities
 *
 * Maps Vocareum API responses to local config settings format.
 * Used by both pull (import) and push (post-create sync) operations.
 */

import type { AssignmentSettings, PartSettings, SubmissionFilters } from '../types/config';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../types/api';

/**
 * Map Vocareum assignment API response to config settings
 */
export function mapAssignmentSettings(apiResponse: VocareumAssignmentResponse): NonNullable<AssignmentSettings> {
  const settings: NonNullable<AssignmentSettings> = {};

  // Only include fields that have values
  if (apiResponse.description !== undefined) { settings.description = apiResponse.description; }
  if (apiResponse.nosubmit !== undefined) { settings.nosubmit = apiResponse.nosubmit; }
  if (apiResponse.publish !== undefined) { settings.publish = apiResponse.publish; }
  if (apiResponse.publish_grades !== undefined) { settings.publish_grades = apiResponse.publish_grades; }
  if (apiResponse.auto_submit !== undefined) { settings.auto_submit = apiResponse.auto_submit; }
  if (apiResponse.grading_on_submit !== undefined) { settings.grading_on_submit = apiResponse.grading_on_submit; }
  if (apiResponse.noworkarea !== undefined) { settings.noworkarea = apiResponse.noworkarea; }
  if (apiResponse.exam_mode !== undefined) { settings.exam_mode = apiResponse.exam_mode; }
  if (apiResponse.exam_duration !== undefined) { settings.exam_duration = apiResponse.exam_duration; }
  if (apiResponse.num_attempts !== undefined) { settings.num_attempts = apiResponse.num_attempts; }
  if (apiResponse.show_end_exam_button !== undefined) { settings.show_end_exam_button = apiResponse.show_end_exam_button; }
  if (apiResponse.copy_startercode !== undefined) { settings.copy_startercode = apiResponse.copy_startercode; }
  if (apiResponse.uncompressupload !== undefined) { settings.uncompressupload = apiResponse.uncompressupload; }
  if (apiResponse.lti_on !== undefined) { settings.lti_on = apiResponse.lti_on; }
  if (apiResponse.anonymous_grading !== undefined) { settings.anonymous_grading = apiResponse.anonymous_grading; }
  if (apiResponse.grading_visibility !== undefined) { settings.grading_visibility = apiResponse.grading_visibility; }
  if (apiResponse.send_webhook !== undefined) { settings.send_webhook = apiResponse.send_webhook; }
  if (apiResponse.live_code_comments !== undefined) { settings.live_code_comments = apiResponse.live_code_comments; }

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
export function mapPartSettings(apiResponse: VocareumPartResponse): NonNullable<PartSettings> {
  const settings: NonNullable<PartSettings> = {};

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

  // Late submission settings
  if (apiResponse.late_penalty_percent !== undefined) { settings.late_penalty_percent = apiResponse.late_penalty_percent; }
  if (apiResponse.late_penalty_percent_rule !== undefined) { settings.late_penalty_percent_rule = apiResponse.late_penalty_percent_rule; }
  if (apiResponse.deadlinedate !== undefined) { settings.deadlinedate = apiResponse.deadlinedate; }

  // Lab settings
  if (apiResponse.endlab !== undefined) { settings.endlab = apiResponse.endlab; }
  if (apiResponse.labtype !== undefined) { settings.labtype = apiResponse.labtype; }
  if (apiResponse.container_image !== undefined) { settings.container_image = apiResponse.container_image; }
  if (apiResponse.number_of_submissions !== undefined) { settings.number_of_submissions = apiResponse.number_of_submissions; }
  if (apiResponse.lab_interface !== undefined) { settings.lab_interface = apiResponse.lab_interface; }

  // Other settings - coerce databricks_maxusers to number (API returns string)
  if (apiResponse.databricks_maxusers !== undefined) {
    const parsed = typeof apiResponse.databricks_maxusers === 'string'
      ? parseInt(apiResponse.databricks_maxusers, 10)
      : apiResponse.databricks_maxusers;
    if (!isNaN(parsed)) { settings.databricks_maxusers = parsed; }
  }
  if (apiResponse.tags !== undefined) { settings.tags = apiResponse.tags; }

  return settings;
}
