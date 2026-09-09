/**
 * The one place a command's failure becomes an exit category and (under --json)
 * a document.
 *
 * Extracted from src/index.ts so the invariant it enforces can be tested
 * behaviorally. It previously lived inline in the entrypoint, which made it
 * reachable only by spawning the CLI, so its most important property -- that
 * stdout carries exactly ONE document -- was covered by a test that grepped
 * the source for a substring. That is not a test of behavior, and this
 * invariant had already broken once undetected.
 *
 * It does NOT set process.exitCode: it throws, and src/index.ts remains the
 * sole owner of the exit code (AGENTS.md #14).
 */
import { buildReport, type CommandName, writeReport } from '../core/report';
import { CollectingEventSink } from '../core/services/event-sink';
import { CommandFailureError } from './command-failure';
import { commandFailureFromError, reportErrorFromFailure } from './failure-classifier';
import { logger } from './logger';

export async function runCommandWithFailureClassification<TOptions>(
  command: CommandName | undefined,
  options: TOptions,
  action: (collector: CollectingEventSink) => Promise<void>,
  failurePrefix: string,
  payloadSchemaVersion = 1,
): Promise<void> {
  const collector = new CollectingEventSink();
  const json = (options as { json?: boolean }).json === true;
  try {
    await logger.withJsonMode(json, () => action(collector));
  } catch (error) {
    const failure = error instanceof CommandFailureError
      ? error
      : commandFailureFromError(
          `${failurePrefix}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error,
        );

    // A command that already rendered its own message must not be re-logged.
    if (!(error instanceof CommandFailureError)) { logger.error(failure.message); }

    // Skip when the command already emitted its document. A command that
    // reports findings writes `result: "reported"` and then throws to set exit
    // 5; writing again here put TWO documents on stdout, the second wrongly
    // saying `result: "failed"` -- so a consumer reading the last line was told
    // the run failed when it had succeeded at reporting findings.
    if (json && command !== undefined && !failure.reportWritten) {
      writeReport(buildReport({
        command,
        result: 'failed',
        payload: { payload_schema_version: payloadSchemaVersion },
        events: collector.drain(),
        error: reportErrorFromFailure(failure),
      }));
    }
    throw failure;
  }
}
