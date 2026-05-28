/**
 * Abstraction over Vocareum authentication. Owns the API base URL (including
 * the version path) and produces the Authorization header. See spec
 * docs/superpowers/specs/2026-05-27-v3-oauth-support-design.md.
 */
export interface AuthProvider {
  /** API base URL including version path, e.g. https://api.vocareum.com/api/v2.
   *  MUST be already normalized (include the /api/vN path) and allowlisted —
   *  VocareumClient calls assertAllowedBaseUrl on it but does not normalize. */
  readonly apiBaseUrl: string;
  /** Authorization header value, e.g. "Token x" or "Bearer y". May exchange/refresh lazily. */
  getAuthorizationHeader(): Promise<string>;
  /** Invalidate cached credentials so the next getAuthorizationHeader() re-acquires.
   *  Optional — token auth has no refresh, so a 401 there is terminal. */
  refreshAfterUnauthorized?(): Promise<void>;
}
