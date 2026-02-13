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
