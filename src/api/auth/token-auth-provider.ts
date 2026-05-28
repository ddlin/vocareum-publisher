import type { AuthProvider } from './auth-provider';
import { normalizeApiBaseUrl, assertBaseUrlForVersion } from '../client';

export class TokenAuthProvider implements AuthProvider {
  readonly apiBaseUrl: string;
  constructor(private readonly token: string, baseUrl = 'https://api.vocareum.com') {
    this.apiBaseUrl = normalizeApiBaseUrl(baseUrl);
    // Token auth must target the v2 host; reject a crossed base URL (e.g. the v3
    // host in api_base_url) so a personal Token is never sent to v3.
    assertBaseUrlForVersion(this.apiBaseUrl, 'v2');
  }
  async getAuthorizationHeader(): Promise<string> {
    return `Token ${this.token}`;
  }
}
