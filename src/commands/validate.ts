/**
 * Validate Command
 *
 * Validate configuration and file structure consistency.
 */

import { loadConfig } from '../core/config';
import { resolveWorkspaceContext } from '../core/workspace';
import { validateWorkspace } from '../core/services/validate-service';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { InteractivePrompter, NonInteractivePrompter } from '../core/services/context';
import { CommandFailureError } from '../utils/command-failure';
import { commandFailureFromError } from '../utils/failure-classifier';
import { CollectingEventSink } from '../core/services/event-sink';
import { TeeEventSink } from '../utils/tee-event-sink';
import { buildReport, writeReport } from '../core/report';
import { logger } from '../utils/logger';

export interface ValidateOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  strict?: boolean;
  vocareum?: boolean;
  /** Emit a machine-readable report on stdout. */
  json?: boolean;
  /** Internal collector supplied by the CLI wrapper for --json failure envelopes. */
  eventCollector?: CollectingEventSink;
}

/**
 * Execute the validate command
 */
export async function validateCommand(options: ValidateOptions): Promise<void> {
  // Self-contained: under --json human output belongs on stderr even when this
  // is called directly rather than through the CLI wrapper.
  return logger.withJsonMode(options.json === true, () => validateCommandInner(options));
}

async function validateCommandInner(options: ValidateOptions): Promise<void> {
  const { configPath, workspaceRoot } = resolveWorkspaceContext({
    config: options.config,
    root: options.root,
  });

  const collector = options.eventCollector ?? new CollectingEventSink();
  const events = options.json === true
    ? new TeeEventSink([collector, new LoggerEventSink()])
    : new LoggerEventSink();

  try {
    events.emit({ level: 'info', message: 'Validating configuration...' });
    const config = await loadConfig(configPath);
    events.emit({ level: 'success', message: 'Configuration is valid.' });

    const ctx = {
      persistedConfig: config,
      effectiveConfig: config,
      configPath,
      workspaceRoot,
      events,
      // A NonInteractivePrompter under --json makes the documented promise
      // ("--json never prompts") structural rather than incidental. Neither
      // service prompts today, so this changes no behavior -- but if one ever
      // gains a prompt, an automated caller would hang forever waiting on
      // stdin. It now fails fast with UnresolvedDecisionError, which the
      // classifier turns into a reported failure instead of a hang.
      prompter: options.json === true ? new NonInteractivePrompter() : new InteractivePrompter(),
    };

    const report = await validateWorkspace(ctx);

    const hasErrors = report.errors.length > 0;
    const hasWarnings = report.warnings.length > 0;
    const failing = hasErrors || (options.strict === true && hasWarnings);

    if (options.json === true) {
      const ok = writeReport(buildReport({
        command: 'validate',
        // `reported` whenever there is anything to say, even non-failing
        // warnings: a caller asked for the findings, and an empty-handed
        // `no-op` would misdescribe a run that found warnings.
        result: (hasErrors || hasWarnings) ? 'reported' : 'no-op',
        payload: {
          payload_schema_version: 1,
          strict: options.strict === true,
          errors: report.errors,
          warnings: report.warnings,
          counts: { errors: report.errors.length, warnings: report.warnings.length },
        },
        events: collector.drain(),
      }));
      // reportWritten: true on both -- the document is already on stdout, so
      // the entrypoint must not add a second one.
      if (!ok) {
        throw new CommandFailureError('Validate report serialization failed', 'internal', true);
      }
      if (failing) {
        throw new CommandFailureError('Validation failed', 'findings', true);
      }
      return;
    }

    if (failing) {
      throw new CommandFailureError('Validation failed', 'findings');
    }

  } catch (error) {
    if (error instanceof CommandFailureError) { throw error; }
    events.emit({ level: 'error', message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
    throw commandFailureFromError(`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`, error);
  }
}
