/**
 * Publisher Module
 *
 * Execute the reconciliation plan by orchestrating API calls.
 */

import type { Config } from '../types/config';
import type { PublishResult, PublishOperationOptions } from '../types/state';
import { VocareumClient } from '../api/client';
import { withSession } from './session';
import { planPush, executePush } from './services/push-service';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { NonInteractivePrompter } from './services/context';
import type { UnknownFieldReporter } from '../utils/unknown-field-reporter';

// Re-export helpers from the shared module so downstream callers importing from
// publisher.ts continue to work without changes.
export {
  RESERVED_ASSIGNMENT_KEYS,
  RESERVED_PART_KEYS,
  isHttp400,
  sanitizeSubmissionFilters,
  normalizeTags,
  withoutUndefined,
  filterUnknownSettingsForPayload,
  hasSettingValue,
  settingsEqual,
  pushSettingChange,
  buildPartSettingsPayload,
  collectSettingsState,
} from './payload-helpers';

/**
 * Internal: executes a push without prompting; confirmation belongs to the CLI wrapper.
 *
 * Compatibility shim — builds a PushContext from legacy parameters, opens one
 * withSession, calls planPush → executePush (no confirm). Callers that need
 * interactive confirmation should use planPush + executePush directly.
 *
 * @param config - Configuration to publish
 * @param client - Vocareum API client
 * @param options - Publish options
 * @returns Publish result
 */
export async function publish(
  config: Config,
  client: VocareumClient,
  options: PublishOperationOptions,
  reporter?: UnknownFieldReporter
): Promise<PublishResult> {
  const configPath = options.configPath ?? 'vocareum.yaml';
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  const ctx = {
    persistedConfig: config,
    effectiveConfig: config,
    configPath,
    workspaceRoot,
    events: new LoggerEventSink(),
    prompter: new NonInteractivePrompter(),
    client,
  };

  const req = {
    dryRun: options.dryRun,
    nonInteractive: true, // shim is always non-interactive
    autoCommit: options.autoCommit,
    syncDeletes: options.syncDeletes,
    onMissingId: options.onMissingId,
    abortOnError: options.abortOnError,
    assignment: options.assignment,
    part: options.part,
    forceAll: options.forceAll,
    verbose: options.verbose,
    deferDeleteResolution: true,
  };

  return withSession(configPath, async (session) => {
    const plan = await planPush(ctx, req);
    return executePush(session, ctx, req, plan, reporter);
  });
}
