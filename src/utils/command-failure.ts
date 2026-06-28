/**
 * Thrown by command action handlers when a command fails.
 * The command is responsible for logging its own error message before throwing.
 * The entrypoint (src/index.ts) catches this and sets process.exitCode without
 * logging again, preventing double-log.
 */
export class CommandFailureError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = 'CommandFailureError';
  }
}
