/**
 * Publish Command
 *
 * Main command to publish assignments to Vocareum.
 */

import { loadConfig } from '../core/config';
import { publish } from '../core/publisher';
import { VocareumClient } from '../api/client';
import { resolveAuthProvider } from '../api/auth/cli-auth-options';
import { logger } from '../utils/logger';
import { loadDotEnvIfPresent, isCI } from '../utils/env';
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';
import type { PublishOperationOptions } from '../types/state';

export interface PublishCommandOptions extends PublishOperationOptions {
  config?: string;
  dryRun?: boolean;
  verbose?: boolean;
  auth?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Execute the publish command
 */
export async function publishCommand(options: PublishCommandOptions): Promise<void> {
  const configPath = options.config ?? 'vocareum.yaml';
  const reporter = new UnknownFieldReporter(logger);

  try {
    loadDotEnvIfPresent();
    const config = await loadConfig(configPath);
    const client = new VocareumClient(resolveAuthProvider(options, config.vocareum.api_base_url));

    const requestedAutoCommit = options.autoCommit ?? config.publish_options?.auto_commit ?? false;
    const autoCommit = isCI() ? false : requestedAutoCommit;
    if (isCI() && requestedAutoCommit) {
      logger.warn('Auto-commit is disabled in CI/CD environments.');
    }

    // Merge options with config defaults
    // In CI, always run non-interactive
    const nonInteractive = options.nonInteractive ?? isCI();

    const publishOptions: PublishOperationOptions = {
      dryRun: options.dryRun ?? false,
      verbose: options.verbose ?? false,
      nonInteractive,
      autoCommit,
      syncDeletes: options.syncDeletes ?? config.publish_options?.sync_deletes ?? false,
      onMissingId: options.onMissingId ?? config.publish_options?.on_missing_id ?? 'skip',
      abortOnError: options.abortOnError ?? config.publish_options?.abort_on_error ?? false,
      configPath,
      assignment: options.assignment,
      part: options.part,
      forceAll: options.forceAll ?? false,
    };

    logger.info(`Starting push for course ${config.vocareum.course_id}...`);
    if (publishOptions.dryRun === true) {
      logger.info('DRY RUN MODE: No changes will be applied.');
    }

    const result = await publish(config, client, publishOptions, reporter);

    if (result.success) {
      logger.success('Push completed successfully!');
      if (result.summary) {
        logger.info(result.summary);
      }
    } else {
      logger.error('Push failed with errors.');
      if (result.failed.length > 0) {
        result.failed.forEach(f => {
          const errorMsg = f.error instanceof Error ? f.error.message : String(f.error);
          logger.error(`- ${f.type} ${f.id}: ${errorMsg}`);
        });
      }
      throw new Error('Push completed with errors');
    }

  } finally {
    reporter.printSummary();
  }
}
