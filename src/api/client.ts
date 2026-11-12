/**
 * Vocareum API Client
 *
 * Base HTTP client for Vocareum API with authentication and error handling.
 *
 * CRITICAL: All IDs are strings, not numbers!
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import type { EventSink } from '../core/services/event-sink';
import { LoggerEventSink } from '../utils/logger-event-sink';
import type { AuthProvider } from './auth/auth-provider';
import { RequestScheduler } from './scheduler';
import { DEFAULT_THROTTLE, type ResolvedThrottle } from './throttle';
import {
  REGION_HOSTS, VOCAREUM_REGIONS, canonicalBaseUrl, hasUnsafeBaseUrlChars, normalizeApiBaseUrl,
  redactUrlForDisplay,
} from './regions';

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
  constructor(public retryAfter?: number) {
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
  /**
   * @param url - the offending URL. Echoed only in redacted form
   *   (scheme://host/path): a token pasted into userinfo or a query must not
   *   reach the terminal or CI logs.
   * @param malformed - true when the URL carries a query, fragment, userinfo,
   *   backslash or whitespace. The override flag does not help there, so the
   *   message says what to remove instead of suggesting it.
   */
  constructor(url: string, malformed = false) {
    super(
      `Insecure API base URL: "${redactUrlForDisplay(url)}". ` +
      (malformed
        ? `API base URLs must be a plain https://host[/api/vN] with no query (?), ` +
          `fragment (#), credentials (user@), backslash or whitespace.`
        : `Only the Vocareum API hosts are allowed by default: ` +
          `https://api.vocareum.com and https://labs.vocareum.com (NA), ` +
          `https://api.eu.vocareum.com (EU). ` +
          `Set VOCAREUM_ALLOW_CUSTOM_BASE_URL=1 to override (use with caution).`),
      'INSECURE_BASE_URL'
    );
    this.name = 'InsecureBaseUrlError';
  }
}

/** Reject a base URL the parser would validate differently from how axios
 *  sends it. Runs before the override check: VOCAREUM_ALLOW_CUSTOM_BASE_URL
 *  relaxes WHICH host is allowed, never whether the URL is well-formed. */
export function assertWellFormedBaseUrl(baseUrl: string): void {
  if (hasUnsafeBaseUrlChars(baseUrl)) {
    throw new InsecureBaseUrlError(baseUrl, true);
  }
}

/** True for a raw upstream API response 401 — NOT a token-exchange/auth-acquisition
 *  failure (which is not an AxiosError carrying a 401 response). */
function isRawApiResponse401(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 401;
}

type ApiUnauthorizedFlag = { isApiResponseUnauthorized?: boolean };

/** Canonical, allowed (host, version-path) base URLs, split by API version so
 *  an auth mode can be bound to its host (token→v2, oauth→v3). Derived from the
 *  region table so a tenant's hosts are declared in exactly one place. */
const ALLOWED_V2_BASE_URLS: ReadonlySet<string> = new Set(
  VOCAREUM_REGIONS.map(r => REGION_HOSTS[r].v2BaseUrl),
);
const ALLOWED_V3_BASE_URLS: ReadonlySet<string> = new Set(
  VOCAREUM_REGIONS.flatMap(r => {
    const v3 = REGION_HOSTS[r].v3BaseUrl;
    return v3 === undefined ? [] : [v3];
  }),
);
const ALLOWED_BASE_URLS: ReadonlySet<string> = new Set([
  ...ALLOWED_V2_BASE_URLS,
  ...ALLOWED_V3_BASE_URLS,
]);

export { normalizeApiBaseUrl };

/** True when `baseUrl` (already normalized) is an exact allowlist entry for
 *  `version`. Pure: ignores VOCAREUM_ALLOW_CUSTOM_BASE_URL and emits nothing —
 *  for display (status), not for gating a request. */
export function isAllowlistedBaseUrl(baseUrl: string, version: 'v2' | 'v3'): boolean {
  if (hasUnsafeBaseUrlChars(baseUrl)) {
    return false;
  }
  const canonical = canonicalBaseUrl(baseUrl);
  if (canonical?.startsWith('https://') !== true) {
    return false;
  }
  return (version === 'v2' ? ALLOWED_V2_BASE_URLS : ALLOWED_V3_BASE_URLS).has(canonical);
}

