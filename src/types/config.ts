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
 */
export const SubmissionFiltersSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  list: z.array(z.string()).optional(),  // Explicit file list
});

export type SubmissionFilters = z.infer<typeof SubmissionFiltersSchema>;

/**
 * Part settings for Vocareum configuration
 */
export const PartSettingsSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    /** Include/exclude patterns for student submissions (passed to rsync) */
    submission_filters: SubmissionFiltersSchema.optional(),
    /** Enable cloud labs for this part */
    cloud_labs: z.boolean().optional(),
    /** Enable instant AWS access for this part */
    instant_aws_access: z.boolean().optional(),
    /** Lab session length (e.g. "3600" for 1 hour) */
    session_length: z.string().optional(),
    /** Monthly dollar budget for cloud resources */
    monthly_dollar: z.string().optional(),
    /** Monthly time budget for cloud resources */
    monthly_time: z.string().optional(),
    /** Total time budget for cloud resources */
    total_time: z.string().optional(),
    /** Total dollar budget for cloud resources */
    total_dollar: z.string().optional(),
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
 *
 * Fields that DO NOT work via API (return "No valid parameters"):
 * - published, points, due_date
 * These must be set manually in Vocareum UI.
 */
export const AssignmentSettingsSchema = z
  .object({
    description: z.string().optional(),
    /** Disable student submissions for this assignment */
    nosubmit: z.boolean().optional(),
    /** Enable automatic submission */
    auto_submit: z.boolean().optional(),
    /** Grade immediately on submit */
    grading_on_submit: z.boolean().optional(),
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
 * Vocareum connection configuration
 * CRITICAL: All IDs are strings
 */
export const VocareumConfigSchema = z.object({
  org_id: z.string(),
  course_id: z.string(),
  template_assignment_id: z.string().optional(),
  api_base_url: z.string().optional().default('https://api.vocareum.com'),
  /** Optional course settings to sync */
  course_settings: CourseSettingsConfigSchema,
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
 * Publish history entry
 */
export const PublishHistorySchema = z.object({
  timestamp: z.string(),
  commit_sha: z.string(),
  published_by: z.string(),
  status: z.enum(['success', 'failed']).optional().default('success'),
  content_state: z.record(z.string(), z.string()),
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
}
