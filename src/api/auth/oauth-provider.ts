import axios, { type AxiosInstance } from 'axios';
import type { AuthProvider } from './auth-provider';
import { AuthenticationError, InsecureBaseUrlError, assertBaseUrlForVersion } from '../client';

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
  readonly unauthorizedHint =
    'OAuth authentication failed. Verify VOCAREUM_OAUTH_CLIENT_ID / ' +
    'VOCAREUM_OAUTH_CLIENT_SECRET and that the client is authorized for this org.';
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly post: PostFn;
  private readonly now: () => number;
  private cached?: CachedToken;
  private inflight?: Promise<string>;
  private static sharedHttp?: AxiosInstance;

  constructor(opts: OAuthProviderOptions) {
    // OAuth must target the v3 host; reject a crossed base URL (e.g. the v2
    // host via VOCAREUM_API_V3_BASE_URL) so a Bearer token is never sent to v2.
    assertBaseUrlForVersion(opts.apiBaseUrl, 'v3');
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
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
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
      // Refresh 5 min early, but keep at least a 30s TTL so short-lived tokens
      // don't trigger a re-exchange on every request.
      expiresAtMs: this.now() + Math.max(30, expiresInSec - TOKEN_REFRESH_BUFFER_SEC) * 1000,
    };
    return data.access_token;
  }
}