/**
 * Validate a base URL is safe to send credentials to: HTTPS + an allowed
 * (host, version-path) pair, unless VOCAREUM_ALLOW_CUSTOM_BASE_URL=1.
 *
 * @param baseUrl - The base URL to validate
 * @param events - Event sink for warnings (defaults to LoggerEventSink so
 *   standalone callers still get console output, but VocareumClient passes its
 *   injected sink so warnings are captured by a CollectingEventSink in Stage 1b)
 */
export function assertAllowedBaseUrl(baseUrl: string, events?: EventSink): void {
  const sink: EventSink = events ?? new LoggerEventSink();
  assertWellFormedBaseUrl(baseUrl);
  const allowCustom = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL === '1';
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new InsecureBaseUrlError(baseUrl); }
  if (parsed.protocol !== 'https:') {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    // Non-HTTPS is only reachable with the explicit override; skip the path
    // allowlist check since TLS is already absent (dev/test escape hatch).
    sink.emit({ level: 'warn', message: `WARNING: Using non-HTTPS API URL: ${baseUrl}` });
    return;
  }
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  if (!ALLOWED_BASE_URLS.has(canonical)) {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    sink.emit({ level: 'warn', message: `WARNING: Using non-standard API base URL: ${canonical}. Your credentials will be sent to this host.` });
  }
}

/**
 * Bind an auth mode to its API host: token auth must target the v2 host, OAuth
 * must target the v3 host. Prevents sending a Bearer token to the v2 host (or a
 * personal Token to v3) when a crossed base-URL override (e.g.
 * VOCAREUM_API_V3_BASE_URL pointed at the v2 host) slips past the union
 * allowlist. HTTPS + exact (host, version-path) match required, unless
 * VOCAREUM_ALLOW_CUSTOM_BASE_URL=1.
 *
 * @param baseUrl - The base URL to validate
 * @param version - API version to validate against ('v2' or 'v3')
 * @param events - Event sink for warnings (defaults to LoggerEventSink so
 *   standalone callers still get console output, but VocareumClient passes its
 *   injected sink so warnings are captured by a CollectingEventSink in Stage 1b)
 */
export function assertBaseUrlForVersion(baseUrl: string, version: 'v2' | 'v3', events?: EventSink): void {
  const sink: EventSink = events ?? new LoggerEventSink();
  const allowed = version === 'v2' ? ALLOWED_V2_BASE_URLS : ALLOWED_V3_BASE_URLS;
  assertWellFormedBaseUrl(baseUrl);
  const allowCustom = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL === '1';
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new InsecureBaseUrlError(baseUrl); }
  if (parsed.protocol !== 'https:') {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    sink.emit({ level: 'warn', message: `WARNING: Using non-HTTPS API URL: ${baseUrl}` });
    return;
  }
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  if (!allowed.has(canonical)) {
    if (!allowCustom) { throw new InsecureBaseUrlError(baseUrl); }
    sink.emit({ level: 'warn', message: `WARNING: Using non-standard ${version} API base URL: ${canonical}. Your credentials will be sent to this host.` });
  }
}

/**
 * Retry options for API requests
 */
interface RetryOptions {
  maxRetries?: number;
  backoff?: number;
}

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'PUT',
  'DELETE',
]);

/**
 * Transient connection-level failures worth retrying. Note axios v1 reports
 * its own request timeouts as ECONNABORTED (not ETIMEDOUT) by default.
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
]);

/**
 * Check if an error is retryable
 */
