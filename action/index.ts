/**
 * GitHub Action Entry Point
 *
 * Wrapper for CLI functionality to run as a GitHub Action.
 */

import * as core from '@actions/core';
import { loadConfig } from '../src/core/config';
import { publish } from '../src/core/publisher';
import { VocareumClient } from '../src/api/client';
import { logger } from '../src/utils/logger';
import type { PublishOperationOptions } from '../src/types/state';

async function run(): Promise<void> {
  try {
    // 1. Get Inputs
    const apiKey = core.getInput('api-key', { required: true });
    // Set env var just in case deeper code uses it
    process.env.VOCAREUM_API_KEY = apiKey;

    const configFile = core.getInput('config-file') || 'vocareum.yaml';
    const dryRun = core.getBooleanInput('dry-run');
    const nonInteractive = core.getBooleanInput('non-interactive');
    const syncDeletes = core.getBooleanInput('sync-deletes');
    const requestedAutoCommit = core.getBooleanInput('auto-commit');
    const verbose = core.getBooleanInput('verbose');
    const assignmentValues = core.getInput('assignment');
    const partValues = core.getInput('part');
    const forceAll = core.getBooleanInput('force-all');

    // 2. Configure Logger
    // We rely on standard console output which Actions captures.
    if (verbose) {
      logger.info('Verbose logging enabled');
    }

    // 3. Load Config & Init Client
    const config = await loadConfig(configFile);
    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

    // 4. Construct Options
    if (requestedAutoCommit) {
      logger.warn('Auto-commit is disabled in GitHub Actions runtime.');
    }

    const options: PublishOperationOptions = {
      dryRun,
      nonInteractive,
      syncDeletes,
      autoCommit: false,
      configPath: configFile,
      assignment: assignmentValues || undefined,
      part: partValues || undefined,
      forceAll,
      verbose,
    };

    logger.info(`Starting publish process for course ${config.vocareum.course_id}...`);

    // 5. Run Publish
    const result = await publish(config, client, options);

    // 6. Set Outputs
    core.setOutput('success', result.success.toString());
    core.setOutput('summary', result.summary);
    core.setOutput('created-ids', JSON.stringify(result.created));
    core.setOutput('updated-ids', JSON.stringify(result.updated));

    if (result.success) {
      logger.success('Publish completed successfully!');
    } else {
      logger.error('Publish failed with errors.');
      if (result.failed.length > 0) {
        result.failed.forEach(f => logger.error(`- ${f.type} ${f.id}: ${f.error}`));
      }
      core.setFailed('Publish process failed.');
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Action failed: ${message}`);
    core.setFailed(message);
  }
}

run();
