/**
 * Configuration Types for vocareum.yaml
 *
 * CRITICAL: All IDs are strings, not numbers!
 * This matches the Vocareum API which returns all IDs as strings.
 */

import { z } from 'zod';

/**
 * Directory types for content upload
 *
 * Part-level directories: lib, asnlib, docs, scripts, startercode
 * Course-level directories: course, data, docs, scripts, private, startercode
 */
export type DirectoryType =
  | 'startercode'
  | 'scripts'
  | 'docs'
  | 'data'
  | 'lib'
  | 'asnlib'
  | 'private'
  | 'course';

export const DirectoryTypeSchema = z.enum([
  'startercode',
  'scripts',
  'docs',
  'data',
  'lib',
  'asnlib',
  'private',
  'course'
]);

/**
 * Submission filter patterns for part file submissions.
 * Patterns are passed as-is to rsync on the Vocareum backend.
 *
 * Accepts two formats:
 * 1. Object with include/exclude/list arrays: { include: ["*.py"], exclude: ["*.pyc"] }
 * 2. Simple array (treated as include list): ["*.py", "*.txt"]
 */
const SubmissionFiltersObjectSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  list: z.array(z.string()).optional(),  // Explicit file list
});

export const SubmissionFiltersSchema = z.union([
  SubmissionFiltersObjectSchema,
  z.array(z.string()),  // Simple array format from API
]);

export type SubmissionFilters = z.infer<typeof SubmissionFiltersSchema>;

/** Normalized submission filters in object format */
export type SubmissionFiltersObject = z.infer<typeof SubmissionFiltersObjectSchema>;

/**
 * Normalize submission_filters to object format.
 * Handles both array format (from API) and object format (from config).
 */
export function normalizeSubmissionFilters(
  filters: SubmissionFilters | null | undefined
): SubmissionFiltersObject | undefined {
  if (filters === undefined || filters === null) {return undefined;}

  // If it's an array, treat as include list
  if (Array.isArray(filters)) {
    return filters.length > 0 ? { include: filters } : undefined;
  }

  // Already object format
  return filters;
}

/**
 * Convert null to undefined for API compatibility.
 * The Vocareum API doesn't accept null values, only undefined (omitted).
 */
export function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Lab interface configuration schema
 */
export const LabInterfaceSchema = z.object({
  panels: z.array(z.string()).optional(),
  controls: z.array(z.string()).optional(),
  information: z.array(z.string()).optional(),
  launch_behavior: z.array(z.string()).optional(),
  grades: z.array(z.string()).optional(),
});

export type LabInterface = z.infer<typeof LabInterfaceSchema>;

/**
 * Part settings for Vocareum configuration
 *
 * All fields confirmed working via API (Feb 2026).
 * Note: Many fields use .nullish() because API may return null values.
 */
export const PartSettingsSchema = z
  .object({
    /** Include/exclude patterns for student submissions */
    submission_filters: SubmissionFiltersSchema.nullish(),
    /** Enable cloud labs for this part (requires org permission) */
    cloud_labs: z.boolean().nullish(),
    /** Enable instant AWS access for this part (requires org permission) */
    instant_aws_access: z.boolean().nullish(),
    /** Lab session length in minutes (e.g. "60" for 1 hour) */
    session_length: z.string().nullish(),
    /** Monthly dollar budget for cloud resources */
    monthly_dollar: z.string().nullish(),
    /** Monthly time budget for cloud resources (minutes) */
    monthly_time: z.string().nullish(),
    /** Total time budget for cloud resources (minutes) */
    total_time: z.string().nullish(),
    /** Total dollar budget for cloud resources */
    total_dollar: z.string().nullish(),
    /** Late submission penalty percentage (0-100) */
    late_penalty_percent: z.number().nullish(),
    /** How late penalty is applied: "max score" or "student score" */
    late_penalty_percent_rule: z.enum(['max score', 'student score']).nullish(),
    /** Part submission deadline (ISO 8601 date string) */
    deadlinedate: z.string().nullish(),
    /** Behavior on end lab: "stop" or "terminate" */
    endlab: z.enum(['stop', 'terminate']).nullish(),
    /** Lab type name (e.g., "Visual Studio Code", "JupyterLab") */
    labtype: z.string().nullish(),
    /** Container image name (must be valid for the labtype) */
    container_image: z.string().nullish(),
    /** Maximum number of submissions allowed */
    number_of_submissions: z.number().nullish(),
    /** Lab interface configuration */
    lab_interface: LabInterfaceSchema.nullish(),
    /** Maximum users for Databricks labs */
    databricks_maxusers: z.number().nullish(),
    /** Tags for the part */
    tags: z.array(z.string()).nullish(),
  })
  .optional();

