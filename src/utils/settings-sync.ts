import type { Assignment, Part } from '../types/config';

interface SettingsSyncConfig {
  publish_options?: {
    sync_settings?: boolean;
    sync_rubrics?: boolean;
  };
}

/**
 * Resolve settings-sync intent using the configured precedence:
 * part override -> assignment override -> global publish option -> true.
 */
export function shouldSyncPartSettings(
  config: SettingsSyncConfig,
  assignment: Pick<Assignment, 'sync_settings'>,
  part: Pick<Part, 'sync_settings'>
): boolean {
  return part.sync_settings ?? assignment.sync_settings ?? config.publish_options?.sync_settings ?? true;
}

/**
 * Resolve assignment settings-sync intent.
 */
export function shouldSyncAssignmentSettings(
  config: SettingsSyncConfig,
  assignment: Pick<Assignment, 'sync_settings'>
): boolean {
  return assignment.sync_settings ?? config.publish_options?.sync_settings ?? true;
}

/**
 * Course settings are governed by the global settings-sync option.
 */
export function shouldSyncCourseSettings(config: SettingsSyncConfig): boolean {
  return config.publish_options?.sync_settings ?? true;
}

/**
 * Whether the rubric option is enabled. Global-only — there is no per-assignment
 * or per-part rubric override.
 *
 * This is the INNER gate. Rubrics are fetched inside the settings-drift traversal,
 * so `sync_settings: false` skips them regardless of this value; `sync_rubrics:
 * false` turns rubrics off while leaving settings sync on. Independent traversal
 * was rejected deliberately: it would double the request count for exactly the
 * users who disabled settings sync to reduce it.
 */
export function shouldSyncRubrics(config: SettingsSyncConfig): boolean {
  return config.publish_options?.sync_rubrics ?? true;
}
