/**
 * Vocareum API Response Types
 *
 * Based on Vocareum API documentation.
 * CRITICAL: All IDs are strings, not numbers!
 * CRITICAL: seqnum is a string that must be parsed for sorting
 */

/**
 * Course response from Vocareum API
 */
export interface VocareumCourseResponse {
  id: string;
  name: string;
  description?: string;
  org_id: string;
}

/**
 * Courses list/get API response
 */
export interface CoursesListResponse {
  status: 'success';
  courses?: VocareumCourseResponse[];
}

/**
 * Assignment response from Vocareum API
 *
 * Includes settings fields that may be returned by getAssignment.
 */
export interface VocareumAssignmentResponse {
  id: string;
  courseid: string;
  name: string;
  description?: string;
  due_date?: string;
  /** DERIVED, not storable: the sum of this assignment's parts' `max_points`, which are
   *  themselves summed from rubric maxscore. An assignment PUT setting it is rejected with
   *  "No valid parameters to update the assignment". Recorded under _observed_settings;
   *  never sent. See docs/vocareum-api-rubrics-findings.md §3. */
  total_points?: string;
  points?: string;
  published?: string; // "0" or "1"
  deleted: string; // "0" or "1"
  gradespublished?: boolean | string;
  // Additional settings that may be returned
  nosubmit?: boolean;
  publish?: boolean;
  publish_grades?: boolean | string;
  auto_submit?: boolean;
  grading_on_submit?: boolean;
  noworkarea?: boolean;
  exam_mode?: 'NO_EXAM' | 'SCHEDULED' | 'TIMED' | 'TIMED_UNRESTRICTED' | 'TIMED_SCHEDULED' | 'no_exam' | 'scheduled' | 'timed' | 'timed_unrestricted' | 'timed_scheduled';
  exam_duration?: number;
  num_attempts?: number;
  show_end_exam_button?: boolean;
  copy_startercode?: boolean;
  uncompressupload?: boolean;
  /** Vocareum returns this as a "1"/"0" string — coerce via mapAssignmentSettings */
  lti_on?: boolean | string;
  anonymous_grading?: boolean;
  grading_visibility?: 'ALL' | 'ASSIGNED' | 'all' | 'assigned';
  send_webhook?: boolean;
  live_code_comments?: boolean;
}

/**
 * Part response from Vocareum API
 *
 * CRITICAL: seqnum is a STRING like "0", "1", "2"
 * Must parse to integer for correct sorting!
 */
export interface VocareumPartResponse {
  id: string;
  courseid: string;
  assignmentid: string;
  name: string;
  description?: string;
  seqnum: string; // Sequence number as string: "0", "1", "2"
  deleted: string; // "0" or "1"
  /** DERIVED, not storable: Vocareum computes this as the sum of the part's rubric
   *  `maxscore` over criteria where `exclude !== true`. A part PUT setting it returns a
   *  successful "Part updated" transaction and changes nothing (VOC-4003). Recorded under
   *  _observed_settings; never sent. See docs/vocareum-api-rubrics-findings.md §3. */
  max_points?: string;
  part_url?: string;
  // Cloud/AWS settings
  cloud_labs?: boolean;
  instant_aws_access?: boolean;
  // Resource budgets
  session_length?: string;
  monthly_dollar?: string;
  monthly_time?: string;
  total_time?: string;
  total_dollar?: string;
  // Submission settings - API may return array/string/object format
  submission_filters?: {
    include?: string[];
    exclude?: string[];
    list?: string[];
  } | string[] | string;
  // Late submission settings
  late_penalty_percent?: number;
  late_penalty_percent_rule?: 'max score' | 'student score';
  deadlinedate?: string;
  // Lab settings
  endlab?: boolean | string;
  labtype?: string;
  container_image?: string;
  number_of_submissions?: number;
  lab_interface?: {
    panels?: string[];
    controls?: string[];
    information?: string[];
    launch_behavior?: string[];
    grades?: string[];
  } | string[] | string;
  // Other settings
  databricks_maxusers?: number;
  tags?: Record<string, string | number | boolean>;  // API returns object like {"average_lab_time": 300}
}

/**
 * Parts list API response
 */
export interface PartsListResponse {
  status: 'success';
  parts?: VocareumPartResponse[];
  total_records?: number | string;
}

/**
 * A single rubric criterion.
 *
 * CRITICAL: every field is a string, including `seqnum` and `maxscore`.
 * `id` is server-assigned and course-scoped — it must not be copied between
 * courses, and is deliberately not persisted to vocareum.yaml.
 */
export interface VocareumRubricResponse {
  id: string;
  name: string;
  seqnum: string;   // ordering, as a string: "1", "2", "10"
  maxscore: string; // per-criterion points, as a string
  exclude?: boolean;
  auto?: boolean;
}

/**
 * Rubrics list API response. Part-scoped: the assignment-level and
 * collection-level variants of this endpoint return `Invalid Request`.
 *
 * NOTE: Vocareum may encode failures in the response body with a 200 status line
 * (see src/api/content.ts:257 for the same pattern). The `status` field is widened
 * to `string` to allow runtime guards to reject non-success responses before treating
 * them as empty results.
 */
export interface RubricsListResponse {
  status: string;
  parent?: { courseid: string; assignmentid: string; partid: string };
  rubrics?: VocareumRubricResponse[];
  total_records?: number | string;
}

