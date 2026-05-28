# v3 OAuth Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vocareum v3 OAuth client-credentials auth alongside the existing v2 personal-token auth, behind an `AuthProvider` seam, with v2 remaining the default.

**Architecture:** Move auth + base-URL ownership out of `VocareumClient` into an `AuthProvider` (owns `apiBaseUrl` + produces the `Authorization` header). The client injects the header per-request via an async axios interceptor and refreshes-and-retries exactly once on an API 401. Two providers: `TokenAuthProvider` (v2, `Token` header) and `OAuthClientCredentialsProvider` (v3, `Bearer`, lazy token exchange + caching + coalescing). API call sites become version-relative; the version segment lives in the provider base URL.

**Tech Stack:** TypeScript, axios 1.13.5 (AxiosHeaders), vitest. No new runtime deps.

**Spec:** [docs/superpowers/specs/2026-05-27-v3-oauth-support-design.md](../specs/2026-05-27-v3-oauth-support-design.md). Token endpoint already confirmed live: `https://labs.vocareum.com/api/v3/oauth/token`.

---

## File Map

NEW:
- `src/api/auth/auth-provider.ts` — `AuthProvider` interface; `createAuthProvider()` factory (added in Task 6).
- `src/api/auth/token-auth-provider.ts` — v2 `TokenAuthProvider` + `normalizeV2BaseUrl`.
- `src/api/auth/oauth-provider.ts` — v3 `OAuthClientCredentialsProvider`, `OAuthTokenExchangeError`.
- `src/api/auth/cli-auth-options.ts` — shared commander flags + provider resolution.
- `test/unit/auth/token-auth-provider.test.ts`, `test/unit/auth/oauth-provider.test.ts`, `test/unit/auth/auth-provider.test.ts`, `test/unit/client-auth.test.ts`.
- `scripts/probe-v3-oauth.mjs` — gated live smoke.

MODIFIED:
- `src/api/client.ts` — path-aware `validateBaseUrl`, base-URL normalization (Task 1) → `AuthProvider` constructor + async interceptor + 401 refresh-retry + recursive `sanitizeForLog` (Tasks 3-4).
- `src/api/courses.ts`, `assignments.ts`, `parts.ts`, `content.ts` — version-relative paths.
- `src/utils/env.ts` — readers for auth mode + OAuth creds + v3 URLs.
- `src/commands/publish.ts`, `pull.ts` — resolve provider via shared helper.
- `src/index.ts` — `--auth`/`--client-id`/`--client-secret` on push + pull.
- `test/unit/assignments.test.ts`, `test/unit/content.test.ts` — version-relative URL assertions.
- `README.md`, `CHANGELOG.md`.

---

## Task 1: Path refactor — version segment into base URL

**Files:**
- Modify: `src/api/client.ts` (constructor default + `validateBaseUrl`)
- Modify: `src/api/courses.ts`, `src/api/assignments.ts`, `src/api/parts.ts`, `src/api/content.ts`
- Modify: `test/unit/assignments.test.ts`, `test/unit/content.test.ts`

This keeps the existing `(apiKey, baseUrl)` constructor — no auth change yet. It only moves `/api/v2` out of call-site paths and into a normalized base URL.

- [ ] **Step 1.1: Add base-URL normalization + make validateBaseUrl path-aware (write failing test first)**

Create `test/unit/client-auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeApiBaseUrl, assertAllowedBaseUrl } from '../../src/api/client';

describe('normalizeApiBaseUrl', () => {
  it('appends /api/v2 when no version path present', () => {
    expect(normalizeApiBaseUrl('https://api.vocareum.com')).toBe('https://api.vocareum.com/api/v2');
  });
  it('strips trailing slash then appends /api/v2', () => {
    expect(normalizeApiBaseUrl('https://api.vocareum.com/')).toBe('https://api.vocareum.com/api/v2');
  });
  it('leaves an existing version path untouched', () => {
    expect(normalizeApiBaseUrl('https://api.vocareum.com/api/v2')).toBe('https://api.vocareum.com/api/v2');
    expect(normalizeApiBaseUrl('https://labs.vocareum.com/api/v3')).toBe('https://labs.vocareum.com/api/v3');
  });
});

describe('assertAllowedBaseUrl', () => {
  it('accepts the canonical v2 host+path', () => {
    expect(() => assertAllowedBaseUrl('https://api.vocareum.com/api/v2')).not.toThrow();
  });
  it('accepts the canonical v3 host+path', () => {
    expect(() => assertAllowedBaseUrl('https://labs.vocareum.com/api/v3')).not.toThrow();
  });
  it('rejects a known host with an unexpected path', () => {
    expect(() => assertAllowedBaseUrl('https://api.vocareum.com/evil')).toThrow(/Insecure/);
  });
  it('rejects an unknown host', () => {
    expect(() => assertAllowedBaseUrl('https://evil.example.com/api/v2')).toThrow(/Insecure/);
  });
  it('rejects http', () => {
    expect(() => assertAllowedBaseUrl('http://api.vocareum.com/api/v2')).toThrow(/Insecure/);
  });
  it('allows override with VOCAREUM_ALLOW_CUSTOM_BASE_URL=1', () => {
    process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL = '1';
    try { expect(() => assertAllowedBaseUrl('https://staging.example.com/api/v2')).not.toThrow(); }
    finally { delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL; }
  });
});
```

- [ ] **Step 1.2: Run, expect fail**

Run: `npx vitest run test/unit/client-auth.test.ts`
Expected: FAIL — `normalizeApiBaseUrl`/`assertAllowedBaseUrl` not exported.

- [ ] **Step 1.3: Implement in `src/api/client.ts`**

Replace the `ALLOWED_API_HOSTS` constant and `validateBaseUrl` function with path-aware logic, and export two helpers:

```ts
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
```

In the constructor, normalize then validate, and use the normalized URL as the axios `baseURL`:

