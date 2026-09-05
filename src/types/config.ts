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
 * Synced directories: startercode, scripts, docs, data, lib, asnlib, private
 *
 * NOT synced: 'course' - Contains course-wide shared files that are symlinked
 * across all assignments. Syncing would cause infinite update loops since changes
 * to course files affect all assignments simultaneously.
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
 * Vocareum has two workspace architectures with different directory sets:
 *
 * Elite: Vocareum Standard, Basic, Vocareum Elite, Jupyter Elite
 * Container: Vocareum Notebook, Databricks, VSCode, JupyterLab
 *
 * 'course' is excluded from both — it's shared across all assignments
 * and syncing it would cause infinite update loops.
 */
export const ELITE_DIRECTORIES: DirectoryType[] = [
  'asnlib',
  'docs',
  'scripts',
  'startercode',
  'lib',
];

export const CONTAINER_DIRECTORIES: DirectoryType[] = [
  'docs',
  'scripts',
  'startercode',
  'private',
  'data',
];

/** Lab types that use the Elite architecture */
const ELITE_LABTYPES = [
  'vocareum standard',
  'basic',
  'vocareum elite',
  'jupyter elite',
];

/**
 * Detect workspace architecture from labtype string.
 * Returns 'elite' or 'container' (default).
 */
export function detectArchitecture(labtype: string | null | undefined): 'elite' | 'container' {
  if (!labtype) { return 'container'; }
  return ELITE_LABTYPES.includes(labtype.toLowerCase()) ? 'elite' : 'container';
}

/**
 * Resolve a part's workspace architecture from config, falling back to labtype.
 *
 * An explicit `vocareum.architecture` wins — an operator who set it meant it.
 * Otherwise derive it from the labtype, which is what the part actually runs on.
 *
 * Both the pull and push paths must use this. getDownloadPlan had the fallback
 * inline while push read the config field directly, so on any config without an
 * explicit architecture (which is all of them in practice) push treated Elite
 * courses as Container and asked for /voc paths that cannot exist there.
 */
export function resolveArchitecture(
  configArchitecture: 'elite' | 'container' | undefined,
  labtype: string | null | undefined,
): 'elite' | 'container' | undefined {
  if (configArchitecture !== undefined) { return configArchitecture; }
  if (labtype === undefined || labtype === null || labtype === '') { return undefined; }
  return detectArchitecture(labtype);
}

/**
 * Get the correct directory set for a given labtype.
 * Use this instead of hardcoded directory lists.
 */
export function getDirectoriesForLabtype(labtype: string | null | undefined): DirectoryType[] {
  return detectArchitecture(labtype) === 'elite' ? ELITE_DIRECTORIES : CONTAINER_DIRECTORIES;
}

/**
 * Default directories used when architecture cannot be determined.
 * This is the union of both architectures (minus 'course') for backward
 * compatibility with configs that don't specify labtype.
 */
export const DEFAULT_PART_DIRECTORIES: DirectoryType[] = [
  'startercode',
  'scripts',
  'docs',
  'data',
  'private',
  'lib',
  'asnlib',
];

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
  z.string(),
]);

export type SubmissionFilters = z.infer<typeof SubmissionFiltersSchema>;

/** Normalized submission filters in object format */
export type SubmissionFiltersObject = z.infer<typeof SubmissionFiltersObjectSchema>;

