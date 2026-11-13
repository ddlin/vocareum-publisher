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
import { resolvePullZipSettings } from '../utils/zip-switches';
import { prompt, promptChoice } from '../utils/prompts';
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';
import { withSession } from '../core/session';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { CollectingEventSink } from '../core/services/event-sink';
import { TeeEventSink } from '../utils/tee-event-sink';
import { buildReport, writeReport } from '../core/report';
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
  PullResult,
  PullInspection,
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
import { CommandFailureError, type FailureCategory } from '../utils/command-failure';
import type { EventSink } from '../core/services/event-sink';
import type { AssignmentContentDrift } from '../core/services/pull-service';
import { resolveCourseRootEvidence, type RootEvidence } from '../core/course-architecture';
import { listDirectoryBounded } from '../api/content';

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

/** Root listing cap, as in the push guard: more names than this is not evidence. */
const ROOT_LISTING_CAP = 1000;

const ASNLIB_PUSH_NOTE =
  'Note: push refuses `asnlib` on this course, so keeping local `asnlib` files will not overwrite the remote.';

/**
 * True when the assignment's drift touches `asnlib`: a differing file under it,
 * or a directory an earlier pull left incomplete. Remote paths in a part's
 * drift begin with their directory name.
 */
export function driftIncludesAsnlib(drift: AssignmentContentDrift): boolean {
  return drift.partsDrift.some(part =>
    part.fileDiffs.some(f => f.filePath.split('/')[0] === 'asnlib') ||
    (part.incompleteDirectories ?? []).includes('asnlib') ||
    (part.stillIncompleteDirectories ?? []).includes('asnlib'));
}

/** Dependencies of the content-drift prompt; the command layer owns the client. */
export interface ContentDriftPromptDeps {
  batch: boolean;
  nonInteractive: boolean;
  events: EventSink;
  /** Looks up the course root evidence; called only when the prompt is about to be shown for asnlib drift. */
  lookupRootEvidence: (issue: PullIssueContentDrift) => Promise<RootEvidence>;
  ask?: typeof promptChoice;
}

/**
 * The drift prompt's course-root lookup. The drift's own part is a part of the
 * destination course, so its root is what the push guard would list; the
 * listing names the drift's own assignment and part IDs.
 *
 * @param client - The Vocareum client.
 * @param courseId - The destination course ID (string).
 * @param cache - Per-run evidence cache, shared with nothing else in pull.
 */
export function rootEvidenceLookup(
  client: VocareumClient,
  courseId: string,
  cache: Map<string, RootEvidence>,
): (issue: PullIssueContentDrift) => Promise<RootEvidence> {
  return (issue) => resolveCourseRootEvidence(
    (partId) => listDirectoryBounded(
      client, courseId, issue.drift.assignmentId, partId, '/', { remaining: ROOT_LISTING_CAP },
    ),
    issue.drift.partsDrift[0]?.partId,
    cache,
    courseId,
  );
}

/**
 * Decides one assignment's content-drift action. Under --batch and
 * non-interactive mode nothing is asked and no lookup runs. Interactively, when
 * the drift includes `asnlib` and the course is not positively Elite (including
 * a failed lookup), a note is added before the unchanged question, because
 * "Keep local files (will overwrite remote on next push)" is false for it.
 */
export async function chooseContentDriftAction(
  issue: PullIssueContentDrift,
  deps: ContentDriftPromptDeps,
): Promise<ContentDriftAction> {
  if (deps.batch) {
    deps.events.emit({ level: 'plain', message: '  Pulling content (batch mode)' });
    return 'pull';
  }
  if (deps.nonInteractive) {
    deps.events.emit({ level: 'plain', message: '  Skipped (non-interactive mode)' });
    return 'skip';
  }
  if (driftIncludesAsnlib(issue.drift)) {
    let evidence: RootEvidence;
    try {
      evidence = await deps.lookupRootEvidence(issue);
    } catch {
      // Not positively Elite: show the note and let the pull continue.
      evidence = { kind: 'unknown', detail: 'the lookup failed' };
    }
    if (evidence.kind !== 'elite') {
      deps.events.emit({ level: 'plain', message: ASNLIB_PUSH_NOTE });
    }
  }
  const choice = await (deps.ask ?? promptChoice)('What would you like to do?', [
    'Pull remote files (overwrite local)',
    'Keep local files (will overwrite remote on next push)',
    'Skip (do nothing for now)',
  ]);
  if (choice === 'Pull remote files (overwrite local)') { return 'pull'; }
  if (choice === 'Keep local files (will overwrite remote on next push)') { return 'keep'; }
  return 'skip';
}

