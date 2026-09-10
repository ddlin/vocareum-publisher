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
import { CommandFailureError, type FailureCategory } from '../utils/command-failure';
import { buildReport, writeReport } from '../core/report';
import type {
  PublishResult, CreatedEntity, UpdatedEntity, SkippedEntity, FailedEntity,
} from '../types/state';
import type { PublishOperationOptions } from '../types/state';
import { planPush, executePush } from '../core/services/push-service';
import { withSession } from '../core/session';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { CollectingEventSink } from '../core/services/event-sink';
import { TeeEventSink } from '../utils/tee-event-sink';
import { InteractivePrompter, NonInteractivePrompter } from '../core/services/context';
import { promptConfirm } from '../utils/prompts';

export interface PublishCommandOptions extends PublishOperationOptions {
  /** Emit a machine-readable report on stdout. Implies non-interactive. */
  json?: boolean;
  /** Internal collector supplied by the CLI wrapper for --json failure envelopes. */
  eventCollector?: CollectingEventSink;
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
 * Push payload shape.
 *
 * PublishResult carries arrays, not counts, and the exit decision needs counts.
 * Both are kept: counts drive the outcome, arrays tell a caller WHICH items
 * failed. `failed[].error` is flattened to a string because JSON.stringify
 * renders an Error as `{}` -- the report exists to explain a failure, so losing
 * the message defeats it.
 */
export interface SerializedPublishResult {
  success: boolean;
  counts: { created: number; updated: number; skipped: number; failed: number };
  created: CreatedEntity[];
  updated: UpdatedEntity[];
  skipped: SkippedEntity[];
  failed: Array<{ type: string; id: string; error: string }>;
}

export function serializePublishResult(result: PublishResult): SerializedPublishResult {
  return {
    success: result.success,
    counts: {
      created: result.created.length,
      updated: result.updated.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    failed: result.failed.map((f: FailedEntity) => ({
      type: String(f.type),
      id: String(f.id),
      error: f.error instanceof Error ? f.error.message : String(f.error),
    })),
  };
}

/**
 * Map a completed push onto an envelope result and an exit category.
 *
 * A push is `partial` whenever anything failed, even if everything failed:
 * per-item failures are not an internal error, and the payload already names
 * them. A push the user declined is a `no-op` -- declining is a choice, not a
 * failure. Precedence is partial > findings > applied > no-op.
 */
/**
 * Project PushPlan down to what a consumer needs.
 *
 * Emitting the plan wholesale put 113 KB on stdout for a 13-assignment course,
 * 95% of it `plan.execution` -- `workingConfig` (the entire config), the
 * reconciliation state and the last history entry. That is internal machinery:
 * no caller needs it, it would grow to roughly a megabyte on a 107-assignment
 * course, and shipping it pins internal shapes into a public schema. The spec
 * calls for explicit projections precisely so an internal refactor cannot
 * silently reshape the contract.
 */
export interface SerializedPushPlan {
  has_changes: boolean;
  summary: string;
  semantic_fingerprint: string;
  intent: unknown;
  preconditions: unknown;
  /**
   * Assignments present in Vocareum with no local counterpart, and config
   * entries whose remote is gone.
   *
   * Lifted out of plan.execution.reconciliation, which this projection
   * otherwise drops. The human path reports orphans ("X has no local
   * counterpart and will be left in place"), so omitting them here gave a
   * --json caller strictly less than a human running the same command -- on
   * exactly the thing AGENTS.md #7 exists to surface, since push never deletes
   * them and someone has to notice.
   */
  orphaned_in_vocareum: unknown[];
  stale_in_config: unknown[];
}

export function serializePushPlan(plan: {
  hasChanges: boolean; summary?: string; semanticFingerprint?: string;
  intent?: unknown; preconditions?: unknown;
  execution?: { reconciliation?: { orphanedInVocareum?: unknown[]; staleInConfig?: unknown[] } };
}): SerializedPushPlan {
  const reconciliation = plan.execution?.reconciliation;
  return {
    has_changes: plan.hasChanges,
    summary: plan.summary ?? '',
    semantic_fingerprint: plan.semanticFingerprint ?? '',
    intent: plan.intent ?? null,
    preconditions: plan.preconditions ?? null,
    orphaned_in_vocareum: reconciliation?.orphanedInVocareum ?? [],
    stale_in_config: reconciliation?.staleInConfig ?? [],
  };
}

export function pushResultToOutcome(
  state: {
    succeeded: number; failed: number; dryRun: boolean; planned: number;
    cancelled?: boolean; success?: boolean;
  }
): { result: 'applied' | 'partial' | 'reported' | 'no-op'; category: FailureCategory | undefined } {
  if (state.failed > 0 || state.success === false) { return { result: 'partial', category: 'partial' }; }
  if (state.cancelled === true) { return { result: 'no-op', category: undefined }; }
  if (state.dryRun) {
    return state.planned > 0
      ? { result: 'reported', category: 'findings' }
      : { result: 'no-op', category: undefined };
  }
  if (state.succeeded > 0) { return { result: 'applied', category: undefined }; }
  return { result: 'no-op', category: undefined };
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
  // Self-contained, like pullCommand and statusCommand: under --json human
  // output must go to stderr even when this is invoked directly (a test, an
  // embedded caller) rather than through the CLI wrapper. Without it,
  // logger.info wrote prose to stdout ahead of the document.
  return logger.withJsonMode(options.json === true, async () => {
    const ctx = resolveWorkspaceContext({ config: options.config, root: options.root });
    await publishCommandLocked(ctx, options);
  });
}

async function publishCommandLocked(
  ctx: WorkspaceContext,
  options: PublishCommandOptions
): Promise<void> {
  const { configPath, workspaceRoot } = ctx;
  // Shared event sink: reporter output joins the same stream as service events,
  // preventing interleaving when Stage 1b processes courses concurrently.
  // Under --json the same stream is needed twice: captured for the report's
  // diagnostics, and rendered to stderr for a human watching a long push.
  const collector = options.eventCollector ?? new CollectingEventSink();
  const events = options.json === true
    ? new TeeEventSink([collector, new LoggerEventSink()])
    : new LoggerEventSink();
  const reporter = new UnknownFieldReporter(events);

  try {
    loadDotEnvIfPresent(path.join(workspaceRoot, '.env'));
    const config = await loadConfig(configPath);
    const throttle = resolveThrottle(config.vocareum.throttle);
    const client = new VocareumClient(
      resolveAuthProvider(options, config.vocareum.api_base_url, events),
      throttle,
      undefined,
      events,
    );

    const requestedAutoCommit = options.autoCommit ?? config.publish_options?.auto_commit ?? false;
    const autoCommit = isCI() ? false : requestedAutoCommit;
    if (isCI() && requestedAutoCommit) {
      logger.warn('Auto-commit is disabled in CI/CD environments.'); // intentional: CI-only guard, non-concurrent command path
    }

    // In CI, always run non-interactive
    // --json never prompts: a blocked prompt hangs an automated caller, and
    // prompt output on stdout would corrupt the document. Adds to the existing
    // rule rather than replacing it, so CI keeps defaulting to non-interactive.
    const nonInteractive = options.json === true || (options.nonInteractive ?? isCI());

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
      deferDeleteResolution: true,
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
          // Wrapped like the executePush path below: returning a bare
          // PublishResult here would make the callback's type a union and
          // neither result.plan nor result.executed would typecheck.
          return {
            plan,
            cancelled: true,
            executed: {
              success: true,
              created: [],
              updated: [],
              skipped: [],
              failed: [],
              contentState: { ...(config.publish_history?.[0]?.content_state) },
              summary: 'Cancelled by user',
            },
          };
        }
      }

      const executed = await executePush(session, pushCtx, req, plan, reporter);
      return { plan, cancelled: false, executed };
    });

    if (options.json === true) {
      const outcome = pushResultToOutcome({
        succeeded: result.executed.created.length + result.executed.updated.length,
        failed: result.executed.failed.length,
        // success is passed as well as the failed count. Every current
        // `success = false` site also pushes a failed entry, but relying on
        // that coupling means a future site that forgets would make --json
        // report a clean success for a failed push.
        success: result.executed.success,
        dryRun: req.dryRun === true,
        planned: result.plan.hasChanges ? 1 : 0,
        cancelled: result.cancelled,
      });
      const ok = writeReport(buildReport({
        command: 'push',
        result: outcome.result,
        payload: {
          payload_schema_version: 1,
          plan: serializePushPlan(result.plan),
          applied: serializePublishResult(result.executed),
        },
        events: collector.drain(),
      }));
      // reportWritten: true -- a document is already on stdout, so the
      // entrypoint must not add a second one.
      if (!ok) {
        throw new CommandFailureError('Push report serialization failed', 'internal', true);
      }
      if (outcome.category !== undefined) {
        throw new CommandFailureError(`Push finished with ${outcome.result}`, outcome.category, true);
      }
      return;
    }

    if (result.executed.success) {
      logger.success('Push completed successfully!');
      if (result.executed.summary) {
        logger.info(result.executed.summary);
      }
    } else {
      logger.error('Push failed with errors.');
      if (result.executed.failed.length > 0) {
        result.executed.failed.forEach(f => {
          const errorMsg = f.error instanceof Error ? f.error.message : String(f.error);
          logger.error(`- ${f.type} ${f.id}: ${errorMsg}`);
        });
      }
      // Rendered above, one line per failure. Throwing CommandFailureError (not
      // a plain Error) keeps the entrypoint silent: a plain Error was caught by
      // the push action in index.ts and logged a second time as
      // "Unhandled error: ...", double-reporting every push failure.
      throw new CommandFailureError('Push completed with errors', 'partial');
    }

  } finally {
    reporter.printSummary();
  }
}
