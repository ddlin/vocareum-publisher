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
  ApiPartSettings,
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

  const parts = response.parts || [];

  return parts
    .filter((p) => p.deleted !== '1')
    .sort((a, b) => parseInt(a.seqnum, 10) - parseInt(b.seqnum, 10));
}

/**
 * Get part details
 *
 * @param client - Vocareum API client
 * @param partId - Part ID (string!)
 * @returns Part details
 */
export async function getPart(
  client: VocareumClient,
  partId: string
): Promise<VocareumPartResponse> {
  return client.request<VocareumPartResponse>({
    method: 'GET',
    url: `/api/v2/parts/${partId}`,
  });
}

/**
 * Update part settings
 *
 * @param client - Vocareum API client
 * @param partId - Part ID (string!)
 * @param settings - Settings to update
 * @returns Updated part
 */
export async function updatePart(
  client: VocareumClient,
  partId: string,
  settings: ApiPartSettings
): Promise<VocareumPartResponse> {
  return client.request<VocareumPartResponse>({
    method: 'PUT',
    url: `/api/v2/parts/${partId}`,
    data: settings,
  });
}
