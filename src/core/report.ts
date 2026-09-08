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
  const error = args.error ?? null;
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
 * Serialize fully, then write once.
 *
 * A crash midway through a streamed write would leave half a document on
 * stdout, which is worse for a consumer than a clean failure envelope.
 */
export function writeReport(report: CommandReport): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(report);
  } catch (error) {
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
        message: error instanceof Error ? error.message : 'Unknown serialization error',
        retryable: false,
      },
    };
    serialized = JSON.stringify(fallback);
  }
  process.stdout.write(serialized + '\n');
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
