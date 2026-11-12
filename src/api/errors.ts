/**
 * The base Vocareum error classes. They live apart from `client.ts` so that
 * `deadline.ts` can extend `APIError` while `client.ts` imports `deadline.ts`:
 * with both in `client.ts` the two modules would import each other, and a
 * class that extends a binding from a half-loaded module fails at load time.
 * `client.ts` re-exports both, so existing imports are unchanged.
 */

/**
 * Base error class for Vocareum API errors
 */
export class VocareumError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: unknown
  ) {
    super(message);
    this.name = 'VocareumError';
  }
}

/**
 * Error for general API failures
 */
export class APIError extends VocareumError {
  constructor(
    message: string,
    statusCode?: number,
    details?: unknown,
    public readonly retryable = statusCode !== undefined && statusCode >= 500 && statusCode < 600,
  ) {
    super(message, 'API_ERROR', statusCode, details);
    this.name = 'APIError';
  }
}
