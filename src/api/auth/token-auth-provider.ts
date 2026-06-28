import type { AuthProvider } from './auth-provider';
import { normalizeApiBaseUrl, assertBaseUrlForVersion } from '../client';
import type { EventSink } from '../../core/services/event-sink';

export class TokenAuthProvider implements AuthProvider {
  readonly apiBaseUrl: string;
  readonly unauthorizedHint =
    'Your API token may be invalid or expired. ' +
    'Generate a new token at: Profile > Settings > Personal Access Tokens';
  constructor(
    private readonly token: string,
    baseUrl = 'https://api.vocareum.com',
    events?: EventSink,
  ) {
    this.apiBaseUrl = normalizeApiBaseUrl(baseUrl);
    // Token auth must target the v2 host; reject a crossed base URL (e.g. the v3
    // host in api_base_url) so a personal Token is never sent to v3.
    assertBaseUrlForVersion(this.apiBaseUrl, 'v2', events);
  }
  getAuthorizationHeader(): Promise<string> {
    return Promise.resolve(`Token ${this.token}`);
  }
}
