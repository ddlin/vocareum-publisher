/**
 * Command-level tests: these EXECUTE validateCommand and fixCommand.
 *
 * An earlier draft of this file called buildReport directly, which passes
 * whether or not any wiring exists. Three such tests were found and removed
 * elsewhere in this branch; this is the shape that actually holds the wiring in
 * place.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateCommand } from '../../src/commands/validate';
import { fixCommand } from '../../src/commands/fix';
import { captureStdout, documents } from '../helpers/capture';
import { runCommandWithFailureClassification } from '../../src/utils/command-runner';

const CONFIG = (assignments: string) => [
  "version: '1.0'",
  'vocareum:',
  "  org_id: '265'",
  "  course_id: '99999'",
  '  templates: []',
  '  excluded_assignments: []',
  assignments,
].join('\n');

function workspace(assignments = 'assignments: []'): string {
  const dir = mkdtempSync(join(tmpdir(), 'vocgit-vf-'));
  writeFileSync(join(dir, 'vocareum.yaml'), CONFIG(assignments));
  return dir;
}

const run = async (fn: () => Promise<void>): Promise<{ docs: Array<Record<string, unknown>>; thrown: unknown }> => {
  let thrown: unknown;
  const raw = await captureStdout(async () => {
    try { await fn(); } catch (error) { thrown = error; }
  });
  return { docs: documents(raw), thrown };
};

describe('validate --json', () => {
  it('a clean config emits one no-op document and does not throw', async () => {
    const dir = workspace();
    const { docs, thrown } = await run(() =>
      validateCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    expect(docs).toHaveLength(1);
    expect(docs[0].command).toBe('validate');
    expect(docs[0].result).toBe('no-op');
    expect((docs[0].payload as { counts: { errors: number } }).counts.errors).toBe(0);
    expect(thrown).toBeUndefined();
  });

  it('an assignment pointing at a missing folder reports findings and exits 5', async () => {
    const dir = workspace(['assignments:', '  - path: does-not-exist', '    name: Ghost',
      "    assignment_id: '111'", '    parts: []'].join('\n'));
    const { docs, thrown } = await run(() =>
      validateCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    expect(docs).toHaveLength(1);
    expect(docs[0].result).toBe('reported');
    const payload = docs[0].payload as { errors: unknown[]; counts: { errors: number } };
    expect(payload.counts.errors).toBeGreaterThan(0);
    // The envelope is written BEFORE the throw, so a failing run still reports.
    expect((thrown as { exitCode: number }).exitCode).toBe(5);
  });

  it('puts no JSON document on stdout without --json', async () => {
    const dir = workspace();
    const raw = await captureStdout(() =>
      validateCommand({ config: join(dir, 'vocareum.yaml'), root: dir }));
    // Human output legitimately goes to stdout in this mode; the point is that
    // none of it parses as the envelope.
    expect(raw.length).toBeGreaterThan(0);
    expect(() => JSON.parse(raw.trim().split('\n')[0])).toThrow();
  });

  it('a config error emits a failure envelope through the CLI wrapper', async () => {
    // Called directly, the command throws before writing -- the wrapper is what
    // guarantees spec §6, so this tests the real composition rather than the
    // command in isolation. Duplicating the write inside the command is how
    // stdout came to carry two documents once already.
    const dir = mkdtempSync(join(tmpdir(), 'vocgit-vf-bad-'));
    writeFileSync(join(dir, 'vocareum.yaml'), 'version: "1.0"\nvocareum:\n  org_id: [broken\n');
    let thrown: unknown;
    const raw = await captureStdout(async () => {
      try {
        await runCommandWithFailureClassification(
          'validate', { json: true },
          (collector) => validateCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true, eventCollector: collector }),
          'Validation failed');
      } catch (error) { thrown = error; }
    });
    const docs = documents(raw);
    expect(docs).toHaveLength(1);
    expect(docs[0].result).toBe('failed');
    expect((docs[0].error as { code: string }).code).toBe('usage');
    expect((thrown as { exitCode: number }).exitCode).toBe(2);
  });
});

describe('fix --json', () => {
  it('creates the missing folder and reports it as fixed', async () => {
    const dir = workspace(['assignments:', '  - path: lab1', '    name: Lab 1',
      "    assignment_id: '111'", '    parts: []'].join('\n'));
    const { docs, thrown } = await run(() =>
      fixCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    expect(docs).toHaveLength(1);
    expect(docs[0].command).toBe('fix');
    const payload = docs[0].payload as { fixed: string[]; remaining: unknown[] };
    // Proves the wiring did the WORK, not merely that it reported.
    expect(existsSync(join(dir, 'lab1'))).toBe(true);
    expect(payload.fixed).toContain('lab1');
    expect(docs[0].result).toBe('applied');
    expect(thrown).toBeUndefined();
  });

  it('nothing to fix is a no-op', async () => {
    const dir = workspace(['assignments:', '  - path: lab1', '    name: Lab 1',
      "    assignment_id: '111'", '    parts: []'].join('\n'));
    mkdirSync(join(dir, 'lab1'), { recursive: true });
    const { docs, thrown } = await run(() =>
      fixCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    expect(docs).toHaveLength(1);
    expect(docs[0].result).toBe('no-op');
    expect((docs[0].payload as { fixed: string[] }).fixed).toEqual([]);
    expect(thrown).toBeUndefined();
  });

  it('--json implies non-interactive: it never prompts', async () => {
    // A prompt here would hang an automated caller, and prompt output on stdout
    // would corrupt the document. The test would time out rather than pass.
    const dir = workspace(['assignments:', '  - path: lab2', '    name: Lab 2',
      "    assignment_id: '222'", '    parts: []'].join('\n'));
    const { docs } = await run(() =>
      fixCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    expect(docs).toHaveLength(1);
    expect(existsSync(join(dir, 'lab2'))).toBe(true);
  });
});
