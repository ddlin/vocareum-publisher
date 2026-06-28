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
  /** Hint appended to a 401 AuthenticationError, tailored to the credential
   *  type (personal token vs OAuth client credentials). Optional — the client
   *  falls back to a generic token-centric message when absent. */
  readonly unauthorizedHint?: string;
  /** Invalidate cached credentials so the next getAuthorizationHeader() re-acquires.
   *  Optional — token auth has no refresh, so a 401 there is terminal. */
  refreshAfterUnauthorized?(): Promise<void>;
}

import { TokenAuthProvider } from './token-auth-provider';
import { OAuthClientCredentialsProvider } from './oauth-provider';
import {
  getApiKeyOrThrow, getOAuthClientId, getOAuthClientSecret,
  getAuthModeEnv, getV3ApiBaseUrl, getOAuthTokenUrl,
} from '../../utils/env';
import type { EventSink } from '../../core/services/event-sink';

export interface CreateAuthProviderOptions {
  authMode?: string;         // validated here; from --auth or VOCAREUM_AUTH_MODE
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;       // v2 base from config.vocareum.api_base_url
  events?: EventSink;
}

export function createAuthProvider(opts: CreateAuthProviderOptions): AuthProvider {
  const mode = (opts.authMode ?? getAuthModeEnv() ?? 'token').toLowerCase();
  if (mode !== 'token' && mode !== 'oauth') {
    throw new Error(`Invalid auth mode "${mode}". Use "token" (v2, default) or "oauth" (v3).`);
  }
  if (mode === 'oauth') {
    const clientId = (opts.clientId ?? getOAuthClientId())?.trim();
    const clientSecret = (opts.clientSecret ?? getOAuthClientSecret())?.trim();
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
      events: opts.events,
    });
  }
  return new TokenAuthProvider(
    getApiKeyOrThrow(),
    opts.apiBaseUrl ?? 'https://api.vocareum.com',
    opts.events,
  );
}
