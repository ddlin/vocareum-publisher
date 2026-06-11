/**
 * Validator Module
 *
 * Validate configuration and file structure consistency.
 */

import * as path from 'path';
import type { Config } from '../types/config';
import type { ValidationResult } from '../types/state';
import { getDirectories, pathExists } from '../utils/files';
import { directoriesForPart, isConfinedToWorkspace } from './local-scan';
import { logger } from '../utils/logger';

/**
 * Validate that the filesystem structure matches the configuration
 *
 * @param config - Parsed configuration
 * @param basePath - Base directory path
 * @returns Validation result
 */
export async function validateStructure(
  config: Config,
  basePath: string
): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  };

  // 1. Check each YAML assignment has corresponding folder
  for (const assignment of config.assignments) {
    // Confinement comes before existence: escaping paths (../, absolute,
    // symlinks out of the workspace) must NEVER be reported as missing_folder,
    // or `vocgit fix` would create directories outside the workspace.
    if (!await isConfinedToWorkspace(basePath, assignment.path)) {
      result.errors.push({
        type: 'invalid_structure',
        path: assignment.path,
        message: `Assignment "${assignment.name}" path "${assignment.path}" escapes the workspace root`,
        fix: 'Correct the path in vocareum.yaml — paths must stay inside the workspace'
      });
      result.valid = false;
      continue;
    }

    const assignmentPath = path.join(basePath, assignment.path);

    if (!await pathExists(assignmentPath)) {
      result.errors.push({
        type: 'missing_folder',
        path: assignment.path,
        message: `Assignment "${assignment.name}" references path "${assignment.path}" which doesn't exist`,
        fix: `Run: vocgit new ${assignment.path}`
      });
      result.valid = false;
      continue; // Skip part checks if assignment folder missing
    }

    // Check each part folder
    for (const part of assignment.parts) {
      if (!await isConfinedToWorkspace(basePath, path.join(assignment.path, part.path))) {
        result.errors.push({
          type: 'invalid_structure',
          path: `${assignment.path}/${part.path}`,
          message: `Part "${part.name ?? part.path}" path escapes the workspace root`,
          fix: 'Correct the path in vocareum.yaml — paths must stay inside the workspace'
        });
        result.valid = false;
        continue;
      }

      const partPath = path.join(assignmentPath, part.path);
      if (!await pathExists(partPath)) {
        result.errors.push({
          type: 'missing_folder',
          path: `${assignment.path}/${part.path}`,
          message: `Part "${part.name ?? part.path}" folder not found at ${part.path}`,
          fix: `Create directory: ${assignment.path}/${part.path}/`
        });
        result.valid = false;
        continue;
      }

      // Confinement applies to every directory push would inspect, including
      // architecture/default directories that are not explicitly listed.
      for (const dir of directoriesForPart(config, part)) {
        const relativeDirPath = path.join(assignment.path, part.path, dir);
        if (!await isConfinedToWorkspace(basePath, relativeDirPath)) {
          result.errors.push({
            type: 'invalid_structure',
            path: relativeDirPath,
            message: `Content directory "${dir}" path escapes the workspace root`,
            fix: 'Replace the symlink or correct the path so it stays inside the workspace'
          });
          result.valid = false;
          continue;
        }

        // Only explicitly configured directories are required to exist.
        if (part.directories !== undefined) {
          const dirPath = path.join(partPath, dir);
          if (!await pathExists(dirPath)) {
            result.errors.push({
              type: 'invalid_structure',
              path: relativeDirPath,
              message: `Required directory "${dir}" not found in part ${part.path}`,
              fix: `Create directory: mkdir -p ${assignment.path}/${part.path}/${dir}`
            });
            result.valid = false;
          }
        }
      }
    }
  }

  // 2. Check for orphaned folders (folders without YAML entries)
  try {
    const assignmentFolders = await getDirectories(basePath);
    // Ignore hidden folders, node_modules, dist, etc.
    // getDirectories already ignores starting with '.'
    const ignoredDirs = new Set(['node_modules', 'dist', 'src', 'action', 'examples', 'test', 'docs']);

    // Config paths
    const configPaths = new Set(config.assignments.map((a) => a.path));

    for (const folder of assignmentFolders) {
      if (ignoredDirs.has(folder)) {
        continue;
      }

      if (!configPaths.has(folder)) {
        result.warnings.push({
          type: 'orphaned_folder',
          path: folder,
          message: `Folder "${folder}/" has no entry in vocareum.yaml (will be ignored)`,
        });
      }
    }
  } catch (error) {
    // If basePath doesn't exist or other error, we might catch it here.
    // But valid structure assumes basePath exists.
    logger.debug('Error checking orphaned folders:', { error });
  }

  return result;
}


/**
 * Display validation result to console
 *
 * @param result - Validation result to display
 */
export function displayValidationResult(result: ValidationResult): void {
  if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
    logger.success('Validation passed - no issues found');
    return;
  }

  if (result.errors.length > 0) {
    logger.error(`Found ${result.errors.length} error(s):`);
    for (const error of result.errors) {
      logger.plain(`  [${error.type}] ${error.message}`);
      if (error.fix !== undefined && error.fix !== '') {
        logger.plain(`    Fix: ${error.fix}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    logger.warn(`Found ${result.warnings.length} warning(s):`);
    for (const warning of result.warnings) {
      logger.plain(`  [${warning.type}] ${warning.message}`);
    }
  }

  if (result.valid) {
    logger.success('Validation passed with warnings');
  } else {
    logger.error('Validation failed');
  }
}
