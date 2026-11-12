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

    // Repair, then validate again: the validator stops descending at a missing
    // assignment or part folder, so creating `lab` is what reveals a missing
    // `lab/part1`, and that a missing `lab/part1/startercode`. A single pass
    // reported a fully repaired workspace that the next `validate` disputed.
    // Each round repairs what is newly visible; a path is attempted once.
    const MAX_ROUNDS = 10;
    const attempted = new Set<string>();
    let result = await validateStructure(config, workspaceRoot);
    for (let round = 0; round < MAX_ROUNDS && !result.valid; round++) {
      // `fix --help` promises to create required directories that are missing,
      // but this only ever acted on `missing_folder`. A part that declares
      // `directories: [startercode]` with the directory absent produces
      // `invalid_structure`, so it was reported unfixable.
      //
      // `invalid_structure` is raised in FOUR places and three of them are
      // path-ESCAPE violations (an assignment, part, or directory path that
      // leaves the workspace). Creating a directory for those would be actively
      // harmful. They cannot be told apart by `type` or `path`, only by prose,
      // so the discriminator is structural: the escape cases are emitted
      // exactly when confinement FAILS. A confined `invalid_structure` whose
      // path does not exist is the missing-directory case and nothing else.
      const repairable: typeof result.errors = [];
      for (const error of result.errors) {
        if (error.path === undefined || attempted.has(error.path)) { continue; }
        if (error.type === 'missing_folder') {
          repairable.push(error);
          continue;
        }
        if (error.type === 'invalid_structure') {
          const confined = await isConfinedToWorkspace(workspaceRoot, error.path);
          if (confined && !await pathExists(path.resolve(workspaceRoot, error.path))) {
            repairable.push(error);
          }
        }
      }
      if (repairable.length === 0) { break; }

      // Parents before children: a folder is asked about before anything inside
      // it, so a "no" is known before a nested repair would create it anyway.
      repairable.sort((a, b) => (a.path ?? '').split('/').length - (b.path ?? '').split('/').length);

      logger.info(`Found ${repairable.length} missing folder(s).`);
      for (const error of repairable) {
        const folderPath = error.path;
        attempted.add(folderPath);
        // Creating anything inside a declined folder would create the declined
        // folder itself (mkdir -p). Respect the "no": skip it, and say why.
        const insideDeclined = remaining.find((r) =>
          r.reason === 'declined' && folderPath.startsWith(`${r.path}/`));
        if (insideDeclined !== undefined) {
          remaining.push({ path: folderPath, reason: 'declined', detail: `inside declined folder ${insideDeclined.path}` });
          continue;
        }
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
          } else if (await promptConfirm(`Create missing folder "${folderPath}"?`)) {
            await ensureDirectory(folderAbs);
            logger.success(`Created ${folderPath}`);
            fixed.push(folderPath);
          } else {
            remaining.push({ path: folderPath, reason: 'declined' });
          }
        } catch (creationError) {
          // One unwritable folder must not abandon the rest.
          const detail = creationError instanceof Error ? creationError.message : 'Unknown error';
          logger.error(`Could not create ${folderPath}: ${detail}`);
          remaining.push({ path: folderPath, reason: 'failed', detail });
        }
      }
      result = await validateStructure(config, workspaceRoot);
    }

    // What is left is what the FINAL validation reports: errors fix did not
    // repair (declined and failed ones are already listed) and warnings, which
    // fix never repairs (an orphaned folder is one; dropping them hid them).
    const listed = new Set(remaining.map((r) => r.path));
    for (const issue of [...result.errors, ...(result.warnings ?? [])]) {
      const issuePath = issue.path ?? '(unknown)';
      if (listed.has(issuePath)) { continue; }
      listed.add(issuePath);
      remaining.push({ path: issuePath, reason: 'unfixable', detail: issue.type });
    }

    const anyFailed = remaining.some((r) => r.reason === 'failed');
    if (anyFailed) {
      logger.warn(`Fixed ${fixed.length}; some folders could not be created (see above).`);
    } else if (fixed.length > 0) {
      logger.success(`Fixed ${fixed.length} issue(s).`);
    } else if (remaining.length === 0) {
      logger.success('No issues found to fix.');
    }
    if (remaining.length > 0 && !anyFailed) {
      logger.warn(`${remaining.length} issue(s) remain that fix did not repair.`);
    }

    if (options.json === true) {
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

    // Human mode: a repair that FAILED is a failure in either mode (exit 6),
    // logged once above per folder. Outstanding findings exit 5 only with
    // --json, so existing scripts that run `fix` keep their exit 0 (spec 5.4).
    if (anyFailed) {
      throw new CommandFailureError('Some fixes could not be applied', 'partial');
    }

  } catch (error) {
    if (error instanceof CommandFailureError) { throw error; }
    logger.error(`Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw commandFailureFromError(`Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`, error);
  }
}
