import { ConfigError } from '../core/config';

/** Resolved settings for pull's zip download path. */
export interface PullZipSettings {
  /** Whether pull may download a directory as one Vocareum zip. */
  enabled: boolean;
  /** Overall time allowed for one zip job, in milliseconds. */
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;

const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * Reads and validates VOCAREUM_PULL_ZIP and VOCAREUM_ZIP_TIMEOUT_MS.
 *
 * Both variables are always validated, even when zip is off, so a typo fails
 * fast and identically for every caller instead of lurking until zip is
 * re-enabled. Values are trimmed; an unset or empty value means the default.
 *
 * @param env - Environment to read (defaults to process.env)
 * @returns The resolved settings
 * @throws ConfigError with code INVALID_ENV for any unrecognised value. It is
 *   deliberately not wrapped in CommandFailureError so it classifies as usage (exit 2).
 */
export function resolvePullZipSettings(env: NodeJS.ProcessEnv = process.env): PullZipSettings {
  return { enabled: resolveEnabled(env.VOCAREUM_PULL_ZIP), timeoutMs: resolveTimeout(env.VOCAREUM_ZIP_TIMEOUT_MS) };
}

function resolveEnabled(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') {return true;}
  if (ON_VALUES.has(value)) {return true;}
  if (OFF_VALUES.has(value)) {return false;}
  throw new ConfigError(
    `Invalid VOCAREUM_PULL_ZIP value "${raw}". Use one of: 1, true, on, yes (zip on) or 0, false, off, no (zip off).`,
    'INVALID_ENV',
  );
}

function resolveTimeout(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') {return DEFAULT_TIMEOUT_MS;}
  // Digits only: rejects signs, fractions, exponents, hex and NaN in one test.
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `Invalid VOCAREUM_ZIP_TIMEOUT_MS value "${raw}". Use a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`,
      'INVALID_ENV',
    );
  }
  return parsed;
}
