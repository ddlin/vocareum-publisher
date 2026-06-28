/**
 * Pull Command
 *
 * Interactively handle orphaned assignments (exist in Vocareum but not in local config).
 * Users can import (download content + add to config) or exclude (add to exclusion list).
 */

import * as path from 'path';
import { loadConfig } from '../core/config';
import { resolveWorkspaceContext, type WorkspaceContext } from '../core/workspace';
import { VocareumClient } from '../api/client';
import { resolveAuthProvider } from '../api/auth/cli-auth-options';
import { resolveThrottle } from '../api/throttle';
import { logger } from '../utils/logger';
import { loadDotEnvIfPresent, isCI } from '../utils/env';
import { prompt, promptChoice } from '../utils/prompts';
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';
import { withSession } from '../core/session';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { InteractivePrompter, NonInteractivePrompter } from '../core/services/context';
import type { PullContext } from '../core/services/context';
import type { PullRequest } from '../core/services/types';
import {
  inspectPull,
  applyPull,
  getUniqueDirectoryName,
  validatePullContentFlags,
} from '../core/services/pull-service';
import type {
  PullResolver,
  PullIssueOrphan,
  PullIssueStale,
  PullIssueSettingsDrift,
  PullIssueContentDrift,
  OrphanAction,
  StaleAction,
  SettingsDriftAction,
  ContentDriftAction,
} from '../core/services/pull-service';

// Re-export helpers that tests/other code may import from pull.ts
export {
  slugify,
  getUniqueDirectoryName,
  findExistingImportTarget,
  resolvePartPath,
  getDownloadPlan,
  valuesEqual,
  validatePullContentFlags,
  scopeAssignmentsForContent,
} from '../core/services/pull-service';

export interface PullOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  nonInteractive?: boolean;
  /** Batch mode: apply sensible defaults without prompting (import orphans, pull drift, skip stale) */
  batch?: boolean;
  verbose?: boolean;
  /**
   * Skip re-downloading part content for orphan imports when a matching local
   * directory already has content on disk (e.g. after a prior failed pull).
   */
  skipContent?: boolean;
  /** Opt in to content-drift detection (downloads remote files to diff them). */
  content?: boolean;
  /** Limit --content drift to these assignment name(s) or id(s). Repeatable. */
  assignment?: string[];
  /** Limit --content drift to these part id(s); requires exactly one --assignment. */
  part?: string[];
  auth?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Execute the pull command.
 *
 * The config lock is acquired exactly ONCE — inside pullCommandLocked via
 * withSession — and is held across inspect → apply.  Do NOT add a
 * second withConfigLock wrapper here: withConfigLock is NON-REENTRANT (throws
 * CONFIG_LOCKED if the lock file already exists).
 */
export async function pullCommand(options: PullOptions): Promise<void> {
  const ctx = resolveWorkspaceContext({ config: options.config, root: options.root });
  await pullCommandLocked(ctx, options);
}

