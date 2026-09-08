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
import { CommandFailureError, type FailureCategory } from './command-failure';

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof CommandFailureError) { return error.category; }
  if (error instanceof ConfigError) { return 'usage'; }
  if (error instanceof InsecureBaseUrlError) { return 'usage'; }
  if (error instanceof AuthenticationError) { return 'auth'; }
  if (error instanceof ForbiddenError) { return 'auth'; }
  if (error instanceof RateLimitError) { return 'transient'; }
  // NotFoundError extends VocareumError, NOT APIError, so it does not reach the
  // APIError branch below. A 404 means the config points at a course,
  // assignment, or part that is not there: the caller fixes ids, it does not retry.
  if (error instanceof NotFoundError) { return 'usage'; }
  if (error instanceof APIError) {
    return error.retryable || (error.statusCode !== undefined && error.statusCode >= 500 && error.statusCode < 600)
      ? 'transient'
      : 'internal';
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