/**
 * Map a completed pull onto an envelope result and an exit category.
 *
 * Findings that were resolved are not findings: a batch pull that applies
 * settings drift is success, while non-interactive mode reporting the same
 * drift exits 5 because work remains for the caller.
 */
export function pullResultToOutcome(
  applied: PullResult,
  state: { hasFindings: boolean; failures: number }
): { result: 'applied' | 'partial' | 'reported' | 'no-op'; category: FailureCategory | undefined } {
  const changed =
    applied.imported + applied.excluded + applied.removed +
    applied.reset + applied.settingsPulled + applied.contentPulled;

  if (state.failures > 0) { return { result: 'partial', category: 'partial' }; }
  if (state.hasFindings) { return { result: 'reported', category: 'findings' }; }
  if (changed > 0) { return { result: 'applied', category: undefined }; }
  return { result: 'no-op', category: undefined };
}

const EMPTY_PULL_RESULT: PullResult = {
  imported: 0,
  excluded: 0,
  skipped: 0,
  removed: 0,
  reset: 0,
  settingsPulled: 0,
  contentPulled: 0,
  filesNotDownloaded: 0,
  importsFailed: 0,
};

/**
 * The public shape of a pull inspection (spec section 3.3: an explicit
 * projection, never an internal type). The inspection carries every
 * downloaded remote file (`remoteFiles`, Buffers) so apply can write them;
 * serialized raw, `pull --content --json` put the course's files on stdout.
 * The document keeps the diff (paths and statuses) and a count.
 */
export function serializePullInspection(inspection: PullInspection): unknown {
  return {
    ...inspection,
    contentDrift: inspection.contentDrift.map((assignment) => ({
      ...assignment,
      partsDrift: assignment.partsDrift.map(({ remoteFiles, ...part }) => ({
        ...part,
        remoteFileCount: Object.keys(remoteFiles).length,
      })),
    })),
  };
}

export interface PullOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  nonInteractive?: boolean;
  /** Emit a machine-readable report on stdout. Implies nonInteractive. */
  json?: boolean;
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
  /** Internal collector supplied by the CLI wrapper for --json failure envelopes. */
  eventCollector?: CollectingEventSink;
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
  return logger.withJsonMode(options.json === true, async () => {
    const ctx = resolveWorkspaceContext({ config: options.config, root: options.root });
    await pullCommandLocked(ctx, options);
  });
}

