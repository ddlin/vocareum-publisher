/**
 * Courses API
 *
 * Manage Vocareum courses.
 */

import { NotFoundError, VocareumClient } from './client';
import type { CoursesListResponse, VocareumCourseResponse } from '../types/api';

/**
 * Get details for a specific course
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID
 * @returns Course details
 */
export async function getCourse(
  client: VocareumClient,
  courseId: string
): Promise<VocareumCourseResponse> {
  const response = await client.request<CoursesListResponse>({
    method: 'GET',
    url: `/api/v2/courses/${courseId}`,
  });

  const course = (response.courses ?? []).find((c) => c.id === courseId);
  if (!course) {
    throw new NotFoundError('Course', courseId);
  }

  return course;
}

/**
 * Update course settings
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID
 * @param settings - Settings to update (name, description)
 * @returns Updated course details
 */
export async function updateCourse(
  client: VocareumClient,
  courseId: string,
  settings: { name?: string; description?: string }
): Promise<VocareumCourseResponse> {
  const response = await client.request<{ status: 'success'; course?: VocareumCourseResponse }>({
    method: 'PUT',
    url: `/api/v2/courses/${courseId}`,
    data: settings,
  });

  // Re-fetch to get updated data if response doesn't include it
  if (response.course) {
    return response.course;
  }
  return getCourse(client, courseId);
}
