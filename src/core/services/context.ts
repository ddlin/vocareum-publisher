/**
 * Service layer contexts, Prompter interface, and RuntimeFacts.
 *
 * IMPORTANT: This file MUST NOT import logger. It may import prompts utilities,
 * EventSink, Config, and VocareumClient types.
 */

import type { EventSink } from './event-sink';
import type { Config } from '../../types/config';
import type { VocareumClient } from '../../api/client';
import { prompt, promptConfirm, promptChoice } from '../../utils/prompts';

// ---------------------------------------------------------------------------
// RuntimeFacts — auth mode, CI detection, credential readiness
// ---------------------------------------------------------------------------

/** The API host a run would target, as resolved by the command layer. */
export interface ApiTargetFacts {
  /** Normalized base URL including the /api/vN path. */
  base_url: string;
  /** Hostname only — safe to display/log. */
  host: string;
  /** 'na' | 'eu' for a known Vocareum tenant; null for a custom host. */
  region: 'na' | 'eu' | null;
  /** Where the value came from (flag is never seen by status). */
  source: 'flag' | 'env' | 'config' | 'default';
  /** Exact allowlist match for the auth mode's API version. When false, the
   *  run is refused unless VOCAREUM_ALLOW_CUSTOM_BASE_URL=1. */
  allowlisted: boolean;
}

export interface RuntimeFacts {
  ci: boolean;
  ciProvider?: string;
  authMode: 'token' | 'oauth';
  credentialLabel: string;
  credentialsConfigured: boolean;
  /** Resolved API host. Populated by `status`; other commands may omit it. */
  api?: ApiTargetFacts;
}

// ---------------------------------------------------------------------------
// Prompter interface + implementations
// ---------------------------------------------------------------------------

export interface Prompter {
  confirm(msg: string, def?: boolean): Promise<boolean>;
  choice(msg: string, choices: string[]): Promise<string>;
  input(msg: string, def?: string): Promise<string>;
}

export class UnresolvedDecisionError extends Error {
  constructor(decision: string) {
    super(`Unresolved decision in non-interactive mode: ${decision}`);
    this.name = 'UnresolvedDecisionError';
  }
}

/**
 * Interactive prompter that delegates to src/utils/prompts.
 * Prompt function mapping:
 *   confirm → promptConfirm
 *   choice  → promptChoice
 *   input   → prompt
 */
export class InteractivePrompter implements Prompter {
  confirm(msg: string, def?: boolean): Promise<boolean> {
    return promptConfirm(msg, def);
  }

  choice(msg: string, choices: string[]): Promise<string> {
    return promptChoice(msg, choices);
  }

  input(msg: string, def?: string): Promise<string> {
    return prompt(msg, def);
  }
}

/**
 * Non-interactive prompter that rejects every decision with UnresolvedDecisionError.
 * Use in CI / --non-interactive flows where no human is present to answer prompts.
 */
export class NonInteractivePrompter implements Prompter {
  confirm(msg: string): Promise<boolean> {
    return Promise.reject(new UnresolvedDecisionError(msg));
  }

  choice(msg: string): Promise<string> {
    return Promise.reject(new UnresolvedDecisionError(msg));
  }

  input(msg: string): Promise<string> {
    return Promise.reject(new UnresolvedDecisionError(msg));
  }
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export interface BaseContext {
  persistedConfig: Config;
  effectiveConfig: Config;
  configPath: string;
  workspaceRoot: string;
  events: EventSink;
  prompter: Prompter;
}

export type StatusContext = BaseContext & { runtime: RuntimeFacts };
export type ValidateContext = BaseContext;
export type PushContext = BaseContext & { client: VocareumClient };
export type PullContext = BaseContext & { client: VocareumClient };