```ts
constructor(apiKey: string, baseUrl: string = 'https://api.vocareum.com') {
  const normalized = normalizeApiBaseUrl(baseUrl);
  assertAllowedBaseUrl(normalized);
  this.apiKey = apiKey;
  this.axios = axios.create({
    baseURL: normalized,
    timeout: 30000,
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
  });
}
```

Delete the old `validateBaseUrl` function and `ALLOWED_API_HOSTS`.

- [ ] **Step 1.4: Run, expect pass**

Run: `npx vitest run test/unit/client-auth.test.ts`
Expected: PASS.

- [ ] **Step 1.5: Strip `/api/v2` from call sites (paths become version-relative)**

In `src/api/courses.ts`, `assignments.ts`, `parts.ts`, `content.ts`, change every `` url: `/api/v2/... `` to drop the `/api/v2` prefix. The exact 14 edits:

- `courses.ts:23` and `:49`: `` `/api/v2/courses/${courseId}` `` → `` `/courses/${courseId}` ``
- `parts.ts:35`: `.../parts` path → `` `/courses/${courseId}/assignments/${assignmentId}/parts` ``
- `parts.ts:65` and `:116`: → `` `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}` ``
- `parts.ts:132`: → `` `/transaction/${response.transactionid}` ``
- `assignments.ts:50`,`:137`: → `` `/courses/${courseId}/assignments` ``
- `assignments.ts:86`,`:252`: → `` `/courses/${courseId}/assignments/${assignmentId}` ``
- `assignments.ts:199`: → `` `/transaction/${transactionId}` ``
- `content.ts:151`,`:539`,`:599`: `.../parts/${partId}/files` → drop `/api/v2`
- `content.ts:302`: → `` `/transaction/${transactionId}` ``
- `content.ts:349`: → `` `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}` ``

Also update the **comments** that say `/api/v2/...` (e.g. `parts.ts:48,79`, `assignments.ts:71,116,222`) to version-relative wording (e.g. "Direct endpoint `/parts/{id}` returns 400").

Verify none remain:

Run: `grep -rn "/api/v2" src/`
Expected: no matches (comments included).

- [ ] **Step 1.6: Update test URL assertions**

The API-layer tests assert absolute `/api/v2/...` URLs. Make them version-relative:

Run:
```bash
sed -i '' 's#/api/v2/#/#g' test/unit/assignments.test.ts test/unit/content.test.ts
grep -rn "/api/v2" test/ || echo "clean"
```
Expected: `clean`.

- [ ] **Step 1.7: Full suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: all green. (Behavior is unchanged — requests still resolve to `https://api.vocareum.com/api/v2/...`.)

- [ ] **Step 1.8: Commit**

```bash
git add src/api/ test/unit/assignments.test.ts test/unit/content.test.ts test/unit/client-auth.test.ts
git commit -m "refactor: move /api/v2 version segment into base URL; path-aware base-URL validation"
```

---

## Task 2: AuthProvider interface + TokenAuthProvider

**Files:**
- Create: `src/api/auth/auth-provider.ts`
- Create: `src/api/auth/token-auth-provider.ts`
- Create: `test/unit/auth/token-auth-provider.test.ts`

- [ ] **Step 2.1: Write failing test**

`test/unit/auth/token-auth-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TokenAuthProvider } from '../../../src/api/auth/token-auth-provider';

describe('TokenAuthProvider', () => {
  it('exposes a v2 apiBaseUrl normalized from a host-only URL', () => {
    const p = new TokenAuthProvider('tok', 'https://api.vocareum.com');
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });
  it('defaults apiBaseUrl to the canonical v2 URL', () => {
    const p = new TokenAuthProvider('tok');
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });
  it('produces a Token header', async () => {
    const p = new TokenAuthProvider('tok');
    expect(await p.getAuthorizationHeader()).toBe('Token tok');
  });
  it('has no refreshAfterUnauthorized (401 is terminal for token auth)', () => {
    const p = new TokenAuthProvider('tok');
    expect(p.refreshAfterUnauthorized).toBeUndefined();
  });
});
```

- [ ] **Step 2.2: Run, expect fail**

Run: `npx vitest run test/unit/auth/token-auth-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement the interface + provider**

`src/api/auth/auth-provider.ts`:

```ts
/**
 * Abstraction over Vocareum authentication. Owns the API base URL (including
 * the version path) and produces the Authorization header. See spec
 * docs/superpowers/specs/2026-05-27-v3-oauth-support-design.md.
 */
export interface AuthProvider {
  /** API base URL including version path, e.g. https://api.vocareum.com/api/v2 */
  readonly apiBaseUrl: string;
  /** Authorization header value, e.g. "Token x" or "Bearer y". May exchange/refresh lazily. */
  getAuthorizationHeader(): Promise<string>;
  /** Invalidate cached credentials so the next getAuthorizationHeader() re-acquires.
   *  Optional — token auth has no refresh, so a 401 there is terminal. */
  refreshAfterUnauthorized?(): Promise<void>;
}
```

`src/api/auth/token-auth-provider.ts`:

```ts
import type { AuthProvider } from './auth-provider';
import { normalizeApiBaseUrl } from '../client';

export class TokenAuthProvider implements AuthProvider {
  readonly apiBaseUrl: string;
  constructor(private readonly token: string, baseUrl = 'https://api.vocareum.com') {
    this.apiBaseUrl = normalizeApiBaseUrl(baseUrl);
  }
  async getAuthorizationHeader(): Promise<string> {
    return `Token ${this.token}`;
  }
}
```

- [ ] **Step 2.4: Run, expect pass**

Run: `npx vitest run test/unit/auth/token-auth-provider.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/api/auth/auth-provider.ts src/api/auth/token-auth-provider.ts test/unit/auth/token-auth-provider.test.ts
git commit -m "feat: add AuthProvider interface and v2 TokenAuthProvider"
```

---

## Task 3: VocareumClient cutover to AuthProvider + async header injection + recursive redaction

**Files:**
- Modify: `src/api/client.ts`
- Modify: `src/commands/publish.ts`, `src/commands/pull.ts`
- Modify: `test/unit/client-auth.test.ts`

- [ ] **Step 3.1: Write failing tests for header injection + recursive redaction**

Append to `test/unit/client-auth.test.ts`:

```ts
import { VocareumClient } from '../../src/api/client';
import { sanitizeForLog } from '../../src/api/client';
import type { AuthProvider } from '../../src/api/auth/auth-provider';

