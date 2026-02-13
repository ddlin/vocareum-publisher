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
    const syncDeletes = core.getBooleanInput('sync-deletes');
    const autoCommit = core.getBooleanInput('auto-commit');
    const verbose = core.getBooleanInput('verbose');
    const assignmentValues = core.getInput('assignment');

    // 2. Configure Logger
    // We rely on standard console output which Actions captures.
    if (verbose) {
      logger.info('Verbose logging enabled');
    }

    // 3. Load Config & Init Client
    const config = await loadConfig(configFile);
    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

    // 4. Construct Options
    const options: PublishOperationOptions = {
      dryRun,
      syncDeletes,
      autoCommit,
      verbose,
    };

    // Filter assignments if specific one requested
    // Since publish() processes everything in config, we might need to filter the config itself?
    // OR we relies on `reconcile` to filter?
    // `reconcile` iterates `config.assignments`.
    // If I modify `config.assignments` here to only include the requested one, `reconcile` will only see that one.
    // However, `reconcile` also compares with `publish_history`.
    // If we only process one, we shouldn't remove others from history?
    // `reconcile` logic:
    // `for (const assignment of config.assignments)` checks for changes.
    // If I filter `config.assignments`, `reconcile` will only check those.
    // It WON'T detect deletions for missing assignments because it iterates CONFIG assignments.
    // But `reconcile` DOES iterate valid Assignments in config.
    // So filtering config.assignments is safe for "publish specific assignment".

    if (assignmentValues) {
      const filters = assignmentValues.split(',').map((s: string) => s.trim());
      const initialCount = config.assignments.length;
      config.assignments = config.assignments.filter(a => filters.includes(a.name) || filters.includes(a.path));
      logger.info(`Filtered assignments: ${config.assignments.length}/${initialCount} match "${assignmentValues}"`);

      if (config.assignments.length === 0) {
        logger.warn('No assignments matched the filter.');
        core.setOutput('success', 'true'); // Not a failure, just nothing done
        return;
      }
    }

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