async function pullCommandLocked(ctx: WorkspaceContext, options: PullOptions): Promise<void> {
  const { configPath, workspaceRoot } = ctx;
  const batch = options.batch ?? false;
  // --json never prompts: prompt output would corrupt stdout and a blocked
  // prompt would hang an automated caller.
  const nonInteractive = options.json === true || (!batch && (options.nonInteractive ?? isCI()));
  const verbose = options.verbose ?? false;
  // Shared event sink: reporter output joins the same stream as service events,
  // preventing interleaving when Stage 1b processes courses concurrently.
  const collector = options.eventCollector ?? new CollectingEventSink();
  const events = options.json === true
    ? new TeeEventSink([collector, new LoggerEventSink()])
    : new LoggerEventSink();
  const reporter = new UnknownFieldReporter(events);

  // Set inside the session; acted on after it closes so imports already
  // written are kept and the lock is released before we fail the command.
  const incomplete: string[] = [];

  try {
    loadDotEnvIfPresent(path.join(workspaceRoot, '.env'));
    // Validated before auth or any request so a typo fails fast. A bare
    // ConfigError (not CommandFailureError) classifies as usage, exit 2.
    const zip = resolvePullZipSettings();
    const config = await loadConfig(configPath);

    validatePullContentFlags(options);

    const throttle = resolveThrottle(config.vocareum.throttle);
    const client = new VocareumClient(
      resolveAuthProvider(options, config.vocareum.api_base_url, events),
      throttle,
      undefined,
      events,
    );

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
      zip,
    };

    logger.info('Scanning for assignment sync issues...');

    const sessionOutcome = await withSession(configPath, async (session) => {
      const inspection = await inspectPull(pullCtx, req, reporter);

      if (!options.content) {
        logger.info('Content drift not checked. Run `vocgit pull --content` to compare file contents (downloads remote files).');
      }

      const hasOrphans = inspection.orphans.length > 0;
      const hasStale = inspection.stale.length > 0;
      const hasSettingsDrift = inspection.settingsDrift.length > 0;
      const hasContentDrift = inspection.contentDrift.length > 0;
      const contentSkipped = inspection.contentDriftIncomplete ?? [];
      if (contentSkipped.length > 0) {
        incomplete.push(
          `content drift check skipped for ${contentSkipped.length} assignment(s): ` +
          contentSkipped.map(d => `"${d.assignmentName}"`).join(', ')
        );
      }
      const settingsSkipped = inspection.settingsDriftIncomplete ?? [];
      if (settingsSkipped.length > 0) {
        incomplete.push(
          `settings could not be read for ${settingsSkipped.length} assignment(s): ` +
          settingsSkipped.map(d => `"${d.assignmentName}"`).join(', ')
        );
      }
      const driftSkipped = [...contentSkipped, ...settingsSkipped];

      if (!hasOrphans && !hasStale && !hasSettingsDrift && !hasContentDrift) {
        // A skipped drift check is "unknown", not "clean": this line once
        // reported a workspace missing 1,374 files as in sync.
        if (driftSkipped.length === 0) {
          logger.success('No sync issues found.');
        }
        return { inspection, pullResult: EMPTY_PULL_RESULT };
      }

      const rootEvidenceCache = new Map<string, RootEvidence>();
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

        async resolveContentDriftAction(issue: PullIssueContentDrift): Promise<ContentDriftAction> {
          return chooseContentDriftAction(issue, {
            batch,
            nonInteractive,
            events: pullCtx.events,
            lookupRootEvidence: rootEvidenceLookup(client, config.vocareum.course_id, rootEvidenceCache),
          });
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
      if (pullResult.importsFailed > 0) {
        logger.plain(`  Import failed:   ${pullResult.importsFailed}`);
        incomplete.push(`${pullResult.importsFailed} import(s) failed`);
      }
      if (pullResult.filesNotDownloaded > 0) {
        logger.plain(`  Not downloaded:  ${pullResult.filesNotDownloaded}`);
        incomplete.push(`${pullResult.filesNotDownloaded} file(s) could not be downloaded`);
      }

      return { inspection, pullResult };
    });

    if (options.json === true) {
      const { inspection, pullResult } = sessionOutcome;
      // hasFindings must mean "something is STILL outstanding", not "something
      // was found". Reading it off the pre-apply inspection made
      // `pull --batch --json` report result "reported" / exit 5 after
      // successfully applying every one of those findings -- precisely the case
      // spec §5.1 exists to rule out ("findings that were resolved are not
      // findings"), and the reason exit 5 stays meaningful.
      //
      // `skipped` is the honest signal: whatever the resolver declined to
      // apply. Non-interactive skips everything, so findings stand. Batch
      // applies orphans and drift but skips stale by design, so a run with
      // stale entries still reports them -- correctly, since a stale entry IS
      // work left for the operator.
      const outcome = pullResultToOutcome(pullResult, {
        hasFindings: pullResult.skipped > 0,
        // Each entry is a per-item failure: a failed import, files that did
        // not download, or a drift check that was skipped (unknown, not
        // clean). Any of them makes the run partial, never success.
        failures: incomplete.length,
      });
      const ok = writeReport(buildReport({
        command: 'pull',
        result: outcome.result,
        payload: { payload_schema_version: 1, inspection: serializePullInspection(inspection), applied: pullResult },
        events: collector.drain(),
      }));
      // reportWritten: true on both throws -- a document is already on stdout
      // (the fallback envelope in the !ok case), so the entrypoint must not
      // write a second one.
      if (!ok) {
        throw new CommandFailureError('Pull report serialization failed', 'internal', true);
      }
      if (outcome.category !== undefined) {
        throw new CommandFailureError(`Pull finished with ${outcome.result}`, outcome.category, true);
      }
      return;
    }
  } finally {
    reporter.printSummary();
  }

  if (incomplete.length > 0) {
    // Per-item failures: partial (exit 6), the same code --json gives.
    const msg = `Pull incomplete: ${incomplete.join('; ')}. See the warnings above.`;
    logger.error(msg);
    throw new CommandFailureError(msg, 'partial');
  }
}
