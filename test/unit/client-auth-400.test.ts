import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { VocareumClient, AuthenticationError, APIError } from '../../src/api/client';
import type { AuthProvider } from '../../src/api/auth/auth-provider';

/**
 * Vocareum signals a bad token IN BAND: HTTP 400 with
 * { error: { message: "Invalid Token" } }, not the 401 the switch expects.
 *
 * Recorded from the live API on 2026-09-08:
 *   invalid token      -> 400 { error: { message: "Invalid Token" } }
 *   missing token      -> 400 { error: { message: "Missing Token" } }
 *   nonexistent course -> 400 { error: { message: "Invalid course" } }
 *   forbidden course   -> 403 { error: { message: "Course access forbidden" } }
 *
 * The third row is why "classify every 400 as auth" is wrong: 400 is overloaded,
 * carrying both auth failures and ordinary bad-request conditions.
 */
function axios400(message: string): AxiosError {
  const error = new AxiosError('Request failed with status code 400');
  error.response = {
    status: 400,
    statusText: 'Bad Request',
    data: { error: { message } },
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  error.config = { headers: new AxiosHeaders() };
  return error;
}

/** wrapError is private; exercise it the way the client does. */
function wrap(client: VocareumClient, error: unknown): unknown {
  return (client as unknown as { wrapError(e: unknown): unknown }).wrapError(error);
}

/** Minimal token provider; wrapError never touches the network. */
const authProvider: AuthProvider = {
  apiBaseUrl: 'https://api.vocareum.com/api/v2',
  getAuthorizationHeader: () => Promise.resolve('Token test-token'),
  invalidate: () => { /* no cached credentials to drop */ },
};

describe('in-band auth failures on HTTP 400', () => {
  const client = new VocareumClient(authProvider);

  it('maps "Invalid Token" to AuthenticationError so it exits 3, not 1', () => {
    const wrapped = wrap(client, axios400('Invalid Token'));
    expect(wrapped).toBeInstanceOf(AuthenticationError);
  });

  it('maps "Missing Token" to AuthenticationError', () => {
    expect(wrap(client, axios400('Missing Token'))).toBeInstanceOf(AuthenticationError);
  });

  it('is case-insensitive, since the casing is the API\'s to change', () => {
    expect(wrap(client, axios400('invalid token'))).toBeInstanceOf(AuthenticationError);
  });

  it('carries the token hint, which a bare APIError would have lost', () => {
    const wrapped = wrap(client, axios400('Invalid Token')) as Error;
    expect(wrapped.message).toContain('Invalid Token');
    expect(wrapped.message).toMatch(/Personal Access Tokens/);
  });

  it('leaves "Invalid course" as an APIError — 400 is overloaded', () => {
    const wrapped = wrap(client, axios400('Invalid course'));
    expect(wrapped).toBeInstanceOf(APIError);
    expect(wrapped).not.toBeInstanceOf(AuthenticationError);
  });

  it('does not treat an unrelated 400 mentioning a token as auth', () => {
    // Guards against a loose /token/i match swallowing real bad-request errors.
    const wrapped = wrap(client, axios400('Token limit exceeded for assignment'));
    expect(wrapped).toBeInstanceOf(APIError);
    expect(wrapped).not.toBeInstanceOf(AuthenticationError);
  });
});
