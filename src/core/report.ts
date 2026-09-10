/**
 * The --json envelope: one document, written once, to stdout.
 *
 * Two versioned surfaces, deliberately separate: `schema_version` is a STRING
 * versioning this envelope, while each payload carries its own numeric
 * `payload_schema_version`. Adding a diagnostic code bumps the envelope;
 * reshaping pull's payload bumps only pull's.
 */
import { classifyFailure } from '../utils/failure-classifier';
import { CommandFailureError } from '../utils/command-failure';
import { collectDiagnostics, type Diagnostic } from './diagnostics';
import type { CollectingEventSink, ServiceEvent } from './services/event-sink';

export const ENVELOPE_SCHEMA_VERSION = '1.0';

export type CommandName = 'pull' | 'push' | 'status' | 'validate' | 'fix';

/**
 * `partial` is first-class on purpose: without it a push where 7 of 10 uploads
 * landed would serialize as applied/error:null, indistinguishable from clean
 * success unless the caller noticed exit 6 and went digging in the payload.
 */
export type CommandResult = 'applied' | 'partial' | 'reported' | 'no-op' | 'failed';

export interface ReportError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface CommandReport {
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  command: CommandName;
  result: CommandResult;
  generated_at: string;
  retryable: boolean;
  payload: Record<string, unknown>;
  diagnostics: Diagnostic[];
  error: ReportError | null;
}

export function buildReport(args: {
  command: CommandName;
  result: CommandResult;
  payload: Record<string, unknown>;
  events: readonly ServiceEvent[];
  error?: ReportError | null;
}): CommandReport {
  // `partial` and `failed` must always carry an error: the README promises it,
  // and a partial with error:null is indistinguishable from clean success to
  // anyone reading the envelope rather than the exit code. Commands pass a
  // specific summary; this is the safety net so a path that forgets cannot
  // silently break the invariant.
  const error = args.error ?? (
    (args.result === 'partial' || args.result === 'failed')
      ? {
          code: args.result === 'partial' ? 'partial_failure' : 'command_failed',
          message: args.result === 'partial'
            ? 'Some items were applied and some failed; see payload for details'
            : 'The command failed; see payload for details',
          retryable: false,
        }
      : null
  );
  return {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    command: args.command,
    result: args.result,
    generated_at: new Date().toISOString(),
    retryable: error?.retryable ?? false,
    payload: args.payload,
    diagnostics: collectDiagnostics(args.events),
    error,
  };
}

/**
 * Write one JSON document to stdout.
 *
 * The single stdout writer in the codebase, enforced by a guard test. Both
 * writeReport and `--version --json` go through it rather than calling
 * process.stdout.write themselves: stdout is the machine-readable channel, and
 * a second writer is how it came to carry two documents.
 *
 * @returns false when the value could not be serialized.
 */
export function writeJsonDocument(value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  process.stdout.write(serialized + '\n');
  return true;
}

/**
 * Serialize fully, then write once.
 *
 * A crash midway through a streamed write would leave half a document on
 * stdout, which is worse for a consumer than a clean failure envelope.
 *
 * @returns `true` when the report serialized cleanly, `false` when it fell back
 * to a minimal `report_serialization_failed` envelope.
 *
 * **Callers must fail the command when this returns `false`.** It cannot set
 * the exit code itself: `src/index.ts` is the sole owner of `process.exitCode`
 * (AGENTS.md #14), and a guard test fails the build on any `process.exit*`
 * elsewhere. Before this returned anything, a successful command with an
 * unserializable payload printed `"result":"failed"` to stdout and still exited
 * 0 — a caller checking only the exit code saw success while the document it
 * just received said otherwise.
 */
export function writeReport(report: CommandReport): boolean {
  if (writeJsonDocument(report)) { return true; }

  // The report itself could not be serialized (an unserializable payload).
  // Emit a minimal envelope so the caller still receives a document, and report
  // false so it fails the command -- printing "failed" while exiting 0 would be
  // worse than either alone.
  const fallback: CommandReport = {
    schema_version: ENVELOPE_SCHEMA_VERSION,
    command: report.command,
    result: 'failed',
    generated_at: new Date().toISOString(),
    retryable: false,
    payload: {},
    diagnostics: [],
    error: {
      code: 'report_serialization_failed',
      message: 'The report payload could not be serialized to JSON',
      retryable: false,
    },
  };
  writeJsonDocument(fallback);
  return false;
}

/**
 * Run a --json command body so that a failure still produces a document.
 *
 * Without this, a ConfigError or an auth rejection exits non-zero with empty
 * stdout: the caller learns that something broke but not what, and not whether
 * retrying could help -- the exact gap this feature exists to close.
 */
export async function reportingFailures<T>(
  command: CommandName,
  json: boolean,
  collector: CollectingEventSink,
  body: () => Promise<T>
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const category = classifyFailure(error);
    if (json) {
      writeReport(buildReport({
        command,
        result: 'failed',
        payload: {},
        events: collector.drain(),
        error: {
          code: category,
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: category === 'transient',
        },
      }));
    }
    throw error instanceof CommandFailureError
      ? error
      : new CommandFailureError(
          error instanceof Error ? error.message : 'Unknown error', category);
  }
}