class FakeProvider implements AuthProvider {
  readonly apiBaseUrl = 'https://api.vocareum.com/api/v2';
  header = 'Token fake';
  refreshed = 0;
  async getAuthorizationHeader() { return this.header; }
  async refreshAfterUnauthorized() { this.refreshed += 1; }
}

describe('VocareumClient header injection', () => {
  it('asks the provider for the Authorization header on each request', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
    // Access the underlying axios instance's interceptor by issuing a request to a
    // mocked adapter. Simplest: spy on provider.getAuthorizationHeader.
    const spy = vi.spyOn(provider, 'getAuthorizationHeader');
    // Use a mock adapter so no network call happens:
    (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter =
      async (config: { headers: { get(k: string): unknown } }) => ({
        data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config,
      });
    await client.request({ method: 'GET', url: '/courses' });
    expect(spy).toHaveBeenCalled();
  });
});

describe('sanitizeForLog (recursive)', () => {
  it('redacts secrets nested in objects and bodies', () => {
    const out = JSON.stringify(sanitizeForLog({
      headers: { Authorization: 'Bearer abc' },
      data: { grant_type: 'client_credentials', client_secret: 'shh', nested: { access_token: 'tok' } },
    } as never));
    expect(out).not.toContain('shh');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('"tok"');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts secrets in a urlencoded form-string body, preserving non-secret params', () => {
    const out = sanitizeForLog('grant_type=client_credentials&client_id=cid&client_secret=shh') as string;
    expect(out).not.toContain('shh');
    expect(out).toContain('client_id=cid');            // non-secret preserved
    expect(out).toContain('client_secret=[REDACTED]');
  });
});
```

Add `import { vi } from 'vitest';` to the file's imports.

- [ ] **Step 3.2: Run, expect fail**

Run: `npx vitest run test/unit/client-auth.test.ts`
Expected: FAIL — `VocareumClient` still takes `(apiKey, baseUrl)`; `sanitizeForLog` not exported / not recursive.

- [ ] **Step 3.3: Rewrite the constructor + add interceptor + recursive sanitize**

In `src/api/client.ts`:

Replace the constructor and `apiKey` field:

```ts
import type { AuthProvider } from './auth/auth-provider';

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
      config.headers.set('Authorization', await authProvider.getAuthorizationHeader());
      return config;
    });
  }
```

Remove the old `getApiKey()` method (no longer holds a key).

Replace `sanitizeForLog` with a recursive, exported version:

```ts
const REDACT_KEY = /^(authorization|client_secret|access_token|refresh_token|id_token|password|secret|token)$/i;
// Redact sensitive params inside a urlencoded form string (the OAuth token-exchange
// body is a string, not an object). Non-secret params (e.g. client_id) are preserved.
const REDACT_FORM_PARAM = /((?:^|&)(?:authorization|client_secret|access_token|refresh_token|id_token|password|secret|token)=)[^&]*/gi;

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') { return value.replace(REDACT_FORM_PARAM, '$1[REDACTED]'); }
  if (Array.isArray(value)) { return value.map(sanitizeForLog); }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY.test(k) ? '[REDACTED]' : sanitizeForLog(v);
    }
    return out;
  }
  return value;
}
```

(The `request()` debug log already calls `sanitizeForLog(config)` — it now redacts recursively.)

- [ ] **Step 3.4: Update the two command construction sites**

In `src/commands/publish.ts` and `src/commands/pull.ts`, replace:

```ts
const apiKey = getApiKeyOrThrow();
const client = new VocareumClient(apiKey, config.vocareum.api_base_url);
```

with (Task 6 will swap this for the shared resolver; for now construct a token provider directly):

```ts
import { TokenAuthProvider } from '../api/auth/token-auth-provider';
// ...
const apiKey = getApiKeyOrThrow();
const client = new VocareumClient(new TokenAuthProvider(apiKey, config.vocareum.api_base_url));
```

- [ ] **Step 3.5: Run tests + typecheck; fix any client-construction in other tests**

Run: `npm run typecheck`
Expected: PASS. If any test constructs `new VocareumClient(apiKey, baseUrl)`, update it to `new VocareumClient(new TokenAuthProvider(apiKey, baseUrl))` (import from `../../src/api/auth/token-auth-provider`).

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 3.6: Commit**

```bash
git add src/api/client.ts src/commands/publish.ts src/commands/pull.ts test/unit/client-auth.test.ts
git commit -m "feat: VocareumClient takes an AuthProvider; async header injection; recursive log redaction"
```

---

## Task 4: 401 refresh-and-retry (exactly once, distinct from normal retry)

**Files:**
- Modify: `src/api/client.ts` (`request`)
- Modify: `test/unit/client-auth.test.ts`

- [ ] **Step 4.1: Write failing tests**

Append to `test/unit/client-auth.test.ts`:

```ts
import { AxiosError } from 'axios';

// A custom adapter must reject non-2xx itself — axios only applies validateStatus
// inside its built-in adapters (via settle), not to a custom adapter's resolved
// value. So we throw a REAL AxiosError (carrying .response.status) for status >= 400.
function mockAdapter(responses: Array<{ status: number; data?: unknown }>) {
  let i = 0;
  return async (config: unknown) => {
    const r = responses[Math.min(i, responses.length - 1)]; i += 1;
    const response = { data: r.data ?? {}, status: r.status, statusText: '', headers: {}, config };
    if (r.status >= 400) {
      throw new AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE',
        config as never, {}, response as never);
    }
    return response;
  };
}
function setAdapter(client: VocareumClient, adapter: unknown) {
  (client as unknown as { axios: { defaults: Record<string, unknown> } }).axios.defaults.adapter = adapter;
}

