import type { ThrottleConfig } from '../types/config';

export interface ResolvedThrottle {
  maxConcurrency: number;
  minIntervalMs: number;
  jitter: boolean;
}

export const DEFAULT_THROTTLE: ResolvedThrottle = {
  maxConcurrency: 1,
  minIntervalMs: 300,
  jitter: true,
};

function parseIntEnv(name: string, raw: string, min: number, max: number): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

function parseBoolEnv(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') { return true; }
  if (v === '0' || v === 'false') { return false; }
  throw new Error(`${name} must be one of 0/1/true/false (got "${raw}").`);
}

/**
 * Resolve throttle settings. Precedence (highest first): env var, config
 * block, built-in default. Config is assumed already schema-validated; env
 * vars are validated here and throw on bad values (no silent clamp).
 */
export function resolveThrottle(
  configThrottle?: ThrottleConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedThrottle {
  let maxConcurrency = configThrottle?.max_concurrency ?? DEFAULT_THROTTLE.maxConcurrency;
  let minIntervalMs = configThrottle?.min_interval_ms ?? DEFAULT_THROTTLE.minIntervalMs;
  let jitter = configThrottle?.jitter ?? DEFAULT_THROTTLE.jitter;

  const cEnv = env.VOCAREUM_MAX_CONCURRENCY;
  if (cEnv !== undefined && cEnv !== '') {
    maxConcurrency = parseIntEnv('VOCAREUM_MAX_CONCURRENCY', cEnv, 1, 5);
  }
  const iEnv = env.VOCAREUM_MIN_REQUEST_INTERVAL_MS;
  if (iEnv !== undefined && iEnv !== '') {
    minIntervalMs = parseIntEnv('VOCAREUM_MIN_REQUEST_INTERVAL_MS', iEnv, 0, 60000);
  }
  const jEnv = env.VOCAREUM_THROTTLE_JITTER;
  if (jEnv !== undefined && jEnv !== '') {
    jitter = parseBoolEnv('VOCAREUM_THROTTLE_JITTER', jEnv);
  }

  return { maxConcurrency, minIntervalMs, jitter };
}
