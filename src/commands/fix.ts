/**
 * Fix Command
 *
 * Interactively fix validation issues.
 */


import * as path from 'path';
import { loadConfig } from '../core/config';
import { assertConfinedToWorkspace, isConfinedToWorkspace } from '../core/local-scan';
import { validateStructure } from '../core/validator';
import { resolveWorkspaceContext } from '../core/workspace';
import { ensureDirectory, pathExists } from '../utils/files';
import { logger } from '../utils/logger';
import { CommandFailureError } from '../utils/command-failure';
import { commandFailureFromError } from '../utils/failure-classifier';
import { CollectingEventSink } from '../core/services/event-sink';
import { buildReport, writeReport } from '../core/report';
import { promptConfirm } from '../utils/prompts';

export interface FixOptions {
  /** Emit a machine-readable report on stdout. Implies non-interactive. */
  json?: boolean;
  /** Internal collector supplied by the CLI wrapper for --json failure envelopes. */
  eventCollector?: CollectingEventSink;
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  nonInteractive?: boolean;
}

/**
 * Execute the fix command
 */
export async function fixCommand(options: FixOptions): Promise<void> {
  return logger.withJsonMode(options.json === true, () => fixCommandInner(options));
}

/**
 * `fixed` / `remaining` are tracked rather than only logged, because the report
 * has to say what actually changed. The three ways an item can remain are kept
 * distinct in `reason`, since they mean different things to a caller:
 * `unfixable` (fix does not handle that error type), `declined` (the operator
 * said no), and `failed` (creation was attempted and errored).
 *
 * Only `failed` makes the run partial. The other two are findings: nothing went
 * wrong, there is simply work left.
 */