describe('VocareumClient 401 refresh-retry', () => {
  it('refreshes once and retries once on an API 401, then succeeds', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 401 }, { status: 200, data: { ok: true } }]));
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' });
    expect(out).toEqual({ ok: true });
    expect(provider.refreshed).toBe(1);
  });

  it('does not retry past one refresh; a second 401 throws', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 401 }, { status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow();
    expect(provider.refreshed).toBe(1);
  });

  it('does not attempt refresh when the provider has no refreshAfterUnauthorized', async () => {
    const provider = new FakeProvider();
    (provider as Partial<FakeProvider>).refreshAfterUnauthorized = undefined;
    const client = new VocareumClient(provider as AuthProvider);
    setAdapter(client, mockAdapter([{ status: 401 }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow();
  });

  it('normal retry (500 then 200) still works and is independent of the 401 path', async () => {
    const provider = new FakeProvider();
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 500 }, { status: 200, data: { ok: true } }]));
    const out = await client.request<{ ok: boolean }>({ method: 'GET', url: '/courses' }, { backoff: 1 });
    expect(out).toEqual({ ok: true });
    expect(provider.refreshed).toBe(0); // 5xx is not the auth path
  });

  it('an auth-acquisition failure (interceptor throws) does NOT trigger the 401 refresh path', async () => {
    // Simulates a token-exchange failure: getAuthorizationHeader throws before any API call.
    const provider = new FakeProvider();
    provider.getAuthorizationHeader = async () => { throw new Error('token exchange failed'); };
    const client = new VocareumClient(provider);
    setAdapter(client, mockAdapter([{ status: 200, data: { ok: true } }]));
    await expect(client.request({ method: 'GET', url: '/courses' })).rejects.toThrow(/token exchange failed/);
    expect(provider.refreshed).toBe(0); // no refresh — it was not an API-response 401
  });
});
```

- [ ] **Step 4.2: Run, expect fail**

Run: `npx vitest run test/unit/client-auth.test.ts -t "401 refresh-retry"`
Expected: FAIL — no refresh path yet.

- [ ] **Step 4.3: Implement the outer 401 wrapper**

In `src/api/client.ts`, rename the existing retry loop method to `private attempt<T>(...)` (same body as the current `request`), and add a new `request` wrapper. The "was this an API-response 401?" signal is carried as a **flag on the thrown error** (not an instance field — instance state would race across concurrent requests on the same client):

```ts
/** True for a raw upstream API response 401 — NOT a token-exchange/auth-acquisition
 *  failure (which is not an AxiosError carrying a 401 response). */
function isRawApiResponse401(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 401;
}

type ApiUnauthorizedFlag = { isApiResponseUnauthorized?: boolean };

public async request<T>(config: AxiosRequestConfig, options: RetryOptions = {}): Promise<T> {
  try {
    return await this.attempt<T>(config, options);
  } catch (err) {
    const apiUnauthorized = (err as ApiUnauthorizedFlag).isApiResponseUnauthorized === true;
    if (apiUnauthorized && this.authProvider.refreshAfterUnauthorized) {
      await this.authProvider.refreshAfterUnauthorized();
      return await this.attempt<T>(config, options);   // exactly one refresh+retry
    }
    throw err;
  }
}

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
      if (a === maxRetries - 1 || !isRetryable(wrapped)) { throw wrapped; }
      await sleep(backoff * Math.pow(2, a));
    }
  }
  throw new APIError('Max retries exceeded');
}
```

Why this is correct and race-free:
- The flag lives on the thrown error object, so concurrent requests on the same client never clobber each other.
- `isRetryable` does NOT include 401, so a 401 breaks out of `attempt` immediately with the flag set; the outer `request` refreshes and retries exactly once.
- A **token-exchange / auth-acquisition failure** throws from the interceptor *before* an API response exists. In `attempt`'s catch that `error` is not an `AxiosError` carrying a 401 response, so `isRawApiResponse401` is false, the flag is never set, and `request` propagates it without a refresh — no pointless re-exchange loop (spec §4, review #2).

- [ ] **Step 4.4: Run, expect pass**

Run: `npx vitest run test/unit/client-auth.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Full suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 4.6: Commit**

```bash
git add src/api/client.ts test/unit/client-auth.test.ts
git commit -m "feat: refresh-and-retry once on API 401, distinct from normal retry"
```

---

## Task 5: OAuthClientCredentialsProvider (v3)

**Files:**
- Create: `src/api/auth/oauth-provider.ts`
- Create: `test/unit/auth/oauth-provider.test.ts`

- [ ] **Step 5.1: Write failing tests**

