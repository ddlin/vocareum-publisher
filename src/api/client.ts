/**
 * Vocareum API Client
 *
 * Base HTTP client for Vocareum API with authentication and error handling.
 *
 * CRITICAL: All IDs are strings, not numbers!
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { logger } from '../utils/logger';

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
  constructor(message: string, statusCode?: number, details?: unknown) {
    super(message, 'API_ERROR', statusCode, details);
    this.name = 'APIError';
  }
}

/**
 * Error for authentication failures
 */
export class AuthenticationError extends VocareumError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

/**
 * Error for rate limiting
 */
export class RateLimitError extends VocareumError {
  constructor(retryAfter?: number) {
    super(
      `Rate limit exceeded${retryAfter !== undefined ? `. Retry after ${retryAfter} seconds` : ''}`,
      'RATE_LIMIT',
      429
    );
    this.name = 'RateLimitError';
  }
}

/**
 * Error for not found resources
 */
export class NotFoundError extends VocareumError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

/**
 * Error for forbidden access (403)
 */
export class ForbiddenError extends VocareumError {
  constructor(message: string, public resource?: string) {
    const hint = resource
      ? `\n\nPossible causes:\n` +
        `  - Your API token doesn't have access to this ${resource}\n` +
        `  - The ${resource} was deleted or moved to another org\n` +
        `  - Your permissions were revoked\n\n` +
        `To fix:\n` +
        `  1. Verify the ${resource} exists in Vocareum web UI\n` +
        `  2. Check that your account has instructor/admin access\n` +
        `  3. Generate a new token: Profile > Settings > Personal Access Tokens`
      : '';
    super(message + hint, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

/**
 * Error for insecure API base URL configuration
 */
export class InsecureBaseUrlError extends VocareumError {
  constructor(url: string) {
    super(
      `Insecure API base URL: "${url}". ` +
      `Only https://api.vocareum.com is allowed by default. ` +
      `Set VOCAREUM_ALLOW_CUSTOM_BASE_URL=1 to override (use with caution).`,
      'INSECURE_BASE_URL'
    );
    this.name = 'InsecureBaseUrlError';
  }
}

/** Canonical, allowed (host, version-path) base URLs. */
const ALLOWED_BASE_URLS: ReadonlySet<string> = new Set([
  'https://api.vocareum.com/api/v2',
  'https://labs.vocareum.com/api/v3',
]);

/** Append /api/v2 when the base URL carries no /api/vN version path. */
export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v2`;
}

/**
 * Validate a base URL is safe to send credentials to: HTTPS + an allowed
 * (host, version-path) pair, unless VOCAREUM_ALLOW_CUSTOM_BASE_URL=1.
 */
export function assertAllowedBaseUrl(baseUrl: string): void {
  const allowCustom = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL === '1';
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new InsecureBaseUrlError(baseUrl); }
  if (parsed.protocol !== 'https:') {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    logger.warn(`WARNING: Using non-HTTPS API URL: ${baseUrl}`);
    return;
  }
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  if (!ALLOWED_BASE_URLS.has(canonical)) {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    logger.warn(`WARNING: Using non-standard API base URL: ${canonical}. Your credentials will be sent to this host.`);
  }
}

/**
 * Retry options for API requests
 */
interface RetryOptions {
  maxRetries?: number;
  backoff?: number;
}

/**
 * Check if an error is retryable
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status !== undefined && status >= 500 && status < 600) {
      return true;
    }
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return true;
    }
  }
  return false;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitize request config for logging (redact API keys)
 */
function sanitizeForLog(config: AxiosRequestConfig): unknown {
  const sanitized = { ...config };
  if (sanitized.headers) {
    sanitized.headers = { ...sanitized.headers };
    if (typeof sanitized.headers['Authorization'] === 'string') {
      sanitized.headers['Authorization'] = '[REDACTED]';
    }
  }
  return sanitized;
}

/**
 * Vocareum API Client
 *
 * Provides typed interface to Vocareum REST API with:
 * - Authentication (API key injection)
 * - Error handling and retry logic
 * - Rate limiting and backoff
 * - Request/response logging (with credential redaction)
 */
export class VocareumClient {
  private axios: AxiosInstance;
  private apiKey: string;

  constructor(apiKey: string, baseUrl: string = 'https://api.vocareum.com') {
    const normalized = normalizeApiBaseUrl(baseUrl);
    assertAllowedBaseUrl(normalized);
    this.apiKey = apiKey;
    this.axios = axios.create({
      baseURL: normalized,
      timeout: 30000,
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Make an authenticated request to the Vocareum API
   *
   * @param config - Axios request configuration
   * @returns Response data
   * @throws VocareumError on failure
   */
  public async request<T>(
    config: AxiosRequestConfig,
    options: RetryOptions = {}
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const backoff = options.backoff ?? 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        logger.debug('API request', sanitizeForLog(config));
        const response = await this.axios.request<T>(config);
        logger.debug(`API response: ${response.status}`, { data: response.data });
        return response.data;
      } catch (error) {
        const wrappedError = this.wrapError(error);

        if (attempt === maxRetries - 1 || !isRetryable(wrappedError)) {
          throw wrappedError;
        }

        const waitTime = backoff * Math.pow(2, attempt);
        logger.debug(`Retrying in ${waitTime}ms (attempt ${attempt + 1}/${maxRetries})`);
        await sleep(waitTime);
      }
    }

    // Should never reach here, but TypeScript requires it
    throw new APIError('Max retries exceeded');
  }

  /**
   * Wrap axios errors into VocareumError types
   */
  private wrapError(error: unknown): VocareumError {
    if (error instanceof VocareumError) {
      return error;
    }

    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const data = error.response?.data as { message?: string; error?: { message?: string } } | undefined;
      // Vocareum API returns errors as { error: { message: "..." } } or { message: "..." }
      const message = data?.error?.message ?? data?.message ?? error.message;

      // Try to detect resource type from URL for better error messages
      const url = error.config?.url ?? '';
      const resourceType = this.detectResourceType(url);

      switch (status) {
        case 401:
          return new AuthenticationError(
            message + '\n\nYour API token may be invalid or expired. ' +
            'Generate a new token at: Profile > Settings > Personal Access Tokens'
          );
        case 403:
          return new ForbiddenError(message, resourceType);
        case 404:
          return new NotFoundError(resourceType || 'Resource', 'unknown');
        case 429:
          return new RateLimitError();
        default:
          return new APIError(message, status, data);
      }
    }

    if (error instanceof Error) {
      return new APIError(error.message);
    }

    return new APIError('Unknown error');
  }

  /**
   * Detect resource type from API URL for better error messages
   */
  private detectResourceType(url: string): string | undefined {
    if (url.includes('/parts/')) { return 'part'; }
    if (url.includes('/assignments/')) { return 'assignment'; }
    if (url.includes('/courses/')) { return 'course'; }
    if (url.includes('/orgs/')) { return 'organization'; }
    return undefined;
  }

  /**
   * Get API key (for testing - never log this!)
   */
  protected getApiKey(): string {
    return this.apiKey;
  }
}
