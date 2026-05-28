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