`test/unit/auth/oauth-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuthClientCredentialsProvider, OAuthTokenExchangeError } from '../../../src/api/auth/oauth-provider';

function makeProvider(post: ReturnType<typeof vi.fn>) {
  return new OAuthClientCredentialsProvider({
    clientId: 'cid', clientSecret: 'sec',
    apiBaseUrl: 'https://labs.vocareum.com/api/v3',
    tokenUrl: 'https://labs.vocareum.com/api/v3/oauth/token',
    httpPost: post, // injected for testing (real default uses a private axios)
    now: () => 1_000_000,
  });
}

describe('OAuthClientCredentialsProvider', () => {
  it('exchanges form-encoded client_credentials and returns a Bearer header', async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    expect(await p.getAuthorizationHeader()).toBe('Bearer AT');
    const [url, body, cfg] = post.mock.calls[0];
    expect(url).toBe('https://labs.vocareum.com/api/v3/oauth/token');
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=sec');
    expect(cfg.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('caches the token until expires_in minus the 5-min buffer', async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    await p.getAuthorizationHeader();
    await p.getAuthorizationHeader();
    expect(post).toHaveBeenCalledTimes(1); // cached, no re-exchange
  });

  it('coalesces concurrent exchanges into one request', async () => {
    let resolve!: (v: unknown) => void;
    const post = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));
    const p = makeProvider(post);
    const a = p.getAuthorizationHeader();
    const b = p.getAuthorizationHeader();
    resolve({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    expect(await a).toBe('Bearer AT');
    expect(await b).toBe('Bearer AT');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refreshAfterUnauthorized forces a re-exchange on next header', async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } });
    const p = makeProvider(post);
    await p.getAuthorizationHeader();
    await p.refreshAfterUnauthorized();
    await p.getAuthorizationHeader();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('throws OAuthTokenExchangeError (no secret in message) on exchange failure', async () => {
    const err = Object.assign(new Error('bad'), { isAxiosError: true, response: { status: 401, data: { error: 'invalid_client' } } });
    const post = vi.fn().mockRejectedValue(err);
    const p = makeProvider(post);
    await expect(p.getAuthorizationHeader()).rejects.toBeInstanceOf(OAuthTokenExchangeError);
    await expect(p.getAuthorizationHeader()).rejects.not.toThrow(/sec/);
  });

  it('rejects a non-HTTPS or non-allowlisted tokenUrl unless override set', () => {
    expect(() => new OAuthClientCredentialsProvider({
      clientId: 'c', clientSecret: 's',
      apiBaseUrl: 'https://labs.vocareum.com/api/v3',
      tokenUrl: 'https://evil.example.com/oauth/token',
    })).toThrow(/Insecure/);
  });
});
```

- [ ] **Step 5.2: Run, expect fail**

Run: `npx vitest run test/unit/auth/oauth-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement the provider**

`src/api/auth/oauth-provider.ts`:

```ts
import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { AuthProvider } from './auth-provider';
import { AuthenticationError, InsecureBaseUrlError } from '../client';

const TOKEN_REFRESH_BUFFER_SEC = 300; // refresh 5 min early
const ALLOWED_TOKEN_URLS: ReadonlySet<string> = new Set([
  'https://labs.vocareum.com/api/v3/oauth/token',
]);

export class OAuthTokenExchangeError extends AuthenticationError {
  constructor(message: string) { super(message); this.name = 'OAuthTokenExchangeError'; }
}

type PostFn = (url: string, body: string, cfg: { headers: Record<string, string> }) => Promise<{ data: unknown }>;

export interface OAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  tokenUrl: string;
  /** Injectable for testing; defaults to a private unauthenticated axios instance. */
  httpPost?: PostFn;
  /** Injectable clock for testing. */
  now?: () => number;
}

interface CachedToken { accessToken: string; expiresAtMs: number; }

function assertAllowedTokenUrl(tokenUrl: string): void {
  const allowCustom = process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL === '1';
  let parsed: URL;
  try { parsed = new URL(tokenUrl); } catch { throw new InsecureBaseUrlError(tokenUrl); }
  const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  if (parsed.protocol !== 'https:' || !ALLOWED_TOKEN_URLS.has(canonical)) {
    if (!allowCustom) { throw new InsecureBaseUrlError(tokenUrl); }
  }
}

export class OAuthClientCredentialsProvider implements AuthProvider {
  readonly apiBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly post: PostFn;
  private readonly now: () => number;
  private cached?: CachedToken;
  private inflight?: Promise<string>;
  private static sharedHttp?: AxiosInstance;

  constructor(opts: OAuthProviderOptions) {
    assertAllowedTokenUrl(opts.tokenUrl);
    this.apiBaseUrl = opts.apiBaseUrl;
    this.tokenUrl = opts.tokenUrl;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.now = opts.now ?? Date.now;
    this.post = opts.httpPost ?? ((url, body, cfg) => {
      OAuthClientCredentialsProvider.sharedHttp ??= axios.create({ timeout: 30000 });
      return OAuthClientCredentialsProvider.sharedHttp.post(url, body, cfg);
    });
  }

  async getAuthorizationHeader(): Promise<string> {
    return `Bearer ${await this.getAccessToken()}`;
  }

  async refreshAfterUnauthorized(): Promise<void> {
    this.cached = undefined;
  }

  private async getAccessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs) { return this.cached.accessToken; }
    if (this.inflight) { return this.inflight; }
    this.inflight = this.exchange().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async exchange(): Promise<string> {
    const body = [
      `grant_type=client_credentials`,
      `client_id=${encodeURIComponent(this.clientId)}`,
      `client_secret=${encodeURIComponent(this.clientSecret)}`,
    ].join('&');
    let data: { access_token?: string; expires_in?: number };
    try {
      const res = await this.post(this.tokenUrl, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      data = res.data as typeof data;
    } catch (error) {
      const status = error instanceof AxiosError ? error.response?.status : undefined;
      throw new OAuthTokenExchangeError(
        `OAuth token exchange failed${status ? ` (HTTP ${status})` : ''}. ` +
        `Check VOCAREUM_OAUTH_CLIENT_ID / VOCAREUM_OAUTH_CLIENT_SECRET.`
      );
    }
    if (!data.access_token) {
      throw new OAuthTokenExchangeError('OAuth token exchange returned no access_token.');
    }
    const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.cached = {
      accessToken: data.access_token,
      expiresAtMs: this.now() + Math.max(0, expiresInSec - TOKEN_REFRESH_BUFFER_SEC) * 1000,
    };
    return data.access_token;
  }
}
```

Note: `AuthenticationError` and `InsecureBaseUrlError` are already exported from `client.ts`. If `client.ts` doesn't export them, add `export` to those class declarations in `client.ts` as part of this task.

- [ ] **Step 5.4: Run, expect pass**

Run: `npx vitest run test/unit/auth/oauth-provider.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Full suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: green.

- [ ] **Step 5.6: Commit**

```bash
git add src/api/auth/oauth-provider.ts test/unit/auth/oauth-provider.test.ts src/api/client.ts
git commit -m "feat: add v3 OAuthClientCredentialsProvider (exchange, cache, coalesce, validation)"
```

