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
import type { Config } from '../types/config';

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

  if (await pathExists(configPath) && !options.force) {
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

  const courseId = options.courseId || await prompt('Enter Course ID:');

  if (!courseId) {
    logger.error('Course ID is required.');
    return;
  }

  const templateId = await prompt('Enter Default Template Assignment ID (optional, press Enter to skip):');

  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: orgId,
      course_id: courseId,
      api_base_url: 'https://api.vocareum.com',
      template_assignment_id: templateId || undefined,
      excluded_assignments: [],
    },
    assignments: [],
    publish_history: [],
  };

  try {
    await writeFile(configPath, yaml.dump(config));

    logger.success(`Configuration saved to ${configPath}`);
    logger.info('Run "vocareum-publish new <name>" to create your first assignment.');

  } catch (error) {
    logger.error(`Failed to write configuration: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}
