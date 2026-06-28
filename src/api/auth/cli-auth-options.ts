import { Command, Option } from 'commander';
import { createAuthProvider } from './auth-provider';
import type { AuthProvider } from './auth-provider';
import type { EventSink } from '../../core/services/event-sink';

export interface AuthCliOptions {
  auth?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Add shared auth flags to a command. `.choices` makes commander reject an invalid --auth at parse time. */
export function addAuthOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option('--auth <mode>', 'Auth mode: token (v2, default) or oauth (v3)').choices(['token', 'oauth']))
    .option('--client-id <id>', 'v3 OAuth client id (prefer VOCAREUM_OAUTH_CLIENT_ID; flags can leak via shell history)')
    .option('--client-secret <secret>', 'v3 OAuth client secret (prefer VOCAREUM_OAUTH_CLIENT_SECRET; discouraged on the CLI)');
}

/** Resolve an AuthProvider from CLI options + config base URL. */
export function resolveAuthProvider(
  options: AuthCliOptions,
  apiBaseUrl: string | undefined,
  events?: EventSink,
): AuthProvider {
  return createAuthProvider({
    authMode: options.auth,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    apiBaseUrl,
    events,
  });
}