---

## Task 6: Factory, env readers, shared CLI auth options, command wiring

**Files:**
- Modify: `src/api/auth/auth-provider.ts` (add `createAuthProvider`)
- Modify: `src/utils/env.ts` (OAuth/auth-mode readers)
- Create: `src/api/auth/cli-auth-options.ts`
- Modify: `src/commands/publish.ts`, `src/commands/pull.ts`, `src/index.ts`
- Create: `test/unit/auth/auth-provider.test.ts`

- [ ] **Step 6.1: Write failing tests for the factory**

`test/unit/auth/auth-provider.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createAuthProvider } from '../../../src/api/auth/auth-provider';
import { TokenAuthProvider } from '../../../src/api/auth/token-auth-provider';
import { OAuthClientCredentialsProvider } from '../../../src/api/auth/oauth-provider';

afterEach(() => {
  delete process.env.VOCAREUM_AUTH_MODE;
  delete process.env.VOCAREUM_API_KEY;
  delete process.env.VOCAREUM_OAUTH_CLIENT_ID;
  delete process.env.VOCAREUM_OAUTH_CLIENT_SECRET;
});

describe('createAuthProvider', () => {
  it('defaults to token mode (v2)', () => {
    process.env.VOCAREUM_API_KEY = 'tok';
    const p = createAuthProvider({});
    expect(p).toBeInstanceOf(TokenAuthProvider);
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });

  it('honors config base URL in token mode', () => {
    process.env.VOCAREUM_API_KEY = 'tok';
    const p = createAuthProvider({ apiBaseUrl: 'https://api.vocareum.com' });
    expect(p.apiBaseUrl).toBe('https://api.vocareum.com/api/v2');
  });

  it('builds an OAuth provider when mode=oauth and creds present', () => {
    const p = createAuthProvider({ authMode: 'oauth', clientId: 'c', clientSecret: 's' });
    expect(p).toBeInstanceOf(OAuthClientCredentialsProvider);
    expect(p.apiBaseUrl).toBe('https://labs.vocareum.com/api/v3');
  });

  it('reads oauth creds from env when not passed as options', () => {
    process.env.VOCAREUM_AUTH_MODE = 'oauth';
    process.env.VOCAREUM_OAUTH_CLIENT_ID = 'c';
    process.env.VOCAREUM_OAUTH_CLIENT_SECRET = 's';
    expect(createAuthProvider({})).toBeInstanceOf(OAuthClientCredentialsProvider);
  });

  it('throws an actionable error when oauth mode is selected without creds', () => {
    expect(() => createAuthProvider({ authMode: 'oauth' })).toThrow(/CLIENT_ID/);
  });

  it('throws when token mode has no token', () => {
    expect(() => createAuthProvider({ authMode: 'token' })).toThrow(/VOCAREUM_API_KEY/);
  });

  it('throws fast on an invalid auth mode from options', () => {
    expect(() => createAuthProvider({ authMode: 'bogus' })).toThrow(/Invalid auth mode/);
  });

  it('throws fast on an invalid VOCAREUM_AUTH_MODE env value (typo)', () => {
    process.env.VOCAREUM_AUTH_MODE = 'ouath';
    expect(() => createAuthProvider({})).toThrow(/Invalid auth mode/);
  });
});
```

- [ ] **Step 6.2: Run, expect fail**

Run: `npx vitest run test/unit/auth/auth-provider.test.ts`
Expected: FAIL — `createAuthProvider` not exported.

- [ ] **Step 6.3: Add env readers in `src/utils/env.ts`**

```ts
export function getOAuthClientId(): string | undefined {
  const v = process.env.VOCAREUM_OAUTH_CLIENT_ID;
  return v && v.length > 0 ? v : undefined;
}
export function getOAuthClientSecret(): string | undefined {
  const v = process.env.VOCAREUM_OAUTH_CLIENT_SECRET;
  return v && v.length > 0 ? v : undefined;
}
/** Raw VOCAREUM_AUTH_MODE (trimmed, lowercased), or undefined if unset/empty.
 *  The VALUE is validated in createAuthProvider so a typo fails fast rather than
 *  silently falling back to token mode. */
export function getAuthModeEnv(): string | undefined {
  const v = process.env.VOCAREUM_AUTH_MODE?.trim().toLowerCase();
  return v && v.length > 0 ? v : undefined;
}
export function getV3ApiBaseUrl(): string {
  return process.env.VOCAREUM_API_V3_BASE_URL ?? 'https://labs.vocareum.com/api/v3';
}
export function getOAuthTokenUrl(): string {
  return process.env.VOCAREUM_OAUTH_TOKEN_URL ?? 'https://labs.vocareum.com/api/v3/oauth/token';
}
```

- [ ] **Step 6.4: Add `createAuthProvider` to `src/api/auth/auth-provider.ts`**

```ts
import { TokenAuthProvider } from './token-auth-provider';
import { OAuthClientCredentialsProvider } from './oauth-provider';
import {
  getApiKeyOrThrow, getOAuthClientId, getOAuthClientSecret,
  getAuthModeEnv, getV3ApiBaseUrl, getOAuthTokenUrl,
} from '../../utils/env';

export interface CreateAuthProviderOptions {
  authMode?: string;         // validated here; from --auth or VOCAREUM_AUTH_MODE
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;       // v2 base from config.vocareum.api_base_url
}

export function createAuthProvider(opts: CreateAuthProviderOptions): AuthProvider {
  const mode = (opts.authMode ?? getAuthModeEnv() ?? 'token').toLowerCase();
  if (mode !== 'token' && mode !== 'oauth') {
    throw new Error(`Invalid auth mode "${mode}". Use "token" (v2, default) or "oauth" (v3).`);
  }
  if (mode === 'oauth') {
    const clientId = opts.clientId ?? getOAuthClientId();
    const clientSecret = opts.clientSecret ?? getOAuthClientSecret();
    if (!clientId || !clientSecret) {
      throw new Error(
        'OAuth mode requires client credentials. Set VOCAREUM_OAUTH_CLIENT_ID and ' +
        'VOCAREUM_OAUTH_CLIENT_SECRET (env or secret manager), or pass --client-id/--client-secret.'
      );
    }
    return new OAuthClientCredentialsProvider({
      clientId, clientSecret,
      apiBaseUrl: getV3ApiBaseUrl(),
      tokenUrl: getOAuthTokenUrl(),
    });
  }
  // token mode
  return new TokenAuthProvider(getApiKeyOrThrow(), opts.apiBaseUrl ?? 'https://api.vocareum.com');
}
```

