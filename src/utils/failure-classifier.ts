import { ConfigError } from '../core/config';
import type { ReportError } from '../core/report';
import {
  APIError,
  AuthenticationError,
  ForbiddenError,
  InsecureBaseUrlError,
  NotFoundError,
  RateLimitError,
} from '../api/client';
import { CommandFailureError, UsageError, type FailureCategory } from './command-failure';
import { CredentialsMissingError } from './env';
import { WorkspaceError } from '../core/workspace';

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof CommandFailureError) { return error.category; }
  if (error instanceof ConfigError) { return 'usage'; }
  if (error instanceof WorkspaceError) { return 'usage'; }
  if (error instanceof UsageError) { return 'usage'; }
  if (error instanceof CredentialsMissingError) { return 'auth'; }
  if (error instanceof InsecureBaseUrlError) { return 'usage'; }
  if (error instanceof AuthenticationError) { return 'auth'; }
  if (error instanceof ForbiddenError) { return 'auth'; }
  if (error instanceof RateLimitError) { return 'transient'; }
  // NotFoundError extends VocareumError, NOT APIError, so it does not reach the
  // APIError branch below. A 404 means the config points at a course,
  // assignment, or part that is not there: the caller fixes ids, it does not retry.
  if (error instanceof NotFoundError) { return 'usage'; }
  if (error instanceof APIError) {
    if (error.retryable || (error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode < 600)) {
      return 'transient';
    }
    // A 400 means the request was rejected as invalid, so retrying it unchanged
    // cannot help and the actionable advice is "check your input" (exit 2), not
    // "file a bug" (exit 1). Vocareum answers a nonexistent course_id this way.
    // The tradeoff, accepted deliberately: a malformed payload that is actually
    // vocgit's fault also lands in `usage`. Misdirecting the rarer case is
    // better than telling every user with a wrong id to open an issue -- and the
    // message still says what the API rejected.
    if (error.statusCode === 400) { return 'usage'; }
    return 'internal';
  }
  return 'internal';
}

export function commandFailureFromError(message: string, error: unknown): CommandFailureError {
  if (error instanceof CommandFailureError) { return error; }
  return new CommandFailureError(message, classifyFailure(error));
}

export function reportErrorFromFailure(error: CommandFailureError): ReportError {
  return {
    code: error.category,
    message: error.message,
    retryable: error.retryable,
  };
}
