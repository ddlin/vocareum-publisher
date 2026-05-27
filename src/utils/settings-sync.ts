import type { Assignment, Part } from '../types/config';

interface SettingsSyncConfig {
  publish_options?: {
    sync_settings?: boolean;
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