- [ ] **Step 6.5: Run factory tests, expect pass**

Run: `npx vitest run test/unit/auth/auth-provider.test.ts`
Expected: PASS.

- [ ] **Step 6.6: Shared CLI auth options helper**

`src/api/auth/cli-auth-options.ts`:

```ts
import { Command, Option } from 'commander';
import { createAuthProvider } from './auth-provider';
import type { AuthProvider } from './auth-provider';

export interface AuthCliOptions {
  auth?: string;            // validated by commander .choices() + the factory
  clientId?: string;
  clientSecret?: string;
}

/** Add shared auth flags to a command. Used by push and pull.
 *  `.choices` makes commander reject an invalid --auth value at parse time. */
export function addAuthOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option('--auth <mode>', 'Auth mode: token (v2, default) or oauth (v3)').choices(['token', 'oauth']))
    .option('--client-id <id>', 'v3 OAuth client id (prefer VOCAREUM_OAUTH_CLIENT_ID; flags can leak via shell history)')
    .option('--client-secret <secret>', 'v3 OAuth client secret (prefer VOCAREUM_OAUTH_CLIENT_SECRET; discouraged on the CLI)');
}

/** Resolve an AuthProvider from CLI options + config base URL. */
export function resolveAuthProvider(options: AuthCliOptions, apiBaseUrl: string | undefined): AuthProvider {
  return createAuthProvider({
    authMode: options.auth,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    apiBaseUrl,
  });
}
```

- [ ] **Step 6.7: Wire into commands**

In `src/commands/publish.ts` and `src/commands/pull.ts`, replace the Task 3 construction:

```ts
const client = new VocareumClient(new TokenAuthProvider(apiKey, config.vocareum.api_base_url));
```

with:

```ts
import { resolveAuthProvider } from '../api/auth/cli-auth-options';
// ...
const client = new VocareumClient(resolveAuthProvider(options, config.vocareum.api_base_url));
```

Remove the now-unused `getApiKeyOrThrow`/`TokenAuthProvider` imports if they're no longer referenced (token-mode resolution calls `getApiKeyOrThrow` inside the factory). Add `auth`/`clientId`/`clientSecret` to `PullOptions` and `PublishCommandOptions` types.

In `src/index.ts`, add the flags to both commands via the helper. For push (around line 265) and pull (around line 178):

```ts
import { addAuthOptions } from './api/auth/cli-auth-options';
// ...
addAuthOptions(
  program.command('push')
    // ...existing .option() chain...
);
```

(Apply `addAuthOptions(...)` to the `Command` returned by each `.command()` builder before `.action()`. Keep the existing options.)

- [ ] **Step 6.8: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: green. Update `publish-command.test.ts` / `pull-command.test.ts` if they assert on client construction (they mock `publish`/internal fns, so likely unaffected; fix any that pass `--auth`-less options through).

- [ ] **Step 6.9: Commit**

```bash
git add src/api/auth/auth-provider.ts src/api/auth/cli-auth-options.ts src/utils/env.ts src/commands/publish.ts src/commands/pull.ts src/index.ts test/unit/auth/auth-provider.test.ts
git commit -m "feat: auth-mode factory, env readers, shared CLI auth options, command wiring"
```

---

## Task 7: Gated live smoke script

**Files:**
- Create: `scripts/probe-v3-oauth.mjs`
- Modify: `package.json` (add `probe:v3` script)

- [ ] **Step 7.1: Write the smoke script**

`scripts/probe-v3-oauth.mjs` — read-only by default; `--write` opt-in. Reads `.env`. Never prints secrets/tokens. Header documents that `--write` leaves a `vocgit-smoke-*` assignment behind (manual cleanup).

