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
import {
  canonicalBaseUrl, displayHost, normalizeApiBaseUrl, regionForBaseUrl, resolveV2ApiBaseUrl,
} from '../regions';

export interface CreateAuthProviderOptions {
  authMode?: string;         // validated here; from --auth or VOCAREUM_AUTH_MODE
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;       // v2 base from config.vocareum.api_base_url
  /** v2 base from the --api-base-url flag. Beats VOCAREUM_API_BASE_URL, which
   *  beats apiBaseUrl (config). Token auth only. */
  apiBaseUrlOverride?: string;
  events?: EventSink;
}

function sameBaseUrl(a: string, b: string): boolean {
  return canonicalBaseUrl(normalizeApiBaseUrl(a)) === canonicalBaseUrl(normalizeApiBaseUrl(b));
}

function hostLabel(baseUrl: string): string {
  const region = regionForBaseUrl(baseUrl);
  return `${displayHost(baseUrl)}${region === undefined ? '' : ` (${region.toUpperCase()})`}`;
}

export function createAuthProvider(opts: CreateAuthProviderOptions): AuthProvider {
  const mode = (opts.authMode ?? getAuthModeEnv() ?? 'token').toLowerCase();
  if (mode !== 'token' && mode !== 'oauth') {
    throw new Error(`Invalid auth mode "${mode}". Use "token" (v2, default) or "oauth" (v3).`);
  }
  if (mode === 'oauth') {
    if (opts.apiBaseUrlOverride !== undefined && opts.apiBaseUrlOverride.trim() !== '') {
      throw new Error(
        '--api-base-url selects the v2 host for token auth and cannot be used with --auth oauth. ' +
        'Use VOCAREUM_API_V3_BASE_URL to override the v3 host.'
      );
    }
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
  const resolved = resolveV2ApiBaseUrl({ flag: opts.apiBaseUrlOverride, config: opts.apiBaseUrl });
  // Construct first: an unallowlisted override fails here, before we say anything about it.
  const provider = new TokenAuthProvider(getApiKeyOrThrow(), resolved.baseUrl, opts.events);
  // NA and EU repos live side by side; course IDs are tenant-specific. If a flag
  // or env var points this run at a different host than vocareum.yaml declares,
  // say so — a stray shell export should never silently redirect a push.
  if ((resolved.source === 'flag' || resolved.source === 'env') &&
      opts.apiBaseUrl !== undefined && !sameBaseUrl(resolved.baseUrl, opts.apiBaseUrl)) {
    const via = resolved.source === 'flag' ? '--api-base-url' : 'VOCAREUM_API_BASE_URL';
    opts.events?.emit({
      level: 'warn',
      message: `API host overridden by ${via}: using ${hostLabel(resolved.baseUrl)}; ` +
        `vocareum.yaml declares ${hostLabel(opts.apiBaseUrl)}.`,
    });
  }
  return provider;
}
