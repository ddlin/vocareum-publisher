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
import { listParts } from './parts';

/** Maximum polling attempts for async copy operation (30 attempts × 2s = 60 seconds max) */
const COPY_POLL_MAX_ATTEMPTS = 30;

/** Delay between polling attempts in milliseconds */
const COPY_POLL_DELAY_MS = 2000;

interface TransactionResponse {
  status: 'success';
  state: 'pending' | 'success' | 'failed';
  objid?: string;
  message?: string;
}

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
 * IMPORTANT: Direct endpoint /api/v2/assignments/{id} returns 400.
 * Must use course-scoped endpoint.
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @returns Assignment details
 */
export async function getAssignment(
  client: VocareumClient,
  courseId: string,
  assignmentId: string
): Promise<VocareumAssignmentResponse> {
  const response = await client.request<AssignmentsListResponse>({
    method: 'GET',
    url: `/api/v2/courses/${courseId}/assignments/${assignmentId}`,
  });
  if (response.assignments.length === 0) {
    throw new Error(`Assignment not found: ${assignmentId}`);
  }
  return response.assignments[0];
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
  // Postman contract:
  // POST /api/v2/courses/{courseId}/assignments
  // { method: "copy", source: "{source-assignmentId}", name: "assignment copy" }
  const response = await client.request<{
    status: 'success';
    message?: string;
    transactionid?: string;
    objid?: string;
  }>({
    method: 'POST',
    url: `/api/v2/courses/${courseId}/assignments`,
    data: {
      method: 'copy',
      source: templateId,
      name,
    },
  });

  let assignmentId = response.objid;

  // Copy is async. Even when objid is present in initial response,
  // it may be a placeholder (e.g., course id) until transaction completes.
  if (response.transactionid !== undefined && response.transactionid !== '') {
    assignmentId = await waitForAssignmentObjId(client, response.transactionid);
  }

  if (assignmentId === undefined || assignmentId === '') {
    throw new Error(
      `Assignment copy failed: no assignment ID returned (template=${templateId}, course=${courseId})`
    );
  }

  // Parts are regenerated; fetch and return them sorted by seqnum.
  const parts = await listParts(client, courseId, assignmentId);

  return {
    assignment_id: assignmentId,
    parts: parts.map((p) => ({
      part_id: p.id,
      name: p.name,
      seqnum: p.seqnum,
    })),
  };
}

/**
 * Poll transaction endpoint until assignment copy completes
 * @internal Exported for testing
 */
export async function waitForAssignmentObjId(
  client: VocareumClient,
  transactionId: string,
  options: { maxAttempts?: number; delayMs?: number } = {}
): Promise<string | undefined> {
  const maxAttempts = options.maxAttempts ?? COPY_POLL_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? COPY_POLL_DELAY_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const txn = await client.request<TransactionResponse>({
      method: 'GET',
      url: `/api/v2/transaction/${transactionId}`,
    });

    if (txn.state === 'success') {
      return txn.objid;
    }
    if (txn.state === 'failed') {
      throw new Error(
        txn.message ?? `Copy assignment transaction failed (txn=${transactionId})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(
    `Timed out after ${maxAttempts * delayMs}ms waiting for assignment copy (txn=${transactionId})`
  );
}

/**
 * Update assignment settings
 *
 * IMPORTANT: Direct endpoint /api/v2/assignments/{id} returns 400.
 * Must use course-scoped endpoint.
 *
 * Confirmed working fields (Feb 2026):
 * - name, description, nosubmit, auto_submit, grading_on_submit
 *
 * Fields that DO NOT work (return "No valid parameters"):
 * - published, points, due_date, gradespublished
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @param settings - Settings to update
 */
export async function updateAssignment(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  settings: ApiAssignmentSettings
): Promise<void> {
  const response = await client.request<{
    status: 'success';
    message?: string;
    transactionid?: string;
    objid?: string;
  }>({
    method: 'PUT',
    url: `/api/v2/courses/${courseId}/assignments/${assignmentId}`,
    data: settings,
  });

  // Update is async - wait for transaction if provided
  if (response.transactionid !== undefined && response.transactionid !== '') {
    await waitForAssignmentObjId(client, response.transactionid);
  }
}