```js
#!/usr/bin/env node
// Live v3 OAuth smoke. Read-only by default.
//   node scripts/probe-v3-oauth.mjs                 # token exchange + list courses/assignments
//   node scripts/probe-v3-oauth.mjs --write --rw-template-id <id>
// --write copies a template into a "vocgit-smoke-YYYYMMDD-HHMMSS" assignment,
// polls the transaction, updates the copied assignment + part name, verifies
// readback, and NEVER deletes. Manual cleanup required in the Vocareum UI.
import { existsSync, readFileSync } from 'fs';
import axios from 'axios';
import { createHash } from 'crypto';

const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i <= 0) continue;
    const k = t.slice(0, i).trim().replace(/^export\s+/, ''); let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
const arg = (f) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined; };
const doWrite = process.argv.includes('--write');
const clientId = process.env.VOCAREUM_OAUTH_CLIENT_ID ?? process.env.VOCAREUM_INSTRUCTOR_RW_V3;
const clientSecret = process.env.VOCAREUM_OAUTH_CLIENT_SECRET ?? process.env.VOCAREUM_INSTRUCTOR_RW_SEC_V3;
const courseId = process.env.VOCAREUM_API_TEST_COURSEID ?? arg('--course-id');
const V3 = process.env.VOCAREUM_API_V3_BASE_URL ?? 'https://labs.vocareum.com/api/v3';
const TOKEN_URL = process.env.VOCAREUM_OAUTH_TOKEN_URL ?? `${V3}/oauth/token`;
if (!clientId || !clientSecret || !courseId) { console.error('Missing client creds or course id'); process.exit(1); }
console.log(`client sha256=${createHash('sha256').update(clientId).digest('hex').slice(0, 12)}…  course=${courseId}  write=${doWrite}`);

const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const tok = await axios.post(TOKEN_URL, form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
console.log(`token: ${tok.status} type=${tok.data.token_type} expires_in=${tok.data.expires_in}`);
const api = axios.create({ baseURL: V3, headers: { Authorization: `Bearer ${tok.data.access_token}`, 'Content-Type': 'application/json' }, timeout: 30000 });

const courses = await api.get('/courses');
console.log(`GET /courses -> ${courses.status} count=${(courses.data.courses ?? []).length}`);
const asn = await api.get(`/courses/${courseId}/assignments`);
console.log(`GET /courses/${courseId}/assignments -> ${asn.status} count=${(asn.data.assignments ?? []).length}`);

if (!doWrite) { console.log('read-only smoke OK'); process.exit(0); }

const templateId = arg('--rw-template-id');
if (!templateId) { console.error('--write requires --rw-template-id <id>'); process.exit(1); }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const name = `vocgit-smoke-${stamp}`;
const copy = await api.post(`/courses/${courseId}/assignments`, { method: 'copy', source: templateId, name });
console.log(`copy -> ${copy.status} txn=${copy.data.transactionid ?? copy.data.objid}`);
// Poll transaction
let objid = copy.data.objid;
if (copy.data.transactionid) {
  for (let i = 0; i < 15; i++) {
    const txn = await api.get(`/transaction/${copy.data.transactionid}`);
    if (txn.data.state === 'success') { objid = txn.data.objid ?? objid; break; }
    if (txn.data.state === 'error' || txn.data.state === 'failed') { console.error(`txn ${txn.data.state}`); process.exit(2); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log(`created assignment ${objid} ("${name}") — LEFT IN COURSE, manual cleanup`);
const upd = await api.put(`/courses/${courseId}/assignments/${objid}`, { name: `${name}-renamed` });
console.log(`update assignment name -> ${upd.status}`);
const back = await api.get(`/courses/${courseId}/assignments`);
const found = (back.data.assignments ?? []).find((a) => String(a.id) === String(objid));
console.log(`assignment readback name="${found?.name}" (expected "${name}-renamed")`);

// Update a copied part name + readback (poll if the update is async)
const partsRes = await api.get(`/courses/${courseId}/assignments/${objid}/parts`);
const parts = partsRes.data.parts ?? [];
if (parts.length === 0) { console.error('copied assignment has no parts to update'); process.exit(2); }
const partId = parts[0].id;
const partName = `${name}-part-renamed`;
const pUpd = await api.put(`/courses/${courseId}/assignments/${objid}/parts/${partId}`, { name: partName });
console.log(`update part name -> ${pUpd.status}`);
if (pUpd.data?.transactionid) {
  for (let i = 0; i < 15; i++) {
    const txn = await api.get(`/transaction/${pUpd.data.transactionid}`);
    if (txn.data.state === 'success') break;
    if (txn.data.state === 'error' || txn.data.state === 'failed') { console.error(`part txn ${txn.data.state}`); process.exit(2); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const partsBack = await api.get(`/courses/${courseId}/assignments/${objid}/parts`);
const pFound = (partsBack.data.parts ?? []).find((p) => String(p.id) === String(partId));
console.log(`part readback name="${pFound?.name}" (expected "${partName}")`);
console.log('write smoke OK');
```

- [ ] **Step 7.2: Add npm script**

In `package.json` scripts: `"probe:v3": "node scripts/probe-v3-oauth.mjs"`.

- [ ] **Step 7.3: Run read-only smoke**

Run: `npm run probe:v3`
Expected: token exchange 200, list courses + assignments 200. (Uses instructor-RW creds from `.env`.)

- [ ] **Step 7.4: Run gated write smoke (with a real template id from the test course)**

Pick a template assignment id from the read-only listing, then:
Run: `node scripts/probe-v3-oauth.mjs --write --rw-template-id <templateId>`
Expected: copy → txn success → name update → readback shows the renamed value. Note the created `vocgit-smoke-*` id for manual cleanup.

- [ ] **Step 7.5: Commit**

```bash
git add scripts/probe-v3-oauth.mjs package.json
git commit -m "test: gated live v3 OAuth smoke script (read-only + opt-in write)"
```

---

## Task 8: Docs

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 8.1: README — add a v3 OAuth section**

Under Configuration / Environment Variables, document:
- `VOCAREUM_AUTH_MODE=token|oauth` (default token).
- `VOCAREUM_OAUTH_CLIENT_ID` / `VOCAREUM_OAUTH_CLIENT_SECRET` (prefer env/secret manager; `--client-id`/`--client-secret` flags exist but are **discouraged** — they leak via shell history/process listings).
- `VOCAREUM_API_V3_BASE_URL` (default `https://labs.vocareum.com/api/v3`), `VOCAREUM_OAUTH_TOKEN_URL` (default `…/api/v3/oauth/token`).
- A CI example using repository secrets for the client id/secret.
- Note: v2 token is the default; v3 OAuth is opt-in this release; never put secrets in `vocareum.yaml`.

- [ ] **Step 8.2: CHANGELOG — add an entry**

Add under `## [Unreleased]` (or the next version): "Added v3 OAuth client-credentials auth (`--auth oauth` / `VOCAREUM_AUTH_MODE=oauth`) alongside v2 token auth (default unchanged). New `AuthProvider` seam; version-relative API paths; recursive log redaction; path-aware base-URL/token-URL validation."

- [ ] **Step 8.3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document v3 OAuth auth mode and credentials"
```

---

## Out of scope (per spec "Deferred")

- Auto-selecting OAuth when creds are present and no token is set.
- First-party capabilities endpoint (keep file-configured capability mappings).
- Refresh-token / non-client-credentials grants.
- Fixing the org-readonly credential pair (rejected `invalid_client`; owned by voc-mcp side; this plan uses instructor-RW for the write smoke).
