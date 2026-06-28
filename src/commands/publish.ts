/**
 * Publish Command
 *
 * Main command to publish assignments to Vocareum.
 */

import { loadConfig } from '../core/config';
import { resolveWorkspaceContext, type WorkspaceContext } from '../core/workspace';
import * as path from 'path';
import { VocareumClient } from '../api/client';
import { resolveAuthProvider } from '../api/auth/cli-auth-options';
import { resolveThrottle } from '../api/throttle';
import { logger } from '../utils/logger';
import { loadDotEnvIfPresent, isCI } from '../utils/env';
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';
import type { PublishOperationOptions } from '../types/state';
import { planPush, executePush } from '../core/services/push-service';
import { withSession } from '../core/session';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { InteractivePrompter, NonInteractivePrompter } from '../core/services/context';
import { promptConfirm } from '../utils/prompts';

export interface PublishCommandOptions extends PublishOperationOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  dryRun?: boolean;
  verbose?: boolean;
  auth?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Execute the publish command.
 *
 * The config lock is acquired exactly ONCE — inside publishCommandLocked via
 * withSession — and is held across plan → confirm → execute.  Do NOT add a
 * second withConfigLock wrapper here: withConfigLock is NON-REENTRANT (throws
 * CONFIG_LOCKED if the lock file already exists).
 */
export async function publishCommand(options: PublishCommandOptions): Promise<void> {
  const ctx = resolveWorkspaceContext({ config: options.config, root: options.root });
  await publishCommandLocked(ctx, options);
}

async function publishCommandLocked(
  ctx: WorkspaceContext,
  options: PublishCommandOptions
): Promise<void> {
  const { configPath, workspaceRoot } = ctx;
  // Shared event sink: reporter output joins the same stream as service events,
  // preventing interleaving when Stage 1b processes courses concurrently.
  const events = new LoggerEventSink();
  const reporter = new UnknownFieldReporter(events);

  try {
    loadDotEnvIfPresent(path.join(workspaceRoot, '.env'));
    const config = await loadConfig(configPath);
    const throttle = resolveThrottle(config.vocareum.throttle);
    const client = new VocareumClient(resolveAuthProvider(options, config.vocareum.api_base_url), throttle);

    const requestedAutoCommit = options.autoCommit ?? config.publish_options?.auto_commit ?? false;
    const autoCommit = isCI() ? false : requestedAutoCommit;
    if (isCI() && requestedAutoCommit) {
      logger.warn('Auto-commit is disabled in CI/CD environments.'); // intentional: CI-only guard, non-concurrent command path
    }

    // In CI, always run non-interactive
    const nonInteractive = options.nonInteractive ?? isCI();

    const req = {
      dryRun: options.dryRun ?? false,
      verbose: options.verbose ?? false,
      nonInteractive,
      autoCommit,
      syncDeletes: options.syncDeletes ?? config.publish_options?.sync_deletes ?? false,
      onMissingId: options.onMissingId ?? config.publish_options?.on_missing_id ?? 'skip',
      abortOnError: options.abortOnError ?? config.publish_options?.abort_on_error ?? false,
      assignment: options.assignment,
      part: options.part,
      forceAll: options.forceAll ?? false,
    };

    const pushCtx = {
      persistedConfig: config,
      effectiveConfig: config,
      configPath,
      workspaceRoot,
      events,
      prompter: nonInteractive ? new NonInteractivePrompter() : new InteractivePrompter(),
      client,
    };

    logger.info(`Starting push for course ${config.vocareum.course_id}...`);
    if (req.dryRun === true) {
      logger.info('DRY RUN MODE: No changes will be applied.');
    }

    // Open one session: plan → confirm (interactive only) → execute
    const result = await withSession(configPath, async (session) => {
      const plan = await planPush(pushCtx, req);

      // Interactive confirmation — only when not non-interactive/CI and there are changes.
      // plan.hasChanges is the authoritative flag (covers course-settings-only,
      // ID-discovery, and errors-only runs, not just assignment intent length).
      if (!nonInteractive && !req.dryRun && plan.hasChanges) {
        logger.newline();
        const confirmed = await promptConfirm('Proceed with push?', true);
        if (!confirmed) {
          logger.warn('Push cancelled by user.');
          return {
            success: true,
            created: [],
            updated: [],
            skipped: [],
            failed: [],
            contentState: { ...(config.publish_history?.[0]?.content_state) },
            summary: 'Cancelled by user',
          };
        }
      }

      return executePush(session, pushCtx, req, plan, reporter);
    });

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