function isRetryable(error: unknown, method: string): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (error instanceof VocareumError) {
    const status = error.statusCode;
    if (status !== undefined && status >= 500 && status < 600) {
      return IDEMPOTENT_METHODS.has(method);
    }
  }
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    if (status !== undefined && status >= 500 && status < 600) {
      return IDEMPOTENT_METHODS.has(method);
    }
    if (
      error.code !== undefined &&
      RETRYABLE_NETWORK_CODES.has(error.code) &&
      IDEMPOTENT_METHODS.has(method)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Parse a Retry-After header value (delta-seconds or HTTP-date) into seconds.
 */
function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') { return undefined; }
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const httpDatePattern =
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  if (!httpDatePattern.test(value)) { return undefined; }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function retryAfterFromAxiosError(error: unknown): number | undefined {
  if (!(error instanceof AxiosError)) { return undefined; }
  const headers = error.response?.headers;
  if (headers === undefined) { return undefined; }
  const headerAccessor = headers as unknown as { get?: (name: string) => unknown };
  const headerValue: unknown = typeof headerAccessor.get === 'function'
    ? headerAccessor.get('retry-after')
    : Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  return parseRetryAfter(headerValue);
}

/**
 * Vocareum's overload answer: HTTP 200 with a plain-text body such as
 * "VOCAREUM-ERROR: Sorry, your access to Vocareum is temporarily unavailable
 * due to heavy traffic, …" (probed 2026-11-11 on courses 215500 and 240788:
 * 5 of 24 listing requests). Returned as data, a listing read it as an empty
 * page: a directory looked empty, or a paged listing ended early, and drift
 * read the lost names as remote deletions. It is an error.
 */
const OVERLOAD_BODY = /^\s*VOCAREUM-ERROR:/;

/**
 * Vocareum answered "temporarily unavailable" with an HTTP 200 text body.
 * Status 503 is what it means, so the ordinary retry rules apply: retried for
 * idempotent methods, not for a POST that may have landed. Pollers treat it
 * as a sample that said nothing and keep polling.
 */
export class OverloadError extends APIError {
  constructor(message: string, public retryAfter?: number) {
    super(message, 503);
    this.name = 'OverloadError';
  }
}

/** True for the overload answer, however many retries it went through. */
export function isOverloadError(error: unknown): error is OverloadError {
  return error instanceof OverloadError;
}

function retryAfterFromHeaders(headers: unknown): number | undefined {
  if (headers === undefined || headers === null || typeof headers !== 'object') { return undefined; }
  const accessor = headers as { get?: (name: string) => unknown };
  const value: unknown = typeof accessor.get === 'function'
    ? accessor.get('retry-after')
    : Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  return parseRetryAfter(value);
}

/**
 * The overload error for a response, or undefined when the body is a real
 * answer. The server text is redacted like any other error text: it is not
 * debug-gated, and it can end up in warnings and publish_history.
 */
function overloadError(data: unknown, headers: unknown): OverloadError | undefined {
  if (typeof data !== 'string' || !OVERLOAD_BODY.test(data)) { return undefined; }
  return new OverloadError(
    `Vocareum is overloaded: ${sanitizeLogString(data.trim().slice(0, 300))}`,
    retryAfterFromHeaders(headers),
  );
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
 * An absolute http(s) URL, including the JSON-escaped form (`https:\/\/…`).
 * The class always matches to the next whitespace, quote or angle bracket and
 * never fails, so matching is linear in the input (no rescans per `https://`).
 */
const ABSOLUTE_URL = /https?:(?:\/\/|\\\/\\\/)[^\s"'<>]*/gi;
/** Punctuation that usually ends a sentence rather than a URL. */
const URL_TRAILING_PUNCTUATION = /[.,;:!)\]}]+$/;
/**
 * Credential parameters of signed URLs, wherever they appear — after a quote
 * or line break that ended the URL match early, or in a protocol-relative or
 * otherwise unrecognised URL. Names: S3 (`X-Amz-*`, `AWSAccessKeyId`,
 * `Signature`), CloudFront (`Signature`, `Policy`, `Key-Pair-Id`), generic
 * (`sig`, `signature`, `token`).
 */