/** Body row for POST .../rubrics. `seqnum` is deliberately absent — the API rejects it
 *  (400 "Invalid attribure post rubric request: seqnum") and assigns it by append order. */
export interface RubricCreate {
  name: string;
  maxscore: string;
  auto?: boolean;
  exclude?: boolean;
}

/** Body row for PUT .../rubrics. Partial: sending only `maxscore` preserves `name`.
 *  `seqnum` is absent because PUT accepts and silently ignores it — criterion order is
 *  create-order and cannot be changed. */
export interface RubricUpdate {
  id: string;
  name?: string;
  maxscore?: string;
  auto?: boolean;
  exclude?: boolean;
}

/**
 * Assignments list API response
 */
export interface AssignmentsListResponse {
  status: 'success';
  assignments: VocareumAssignmentResponse[];
  total_records: number | string;
}

/**
 * Assignment copy response
 * Returns new assignment_id and new part_ids with seqnum preserved
 */
export interface AssignmentCopyResponse {
  assignment_id: string;
  parts: Array<{
    part_id: string;
    name: string;
    seqnum: string; // Sequence number for ordering
  }>;
}

/**
 * Course settings for updates
 */
export interface CourseSettings {
  name?: string;
  description?: string;
}

/**
 * Assignment settings for API updates
 *
 * Writable fields from the draft OpenAPI contract.
 *
 * Fields that DO NOT work (return "No valid parameters to update the assignment"):
 * - points, due_date, gradespublished
 */
export interface ApiAssignmentSettings {
  name?: string;
  nosubmit?: boolean;
  publish?: boolean;
  publish_grades?: boolean;
  auto_submit?: boolean;
  grading_on_submit?: boolean;
  noworkarea?: boolean;
  exam_mode?: 'NO_EXAM' | 'SCHEDULED' | 'TIMED' | 'TIMED_UNRESTRICTED' | 'TIMED_SCHEDULED';
  exam_duration?: number;
  num_attempts?: number;
  show_end_exam_button?: boolean;
  lti_on?: boolean;
  anonymous_grading?: boolean;
  grading_visibility?: 'ALL' | 'ASSIGNED';
  live_code_comments?: boolean;
}

/**
 * Lab interface configuration for parts (API shape)
 * Note: Use LabInterface from config.ts for config validation
 */
export interface ApiLabInterface {
  panels?: string[];  // e.g., ["Console", "Html"]
  controls?: string[];  // e.g., ["Reset"]
  information?: string[];  // e.g., ["Assignments"]
  launch_behavior?: string[];
  grades?: string[];
}

/**
 * Part settings for API updates
 *
 * Writable fields from the draft OpenAPI contract plus live probes.
 * name is REQUIRED for most update requests.
 *
 * Fields requiring org permissions:
 * - cloud_labs, instant_aws_access ("Cloud not allowed for the org")
 */
export interface ApiPartSettings {
  name?: string;  // REQUIRED for most updates
  submission_filters?: {
    include?: string[];
    exclude?: string[];
    list?: string[];
  };
  // Cloud/AWS settings (require org permission)
  cloud_labs?: boolean;
  instant_aws_access?: boolean;
  // Resource budgets
  session_length?: string;  // Session length in minutes
  monthly_dollar?: string;  // Monthly dollar budget
  monthly_time?: string;  // Monthly time budget in minutes
  total_time?: string;  // Total time budget in minutes
  total_dollar?: string;  // Total dollar budget
  // Accepted by PUT but often not echoed on GET
  late_penalty_percent?: number;
  late_penalty_percent_rule?: 'max score' | 'student score';
  deadlinedate?: string;
  // Lab settings
  endlab?: boolean;
  labtype?: string;  // Lab type name (e.g., "Visual Studio Code", "JupyterLab")
  container_image?: string;  // Container image (must match labtype)
  number_of_submissions?: number;
  lab_interface?: ApiLabInterface;
  // Optional/advanced settings
  databricks_maxusers?: number;  // Max users for Databricks
  tags?: Record<string, string | number | boolean>;  // Tags object like {"average_lab_time": 300}
}

/**
 * Outgoing payload types for update calls. The base interfaces above describe
 * the known/typed shape; the payload types additionally permit arbitrary unknown
 * keys to be spread in at the top level so callers can pass _unknown_settings
 * keys back through on writes without unsafe casts at the call site. See
 * docs/superpowers/specs/2026-05-21-unknown-settings-passthrough-design.md §5.
 */
export type AssignmentSettingsPayload = ApiAssignmentSettings & Record<string, unknown>;
export type PartSettingsPayload = ApiPartSettings & Record<string, unknown>;

/**
 * File information from Vocareum
 */
export interface FileInfo {
  path: string;
  size: number;
  modifiedAt?: string;
}

/**
 * Map of relative paths to file contents
 */
export interface FileMap {
  [relativePath: string]: Buffer | string;
}

/**
 * Upload result from content operations
 */
export interface UploadResult {
  succeeded: string[];
  failed: Array<{ path: string; error: unknown }>;
  deleted?: string[];
  directoryHash: string;
}

/**
 * Generic API error response
 */
export interface ApiErrorResponse {
  status: 'error';
  message: string;
  code?: string;
  details?: unknown;
}
