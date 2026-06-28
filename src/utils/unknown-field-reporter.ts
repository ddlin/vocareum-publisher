/**
 * Run-level collector for unknown Vocareum API fields encountered during
 * a single CLI command invocation. Ownership: command entrypoints
 * construct one instance, pass it down, and call printSummary() in
 * a try/finally at the command boundary. Lower layers only call record().
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import type { EventSink } from '../core/services/event-sink';

export type UnknownFieldScope = 'assignment' | 'part'; // 'course' added in deferred phase

export interface UnknownFieldRecord {
  scope: UnknownFieldScope;
  field: string;
  exampleValue: unknown;
  count: number;
  firstResourceId: string;
}

export interface MinimalLogger {
  warn: (msg: string) => void;
  plain: (msg: string) => void;
}

/**
 * Adapter that bridges an EventSink to the MinimalLogger interface used
 * internally by UnknownFieldReporter. Allows callers to pass either a
 * MinimalLogger (legacy/test path) or an EventSink (service-layer path),
 * so that reporter output participates in the per-command collecting sink
 * and cannot interleave with concurrent-course output in Stage 1b.
 */
function makeMinimalLoggerFromSink(sink: EventSink): MinimalLogger {
  return {
    warn: (msg: string): void => { sink.emit({ level: 'warn', message: msg }); },
    plain: (msg: string): void => { sink.emit({ level: 'plain', message: msg }); },
  };
}

/** Type guard: distinguishes EventSink (has `emit`) from MinimalLogger. */
function isEventSink(v: MinimalLogger | EventSink): v is EventSink {
  return typeof (v as EventSink).emit === 'function';
}

const ISSUE_URL = 'https://github.com/ddlin/vocareum-publisher/issues/new';

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// JSON.stringify silently produces undefined for functions/symbols and drops
// undefined object values. Wrap so the summary never prints "field=" with
// nothing after the equals sign.
function safeStringify(v: unknown): string {
  if (v === undefined) { return 'undefined'; }
  if (typeof v === 'function') { return '<function>'; }
  if (typeof v === 'symbol') { return v.toString(); }
  try {
    return JSON.stringify(v) ?? 'undefined';
  } catch {
    return '<unserializable>';
  }
}

export class UnknownFieldReporter {
  private records = new Map<string, UnknownFieldRecord>();
  private logger: MinimalLogger;

  /**
   * @param output - Either a MinimalLogger (backward-compatible) or an EventSink.
   *   Pass an EventSink (e.g. ctx.events from a command context) so that reporter
   *   output joins the same event stream as the rest of the service layer; this
   *   prevents output interleaving when Stage 1b runs courses concurrently.
   */
  constructor(output: MinimalLogger | EventSink) {
    this.logger = isEventSink(output) ? makeMinimalLoggerFromSink(output) : output;
  }

  record(
    scope: UnknownFieldScope,
    field: string,
    exampleValue: unknown,
    resourceId: string
  ): void {
    const key = `${scope}.${field}`;
    const existing = this.records.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.records.set(key, {
      scope,
      field,
      exampleValue,
      count: 1,
      firstResourceId: resourceId,
    });
    this.logger.warn(
      `Vocareum returned unknown ${scope} setting "${field}" (preserved under _unknown_settings)`
    );
  }

  hasAny(): boolean {
    return this.records.size > 0;
  }

  summary(): UnknownFieldRecord[] {
    return [...this.records.values()].sort((a, b) => {
      if (a.scope !== b.scope) { return a.scope < b.scope ? -1 : 1; }
      return a.field < b.field ? -1 : 1;
    });
  }

  printSummary(): void {
    if (!this.hasAny()) { return; }
    const lines: string[] = [];
    const divider = '─'.repeat(65);
    lines.push(divider);
    lines.push('Vocareum returned unsupported settings fields.');
    lines.push('');
    lines.push('These fields were preserved under _unknown_settings in vocareum.yaml');
    lines.push('and will be passed through on future updates, but vocgit does not');
    lines.push('understand them yet.');
    lines.push('');
    lines.push('Please file a bug or enhancement request so vocgit can promote these');
    lines.push('fields to formally supported settings.');
    lines.push('');
    lines.push(`  ${ISSUE_URL}`);
    lines.push('');
    lines.push('Include in the report:');
    lines.push(`  - vocgit version:    ${readPackageVersion()}`);
    const summary = this.summary();
    const byScope = new Map<string, UnknownFieldRecord[]>();
    for (const r of summary) {
      const arr = byScope.get(r.scope) ?? [];
      arr.push(r);
      byScope.set(r.scope, arr);
    }
    let scopeIdx = 0;
    for (const [scope, recs] of byScope) {
      if (scopeIdx > 0) { lines.push(''); }
      lines.push(`  - resource scope:    ${scope}`);
      lines.push(`  - field names:       ${recs.map((r) => r.field).join(', ')}`);
      lines.push(
        `  - example values:    ${recs
          .map((r) => `${r.field}=${safeStringify(r.exampleValue)}`)
          .join(', ')}`
      );
      scopeIdx += 1;
    }
    lines.push('  - redacted vocareum.yaml snippet showing _unknown_settings');
    lines.push(divider);
    for (const line of lines) {
      this.logger.plain(line);
    }
  }
}
