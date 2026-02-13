/**
 * Publish Command
 *
 * Main command to publish assignments to Vocareum.
 */

import { loadConfig } from '../core/config';
import { publish } from '../core/publisher';
import { VocareumClient } from '../api/client';
import { logger } from '../utils/logger';
import { loadDotEnvIfPresent } from '../utils/env';
import type { PublishOperationOptions } from '../types/state';

export interface PublishCommandOptions extends PublishOperationOptions {
  config?: string;
  dryRun?: boolean;
  verbose?: boolean;
}

/**
 * Execute the publish command
 */
export async function publishCommand(options: PublishCommandOptions): Promise<void> {
  const configPath = options.config ?? 'vocareum.yaml';

  try {
    loadDotEnvIfPresent();
    const config = await loadConfig(configPath);

    // API Key - support both env var names
    const apiKey = process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN;
    if (apiKey === undefined || apiKey === '') {
      logger.error('VOCAREUM_API_KEY (or VOCAREUM_API_TOKEN) environment variable is required.');
      process.exit(1);
    }

    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

    // Merge options with config defaults
    const publishOptions: PublishOperationOptions = {
      dryRun: options.dryRun ?? false,
      verbose: options.verbose ?? false,
      autoCommit: options.autoCommit ?? config.publish_options?.auto_commit ?? false,
      syncDeletes: options.syncDeletes ?? config.publish_options?.sync_deletes ?? false,
    };

    logger.info(`Starting publish process for course ${config.vocareum.course_id}...`);
    if (publishOptions.dryRun === true) {
      logger.info('DRY RUN MODE: No changes will be applied.');
    }

    const result = await publish(config, client, publishOptions);

    if (result.success) {
      logger.success('Publish completed successfully!');
      if (result.summary) {
        logger.info(result.summary);
      }
    } else {
      logger.error('Publish failed with errors.');
      if (result.failed.length > 0) {
        result.failed.forEach(f => {
          const errorMsg = f.error instanceof Error ? f.error.message : String(f.error);
          logger.error(`- ${f.type} ${f.id}: ${errorMsg}`);
        });
      }
      process.exit(1);
    }

  } catch (error) {
    logger.error(`Publish failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
