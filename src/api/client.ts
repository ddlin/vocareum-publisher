/**
 * Vocareum API Client
 *
 * Base HTTP client for Vocareum API with authentication and error handling.
 *
 * CRITICAL: All IDs are strings, not numbers!
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { logger } from '../utils/logger';
import type { AuthProvider } from './auth/auth-provider';

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
      `Only https://api.vocareum.com and https://labs.vocareum.com are allowed by default. ` +
      `Set VOCAREUM_ALLOW_CUSTOM_BASE_URL=1 to override (use with caution).`,
      'INSECURE_BASE_URL'
    );
    this.name = 'InsecureBaseUrlError';
  }
}

/** True for a raw upstream API response 401 — NOT a token-exchange/auth-acquisition
 *  failure (which is not an AxiosError carrying a 401 response). */
function isRawApiResponse401(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 401;
}

type ApiUnauthorizedFlag = { isApiResponseUnauthorized?: boolean };

/** Canonical, allowed (host, version-path) base URLs, split by API version so
 *  an auth mode can be bound to its host (token→v2, oauth→v3). */
const ALLOWED_V2_BASE_URLS: ReadonlySet<string> = new Set([
  'https://api.vocareum.com/api/v2',
]);
const ALLOWED_V3_BASE_URLS: ReadonlySet<string> = new Set([
  'https://labs.vocareum.com/api/v3',
]);
const ALLOWED_BASE_URLS: ReadonlySet<string> = new Set([
  ...ALLOWED_V2_BASE_URLS,
  ...ALLOWED_V3_BASE_URLS,
]);

/** Append /api/v2 when the base URL carries no /api/vN version path.
 *  Note: a bare host always normalizes to /api/v2 (the default). The v3 host
 *  (labs.vocareum.com) must be passed with its full /api/v3 path; a bare labs
 *  host would normalize to /api/v2 and then fail assertAllowedBaseUrl. */
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
    // Non-HTTPS is only reachable with the explicit override; skip the path
    // allowlist check since TLS is already absent (dev/test escape hatch).
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
 * Bind an auth mode to its API host: token auth must target the v2 host, OAuth
 * must target the v3 host. Prevents sending a Bearer token to the v2 host (or a
 * personal Token to v3) when a crossed base-URL override (e.g.
 * VOCAREUM_API_V3_BASE_URL pointed at the v2 host) slips past the union
 * allowlist. HTTPS + exact (host, version-path) match required, unless
 * VOCAREUM_ALLOW_CUSTOM_BASE_URL=1.
 */
export function assertBaseUrlForVersion(baseUrl: string, version: 'v2' | 'v3'): void {
  const allowed = version === 'v2' ? ALLOWED_V2_BASE_URLS : ALLOWED_V3_BASE_URLS;
  const allowCustom = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL === '1';
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new InsecureBaseUrlError(baseUrl); }
  if (parsed.protocol !== 'https:') {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    logger.warn(`WARNING: Using non-HTTPS API URL: ${baseUrl}`);
    return;
  }
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  if (!allowed.has(canonical)) {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    logger.warn(`WARNING: Using non-standard ${version} API base URL: ${canonical}. Your credentials will be sent to this host.`);
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
  if (error instanceof VocareumError) {
    const status = error.statusCode;
    if (status !== undefined && status >= 500 && status < 600) {
      return true;
    }
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

const REDACT_KEY = /^(authorization|client_secret|access_token|refresh_token|id_token|password|secret|token)$/i;
const REDACT_FORM_PARAM = /((?:^|&)(?:authorization|client_secret|access_token|refresh_token|id_token|password|secret|token)=)[^&]*/gi;

/**
 * Sanitize a value for logging (redact secrets recursively in objects, arrays, and form strings)
 */
export function sanitizeForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') { return value.replace(REDACT_FORM_PARAM, '$1[REDACTED]'); }
  if (Array.isArray(value)) { return value.map((v) => sanitizeForLog(v, seen)); }
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) { return '[Circular]'; }
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[REDACTED]' : sanitizeForLog(v, seen);
    }
    return out;
  }
  return value;
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
  private authProvider: AuthProvider;

  constructor(authProvider: AuthProvider) {
    assertAllowedBaseUrl(authProvider.apiBaseUrl);
    this.authProvider = authProvider;
    this.axios = axios.create({
      baseURL: authProvider.apiBaseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    // Inject the auth header per request (async: OAuth may exchange/cache a token).
    this.axios.interceptors.request.use(async (config) => {
      config.headers.set('Authorization', await this.authProvider.getAuthorizationHeader());
      return config;
    });
  }

  /**
   * Make an authenticated request to the Vocareum API.
   *
   * Wraps `attempt` to handle a single refresh-and-retry on an upstream API
   * 401 response. The "was this an API 401?" signal is carried as a flag on
   * the thrown error (not instance state) so concurrent requests cannot race.
   *
   * @param config - Axios request configuration
   * @returns Response data
   * @throws VocareumError on failure
   */
  public async request<T>(config: AxiosRequestConfig, options: RetryOptions = {}): Promise<T> {
    try {
      return await this.attempt<T>(config, options);
    } catch (err) {
      const apiUnauthorized = (err as ApiUnauthorizedFlag).isApiResponseUnauthorized === true;
      if (apiUnauthorized && this.authProvider.refreshAfterUnauthorized) {
        await this.authProvider.refreshAfterUnauthorized();
        // The post-refresh attempt uses the normal retry budget (429/5xx/network);
        // the 401-refresh itself happens at most once per request() call.
        return await this.attempt<T>(config, options);   // exactly one refresh+retry
      }
      throw err;
    }
  }

  /**
   * Inner retry loop — retries on 429/5xx up to maxRetries times.
   * On a raw API 401, sets `isApiResponseUnauthorized` on the thrown error
   * so the outer `request` can do a single refresh+retry.
   */
  private async attempt<T>(config: AxiosRequestConfig, options: RetryOptions = {}): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const backoff = options.backoff ?? 1000;

    for (let a = 0; a < maxRetries; a++) {
      try {
        logger.debug('API request', sanitizeForLog(config));
        const response = await this.axios.request<T>(config);
        logger.debug(`API response: ${response.status}`, { data: response.data });
        return response.data;
      } catch (error) {
        const wrapped = this.wrapError(error);
        if (isRawApiResponse401(error)) {
          (wrapped as VocareumError & ApiUnauthorizedFlag).isApiResponseUnauthorized = true;
        }
        const retryable = isRetryable(wrapped) || isRetryable(error);
        if (a === maxRetries - 1 || !retryable) { throw wrapped; }
        await sleep(backoff * Math.pow(2, a));
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

}
