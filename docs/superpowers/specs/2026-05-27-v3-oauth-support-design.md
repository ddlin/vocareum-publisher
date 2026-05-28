# v3 OAuth Support — Design

**Date:** 2026-05-27
**Status:** Approved (with review refinements). Blocking gate **CLEARED** 2026-05-28 via live read-only smoke — endpoint and Bearer flow confirmed. Ready for implementation plan.

## Implementation gate — RESOLVED (2026-05-28)

A live read-only smoke against test course 215500 (instructor-RW client; client_id hash matched voc-mcp's capability report) confirmed:

- **Token endpoint:** `https://labs.vocareum.com/api/v3/oauth/token`. The host-root `/oauth/token` returns 404 — so `/oauth/token` in the capability report is relative to the v3 base. **This is the pinned default `tokenUrl`** and the sole allowed token host+path.
- **Token exchange:** `POST` form-encoded `client_credentials` → `200`, `token_type: Bearer`, `expires_in: 3600`.
- **Reads:** `GET /courses` → `{status, courses}`; `GET /courses/{id}/assignments` → `{status, assignments, total_records}`; all IDs strings — shapes mirror v2.
- **Credential note:** the instructor-RW pair (`VOCAREUM_INSTRUCTOR_RW_V3`/`_SEC_V3`) works and will drive the gated write smoke. The org-readonly pair (`VOCAREUM_ORG_READONLY_V3`/`_SEC_V3`) is currently rejected (`invalid_client`) and is **not** relied upon by this plan.
**Author:** David Lin (vocgit maintainer)
**Sources:** `.claude/oauth-support-recommendation.md`, `.claude/oauth-capability-report.json` (voc-mcp live probe), `.claude/feedback-from-voc-mcp.md`

## Problem

vocgit authenticates to Vocareum with a v2 personal token: a hardcoded `Authorization: Token <apiKey>` header set in the `VocareumClient` constructor ([client.ts:210](../../../src/api/client.ts#L210)), against base host `https://api.vocareum.com` with `/api/v2/...` paths hardcoded at ~21 call sites. Vocareum now offers a v3 API authenticated with **OAuth client-credentials** (`Authorization: Bearer <access_token>`) on a different host (`https://labs.vocareum.com`). voc-mcp has empirically confirmed v3 token exchange and reads work; v3 response shapes mirror v2.

vocgit needs to support v3 OAuth **alongside** the existing v2 token flow, without leaking auth-mode or base-URL concerns into every API module.

## Goals

1. Add v3 OAuth client-credentials auth alongside v2 token auth. v2 token stays the **default** this release.
2. Move auth + base-URL ownership out of `VocareumClient` behind an `AuthProvider` seam, so API modules are auth-agnostic.
3. Lazy OAuth token exchange with caching (honor `expires_in`), single refresh-and-retry on `401`, and request coalescing.
4. Never log or persist secrets/tokens; never write v3 secrets to `vocareum.yaml`.
5. Verify against the live v3 API (read-only + gated write smoke) on test course 215500.

## Non-Goals

- Removing or deprecating v2 token auth (kept as default).
- Auto-selecting OAuth when creds are present (deferred to a later release per the rollout).
- A first-party capabilities endpoint (forthcoming from Vocareum; keep file-configured capability mappings).
- Changing settings/field write policy — OAuth changes authentication only, not which fields are writable. The existing settings capability model is unaffected.

## Design

### 1. AuthProvider seam

New module `src/api/auth/`. The provider owns the API base URL and produces the auth header:

```ts
// src/api/auth/auth-provider.ts
export interface AuthProvider {
  /** API base URL INCLUDING the version path, e.g. https://api.vocareum.com/api/v2 */
  readonly apiBaseUrl: string;
  /** Authorization header value, e.g. "Token x" or "Bearer y". May exchange/refresh lazily. */
  getAuthorizationHeader(): Promise<string>;
  /** Invalidate cached credentials so the next getAuthorizationHeader() re-acquires.
   *  Optional — token auth has no refresh, so a 401 there is terminal. Returns void:
   *  the client re-attempts and the interceptor re-fetches the header (review #4). */
  refreshAfterUnauthorized?(): Promise<void>;
}
```

`tokenUrl` is **not** on the interface — it's an internal detail of the OAuth provider (review #1). The interface exposes only what the client needs: the API base URL and the header.

### 2. TokenAuthProvider (v2)

```ts
// src/api/auth/token-auth-provider.ts
export class TokenAuthProvider implements AuthProvider {
  readonly apiBaseUrl: string;        // normalized to include /api/v2 (see §5)
  constructor(token: string, apiBaseUrl: string) { ... }
  async getAuthorizationHeader(): Promise<string> { return `Token ${this.token}`; }
  // No refreshAfterUnauthorized — a personal token cannot be refreshed; 401 is terminal.
}
```

### 3. OAuthClientCredentialsProvider (v3)

Owns **both** `apiBaseUrl` and a private `tokenUrl` (review #1). Uses a **private, unauthenticated axios instance** for token exchange so the client's auth interceptor cannot recurse or attach a Bearer token while acquiring one (review #2). Coalesces concurrent exchanges via an in-flight promise (review #4).

```ts
// src/api/auth/oauth-provider.ts
interface CachedToken { accessToken: string; expiresAtMs: number; }

export class OAuthClientCredentialsProvider implements AuthProvider {
  readonly apiBaseUrl: string;          // e.g. https://labs.vocareum.com/api/v3
  private readonly tokenUrl: string;    // e.g. https://labs.vocareum.com/api/v3/oauth/token (overridable)
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly http: AxiosInstance; // unauthenticated, dedicated to token exchange
  private cached?: CachedToken;
  private inflight?: Promise<string>;   // coalesce concurrent exchanges

  async getAuthorizationHeader(): Promise<string> {
    return `Bearer ${await this.getAccessToken()}`;
  }

  async refreshAfterUnauthorized(): Promise<void> {
    this.cached = undefined;            // force re-exchange on next getAccessToken
  }

  private async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAtMs) { return this.cached.accessToken; }
    if (this.inflight) { return this.inflight; }
    this.inflight = this.exchange().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async exchange(): Promise<string> {
    // POST tokenUrl, Content-Type: application/x-www-form-urlencoded
    // body: grant_type=client_credentials&client_id=...&client_secret=...
    // On success: cache accessToken, expiresAtMs = now + (expires_in - 300)*1000  (5-min buffer)
    // On failure: throw OAuthTokenExchangeError (NO secret in the message). This error
    //   type is distinct from an API-resource 401 so the client never treats a bad-
    //   credentials exchange failure as a "refresh-and-retry" situation (review #2).
  }
}
```

**`tokenUrl` validation (review #1).** `tokenUrl` is where `client_secret` is transmitted, so it is validated independently and at least as strictly as the API base URL: **HTTPS required**, host+path must match the allowed default (`https://labs.vocareum.com/api/v3/oauth/token`), and any override via `VOCAREUM_OAUTH_TOKEN_URL` is rejected unless `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`. Validation happens in the OAuth provider constructor, before any exchange.

**Token URL default — CONFIRMED.** Live smoke (2026-05-28) confirmed `https://labs.vocareum.com/api/v3/oauth/token` (host-root `/oauth/token` 404s). This is the pinned default and the sole allowed token host+path; overridable via `VOCAREUM_OAUTH_TOKEN_URL` only with `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`. See "Implementation gate — RESOLVED" above.

### 4. VocareumClient changes

- Constructor: `(authProvider: AuthProvider)` instead of `(apiKey, baseUrl)`. `axios.create({ baseURL: authProvider.apiBaseUrl, ... })` — no static `Authorization` header.
- **Async request interceptor** injects the header on every request (including retries): `config.headers.Authorization = await authProvider.getAuthorizationHeader()`.
- **401 refresh-and-retry, exactly once, distinct from normal retry** (review #3). Normal retry (429/5xx/ECONNRESET/ETIMEDOUT) is unchanged and does **not** treat 401 as retryable. A 401 is handled by an outer wrapper that refreshes once and re-attempts once:

```ts
public async request<T>(config, options): Promise<T> {
  try {
    return await this.attempt<T>(config, options);     // normal retry loop; 401 not retryable
  } catch (err) {
    if (isApiResponseUnauthorized(err) && this.authProvider.refreshAfterUnauthorized) {
      await this.authProvider.refreshAfterUnauthorized(); // clears OAuth cache (returns void)
      return await this.attempt<T>(config, options);     // single retry; interceptor picks up fresh token
    }
    throw err;
  }
}
```

- **`isApiResponseUnauthorized` is narrow and precise (review #2).** It means "the upstream API returned **401 in a response** to a request that already carried an auth header" — i.e., the raw error is an `AxiosError` with `response?.status === 401`. It is **not** any `AuthenticationError`. Critically, a **token-exchange failure** (bad `client_secret` → the OAuth provider's `exchange()` throws `OAuthTokenExchangeError`) surfaces from the request interceptor *before* an API call completes; it has no API `response` and is **not** an `AxiosError` 401, so it does **not** trigger the refresh path. It propagates immediately. This prevents the "bad credentials → exchange 401 → refresh → exchange again" pointless loop and surfaces the real cause. (`attempt` evaluates this on the raw axios error before `wrapError` collapses it into an `AuthenticationError`.)

This guarantees at most one refresh+retry per `request()` call, never `maxRetries × authRetries`. Token-mode providers have no `refreshAfterUnauthorized`, so their 401 stays terminal (current behavior).

### 5. Base-URL / path refactor + path-aware validation

- The ~21 `/api/v2/...` call sites in `src/api/*.ts` become **version-relative** (`/courses/...`, `/courses/{c}/assignments/{a}/parts/{p}`, `/transaction/{id}`, …). The version segment moves into the provider's `apiBaseUrl`. Comments that reference `/api/v2/...` are updated to version-relative wording (review #9).
- **Backwards compat:** existing YAMLs set `vocareum.api_base_url: https://api.vocareum.com` (host only). `TokenAuthProvider` normalizes: if the configured/default base URL has no version path, append `/api/v2`. So existing configs keep working.
- **Path-aware allowlist** (review #5). `validateBaseUrl` keeps the host allowlist and adds canonical host+path expectations:
  - token mode → `https://api.vocareum.com/api/v2`
  - oauth mode → `https://labs.vocareum.com/api/v3`
  - A known host with an unexpected path (e.g. `https://api.vocareum.com/evil`) is rejected unless `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`.
  - Both `api.vocareum.com` and `labs.vocareum.com` are allowed hosts.
  - **Mode↔host binding (post-review hardening).** The union allowlist alone would let a crossed override (e.g. `VOCAREUM_API_V3_BASE_URL=https://api.vocareum.com/api/v2` in oauth mode) send a `Bearer` token to the v2 host. So each provider additionally asserts its base URL against a **version-specific** allowlist in its constructor: `TokenAuthProvider`→v2 only, `OAuthClientCredentialsProvider`→v3 only (`assertBaseUrlForVersion`, same `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1` escape hatch). This prevents sending the wrong credential type to the wrong known host.

### 6. Auth-mode selection + shared CLI surface

- Factory `createAuthProvider(opts)` resolves the provider from precedence: explicit flag/`VOCAREUM_AUTH_MODE` → else **default token (v2)**.
  - `oauth` mode requires `client_id` + `client_secret`; clear actionable error if missing.
  - `token` mode requires a token; existing error if missing.
- **Shared CLI helper** (review #6): a single module `src/api/auth/cli-auth-options.ts` adds the `--auth <token|oauth>`, `--client-id`, `--client-secret` options and resolves the provider, consumed by both `push` and `pull` (and future `validate --vocareum`) rather than duplicating commander flags.

### 7. Environment variables (review #7)

| Variable | Purpose |
|---|---|
| `VOCAREUM_AUTH_MODE` | `token` (default) or `oauth` |
| `VOCAREUM_API_KEY` / `VOCAREUM_API_TOKEN` | v2 personal token (existing) |
| `VOCAREUM_OAUTH_CLIENT_ID` | v3 client id |
| `VOCAREUM_OAUTH_CLIENT_SECRET` | v3 client secret |
| `VOCAREUM_API_V3_BASE_URL` | v3 API base (default `https://labs.vocareum.com/api/v3`) |
| `VOCAREUM_OAUTH_TOKEN_URL` | optional token-endpoint override |

CLI flags (`--client-id`/`--client-secret`) override env. Secrets are never written to `vocareum.yaml`.

### 8. Error handling

- Token-exchange failure → `OAuthTokenExchangeError` (extends `AuthenticationError`) with an actionable message, **no secret in it**. Distinct type so the client does not mistake it for an API-resource 401 (review #2); it propagates immediately without a refresh-retry.
- Post-refresh API 401 → `AuthenticationError` (propagates from the second `attempt`).
- Missing creds for the selected mode → actionable error at provider construction (before any API call).
- Unknown host or unexpected path (no override) → `InsecureBaseUrlError` — for both the API base URL **and** `tokenUrl`.

### 9. Security / redaction (review #8)

- Never log `client_secret`, `access_token`, `refresh_token`.
- `sanitizeForLog` becomes **recursive** over objects and form-like bodies (not just the `Authorization` header). Redact keys matching (case-insensitive): `authorization`, `client_secret`, `access_token`, `refresh_token`, `id_token`, `password`, `secret`, and the generic `token`.
- If logging identity, log `sha256(client_id)`, not the raw id.
- Keep ID-to-string normalization (v3 still returns mixed ID typing).
- **`--client-secret`/`--client-id` flags are an escape hatch, documented as discouraged** (review #5): flags leak via shell history and process listings. README prefers env vars / secret managers; the flag is acceptable for local testing only.

### 10. Components touched

| File | Change |
|---|---|
| `src/api/auth/auth-provider.ts` | NEW — `AuthProvider` interface + `createAuthProvider()` factory + mode resolution. |
| `src/api/auth/token-auth-provider.ts` | NEW — v2 provider, base-URL normalization to `/api/v2`. |
| `src/api/auth/oauth-provider.ts` | NEW — v3 provider, token exchange (private unauth axios), caching, coalescing. |
| `src/api/client.ts` | Constructor takes `AuthProvider`; async request interceptor; 401 refresh-retry-once; path-aware `validateBaseUrl`; recursive `sanitizeForLog`. |
| `src/api/courses.ts`, `assignments.ts`, `parts.ts`, `content.ts` | Drop `/api/v2` prefix → version-relative paths; update comments. |
| `src/utils/env.ts` | Readers for auth mode, client id/secret, v3 base/token URLs. |
| `src/commands/publish.ts`, `pull.ts` | Use the shared auth helper + factory to build the provider; construct client from it. |
| `src/api/auth/cli-auth-options.ts` | NEW — shared commander flags + provider resolution (used by push/pull). |
| `src/index.ts` | Wire `--auth`/`--client-id`/`--client-secret` on push/pull. |
| `scripts/probe-v3-oauth.mjs` | NEW — gated live smoke (read-only + opt-in write). |
| `test/unit/...` | New provider/client auth tests; update tests asserting `/api/v2/...`. |
| `README.md`, `CHANGELOG.md` | Document v3 OAuth, env/CI examples. |

### 11. Test contract

**Unit:**
1. Token mode → header `Token <token>`, `apiBaseUrl` resolves to `…/api/v2`.
2. OAuth mode → form-encoded `client_credentials` exchange, header `Bearer <access_token>`, `apiBaseUrl` `…/api/v3`.
3. Token cache honors `expires_in` minus the 5-min buffer (no re-exchange before expiry; re-exchange after).
4. Wrong `client_secret` for a given `client_id` does **not** reuse a previously cached token.
5. Concurrent requests on an expired/empty cache trigger **one** exchange (coalescing).
6. Upstream API `401` → cache invalidated, re-exchange **once**, retry **once**; a second 401 throws `AuthenticationError` (no infinite loop, no `maxRetries × authRetries`).
7. Normal retry (429/5xx) still works and is independent of the 401 path.
7a. **Token-exchange failure does NOT trigger the API-401 refresh path** (review #2): a `401` from the token endpoint (bad `client_secret`) throws `OAuthTokenExchangeError`, exchange runs once, and the client surfaces it immediately — it does not re-exchange or retry the API call.
7b. **`tokenUrl` validation** (review #1): HTTPS required; the default host+path is accepted; an arbitrary `VOCAREUM_OAUTH_TOKEN_URL` is rejected as `InsecureBaseUrlError` unless `VOCAREUM_ALLOW_CUSTOM_BASE_URL=1`; an `http://` token URL is rejected.
8. Redaction: logs/errors never contain `client_secret`/`access_token`; recursive redaction covers nested objects and the token-exchange form body.
9. `validateBaseUrl`: accepts the two canonical host+path combos; rejects unexpected path on a known host unless override set; rejects unknown host.
10. Token-exchange failure → `AuthenticationError` without the secret.
11. Existing v2 call-site tests updated to version-relative paths and still pass.

**Live (gated, opt-in flag, not in `npm test`):** against course 215500 with `VOCAREUM_OAUTH_CLIENT_ID`/`SECRET`.
12. Read-only smoke: token exchange → `GET /courses` → `GET /courses/215500/assignments`. Confirms the real `tokenUrl` and Bearer flow.
13. Gated write smoke: copy a template assignment, poll transaction to `success`, update the copied assignment name, update a copied part name, verify readback. **Never deletes.**

### 12. Round-trip / adversarial considerations (per AGENTS.md discipline)

- **Auth-mode round trip:** token-default with no env set → token provider (unchanged behavior); `VOCAREUM_AUTH_MODE=oauth` with creds → oauth; oauth without creds → actionable error, not a confusing 401. Each path tested.
- **Adversarial input:** secrets only from env/flags, never yaml; a `client_secret` accidentally placed in `vocareum.yaml` is ignored by auth resolution (and the recursive redactor keeps it out of logs if it appears in a logged config object); malicious `api_base_url` rejected by the path-aware allowlist.
- **Token-expiry edge:** clock skew handled by the 5-min early-refresh buffer; a mid-run expiry surfaces as a 401 → single refresh+retry.

## Live write smoke — accumulation story (review #10)

The write smoke creates a copied assignment that vocgit will not delete. Use a strong, timestamped prefix `vocgit-smoke-YYYYMMDD-HHMMSS`, print the created IDs, document manual cleanup in the script header and README, and keep it strictly opt-in (explicit flag, excluded from `npm test`).

## Rollout

1. Ship v3 OAuth behind explicit `--auth oauth` / `VOCAREUM_AUTH_MODE=oauth`; **v2 token remains default**.
2. README/CHANGELOG + CI/secret-manager examples for `VOCAREUM_OAUTH_CLIENT_ID`/`SECRET`.
3. Read-only smoke first; gated write smoke behind a flag.
4. (Deferred, later release) consider auto-selecting OAuth when both client creds are set and no v2 token is present.

## Deferred

- Auto OAuth-mode selection.
- First-party capabilities endpoint consumption (keep file-configured capability mappings until available).
- Refresh-token / other grant types (only client-credentials is in scope).