export type PartSettings = z.infer<typeof PartSettingsSchema>;

/**
 * Part configuration
 * CRITICAL: part_id is string | null, never a number
 */
export const PartSchema = z.object({
  part_id: z.string().nullable(),
  path: z.string(),
  name: z.string().optional(),
  directories: z.array(DirectoryTypeSchema).optional(),
  settings: PartSettingsSchema,
});

export type Part = z.infer<typeof PartSchema>;

/**
 * Assignment settings for Vocareum configuration
 *
 * Confirmed working fields (Feb 2026 API probes):
 * - description, nosubmit, auto_submit, grading_on_submit
 * - publish, publish_grades, noworkarea, exam_mode, exam_duration, num_attempts
 * - show_end_exam_button, copy_startercode, uncompressupload, lti_on
 * - anonymous_grading, grading_visibility, send_webhook, live_code_comments
 *
 * Fields that DO NOT work via API (return "No valid parameters"):
 * - points, due_date
 * These must be set manually in Vocareum UI.
 *
 * Note: Many fields use .nullish() because API may return null values.
 */
export const AssignmentSettingsSchema = z
  .object({
    description: z.string().nullish(),
    /** Disable student submissions for this assignment */
    nosubmit: z.boolean().nullish(),
    /** Publish the assignment to students */
    publish: z.boolean().nullish(),
    /** Publish grades setting (string value) */
    publish_grades: z.string().nullish(),
    /** Enable automatic submission */
    auto_submit: z.boolean().nullish(),
    /** Grade immediately on submit */
    grading_on_submit: z.boolean().nullish(),
    /** Disable work area for students */
    noworkarea: z.boolean().nullish(),
    /** Exam mode: timed, scheduled, or timed_scheduled */
    exam_mode: z.enum(['timed', 'scheduled', 'timed_scheduled']).nullish(),
    /** Exam duration in minutes */
    exam_duration: z.number().nullish(),
    /** Number of attempts allowed */
    num_attempts: z.number().nullish(),
    /** Show end exam button to students */
    show_end_exam_button: z.boolean().nullish(),
    /** Copy starter code to student workspace on start */
    copy_startercode: z.boolean().nullish(),
    /** Uncompress uploaded files */
    uncompressupload: z.boolean().nullish(),
    /** Enable LTI integration */
    lti_on: z.boolean().nullish(),
    /** Enable anonymous grading */
    anonymous_grading: z.boolean().nullish(),
    /** Grading visibility: all or assigned */
    grading_visibility: z.enum(['all', 'assigned']).nullish(),
    /** Send webhook on events */
    send_webhook: z.boolean().nullish(),
    /** Enable live code comments */
    live_code_comments: z.boolean().nullish(),
  })
  .optional();

export type AssignmentSettings = z.infer<typeof AssignmentSettingsSchema>;

/**
 * Assignment configuration
 * CRITICAL: assignment_id is string | null, never a number
 */
export const AssignmentSchema = z.object({
  assignment_id: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  create_from_template: z.boolean().optional().default(false),
  /** Optional template assignment ID override used when creating this assignment */
  template_assignment_id: z.string().optional(),
  /** Optional name to search for in Vocareum when assignment_id is null.
   *  Used to prevent duplicate creation in CI/CD environments. */
  assignment_name_for_lookup: z.string().optional(),
  settings: AssignmentSettingsSchema,
  parts: z.array(PartSchema),
});

export type Assignment = z.infer<typeof AssignmentSchema>;

/**
 * Course settings schema that can be updated via API
 */
export const CourseSettingsConfigSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
}).optional();

/**
 * Named template configuration for assignment creation.
 * Templates can exist in any course within the same organization.
 */
export const TemplateConfigSchema = z.object({
  /** Assignment ID of the template */
  id: z.string(),
  /** Human-readable name for template selection */
  name: z.string(),
  /** Course ID where this template assignment exists */
  course_id: z.string(),
});

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;

/**
 * Vocareum connection configuration
 * CRITICAL: All IDs are strings
 */
