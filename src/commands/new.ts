/**
 * New Command
 *
 * Create new assignment structure with folders and vocareum.yaml entry.
 * This is a LOCAL-ONLY operation - creates in CI/CD is not recommended.
 */

import * as path from 'path';
import type { DirectoryType } from '../types/config';
import { loadConfig, updateConfig } from '../core/config';
import { ensureDirectory, pathExists } from '../utils/files';
import { logger } from '../utils/logger';
import { prompt, promptChoice, promptConfirm } from '../utils/prompts';

export interface NewAssignmentOptions {
  path?: string;
  name?: string;
  force?: boolean;
}

/**
 * Execute the new command to create assignment structure
 */
export async function newCommand(assignmentPath: string | undefined): Promise<void> {
  const configPath = 'vocareum.yaml';

  if (!await pathExists(configPath)) {
    logger.error('vocareum.yaml not found. Run "vocareum-publish init" first.');
    return;
  }

  const config = await loadConfig(configPath);
  const templateChoices = getTemplateChoices(config.vocareum.template_assignment_id, config.vocareum.template_assignment_ids);

  // Interactive prompts
  let name = assignmentPath;
  // If path is provided, use it as name or path? 
  // Argument name is `path` in my interface but `assignment-path` in doc.
  // Usually `vocareum-publish new <name>`

  if (!name) {
    name = await prompt('Assignment Name (folder name):');
  }

  if (!name) {
    logger.error('Assignment name is required');
    return;
  }

  const assignmentDir = name; // Simplify: path = name

  if (await pathExists(assignmentDir)) {
    const confirmUse = await promptConfirm(`Directory ${assignmentDir} already exists. Use it?`);
    if (!confirmUse) {
      return;
    }
  }

  // Check if already in config
  if (config.assignments.some(a => a.path === assignmentDir)) {
    logger.error(`Assignment with path "${assignmentDir}" already exists in vocareum.yaml`);
    return;
  }

  // Create structure
  logger.info(`Creating assignment structure in ${assignmentDir}...`);

  const parts = ['part1']; // Default to 1 part
  const dirs: DirectoryType[] = ['startercode', 'scripts', 'docs', 'data'];

  for (const part of parts) {
    for (const dir of dirs) {
      const fullPath = path.join(assignmentDir, part, dir);
      await ensureDirectory(fullPath);
      logger.debug(`Created ${fullPath}`);
    }
  }

  // Update Config
  const newAssignment = {
    name: name,
    path: assignmentDir,
    assignment_id: null as string | null, // New, so no ID
    create_from_template: true,
    template_assignment_id: await selectTemplateForAssignment(templateChoices),
    parts: parts.map(p => ({
      path: p,
      part_id: null as string | null,
      directories: dirs
    }))
  };

  logger.info('Updating vocareum.yaml...');

  await updateConfig(configPath, {
    assignments: [newAssignment]
  });

  logger.success(`Assignment "${name}" created successfully!`);
}

/**
 * Create new assignment structure and YAML entry
 * @deprecated Use newCommand instead
 */
export function createNewAssignment(
  _options: NewAssignmentOptions,
  _configPath: string
): Promise<void> {
  // Deprecated - use newCommand instead
  return Promise.reject(new Error('Use newCommand instead'));
}

function getTemplateChoices(
  templateAssignmentId: string | undefined,
  templateAssignmentIds: string[] | undefined
): string[] {
  const values = [
    ...(templateAssignmentIds ?? []),
    ...(templateAssignmentId ? [templateAssignmentId] : []),
  ];
  return [...new Set(values)];
}

async function selectTemplateForAssignment(templateChoices: string[]): Promise<string | undefined> {
  if (templateChoices.length === 0) {
    logger.warn('No template assignment IDs configured; publish will fail unless one is added before creation.');
    return undefined;
  }
  if (templateChoices.length === 1) {
    logger.info(`Using template assignment ID ${templateChoices[0]}`);
    return templateChoices[0];
  }

  logger.info('Multiple template assignments found.');
  return promptChoice('Select template assignment ID for this assignment:', templateChoices);
}
