import { OAuthClientCredentialsProvider } from './oauth-provider';
import { TokenAuthProvider } from './token-auth-provider';

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

function getAuthModeEnv(): string | undefined {
  return process.env.VOCAREUM_AUTH_MODE;
}

function getOAuthClientId(): string | undefined {
  return process.env.VOCAREUM_OAUTH_CLIENT_ID;
}

function getOAuthClientSecret(): string | undefined {
  return process.env.VOCAREUM_OAUTH_CLIENT_SECRET;
}

export interface CreateAuthProviderOptions {
  authMode?: string;
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;
}

export function createAuthProvider(opts: CreateAuthProviderOptions = {}): AuthProvider {
  const mode = (opts.authMode ?? getAuthModeEnv() ?? 'token').trim().toLowerCase();
  const baseUrl = opts.apiBaseUrl ?? 'https://api.vocareum.com';

  if (mode === 'oauth') {
    const clientId = (opts.clientId ?? getOAuthClientId())?.trim();
    const clientSecret = (opts.clientSecret ?? getOAuthClientSecret())?.trim();
    if (!clientId || !clientSecret) {
      throw new Error(
        'OAuth mode requires both VOCAREUM_OAUTH_CLIENT_ID and VOCAREUM_OAUTH_CLIENT_SECRET ' +
        '(or opts.clientId and opts.clientSecret). Set via environment variables or pass them in options.'
      );
    }
    return new OAuthClientCredentialsProvider({
      clientId,
      clientSecret,
      apiBaseUrl: baseUrl,
      tokenUrl: 'https://labs.vocareum.com/api/v3/oauth/token',
    });
  }

  if (mode === 'token') {
    const token = process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN;
    if (!token) {
      throw new Error(
        'Token mode requires VOCAREUM_API_KEY or VOCAREUM_API_TOKEN environment variable.'
      );
    }
    return new TokenAuthProvider(token, baseUrl);
  }

  throw new Error(`Unknown auth mode: '${mode}'. Must be 'token' or 'oauth'.`);
}