export const VocareumConfigSchema = z.object({
  org_id: z.string(),
  course_id: z.string(),
  /** @deprecated Use `templates` array instead for named templates */
  template_assignment_id: z.string().optional(),
  /** @deprecated Use `templates` array instead for named templates */
  template_assignment_ids: z.array(z.string()).optional().default([]),
  /** Named templates for assignment creation (preferred over template_assignment_id/ids) */
  templates: z.array(TemplateConfigSchema).optional().default([]),
  api_base_url: z.string().optional().default('https://api.vocareum.com'),
  /** Optional course settings to sync */
  course_settings: CourseSettingsConfigSchema,
  /** Assignment IDs to exclude from orphan detection (hidden from pull scans) */
  excluded_assignments: z.array(z.string()).optional().default([]),
});

export type VocareumConfig = z.infer<typeof VocareumConfigSchema>;

/**
 * Created entity record for publish history (YAML format)
 */
export const HistoryCreatedEntitySchema = z.object({
  assignment: z.string(),
  parts: z.array(z.string()),
});

export type HistoryCreatedEntity = z.infer<typeof HistoryCreatedEntitySchema>;

/**
 * Updated entity record for publish history (YAML format)
 */
export const HistoryUpdatedEntitySchema = z.object({
  assignment: z.string(),
  parts: z.array(z.string()),
});

export type HistoryUpdatedEntity = z.infer<typeof HistoryUpdatedEntitySchema>;

/**
 * Failed entity record for publish history (YAML format)
 */
export const HistoryFailedEntitySchema = z.object({
  type: z.enum(['assignment', 'part', 'file']),
  id: z.string(),
  error: z.string(),
});

export type HistoryFailedEntity = z.infer<typeof HistoryFailedEntitySchema>;

/**
 * Detailed settings change record for publish history
 */
export const HistorySettingChangeSchema = z.object({
  scope: z.enum(['assignment', 'part']),
  assignment_id: z.string(),
  assignment_name: z.string(),
  part_id: z.string().optional(),
  part_name: z.string().optional(),
  field: z.string(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
});

export type HistorySettingChange = z.infer<typeof HistorySettingChangeSchema>;

/**
 * Detailed file size change record for publish history
 */
export const HistoryFileChangeSchema = z.object({
  path: z.string(),
  part_id: z.string(),
  directory: DirectoryTypeSchema,
  previous_size: z.number(),
  current_size: z.number(),
  delta: z.number(),
});

export type HistoryFileChange = z.infer<typeof HistoryFileChangeSchema>;

/**
 * Detailed change summary for a publish run
 */
export const HistoryChangesSchema = z.object({
  settings: z.array(HistorySettingChangeSchema).optional(),
  files: z.array(HistoryFileChangeSchema).optional(),
});

export type HistoryChanges = z.infer<typeof HistoryChangesSchema>;

/**
 * Publish history entry
 */
export const PublishHistorySchema = z.object({
  timestamp: z.string(),
  commit_sha: z.string(),
  published_by: z.string(),
  status: z.enum(['success', 'failed']).optional().default('success'),
  content_state: z.record(z.string(), z.string()),
  file_size_state: z.record(z.string(), z.number()).optional(),
  changes: HistoryChangesSchema.optional(),
  created: z.array(HistoryCreatedEntitySchema).optional(),
  updated: z.array(HistoryUpdatedEntitySchema).optional(),
  failed: z.array(HistoryFailedEntitySchema).optional(),
});

export type PublishHistory = z.infer<typeof PublishHistorySchema>;

/**
 * Publish options configuration
 */
export const PublishOptionsSchema = z
  .object({
    on_missing_id: z.enum(['skip', 'abort']).optional().default('skip'),
    auto_commit: z.boolean().optional().default(false),
    abort_on_error: z.boolean().optional().default(false),
    sync_deletes: z.boolean().optional().default(false),
    exclude_patterns: z.array(z.string()).optional().default([]),
  })
  .optional();

export type PublishOptions = z.infer<typeof PublishOptionsSchema>;

/**
 * Main configuration schema for vocareum.yaml
 */
export const ConfigSchema = z.object({
  version: z.string(),
  vocareum: VocareumConfigSchema,
  assignments: z.array(AssignmentSchema),
  publish_options: PublishOptionsSchema,
  publish_history: z.array(PublishHistorySchema).optional().default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Configuration updates for partial updates
 */
export interface ConfigUpdates {
  assignments?: Partial<Assignment>[];
  publish_history?: PublishHistory[];
  publish_options?: Partial<PublishOptions>;
  excluded_assignments?: string[];
  /** Assignment paths to remove from config */
  remove_assignments?: string[];
  /** Assignment paths to reset IDs (clear assignment_id and part_ids) */
  reset_assignment_ids?: string[];
}
