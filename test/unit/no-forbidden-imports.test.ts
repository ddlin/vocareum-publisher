import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DIAGNOSTIC_CODES, DIAGNOSTIC_SEVERITY } from '../../src/core/diagnostics';
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
  const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
describe('architecture guards', () => {
  it('no process.exit outside src/index.ts', () => {
    expect(walk('src').filter((f) => f !== 'src/index.ts' && /process\.exit\s*\(/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
  it('src/core/services/ imports no logger/loadConfig/withConfigLock and constructs no client', () => {
    expect(walk('src/core/services').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /utils\/logger/.test(s) || /\bloadConfig\b/.test(s) || /\bwithConfigLock\b/.test(s) || /new VocareumClient\(/.test(s);
    })).toEqual([]);
  });
  it('src/api/client.ts and src/api/content.ts have no direct global-logger imports (EventSink-only output)', () => {
    // These files must route all output through EventSink so per-course output
    // cannot interleave during concurrent execution (Stage 1b isolation).
    const transitiveSources = ['src/api/client.ts', 'src/api/content.ts'];
    const violations = transitiveSources.filter((f) => {
      const s = readFileSync(f, 'utf8');
      // Importing from the global logger module is forbidden; LoggerEventSink is the allowed bridge.
      return /from ['"][^'"]*utils\/logger['"]/.test(s);
    });
    expect(violations).toEqual([]);
  });
  it('logger writes stdout only through this.out() so --json can redirect it', () => {
    const source = readFileSync('src/utils/logger.ts', 'utf8');
    // Any direct stdout write inside the Logger class would bypass json mode
    // and corrupt the report document.
    expect(source.includes('process.stdout.write')).toBe(false);
  });
  it('only src/core/report.ts writes to stdout — one document per --json run', () => {
    // Specified in the plan but never implemented, and its absence is exactly
    // how stdout came to carry TWO documents: pull wrote its report and the
    // entrypoint wrote a second. stdout is the machine-readable channel; any
    // other writer corrupts it. Human output goes through logger, which routes
    // to stderr under --json.
    const allowed = new Set(['src/core/report.ts']);
    const offenders = walk('src').filter(
      (f) => !allowed.has(f) && /process\.stdout\.write/.test(readFileSync(f, 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('every emit site uses the severity its code declares', () => {
    // The declared value is what consumers see, so an emit site disagreeing
    // with it silently changes the public severity. Two codes shipped declared
    // 'warn' while their emit sites used 'error' -- caught by reading the sites
    // by hand, which is not a method that scales.
    const mismatches: string[] = [];
    for (const file of walk('src')) {
      if (file === 'src/core/diagnostics.ts') { continue; }
      const source = readFileSync(file, 'utf8');
      const patterns = [
        /level:\s*'(warn|error)'[\s\S]{0,400}?code:\s*'([a-z_]+)'/g,
        /code:\s*'([a-z_]+)'[\s\S]{0,300}?level:\s*'(warn|error)'/g,
      ];
      patterns.forEach((re, idx) => {
        for (const m of source.matchAll(re)) {
          const level = idx === 0 ? m[1] : m[2];
          const code = idx === 0 ? m[2] : m[1];
          const declared = (DIAGNOSTIC_SEVERITY as Record<string, string>)[code];
          if (declared !== undefined && declared !== level) {
            mismatches.push(`${file}: ${code} declared=${declared} emitted=${level}`);
          }
        }
      });
    }
    expect([...new Set(mismatches)]).toEqual([]);
  });

  it('every registered code declares a severity', () => {
    // The promise is that changing a severity is a major bump; that is only
    // meaningful if the severity lives in the registry rather than in whichever
    // level an emit site chose.
    // Static import at the top of this file; require() does not work here.
    expect(Object.keys(DIAGNOSTIC_SEVERITY).sort()).toEqual([...DIAGNOSTIC_CODES].sort());
  });

  it('report.ts writes stdout in exactly ONE place', () => {
    // The file-level guard above allows report.ts to write stdout, but says
    // nothing about how many times. writeReport shipped with its own write for
    // a full commit while the commit message claimed it shared
    // writeJsonDocument -- true at file granularity, false at the level the
    // message asserted.
    const source = readFileSync('src/core/report.ts', 'utf8');
    const writes = source
      .split('\n')
      .filter((line) => line.includes('process.stdout.write'))
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'));
    expect(writes).toHaveLength(1);
  });

  it('every code: literal at an emit site is a registered diagnostic code', () => {
    // Static import at the top of this file:
    //   import { DIAGNOSTIC_CODES } from '../../src/core/diagnostics';
    // (require() does not work here - Vitest runs these as ESM.)
    //
    // `code:` names TWO different vocabularies in this codebase: diagnostic
    // codes on a ServiceEvent, and error codes on a ReportError. Only the first
    // is the registry's business, so the second is listed here explicitly
    // rather than silently skipped -- an unlisted code is still a build failure.
    // `code:` names two vocabularies: diagnostic codes on a ServiceEvent, and
    // error codes on a ReportError. The latter are the FailureCategory values
    // plus the report's own internal codes. Listing them explicitly keeps an
    // unlisted diagnostic code a build failure.
    const NON_DIAGNOSTIC_CODES = new Set([
      'report_serialization_failed', 'partial_failure', 'command_failed',
      'internal', 'usage', 'auth', 'transient', 'findings', 'partial',
      // zod's issue code for a refinement (`ctx.addIssue({ code: 'custom' })`)
      // in config validation: a third vocabulary, never emitted as an event.
      'custom',
    ]);
    const offenders: string[] = [];
    for (const file of walk('src')) {
      if (file === 'src/core/diagnostics.ts') { continue; }
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/code:\s*'([a-z_]+)'/g)) {
        const code = match[1];
        if (NON_DIAGNOSTIC_CODES.has(code)) { continue; }
        if (!(DIAGNOSTIC_CODES as readonly string[]).includes(code)) { offenders.push(`${file}: ${code}`); }
      }
    }
    expect(offenders).toEqual([]);
  });
});
