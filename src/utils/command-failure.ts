/**
 * Thrown by command action handlers when a command fails.
 *
 * The command renders its own error message once and throws; the entrypoint
 * (src/index.ts) sets process.exitCode without logging again (AGENTS.md #14).
 *
 * The category, not the command, chooses the exit code. The split that matters
 * to an automated caller is retryable (transient) versus terminal: an hour-long
 * platform outage and a bad token both used to exit 1, so a script could not
 * tell "back off and retry" from "stop and fix your credentials".
 */
export type FailureCategory =
  | 'internal'    // 1 - unexpected; a bug
  | 'usage'       // 2 - bad flags or bad config; do not retry
  | 'auth'        // 3 - credentials rejected or missing
  | 'transient'   // 4 - API 5xx, timeout, rate limit; RETRY
  | 'findings'    // 5 - drift or validation findings left outstanding
  | 'partial';    // 6 - some items succeeded, some failed

const EXIT_CODES: Record<FailureCategory, number> = {
  internal: 1,
  usage: 2,
  auth: 3,
  transient: 4,
  findings: 5,
  partial: 6,
};

export function exitCodeForCategory(category: FailureCategory): number {
  return EXIT_CODES[category];
}

export class CommandFailureError extends Error {
  readonly category: FailureCategory;
  readonly exitCode: number;
  /**
   * True when the command already wrote its --json document before throwing.
   *
   * A command that reports findings writes a `result: "reported"` envelope and
   * then throws so the entrypoint can set exit 5. Without this flag the
   * entrypoint's catch wrote a SECOND envelope, so stdout carried two
   * documents -- breaking the one-document contract -- and the second one said
   * `result: "failed"`, which is wrong: reporting findings is a successful
   * report, not a failure. A consumer reading the last line got the wrong
   * answer.
   */
  readonly reportWritten: boolean;

  constructor(message: string, category: FailureCategory = 'internal', reportWritten = false) {
    super(message);
    this.name = 'CommandFailureError';
    this.category = category;
    this.exitCode = EXIT_CODES[category];
    this.reportWritten = reportWritten;
  }

  /** True for exactly the transient category; mirrored into the JSON envelope. */
  get retryable(): boolean {
    return this.category === 'transient';
  }
}

/**
 * A caller-input problem raised from somewhere that cannot throw
 * CommandFailureError itself — a service, or a validator that runs before any
 * command wrapper is in scope.
 *
 * It exists so such a site can be classified as `usage` (exit 2, "fix your
 * input") instead of collapsing into `internal` (exit 1, "file a bug"). Plain
 * `Error` throws for bad flag combinations were reaching the classifier
 * indistinguishable from genuine crashes.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
