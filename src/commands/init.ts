/**
 * Init Command
 *
 * Initialize a new course repository with vocareum.yaml configuration.
 * Supports two modes:
 * - Fresh start: Create new empty configuration
 * - Import: Import existing course from Vocareum
 */

import * as yaml from 'js-yaml';
import { pathExists, writeFile } from '../utils/files';
import { logger } from '../utils/logger';
import { prompt, promptConfirm } from '../utils/prompts';
import type { Config, TemplateConfig } from '../types/config';

export interface InitOptions {
  import?: boolean;
  courseId?: string;
  force?: boolean;
}

/**
 * Execute the init command
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const configPath = 'vocareum.yaml';

  if (await pathExists(configPath) && options.force !== true) {
    const overwrite = await promptConfirm(
      'vocareum.yaml already exists. Overwrite?',
      false
    );
    if (!overwrite) {
      logger.info('Aborted.');
      return;
    }
  }

  logger.info('Initializing Vocareum configuration...');

  const orgId = await prompt('Enter Organization ID:');
  if (!orgId) {
    logger.error('Organization ID is required.');
    return;
  }

  const courseId = options.courseId ?? await prompt('Enter Course ID:');

  if (!courseId) {
    logger.error('Course ID is required.');
    return;
  }

  // Collect templates
  const templates: TemplateConfig[] = [];
  const addTemplates = await promptConfirm('Add template assignments for creating new assignments?', true);

  if (addTemplates) {
    let addMore = true;
    while (addMore) {
      const templateCourseId = await prompt(`Template course ID (or press Enter for ${courseId}):`);
      const templateId = await prompt('Template assignment ID:');

      if (!templateId) {
        break;
      }

      const templateName = await prompt(`Template name (e.g., "Standard Lab", "Timed Exam"):`);

      templates.push({
        id: templateId,
        name: templateName || `Template ${templateId}`,
        course_id: templateCourseId || courseId,
      });

      addMore = await promptConfirm('Add another template?', false);
    }
  }

  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: orgId,
      course_id: courseId,
      api_base_url: 'https://api.vocareum.com',
      templates,
      template_assignment_ids: [],
      excluded_assignments: [],
    },
    assignments: [],
    publish_history: [],
  };

  try {
    await writeFile(configPath, yaml.dump(config));

    logger.success(`Configuration saved to ${configPath}`);
    logger.info('Run "vocgit new <name>" to create your first assignment.');

  } catch (error) {
    logger.error(`Failed to write configuration: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}
