/**
 * Courses API
 *
 * Manage Vocareum courses.
 */

import { VocareumClient } from './client';
import type { VocareumCourseResponse } from '../types/api';

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
  // Assuming GET /api/v2/courses/:id for now based on REST conventions
  // If exact endpoint not known, check API docs link in AGENTS.md (I can't browse)
  // But typically getting course details is basic.
  // Actually, usually we list courses and filter?
  // Let's implement getCourse by ID.
  // The client `request` method is protected, so we need to extend or use a public method?
  // `VocareumClient` has protected `request`.
  // So `getCourse` should probably be a method on `VocareumClient` or `client` should expose request?
  // `ARCHITECTURE.md` shows module hierarchy: `api/courses.ts`, `api/assignments.ts`.
  // This implies standalone functions that take a client.
  // But if `client.request` is protected, they can't call it unless they extend `VocareumClient`.
  // Or `VocareumClient` should utilize these functions internally?
  // Let's check `client.ts` again. `request` IS protected.
  // This means I should likely make `request` public OR these functions should be methods.
  // Given the structure, maybe `client.ts` is just the base class and we have a `VocareumAPI` class that extends it and uses these functions?
  // OR `api/courses.ts` exports a class extending `VocareumClient`?
  // "Phase 3: API Client ... api/courses.ts" suggests modules.
  // I will make `request` public in `client.ts` to allow standalone functions to use it, OR add methods to `VocareumClient`.
  // Modifying `client.ts` to make `request` public seems best for functional composition.

  return client.request<VocareumCourseResponse>({
    method: 'GET',
    url: `/api/v2/courses/${courseId}`,
  });
}
