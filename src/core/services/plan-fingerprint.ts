import { createHash } from 'node:crypto';
import type { PushIntent } from './types';

/**
 * Recursively sorts all object keys to produce a canonical representation.
 * Arrays are left as-is (will be sorted at the structural level before serialization).
 */
function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      // Don't sort arrays here; they'll be sorted at the structural level
      return value.map(item => canonicalizeValue(item));
    } else {
      // Sort object keys recursively
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(value).sort();
      for (const key of keys) {
        sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
  }

  return value;
}

/**
 * Produces a canonical, order-independent SHA-256 fingerprint of the entire PushIntent.
 * The fingerprint includes:
 * - assignment paths, assignmentIds, templateAssignmentIds, actions, settingsPayloads
 * - part paths, partIds, contentHashes, settingsPayloads, deletePaths
 *
 * Canonicalization:
 * 1. Sort assignments by path
 * 2. Sort parts within each assignment by path
 * 3. Recursively sort all object keys (so settingsPayload key order doesn't matter)
 * 4. Stringify and hash with SHA-256
 *
 * A change to any content hash, settings value, delete path, template id, or action
 * will change the fingerprint; reordering will not.
 */
export function semanticFingerprint(intent: PushIntent): string {
  // Sort assignments by path
  const sortedAssignments = [...intent.assignments].sort((a, b) => a.path.localeCompare(b.path));

  // For each assignment, sort parts by path and canonicalize
  const canonicalIntentStructure = {
    assignments: sortedAssignments.map(assignment => ({
      path: assignment.path,
      name: assignment.name,
      assignmentId: assignment.assignmentId,
      templateAssignmentId: assignment.templateAssignmentId,
      templateCourseId: assignment.templateCourseId,
      action: assignment.action,
      settingsPayload: assignment.settingsPayload,
      parts: [...assignment.parts]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(part => ({
          partId: part.partId,
          path: part.path,
          contentHashes: part.contentHashes,
          settingsPayload: part.settingsPayload,
          deletePaths: part.deletePaths ? [...part.deletePaths].sort() : undefined,
          reconcileDeleteDirectories: part.reconcileDeleteDirectories
            ? [...part.reconcileDeleteDirectories].sort()
            : undefined,
        })),
    })),
  };

  // Include courseSettings so a course-settings change shifts the fingerprint.
  const withCourse = intent.courseSettings !== undefined
    ? { ...canonicalIntentStructure, courseSettings: intent.courseSettings }
    : canonicalIntentStructure;

  // Recursively canonicalize all object keys
  const canonicalized = canonicalizeValue(withCourse);

  // Stringify and hash
  const canonicalJson = JSON.stringify(canonicalized);
  return createHash('sha256').update(canonicalJson).digest('hex');
}
