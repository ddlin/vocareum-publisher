/**
 * Per-scope sets describing which keys in a Vocareum API response
 * count as "known settings" vs "non-settings" (identity, routed elsewhere,
 * intentionally dropped). Used by mappers to detect unknown drift.
 *
 * Course sets are defined but unused at runtime this phase (see spec
 * "Deferred" section); they exist so partition() and tests have hooks.
 */

export const KNOWN_COURSE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
]);

export const NON_SETTING_FIELDS_COURSE: ReadonlySet<string> = new Set([
  'id',
  'org_id',
]);

export const KNOWN_ASSIGNMENT_SETTING_KEYS: ReadonlySet<string> = new Set([
  'description',
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
  'copy_startercode',
  'uncompressupload',
  'lti_on',
  'anonymous_grading',
  'grading_visibility',
  'send_webhook',
  'live_code_comments',
]);

export const NON_SETTING_FIELDS_ASSIGNMENT: ReadonlySet<string> = new Set([
  'id',
  'courseid',
  'name',
  'due_date',
  'points',
  'deleted',
  'published',
  // Server-managed identity / structural / read-only metadata. These are
  // returned by the API but are not instructor-configurable lab settings, so
  // they are dropped (not preserved under _unknown_settings, not pushed back).
  // Classified from a real pull report (v1.0.20).
  'create_method',      // how the resource was created
  'gradespublished',    // read-only status; API rejects it on write
  'groupdisplayorder',  // server-managed ordering
  'groupid',            // grouping identifier
  'masterid',           // reference to the template/master it was copied from
  'num_parts',          // derived count of parts
  'part_ids',           // the assignment's part-ID list (structure, not config)
]);

export const KNOWN_PART_SETTING_KEYS: ReadonlySet<string> = new Set([
  'submission_filters',
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
]);

export const NON_SETTING_FIELDS_PART: ReadonlySet<string> = new Set([
  'id',
  'courseid',
  'assignmentid',
  'name',
  'description',
  'seqnum',
  'deleted',
  'part_url',
  // Server-managed identity metadata (see NON_SETTING_FIELDS_ASSIGNMENT note).
  // Classified from a real pull report (v1.0.20).
  'create_method',  // how the part was created
  'masterid',       // reference to the template/master it was copied from
]);

export interface PartitionResult {
  knownFields: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
}

export function partitionApiResponse(
  response: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  nonSettingFields: ReadonlySet<string>
): PartitionResult {
  const knownFields: Record<string, unknown> = {};
  const unknownFields: Record<string, unknown> = {};
  for (const key of Object.keys(response)) {
    if (nonSettingFields.has(key)) {
      continue;
    }
    if (knownKeys.has(key)) {
      knownFields[key] = response[key];
    } else {
      unknownFields[key] = response[key];
    }
  }
  return { knownFields, unknownFields };
}