/** Tag values returned by Vocareum may be strings or scalar metadata values. */
export const TagValueSchema = z.union([z.string(), z.number(), z.boolean()]);

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
  if (typeof filters === 'string') {
    return filters.length > 0 ? { include: [filters] } : undefined;
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

export const LabInterfaceConfigSchema = z.union([
  LabInterfaceSchema,
  z.array(z.string()),
]);

export type LabInterfaceConfig = z.infer<typeof LabInterfaceConfigSchema>;

export function labInterfaceToWriteObject(
  labInterface: LabInterfaceConfig | null | undefined
): LabInterface | undefined {
  if (labInterface === undefined || labInterface === null) { return undefined; }
  if (Array.isArray(labInterface)) {
    return labInterface.length > 0 ? { panels: labInterface } : undefined;
  }
  return labInterface;
}

const ExamModeSchema = z.union([
  z.enum(['NO_EXAM', 'SCHEDULED', 'TIMED', 'TIMED_UNRESTRICTED', 'TIMED_SCHEDULED']),
  z.enum(['no_exam', 'scheduled', 'timed', 'timed_unrestricted', 'timed_scheduled'])
    .transform((value) => value.toUpperCase() as 'NO_EXAM' | 'SCHEDULED' | 'TIMED' | 'TIMED_UNRESTRICTED' | 'TIMED_SCHEDULED'),
]);

const GradingVisibilitySchema = z.union([
  z.enum(['ALL', 'ASSIGNED']),
  z.enum(['all', 'assigned']).transform((value) => value.toUpperCase() as 'ALL' | 'ASSIGNED'),
]);

/**
 * Remote fields observed from Vocareum but not written by vocgit push.
 * Pull/import may update this bucket to document server state without turning
 * those fields into local write intent.
 */
export const ObservedSettingsSchema = z.record(z.string(), z.unknown());

export type ObservedSettings = z.infer<typeof ObservedSettingsSchema>;

/**
 * Part settings for Vocareum configuration
 *
 * Writable and observed fields accepted in vocareum.yaml.
 * Pull/import stores read-only or create-only values under _observed_settings.
 * An observed key that is ALSO declared below (e.g. `description`) additionally
 * survives at top level in an older config, and pull migrates it into the bucket.
 * An observed key that is NOT declared below (e.g. `max_points`) is stripped by this
 * schema before any code sees it, so it can only ever exist inside _observed_settings.
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
    /** Accepted by PUT but often not echoed on GET */
    late_penalty_percent: z.number().nullish(),
    /** Accepted by PUT but often not echoed on GET */
    late_penalty_percent_rule: z.enum(['max score', 'student score']).nullish(),
    /** Accepted by PUT but often not echoed on GET */
    deadlinedate: z.string().nullish(),
    /** Whether the lab should end automatically when limits/deadlines require it */
    endlab: z.boolean().nullish(),
    /** Lab type name (e.g., "Visual Studio Code", "JupyterLab") */
    labtype: z.string().nullish(),
    /** Container image name (must be valid for the labtype) */
    container_image: z.string().nullish(),
    /** Accepted by PUT but often not echoed on GET */
    number_of_submissions: z.number().nullish(),
    /** Lab interface configuration */
    lab_interface: LabInterfaceConfigSchema.nullish(),
    /** Maximum users for Databricks labs (API returns string, coerce to number) */
    databricks_maxusers: z.coerce.number().nullish(),
    /** Tags for the part (API returns object, but older configs may have empty array) */
    tags: z.union([z.array(z.string()), z.record(z.string(), TagValueSchema)]).nullish(),
    /** Pass-through bucket for settings vocgit does not formally understand.
     *  Populated by mapPartSettings from unknown API response fields; spread
     *  back into outgoing API payloads on publish. See spec
     *  docs/superpowers/specs/2026-05-21-unknown-settings-passthrough-design.md
     */
    _unknown_settings: z.record(z.string(), z.unknown()).optional(),
    /** Fields observed from Vocareum but intentionally not written by push. */
    _observed_settings: ObservedSettingsSchema.optional(),
  })
  .optional();

export type PartSettings = z.infer<typeof PartSettingsSchema>;

/**
 * A single rubric criterion, as stored in vocareum.yaml.
 *
 * CRITICAL: seqnum and maxscore are strings — they are strings in the API and
 * are never arithmetic here.
 *
 * The server-assigned rubric `id` is deliberately absent: it is course-scoped
 * and must not travel between courses during a migration. See
 * docs/superpowers/plans/2026-09-04-rubrics-pull-support.md.
 */
export const RubricSchema = z.object({
  /** Criterion text shown to graders */
  name: z.string(),
  /** Ordering within the part; sort with parseInt */
  seqnum: z.string(),
  /** Points this criterion contributes */
  maxscore: z.string(),
  /** Whether the criterion is auto-graded */
  auto: z.boolean().optional(),
  /** Whether the criterion is excluded from the total */
  exclude: z.boolean().optional(),
});
// Deliberately NOT .passthrough(), unlike PartSchema. Zod's default is strip, so a
// hand-added key — `id` above all — is dropped at parse time. With passthrough it would
// survive: nothing writes it, but nothing removes it either, and rubricsEqual compares
// only the five known fields, so pull would never self-heal it. That is exactly the
// reserved-name case AGENTS.md "Feature Development Discipline" item 2 asks to defend.
// There is no forward-compatibility cost: this shape is ours, not the server's.

export type Rubric = z.infer<typeof RubricSchema>;

/**
 * Part configuration
 * CRITICAL: part_id is string | null, never a number
 */
export const PartSchema = z.object({
  part_id: z.string().nullable(),
  path: z.string(),
  name: z.string().optional(),
  /** Override settings sync for this part. Defaults to assignment/global setting. */
  sync_settings: z.boolean().optional(),
  directories: z.array(DirectoryTypeSchema).optional(),
  /** Grading rubric criteria, seqnum-ordered. `pull` records them; `push` creates
   *  and updates criteria to match (never deletes — a remote criterion with no
   *  local counterpart is reported as an orphan, not removed). Disabled by
   *  `sync_rubrics: false` or `sync_settings: false`. */
  rubrics: z.array(RubricSchema).optional(),
  settings: PartSettingsSchema,
}).passthrough();

export type Part = z.infer<typeof PartSchema>;

/**
 * Assignment settings for Vocareum configuration
 *
 * Writable fields based on the draft OpenAPI contract plus live probes:
 * - nosubmit, auto_submit, grading_on_submit
 * - publish, publish_grades, noworkarea, exam_mode, exam_duration, num_attempts
 * - show_end_exam_button, lti_on, anonymous_grading, grading_visibility
 * - live_code_comments
 *
 * Observed/create-only fields are accepted for compatibility but should live
 * under _observed_settings after pull/import:
 * - description, copy_startercode, uncompressupload, send_webhook
 *
 * Fields that DO NOT work via API:
 * - points, due_date
 * These must be set manually in Vocareum UI.
 *
 * Note: Many fields use .nullish() because API may return null values.
 */
