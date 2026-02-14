/**
 * New Command
 *
 * Create new assignment structure with folders and vocareum.yaml entry.
 * This is a LOCAL-ONLY operation - creates in CI/CD is not recommended.
 */

import * as path from 'path';
import type { TemplateConfig } from '../types/config';
import { DEFAULT_PART_DIRECTORIES } from '../types/config';
import { loadConfig, updateConfig } from '../core/config';
import { ensureDirectory, pathExists, writeFile } from '../utils/files';
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
  const templateChoices = getTemplateChoices(config.vocareum);

  // Interactive prompts
  let name = assignmentPath;
  // If path is provided, use it as name or path? 
  // Argument name is `path` in my interface but `assignment-path` in doc.
  // Usually `vocareum-publish new <name>`

  if (name === undefined || name === '') {
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

  // Create structure with all default directories
  logger.info(`Creating assignment structure in ${assignmentDir}...`);

  const parts = ['part1']; // Default to 1 part
  const dirs = DEFAULT_PART_DIRECTORIES;

  for (const part of parts) {
    for (const dir of dirs) {
      const fullPath = path.join(assignmentDir, part, dir);
      await ensureDirectory(fullPath);
      // Create .gitkeep to ensure empty directories are tracked in git
      await writeFile(path.join(fullPath, '.gitkeep'), '');
      logger.debug(`Created ${fullPath}/`);
    }
  }

  // Update Config
  const newAssignment = {
    name: name,
    path: assignmentDir,
    assignment_id: null as string | null, // New, so no ID
    create_from_template: true,
    template_assignment_id: await selectTemplateForAssignment(templateChoices, config.vocareum.course_id),
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

interface VocareumConfig {
  course_id: string;
  templates?: TemplateConfig[];
  template_assignment_id?: string;
  template_assignment_ids?: string[];
}

/**
 * Get all available templates, merging named templates with legacy ID-only configs.
 * Named templates take precedence; legacy IDs are shown as "Template <id>".
 */
function getTemplateChoices(vocareum: VocareumConfig): TemplateConfig[] {
  const namedTemplates = vocareum.templates ?? [];
  const namedIds = new Set(namedTemplates.map(t => t.id));

  // Collect legacy IDs not already in named templates
  const legacyIds: string[] = [];
  for (const id of vocareum.template_assignment_ids ?? []) {
    if (!namedIds.has(id)) {
      legacyIds.push(id);
    }
  }
  if (vocareum.template_assignment_id && !namedIds.has(vocareum.template_assignment_id)) {
    if (!legacyIds.includes(vocareum.template_assignment_id)) {
      legacyIds.push(vocareum.template_assignment_id);
    }
  }

  // Convert legacy IDs to template objects with auto-generated names
  // Legacy templates are assumed to be in the main course
  const legacyTemplates: TemplateConfig[] = legacyIds.map(id => ({
    id,
    name: `Template ${id}`,
    course_id: vocareum.course_id,
  }));

  return [...namedTemplates, ...legacyTemplates];
}

/**
 * Format template for display, showing course if different from main course
 */
function formatTemplateChoice(template: TemplateConfig, mainCourseId: string): string {
  if (template.course_id === mainCourseId) {
    return `${template.name} (${template.id})`;
  }
  return `${template.name} (course:${template.course_id}, id:${template.id})`;
}

async function selectTemplateForAssignment(
  templates: TemplateConfig[],
  mainCourseId: string
): Promise<string | undefined> {
  if (templates.length === 0) {
    logger.warn('No templates configured; publish will fail unless one is added before creation.');
    return undefined;
  }
  if (templates.length === 1) {
    const display = formatTemplateChoice(templates[0], mainCourseId);
    logger.info(`Using template: ${display}`);
    return templates[0].id;
  }

  logger.info('Multiple templates available.');
  const choices = templates.map(t => formatTemplateChoice(t, mainCourseId));
  const selected = await promptChoice('Select template for this assignment:', choices);

  // Find the template that matches the selected display string
  const selectedTemplate = templates.find(t => formatTemplateChoice(t, mainCourseId) === selected);
  return selectedTemplate?.id;
}
