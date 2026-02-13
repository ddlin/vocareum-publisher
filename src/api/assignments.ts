/**
 * Assignment Operations
 *
 * API operations for Vocareum assignments.
 * CRITICAL: All IDs are strings!
 */

import { VocareumClient } from './client';
import type {
  VocareumAssignmentResponse,
  AssignmentCopyResponse,
  ApiAssignmentSettings,
  AssignmentsListResponse
} from '../types/api';

/**
 * List all assignments in a course
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @returns Array of assignments
 */
export async function listAssignments(
  client: VocareumClient,
  courseId: string
): Promise<VocareumAssignmentResponse[]> {
  const response = await client.request<AssignmentsListResponse>({
    method: 'GET',
    url: `/api/v2/courses/${courseId}/assignments`,
  });
  return response.assignments;
}

/**
 * Get assignment details
 *
 * @param client - Vocareum API client
 * @param assignmentId - Assignment ID (string!)
 * @returns Assignment details
 */
export async function getAssignment(
  client: VocareumClient,
  assignmentId: string
): Promise<VocareumAssignmentResponse> {
  return client.request<VocareumAssignmentResponse>({
    method: 'GET',
    url: `/api/v2/assignments/${assignmentId}`,
  });
}

/**
 * Copy assignment from template
 * Returns new assignment_id and part_ids with seqnum
 *
 * @param client - Vocareum API client
 * @param templateId - Template assignment ID (string!)
 * @param name - New assignment name
 * @param courseId - Target course ID
 * @returns New assignment with parts
 */
export async function copyAssignment(
  client: VocareumClient,
  templateId: string,
  name: string,
  courseId: string
): Promise<AssignmentCopyResponse> {
  // Guessing endpoint: POST /api/v2/assignments/:templateId/copy
  // Payload likely needs name and target course
  return client.request<AssignmentCopyResponse>({
    method: 'POST',
    url: `/api/v2/assignments/${templateId}/copy`,
    data: {
      name,
      course_id: courseId
    }
  });
}

/**
 * Update assignment settings
 *
 * @param client - Vocareum API client
 * @param assignmentId - Assignment ID (string!)
 * @param settings - Settings to update
 * @returns Updated assignment
 */
export async function updateAssignment(
  client: VocareumClient,
  assignmentId: string,
  settings: ApiAssignmentSettings
): Promise<VocareumAssignmentResponse> {
  return client.request<VocareumAssignmentResponse>({
    method: 'PUT', // or PATCH?
    url: `/api/v2/assignments/${assignmentId}`,
    data: settings,
  });
}
