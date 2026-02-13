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
  cloud_labs?: boolean;
  instant_aws_access?: boolean;
  session_length?: string;
  monthly_dollar?: string;
  monthly_time?: string;
  total_time?: string;
  total_dollar?: string;
  submission_filters?: {
    include?: string[];
    exclude?: string[];
    list?: string[];
  };
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
 *
 * Fields that DO NOT work (return "No valid parameters to update the assignment"):
 * - published, points, due_date, gradespublished
 */
export interface ApiAssignmentSettings {
  name?: string;
  description?: string;
  nosubmit?: boolean;
  auto_submit?: boolean;
  grading_on_submit?: boolean;
}

/**
 * Part settings for API updates
 *
 * Confirmed working fields (Feb 2026 live probes):
 * - name (REQUIRED for most updates)
 * - submission_filters (object with include/exclude/list arrays)
 * - session_length, monthly_dollar, monthly_time, total_time, total_dollar
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
  cloud_labs?: boolean;  // Requires org permission
  instant_aws_access?: boolean;  // Requires org permission
  session_length?: string;
  monthly_dollar?: string;
  monthly_time?: string;
  total_time?: string;
  total_dollar?: string;
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
