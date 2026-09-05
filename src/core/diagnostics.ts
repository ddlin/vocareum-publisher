/**
 * The closed set of machine-readable diagnostic codes.
 *
 * A code is a stable public identifier. Consumers branch on it and never on
 * `message`, which stays free to be reworded. Adding a code is a minor
 * schema_version bump; removing one or changing a severity is a major bump.
 *
 * Severity never sets the exit code (see the spec, section 5.0): a warn-level
 * diagnostic fires on nearly every Elite pull, because those courses declare a
 * `docs` directory that cannot exist in an Elite workspace. Were that alone
 * enough to fail a run, callers would learn to ignore the signal entirely.
 */
import type { ServiceEvent } from './services/event-sink';

export const DIAGNOSTIC_CODES = [
  'directory_unreachable',
  'download_truncated',
  'download_failed',
  'upload_incomplete',
  'delete_sync_failed',
  'part_settings_fallback',
  'unknown_settings',
  'symlink_skipped',
  'insecure_base_url',
  'auto_commit_failed',
  'rubric_read_failed',
  'rubric_write_forbidden',
  'rubric_write_skipped',
] as const;

export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'warn' | 'error';
  message: string;
  /** Occurrences collapsed into this entry; always >= 1. */
  count: number;
  data?: Record<string, unknown>;
}

export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return (DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/**
 * Key-order-independent serialization, so two emit sites that build the same
 * data object in different orders collapse into one diagnostic.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value) ?? 'null'; }
  if (Array.isArray(value)) { return `[${value.map(canonical).join(',')}]`; }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * Turn a captured event stream into the report's `diagnostics` array.
 *
 * Only warn/error events carrying a registered code qualify. An unregistered
 * code is dropped rather than passed through: a typo must not silently become
 * part of a public contract. The guard test in
 * test/unit/no-forbidden-imports.test.ts makes such a typo a build failure.
 */
export function collectDiagnostics(events: readonly ServiceEvent[]): Diagnostic[] {
  const byKey = new Map<string, Diagnostic>();

  for (const event of events) {
    const { code, level } = event;
    if (code === undefined) { continue; }
    if (level !== 'warn' && level !== 'error') { continue; }
    if (!isDiagnosticCode(code)) { continue; }

    const data = (event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data))
      ? (event.data as Record<string, unknown>)
      : undefined;
    const key = `${code}|${canonical(data)}`;

    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    byKey.set(key, {
      code,
      severity: level,
      message: event.message ?? '',
      count: 1,
      ...(data !== undefined ? { data } : {}),
    });
  }

  return [...byKey.values()];
}