export const AssignmentSettingsSchema = z
  .object({
    /** Observed on read; not sent during assignment update */
    description: z.string().nullish(),
    /** Disable student submissions for this assignment */
    nosubmit: z.boolean().nullish(),
    /** Publish the assignment to students */
    publish: z.boolean().nullish(),
    /** Publish grades setting */
    publish_grades: z.boolean().nullish(),
    /** Enable automatic submission */
    auto_submit: z.boolean().nullish(),
    /** Grade immediately on submit */
    grading_on_submit: z.boolean().nullish(),
    /** Disable work area for students */
    noworkarea: z.boolean().nullish(),
    /** Exam mode: NO_EXAM, SCHEDULED, TIMED, TIMED_UNRESTRICTED, or TIMED_SCHEDULED */
    exam_mode: ExamModeSchema.nullish(),
    /** Exam duration in minutes */
    exam_duration: z.number().nullish(),
    /** Number of attempts allowed */
    num_attempts: z.number().nullish(),
    /** Show end exam button to students */
    show_end_exam_button: z.boolean().nullish(),
    /** Create/copy-only; not sent during assignment update */
    copy_startercode: z.boolean().nullish(),
    /** Create/copy-only; not sent during assignment update */
    uncompressupload: z.boolean().nullish(),
    /** Enable LTI integration */
    lti_on: z.boolean().nullish(),
    /** Enable anonymous grading */
    anonymous_grading: z.boolean().nullish(),
    /** Grading visibility: ALL or ASSIGNED */
    grading_visibility: GradingVisibilitySchema.nullish(),
    /** Create/copy-only; not sent during assignment update */
    send_webhook: z.boolean().nullish(),
    /** Enable live code comments */
    live_code_comments: z.boolean().nullish(),
    /** Pass-through bucket for settings vocgit does not formally understand.
     *  Populated by mapAssignmentSettings from unknown API response fields;
     *  spread back into outgoing API payloads on publish. See spec
     *  docs/superpowers/specs/2026-05-21-unknown-settings-passthrough-design.md
     */
    _unknown_settings: z.record(z.string(), z.unknown()).optional(),
    /** Fields observed from Vocareum but intentionally not written by push. */
    _observed_settings: ObservedSettingsSchema.optional(),
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
  /** Override settings sync for this assignment and its parts. Defaults to publish_options.sync_settings. */
  sync_settings: z.boolean().optional(),
  settings: AssignmentSettingsSchema,
  parts: z.array(PartSchema),
}).passthrough();

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
 * Proactive client throttle. Tightly bounded; `.strict()` so a typo'd key
 * (e.g. camelCase) is rejected rather than silently ignored.
 */
export const ThrottleConfigSchema = z
  .object({
    max_concurrency: z.number().int().min(1).max(5).optional(),
    min_interval_ms: z.number().int().min(0).max(60000).optional(),
    jitter: z.boolean().optional(),
  })
  .strict()
  .optional();

export type ThrottleConfig = z.infer<typeof ThrottleConfigSchema>;

/**
 * Vocareum connection configuration
 * CRITICAL: All IDs are strings
 */
export const VocareumConfigSchema = z.object({
  org_id: z.string(),
  course_id: z.string(),
  /** Course workspace architecture: 'elite' or 'container'. Determines which directories are synced. */
  architecture: z.enum(['elite', 'container']).optional(),
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
  /** Proactive request throttle for the Vocareum API client. */
  throttle: ThrottleConfigSchema,
}).passthrough();

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
 * Rubric changes applied to one part during a push. A rubric write changes
 * student-visible points — `max_points` is derived from criteria — so it gets
 * its own audit record rather than folding into `settings` or `files`: which
 * criteria were created and updated by name, the point delta, and (when the
 * part was refused) why nothing was written.
 */
export const HistoryRubricChangeSchema = z.object({
  assignment_id: z.string(),
  part_id: z.string(),
  created: z.array(z.string()).optional(),
  updated: z.array(z.string()).optional(),
  points_before: z.number().optional(),
  points_after: z.number().optional(),
  /** Set when the part was refused: 'duplicate-names' | 'orphans-held' | 'no-scope'. */
  held: z.string().optional(),
});

export type HistoryRubricChange = z.infer<typeof HistoryRubricChangeSchema>;

/**
 * Detailed change summary for a publish run
 */
export const HistoryChangesSchema = z.object({
  settings: z.array(HistorySettingChangeSchema).optional(),
  files: z.array(HistoryFileChangeSchema).optional(),
  rubrics: z.array(HistoryRubricChangeSchema).optional(),
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
  settings_state: z.record(z.string(), z.unknown()).optional(),
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
    sync_settings: z.boolean().optional().default(true),
    /** Fetch each part's rubrics during pull. Adds one API call per visited
     *  part; set false on very large courses or tokens without the optional
     *  rubrics scope. */
    sync_rubrics: z.boolean().optional().default(true),
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
}).passthrough();

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
