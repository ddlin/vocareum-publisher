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
import { prompt, promptChoice, promptConfirm } from '../utils/prompts';
import { getApiBaseUrlEnv } from '../utils/env';
import { assertBaseUrlForVersion } from '../api/client';
import {
  DEFAULT_REGION, REGION_HOSTS, VOCAREUM_REGIONS, displayHost, normalizeApiBaseUrl,
  type VocareumRegion,
} from '../api/regions';
import type { Config, TemplateConfig } from '../types/config';

export interface InitOptions {
  import?: boolean;
  courseId?: string;
  force?: boolean;
  /** --region <na|eu>: Vocareum tenant whose API host is written to vocareum.yaml. */
  region?: string;
  /** --api-base-url <url>: explicit v2 API host (must pass the v2 allowlist). */
  apiBaseUrl?: string;
}

function regionChoiceLabel(region: VocareumRegion): string {
  const hosts = REGION_HOSTS[region];
  return `${region.toUpperCase()} — ${hosts.label} (${displayHost(hosts.apiBaseUrl)})`;
}

/**
 * Decide the v2 API host before any prompt, so a bad flag fails fast.
 * Returns undefined when the user should be asked interactively.
 * Precedence: --api-base-url / --region > VOCAREUM_API_BASE_URL > prompt.
 */
export function resolveInitApiBaseUrl(options: InitOptions): string | undefined {
  const flagUrl = options.apiBaseUrl?.trim();
  const region = options.region?.trim().toLowerCase();
  if (flagUrl !== undefined && flagUrl !== '' && region !== undefined && region !== '') {
    throw new Error('Use either --region or --api-base-url, not both.');
  }
  if (region !== undefined && region !== '') {
    if (!(VOCAREUM_REGIONS as readonly string[]).includes(region)) {
      throw new Error(`Unknown region "${options.region ?? ''}". Use one of: ${VOCAREUM_REGIONS.join(', ')}.`);
    }
    return REGION_HOSTS[region as VocareumRegion].apiBaseUrl;
  }
  const explicit = flagUrl !== undefined && flagUrl !== '' ? flagUrl : getApiBaseUrlEnv();
  if (explicit === undefined) {
    return undefined;
  }
  // Same gate push/pull apply: HTTPS + exact v2 allowlist entry, unless
  // VOCAREUM_ALLOW_CUSTOM_BASE_URL=1. Never write a host we would refuse.
  assertBaseUrlForVersion(normalizeApiBaseUrl(explicit), 'v2');
  return explicit.replace(/\/+$/, '');
}

async function promptRegionApiBaseUrl(): Promise<string> {
  // Default first: inquirer's list highlights the first entry.
  const ordered = [DEFAULT_REGION, ...VOCAREUM_REGIONS.filter(r => r !== DEFAULT_REGION)];
  const labels = ordered.map(regionChoiceLabel);
  const picked = await promptChoice('Vocareum region (tenant):', labels);
  const region = ordered[labels.indexOf(picked)] ?? DEFAULT_REGION;
  return REGION_HOSTS[region].apiBaseUrl;
}

/**
 * Execute the init command
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const configPath = 'vocareum.yaml';
  const presetApiBaseUrl = resolveInitApiBaseUrl(options);

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

  // The tenant comes first: org/course IDs only mean something on one tenant.
  const apiBaseUrl = presetApiBaseUrl ?? await promptRegionApiBaseUrl();
  logger.info(`API host: ${displayHost(apiBaseUrl)}`);

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
      api_base_url: apiBaseUrl,
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
