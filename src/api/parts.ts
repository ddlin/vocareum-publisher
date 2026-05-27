/**
 * Part Operations
 *
 * API operations for Vocareum parts.
 *
 * CRITICAL: All IDs are strings!
 * CRITICAL: seqnum is a STRING that must be parsed for sorting!
 */

import { VocareumClient } from './client';
import type {
  VocareumPartResponse,
  PartSettingsPayload,
  PartsListResponse
} from '../types/api';

/**
 * List all parts in an assignment
 *
 * Returns parts with seqnum field for ordering.
 * Filters out deleted parts (deleted: "1")
 * Sorted by parseInt(seqnum) for correct ordering
 *
 * @param client - Vocareum API client
 * @param assignmentId - Assignment ID (string!)
 * @returns Array of parts sorted by seqnum
 */
export async function listParts(
  client: VocareumClient,
  courseId: string,
  assignmentId: string
): Promise<VocareumPartResponse[]> {
  const response = await client.request<PartsListResponse>({
    method: 'GET',
    url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts`,
  });

  const parts = response.parts ?? [];

  return parts
    .filter((p) => p.deleted !== '1')
    .sort((a, b) => parseInt(a.seqnum, 10) - parseInt(b.seqnum, 10));
}

/**
 * Get part details
 *
 * IMPORTANT: Direct endpoint /api/v2/parts/{id} returns 400.
 * Must use course-scoped endpoint.
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @param partId - Part ID (string!)
 * @returns Part details
 */
export async function getPart(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string
): Promise<VocareumPartResponse> {
  const response = await client.request<PartsListResponse>({
    method: 'GET',
    url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}`,
  });
  if (!response.parts || response.parts.length === 0) {
    throw new Error(
      `Part not found: ${partId} in assignment ${assignmentId}.\n` +
      `The part may have been deleted or the assignment structure changed.`
    );
  }
  return response.parts[0];
}

/**
 * Update part settings
 *
 * IMPORTANT: Direct endpoint /api/v2/parts/{id} returns 400.
 * Must use course-scoped endpoint.
 *
 * Writable fields are based on the draft OpenAPI contract plus live probes:
 * - name (REQUIRED for most updates)
 * - submission_filters (object with include/exclude/list arrays)
 * - session_length, monthly_dollar, monthly_time, total_time, total_dollar
 * - endlab (boolean), labtype, container_image, lab_interface (object)
 * - databricks_maxusers, tags
 *
 * Fields requiring org permissions:
 * - cloud_labs, instant_aws_access ("Cloud not allowed for the org")
 *
 * Fields observed in read responses but not sent during update:
 * - description, late_penalty_percent, late_penalty_percent_rule
 * - deadlinedate, number_of_submissions
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @param partId - Part ID (string!)
 * @param settings - Settings to update (must include name!)
 */
export async function updatePart(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  settings: PartSettingsPayload
): Promise<void> {
  const response = await client.request<{
    status: 'success';
    message?: string;
    transactionid?: string;
    objid?: string;
  }>({
    method: 'PUT',
    url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}`,
    data: settings,
  });

  // Update is async - wait for transaction if provided
  if (response.transactionid !== undefined && response.transactionid !== '') {
    // Poll transaction endpoint until complete
    const maxAttempts = 15;
    const delayMs = 2000;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const txn = await client.request<{
        status: 'success';
        state: 'pending' | 'success' | 'error' | 'failed';
        message?: string;
      }>({
        method: 'GET',
        url: `/api/v2/transaction/${response.transactionid}`,
      });

      if (txn.state === 'success') {
        return;
      }
      if (txn.state === 'error' || txn.state === 'failed') {
        throw new Error(
          txn.message ?? `Part update transaction failed (txn=${response.transactionid})`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `Timed out after ${maxAttempts * delayMs}ms waiting for part update (txn=${response.transactionid})`
    );
  }
}