async function pullCommandLocked(ctx: WorkspaceContext, options: PullOptions): Promise<void> {
  const { configPath, workspaceRoot } = ctx;
  const batch = options.batch ?? false;
  const nonInteractive = !batch && (options.nonInteractive ?? isCI());
  const verbose = options.verbose ?? false;
  // Shared event sink: reporter output joins the same stream as service events,
  // preventing interleaving when Stage 1b processes courses concurrently.
  const events = new LoggerEventSink();
  const reporter = new UnknownFieldReporter(events);

  try {
    loadDotEnvIfPresent(path.join(workspaceRoot, '.env'));
    const config = await loadConfig(configPath);

    validatePullContentFlags(options);

    const throttle = resolveThrottle(config.vocareum.throttle);
    const client = new VocareumClient(resolveAuthProvider(options, config.vocareum.api_base_url), throttle, undefined, events);

    const pullCtx: PullContext = {
      persistedConfig: config,
      effectiveConfig: config,
      configPath,
      workspaceRoot,
      events,
      prompter: nonInteractive ? new NonInteractivePrompter() : new InteractivePrompter(),
      client,
    };

    const req: PullRequest = {
      batch,
      nonInteractive,
      verbose,
      skipContent: options.skipContent ?? false,
      content: options.content,
      assignment: options.assignment,
      part: options.part,
    };

    logger.info('Scanning for assignment sync issues...');

    await withSession(configPath, async (session) => {
      const inspection = await inspectPull(pullCtx, req, reporter);

      if (!options.content) {
        logger.info('Content drift not checked. Run `vocgit pull --content` to compare file contents (downloads remote files).');
      }

      const hasOrphans = inspection.orphans.length > 0;
      const hasStale = inspection.stale.length > 0;
      const hasSettingsDrift = inspection.settingsDrift.length > 0;
      const hasContentDrift = inspection.contentDrift.length > 0;

      if (!hasOrphans && !hasStale && !hasSettingsDrift && !hasContentDrift) {
        logger.success('No sync issues found.');
        return;
      }

      const resolver: PullResolver = {
        async resolveOrphanAction(_issue: PullIssueOrphan): Promise<OrphanAction> {
          if (batch) {
            pullCtx.events.emit({ level: 'plain', message: '  Importing (batch mode)' });
            return 'import';
          } else if (nonInteractive) {
            pullCtx.events.emit({ level: 'plain', message: '  Skipped (non-interactive mode)' });
            return 'skip';
          } else {
            const choice = await promptChoice('What would you like to do?', [
              'Import to local repository',
              'Exclude (hide from future scans)',
              'Skip (do nothing)',
            ]);
            if (choice === 'Import to local repository') { return 'import'; }
            if (choice === 'Exclude (hide from future scans)') { return 'exclude'; }
            return 'skip';
          }
        },

        async resolveStaleAction(_issue: PullIssueStale): Promise<StaleAction> {
          if (batch) {
            pullCtx.events.emit({ level: 'plain', message: '  Skipped (batch mode)' });
            return 'skip';
          } else if (nonInteractive) {
            pullCtx.events.emit({ level: 'plain', message: '  Skipped (non-interactive mode)' });
            return 'skip';
          } else {
            const choice = await promptChoice('This assignment was deleted from Vocareum. What would you like to do?', [
              'Reset ID (allow re-creation from template)',
              'Remove from config',
              'Exclude (keep in config but skip during sync)',
              'Skip (do nothing)',
            ]);
            if (choice === 'Reset ID (allow re-creation from template)') { return 'reset'; }
            if (choice === 'Remove from config') { return 'remove'; }
            if (choice === 'Exclude (keep in config but skip during sync)') { return 'exclude'; }
            return 'skip';
          }
        },

        async resolveSettingsDriftAction(_issue: PullIssueSettingsDrift): Promise<SettingsDriftAction> {
          if (batch) {
            pullCtx.events.emit({ level: 'plain', message: '  Pulling settings (batch mode)' });
            return 'pull';
          } else if (nonInteractive) {
            pullCtx.events.emit({ level: 'plain', message: '  Skipped (non-interactive mode)' });
            return 'skip';
          } else {
            const choice = await promptChoice('What would you like to do?', [
              'Pull settings from Vocareum (update local config)',
              'Keep local settings (will overwrite Vocareum on next publish)',
              'Skip (do nothing for now)',
            ]);
            if (choice === 'Pull settings from Vocareum (update local config)') { return 'pull'; }
            if (choice === 'Keep local settings (will overwrite Vocareum on next publish)') { return 'keep'; }
            return 'skip';
          }
        },

        async resolveContentDriftAction(_issue: PullIssueContentDrift): Promise<ContentDriftAction> {
          if (batch) {
            pullCtx.events.emit({ level: 'plain', message: '  Pulling content (batch mode)' });
            return 'pull';
          } else if (nonInteractive) {
            pullCtx.events.emit({ level: 'plain', message: '  Skipped (non-interactive mode)' });
            return 'skip';
          } else {
            const choice = await promptChoice('What would you like to do?', [
              'Pull remote files (overwrite local)',
              'Keep local files (will overwrite remote on next push)',
              'Skip (do nothing for now)',
            ]);
            if (choice === 'Pull remote files (overwrite local)') { return 'pull'; }
            if (choice === 'Keep local files (will overwrite remote on next push)') { return 'keep'; }
            return 'skip';
          }
        },

        async resolveImportPath(_issue: PullIssueOrphan, suggestedName: string): Promise<string> {
          return getUniqueDirectoryName(workspaceRoot, (await prompt('Local directory name:', suggestedName)) || suggestedName);
        },
      };

      const pullResult = await applyPull(session, pullCtx, req, inspection, resolver, reporter);

      // Print summary
      logger.newline();
      logger.info('Summary:');
      logger.plain(`  Imported:        ${pullResult.imported}`);
      logger.plain(`  Settings pulled: ${pullResult.settingsPulled}`);
      logger.plain(`  Content pulled:  ${pullResult.contentPulled}`);
      logger.plain(`  Excluded:        ${pullResult.excluded}`);
      logger.plain(`  Removed:         ${pullResult.removed}`);
      logger.plain(`  Reset:           ${pullResult.reset}`);
      logger.plain(`  Skipped:         ${pullResult.skipped}`);
    });
  } finally {
    reporter.printSummary();
  }
}
