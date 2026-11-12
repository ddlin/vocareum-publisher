/**
 * The closed set of machine-readable diagnostic codes.
 *
 * A code is a stable public identifier. Consumers branch on it and never on
 * `message`, which stays free to be reworded. Adding a code is a minor
 * schema_version bump; removing one or changing a severity is a major bump.
 * Schema 1.0 is what 1.5.0 first publishes; additions before that release bump nothing.
 *
 * Severity never sets the exit code (see the spec, section 5.0): a warn-level
 * diagnostic fires on nearly every Elite pull, because those courses declare a
 * `docs` directory that cannot exist in an Elite workspace. Were that alone
 * enough to fail a run, callers would learn to ignore the signal entirely.
 */
import type { ServiceEvent } from './services/event-sink';

/**
 * Declared severity per code.
 *
 * The README and AGENTS.md promise that changing a code's severity is a MAJOR
 * schema bump. A bare string list could not enforce that: severity came from
 * whatever level the emit site happened to use, so flipping one from warn to
 * error changed the public meaning with a green build. The registry now states
 * it, `collectDiagnostics` reports the declared value, and a guard test fails
 * if an emit site disagrees.
 */
export const DIAGNOSTIC_SEVERITY = {
  directory_unreachable: 'warn',
  download_truncated: 'warn',
  download_failed: 'warn',
  upload_incomplete: 'error',
  delete_sync_failed: 'warn',
  // Degrading to a safer payload: something WAS written, minus some fields.
  part_settings_fallback: 'warn',
  // The ladder exhausted: NOTHING was written. A different event deserving a
  // different code -- one code cannot carry two severities, which is the whole
  // point of declaring them.
  part_settings_rejected: 'error',
  unknown_settings: 'warn',
  symlink_skipped: 'warn',
  insecure_base_url: 'warn',
  auto_commit_failed: 'warn',
  rubric_read_failed: 'error',
  // A permission failure that blocks rubric sync for the run; both emit sites
  // are terminal for rubrics, so both are error.
  rubric_write_forbidden: 'error',
  rubric_write_skipped: 'warn',
  zip_not_used: 'warn',
  directory_blocked: 'error',
} as const satisfies Record<string, 'warn' | 'error'>;

export const DIAGNOSTIC_CODES = [
  'directory_unreachable',
  'download_truncated',
  'download_failed',
  'upload_incomplete',
  'delete_sync_failed',
  'part_settings_fallback',
  'part_settings_rejected',
  'unknown_settings',
  'symlink_skipped',
  'insecure_base_url',
  'auto_commit_failed',
  'rubric_read_failed',
  'rubric_write_forbidden',
  'rubric_write_skipped',
  'zip_not_used',
  'directory_blocked',
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

/**
 * A diagnostic attached to a plain-text warning callback. Code paths that report
 * through a `(msg) => void` callback pass this as an optional second argument,
 * and the callback's owner emits it with the registry's declared severity, so a
 * call site cannot disagree with the registry.
 */
export interface WarnDiagnostic {
  code: DiagnosticCode;
  data: Record<string, unknown>;
}

export type WarnFn = (message: string, diagnostic?: WarnDiagnostic) => void;

/** The event for a warning callback's message, coded when a diagnostic is given. */
export function warnEvent(message: string, diagnostic?: WarnDiagnostic): ServiceEvent {
  if (diagnostic === undefined) { return { level: 'warn', message }; }
  return { level: DIAGNOSTIC_SEVERITY[diagnostic.code], code: diagnostic.code, message, data: diagnostic.data };
}

/**
 * Why a directory was walked file by file although zip download was on. A closed
 * set: adding a value is a minor schema change. The `code:` guard regex does not
 * see `data.reason`, so the type is what keeps emit sites honest. No value may
 * equal a registered code (hence `object_download_failed`, not `download_failed`).
 */
export const ZIP_NOT_USED_REASONS = [
  'listing_failed', 'listing_over_budget', 'listed_size_over_limit',
  'start_failed', 'poll_failed', 'deadline', 'url_rejected',
  'clock_uncertain', 'object_stale', 'object_window', 'object_headers',
  'object_changed', 'object_download_failed', 'object_settle_changed',
  'zip_invalid', 'zip_over_budget', 'cycle_pattern', 'name_mismatch', 'budget',
  'quarantined',
] as const;

export type ZipNotUsedReason = typeof ZIP_NOT_USED_REASONS[number];

/** Why push refused a directory. */
export const DIRECTORY_BLOCKED_REASONS = ['incomplete-pull', 'container-asnlib'] as const;

export type DirectoryBlockedReason = typeof DIRECTORY_BLOCKED_REASONS[number];

/**
 * The `zip_not_used` diagnostic for a warning callback.
 *
 * @param quarantined - true when this rejection quarantined the part.
 */
export function zipNotUsedDiagnostic(
  partId: string,
  directory: string,
  reason: ZipNotUsedReason,
  quarantined: boolean,
): WarnDiagnostic {
  return { code: 'zip_not_used', data: { part_id: partId, directory, reason, quarantined } };
}

export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return (DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/**
 * Key-order-independent serialization, so two emit sites that build the same
 * data object in different orders collapse into one diagnostic.
 *
 * Three properties this has to get right, each learned from a real defect:
 *
 *  - **It must agree with `JSON.stringify`.** The key decides whether two
 *    diagnostics merge; `JSON.stringify` decides what the reader sees. When they
 *    disagreed, `{}` and `{ path: undefined }` produced two entries whose
 *    rendered payloads were both `{}` — a duplicate, not a dedupe. Keys with an
 *    `undefined` value are therefore dropped, exactly as `JSON.stringify` drops
 *    them. A present `null` is kept, because it survives serialization and is a
 *    real distinction.
 *  - **It must not recurse forever.** `data` is typed `unknown` and comes from
 *    any of the emit sites; an axios error or a parent-linked node is circular.
 *    `collectDiagnostics` runs inside `buildReport`, which is *outside*
 *    `writeReport`'s try/catch, so a `RangeError` here escapes the one place
 *    that guarantees a document is emitted at all.
 *  - **A repeated reference is not a cycle.** The same child object appearing
 *    under two keys is legitimate, so the guard tracks the current path rather
 *    than every object ever seen.
 */
function canonical(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value) ?? 'null'; }

  // `typeof value !== 'object'` above already narrowed this; no assertion needed.
  if (ancestors.has(value)) { return '"[circular]"'; }
  const path = new Set(ancestors);
  path.add(value);

  if (Array.isArray(value)) { return `[${value.map((v) => canonical(v, path)).join(',')}]`; }

  const entries = Object.entries(value as Record<string, unknown>)
    // Match JSON.stringify: a key whose value is undefined is not serialized,
    // so it must not affect the dedupe key either.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, path)}`).join(',')}}`;
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
      // No severity reconciliation needed any more: it comes from
      // DIAGNOSTIC_SEVERITY, so emission order cannot influence it. This
      // previously escalated warn->error, which solved the ordering problem but
      // still let a code's public severity vary run to run.
      continue;
    }
    byKey.set(key, {
      code,
      // The declared severity, so the public value cannot drift with an emit
      // site's level. moreSevere() below still escalates within a run when the
      // same code+data legitimately arrives at both levels.
      severity: DIAGNOSTIC_SEVERITY[code],
      message: event.message ?? '',
      count: 1,
      ...(data !== undefined ? { data } : {}),
    });
  }

  return [...byKey.values()];
}