async function fixCommandInner(options: FixOptions): Promise<void> {
  const fixed: string[] = [];
  const remaining: Array<{ path: string; reason: 'unfixable' | 'declined' | 'failed'; detail?: string }> = [];
  const collector = options.eventCollector ?? new CollectingEventSink();
  // --json never prompts; a blocked prompt would hang an automated caller.
  const nonInteractive = options.json === true || options.nonInteractive === true;

  const emit = (result: 'applied' | 'partial' | 'reported' | 'no-op'): boolean =>
    writeReport(buildReport({
      command: 'fix',
      result,
      payload: {
        payload_schema_version: 1,
        fixed,
        remaining,
        counts: { fixed: fixed.length, remaining: remaining.length },
      },
      events: collector.drain(),
    }));

  const { configPath, workspaceRoot } = resolveWorkspaceContext({
    config: options.config,
    root: options.root,
  });

  try {
    const config = await loadConfig(configPath);
    logger.info('Analyzing structure...');

    // We pass config and basePath.
    // validateStructure(config, basePath) - ensure validator.ts signature matches
    const result = await validateStructure(config, workspaceRoot);

    if (result.valid) {
      // `valid: true` still permits warnings -- an orphaned folder is one, and
      // the command's own --help lists orphans under what it inspects. Returning
      // a bare no-op here hid them from the report entirely.
      for (const warning of result.warnings ?? []) {
        remaining.push({
          path: warning.path ?? '(unknown)',
          reason: 'unfixable',
          detail: warning.type,
        });
      }
      if (remaining.length === 0) {
        logger.success('No issues found to fix.');
      } else {
        logger.warn(`No fixable issues, but ${remaining.length} warning(s) remain.`);
      }
      if (options.json === true) {
        if (!emit(remaining.length > 0 ? 'reported' : 'no-op')) {
          throw new CommandFailureError('Fix report serialization failed', 'internal', true);
        }
        if (remaining.length > 0) {
          throw new CommandFailureError('Warnings remain that fix cannot repair', 'findings', true);
        }
      }
      return;
    }

    // `fix --help` promises to create required directories that are missing, but
    // this only ever acted on `missing_folder`. A part that declares
    // `directories: [startercode]` with the directory absent produces
    // `invalid_structure`, so the command reported it unfixable and left the
    // directory missing -- the help promised something the command did not do.
    //
    // `invalid_structure` is raised in FOUR places and three of them are
    // path-ESCAPE violations (an assignment, part, or directory path that
    // leaves the workspace). Creating a directory for those would be actively
    // harmful: the validator flags them precisely because they point outside
    // the tree. They cannot be told apart by `type` or `path`, only by prose.
    //
    // So the discriminator is structural rather than a message match: the
    // escape cases are emitted exactly when confinement FAILS, so re-checking
    // confinement separates them. A confined `invalid_structure` whose path
    // does not exist is the missing-directory case and nothing else. Anything
    // unconfined stays unfixable and is never touched.
    const repairable: typeof result.errors = [];
    for (const error of result.errors) {
      if (error.type === 'missing_folder') {
        repairable.push(error);
        continue;
      }
      if (error.type === 'invalid_structure' && error.path !== undefined) {
        const confined = await isConfinedToWorkspace(workspaceRoot, error.path);
        if (confined && !await pathExists(path.resolve(workspaceRoot, error.path))) {
          repairable.push(error);
          continue;
        }
      }
      remaining.push({
        path: error.path ?? '(unknown)',
        reason: 'unfixable',
        detail: error.type,
      });
    }
    const missingFolders = repairable;

    if (missingFolders.length === 0) {
      logger.info('No missing folders to fix.');
      // `remaining` was already populated by the classification loop above;
      // re-adding result.errors here would list every unfixable error twice.
      if (options.json === true) {
        if (!emit(remaining.length > 0 ? 'reported' : 'no-op')) {
          throw new CommandFailureError('Fix report serialization failed', 'internal', true);
        }
        if (remaining.length > 0) {
          throw new CommandFailureError('Issues remain that fix cannot repair', 'findings', true);
        }
      }
      return;
    }

    logger.info(`Found ${missingFolders.length} missing folders.`);

    for (const error of missingFolders) {
      // Fix: "Run: vocgit new ..." or "Create directory: ..."
      // The error object has a 'fix' message, but we want to ACT on it.
      // We can infer the path from `error.path`.

      // Error structure from validator.ts:
      // { type: 'missing_folder', path: 'assignment/part', ... }
      // The `path` in error is relative path.

      const folderPath = error.path;
      // Validator paths are workspace-relative — create under the workspace
      // root, and never outside it (defense in depth: the validator already
      // refuses to classify escaping paths as missing_folder).
      await assertConfinedToWorkspace(workspaceRoot, folderPath);
      const folderAbs = path.resolve(workspaceRoot, folderPath);

      try {
        if (nonInteractive) {
          logger.info(`Creating ${folderPath}...`);
          await ensureDirectory(folderAbs);
          fixed.push(folderPath);
        } else {
          const create = await promptConfirm(`Create missing folder "${folderPath}"?`);
          if (create) {
            await ensureDirectory(folderAbs);
            logger.success(`Created ${folderPath}`);
            fixed.push(folderPath);
          } else {
            remaining.push({ path: folderPath, reason: 'declined' });
          }
        }
      } catch (creationError) {
        // One unwritable folder must not abandon the rest.
        const detail = creationError instanceof Error ? creationError.message : 'Unknown error';
        logger.error(`Could not create ${folderPath}: ${detail}`);
        remaining.push({ path: folderPath, reason: 'failed', detail });
      }
    }

    logger.success('Fix operations completed.');

    if (options.json === true) {
      const anyFailed = remaining.some((r) => r.reason === 'failed');
      const result_ =
        anyFailed ? 'partial'
        : remaining.length > 0 ? 'reported'
        : fixed.length > 0 ? 'applied'
        : 'no-op';
      if (!emit(result_)) {
        throw new CommandFailureError('Fix report serialization failed', 'internal', true);
      }
      if (anyFailed) {
        throw new CommandFailureError('Some fixes could not be applied', 'partial', true);
      }
      if (remaining.length > 0) {
        throw new CommandFailureError('Issues remain after fixing', 'findings', true);
      }
      return;
    }

  } catch (error) {
    if (error instanceof CommandFailureError) { throw error; }
    logger.error(`Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw commandFailureFromError(`Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`, error);
  }
}
