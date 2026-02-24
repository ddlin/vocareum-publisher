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
  points?: string;
  published?: string; // "0" or "1"
  deleted: string; // "0" or "1"
  // Additional settings that may be returned
  nosubmit?: boolean;
  publish?: boolean;
  publish_grades?: string;
  auto_submit?: boolean;
  grading_on_submit?: boolean;
  noworkarea?: boolean;
  exam_mode?: 'timed' | 'scheduled' | 'timed_scheduled';
  exam_duration?: number;
  num_attempts?: number;
  show_end_exam_button?: boolean;
  copy_startercode?: boolean;
  uncompressupload?: boolean;
  lti_on?: boolean;
  anonymous_grading?: boolean;
  grading_visibility?: 'all' | 'assigned';
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
  // Submission settings - API may return array or object format
  submission_filters?: {
    include?: string[];
    exclude?: string[];
    list?: string[];
  } | string[];
  // Late submission settings
  late_penalty_percent?: number;
  late_penalty_percent_rule?: 'max score' | 'student score';
  deadlinedate?: string;
  // Lab settings
  endlab?: 'stop' | 'terminate';
  labtype?: string;
  container_image?: string;
  number_of_submissions?: number;
  lab_interface?: {
    panels?: string[];
    controls?: string[];
    information?: string[];
    launch_behavior?: string[];
    grades?: string[];
  };
  // Other settings
  databricks_maxusers?: number;
  tags?: Record<string, string>;  // API returns object like {"average_lab_time": "300"}
}

/**
 * Parts list API response
 */
export interface PartsListResponse {
  status: 'success';
  parts?: VocareumPartResponse[];
  total_records?: number;
}

/**
 * Assignments list API response
 */
export interface AssignmentsListResponse {
  status: 'success';
  assignments: VocareumAssignmentResponse[];
  total_records: number;
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
 * Confirmed working fields (Feb 2026 live probes):
 * - name, description, nosubmit, auto_submit, grading_on_submit
 * - publish, publish_grades, noworkarea, exam_mode, exam_duration, num_attempts
 * - show_end_exam_button, copy_startercode, uncompressupload, lti_on
 * - anonymous_grading, grading_visibility, send_webhook, live_code_comments
 *
 * Fields that DO NOT work (return "No valid parameters to update the assignment"):
 * - points, due_date, gradespublished
 */
export interface ApiAssignmentSettings {
  name?: string;
  description?: string;
  nosubmit?: boolean;
  publish?: boolean;
  publish_grades?: string;
  auto_submit?: boolean;
  grading_on_submit?: boolean;
  noworkarea?: boolean;
  exam_mode?: 'timed' | 'scheduled' | 'timed_scheduled';
  exam_duration?: number;
  num_attempts?: number;
  show_end_exam_button?: boolean;
  copy_startercode?: boolean;
  uncompressupload?: boolean;
  lti_on?: boolean;
  anonymous_grading?: boolean;
  grading_visibility?: 'all' | 'assigned';
  send_webhook?: boolean;
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
 * All fields confirmed working (Feb 2026 live probes).
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
    list?: string[];  // Explicit file list
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
  // Late submission settings
  late_penalty_percent?: number;  // Penalty percentage (0-100)
  late_penalty_percent_rule?: 'max score' | 'student score';
  deadlinedate?: string;  // Part deadline (ISO 8601)
  // Lab settings
  endlab?: 'stop' | 'terminate';  // Behavior on end lab
  labtype?: string;  // Lab type name (e.g., "Visual Studio Code", "JupyterLab")
  container_image?: string;  // Container image (must match labtype)
  number_of_submissions?: number;  // Max submissions allowed
  lab_interface?: ApiLabInterface;  // Lab interface configuration
  // Optional/advanced settings
  databricks_maxusers?: number;  // Max users for Databricks
  tags?: Record<string, string>;  // Tags object like {"average_lab_time": "300"}
}

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