const SIGNED_URL_PARAM = /((?:^|[?&\s"'\\])(?:X-Amz-[A-Za-z-]+|AWSAccessKeyId|Signature|Policy|Key-Pair-Id|sig|token)=)[^&\s"'\\]*/gi;

/**
 * Redact one absolute URL: drop user-info (`user:pass@`) and the whole query
 * string, keeping scheme, host and path. Signed download URLs carry their
 * credential in the query (S3's `X-Amz-*`, the files API's `download_url`),
 * and the parameter names vary by issuer, so the whole query goes.
 */
function redactUrl(match: string): string {
  const trailing = URL_TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
  let url = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
  url = url.replace(/^(https?:(?:\/\/|\\\/\\\/))[^/\\@]*@/i, '$1[REDACTED]@');
  const q = url.indexOf('?');
  if (q !== -1) { url = `${url.slice(0, q)}?[REDACTED]`; }
  return url + trailing;
}

/** Redact secrets in a free-text string (log line, error message). */
export function sanitizeLogString(text: string): string {
  return text
    .replace(ABSOLUTE_URL, redactUrl)
    .replace(SIGNED_URL_PARAM, '$1[REDACTED]')
    .replace(REDACT_FORM_PARAM, '$1[REDACTED]');
}

/**
 * Sanitize a value for logging (redact secrets recursively in objects, arrays, form strings, and URL query strings)
 */
export function sanitizeForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') { return sanitizeLogString(value); }
  if (Array.isArray(value)) { return value.map((v) => sanitizeForLog(v, seen)); }
  if (value && typeof value === 'object') {
    if (seen.has(value)) { return '[Circular]'; }
    seen.add(value);
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
  private scheduler: RequestScheduler;
  readonly events: EventSink;

  constructor(authProvider: AuthProvider, throttle: ResolvedThrottle = DEFAULT_THROTTLE, scheduler?: RequestScheduler, events?: EventSink) {
    // Assign events FIRST so the injected sink (e.g. CollectingEventSink in
    // Stage 1b) receives the base-URL validation warnings rather than a
    // throwaway LoggerEventSink constructed inside the validators.
    this.events = events ?? new LoggerEventSink();
    assertAllowedBaseUrl(authProvider.apiBaseUrl, this.events);
    this.authProvider = authProvider;
    this.scheduler = scheduler ?? new RequestScheduler(throttle);
    this.axios = axios.create({
      baseURL: authProvider.apiBaseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
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
    const method = (config.method ?? 'GET').toUpperCase();

    for (let a = 0; a < maxRetries; a++) {
      try {
        this.events.emit({ level: 'debug', message: 'API request', data: sanitizeForLog(config) });
        const response = await this.scheduler.schedule(() => this.axios.request<T>(config));
        this.events.emit({ level: 'debug', message: `API response: ${response.status}`, data: sanitizeForLog({ data: response.data }) });
        const overloaded = overloadError(response.data, response.headers);
        if (overloaded !== undefined) { throw overloaded; }
        return response.data;
      } catch (error) {
        const wrapped = this.wrapError(error);
        if (isRawApiResponse401(error)) {
          (wrapped as VocareumError & ApiUnauthorizedFlag).isApiResponseUnauthorized = true;
        }
        const retryable = isRetryable(wrapped, method) || isRetryable(error, method);
        if (a === maxRetries - 1 || !retryable) { throw wrapped; }
        // A server-provided Retry-After takes precedence over exponential backoff.
        const retryAfter = retryAfterFromAxiosError(error) ??
          (wrapped instanceof RateLimitError || wrapped instanceof OverloadError ? wrapped.retryAfter : undefined);
        const retryAfterMs = retryAfter !== undefined ? retryAfter * 1000 : undefined;
        await sleep(retryAfterMs ?? backoff * Math.pow(2, a));
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
      // Error text and bodies end up in warnings and error output, which are
      // not debug-gated: never let a signed URL's credentials through.
      const message = sanitizeLogString(data?.error?.message ?? data?.message ?? error.message);

      // Try to detect resource type from URL for better error messages
      const url = error.config?.url ?? '';
      const resourceType = this.detectResourceType(url);

      switch (status) {
        case 401:
          return new AuthenticationError(
            message + '\n\n' + (this.authProvider.unauthorizedHint ??
              'Your API token may be invalid or expired. ' +
              'Generate a new token at: Profile > Settings > Personal Access Tokens')
          );
        case 403:
          return new ForbiddenError(message, resourceType);
        case 404:
          return new NotFoundError(resourceType || 'Resource', 'unknown');
        case 429:
          return new RateLimitError(
            retryAfterFromAxiosError(error)
          );
        default:
          return new APIError(message, status, sanitizeForLog(data));
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
