/**
 * stdout carries exactly ONE JSON document per --json invocation.
 *
 * This broke undetected: pull wrote `result: "reported"` and threw
 * CommandFailureError('findings') to reach exit 5, and the entrypoint's catch
 * wrote a SECOND envelope saying `result: "failed"`. Two documents, and a
 * consumer reading the last line was told the run failed when it had succeeded
 * at reporting findings. Every unit test passed throughout; only invoking the
 * binary revealed it.
 *
 * These tests drive the real wrapper and count what lands on stdout. An earlier
 * version of this file grepped src/index.ts for the guard's source text, which
 * proves nothing about behavior and is the exact test smell this project has
 * been correcting elsewhere.
 */
import { describe, it, expect, vi } from 'vitest';
import { runCommandWithFailureClassification } from '../../src/utils/command-runner';
import { CommandFailureError } from '../../src/utils/command-failure';
import { buildReport, writeReport } from '../../src/core/report';
import { ConfigError } from '../../src/core/config';

/** Run something with stdout captured; returns the parsed documents. */
async function documentsFrom(body: () => Promise<void>): Promise<{ docs: unknown[]; thrown: unknown }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { chunks.push(String(s)); return true; });
  let thrown: unknown;
  try {
    await body();
  } catch (error) {
    thrown = error;
  } finally {
    spy.mockRestore();
  }
  const docs = chunks.join('').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  return { docs, thrown };
}

describe('exactly one document reaches stdout', () => {
  it('a command that reported findings and then threw emits ONE document, not two', async () => {
    // The exact shape of the bug: the command writes its own report, then
    // throws to set the exit code.
    const { docs, thrown } = await documentsFrom(() =>
      runCommandWithFailureClassification('pull', { json: true }, async (collector) => {
        writeReport(buildReport({
          command: 'pull', result: 'reported',
          payload: { payload_schema_version: 1 }, events: collector.drain(),
        }));
        throw new CommandFailureError('Pull finished with reported', 'findings', true);
      }, 'Pull failed'));

    expect(docs).toHaveLength(1);
    expect((docs[0] as { result: string }).result).toBe('reported');
    expect((thrown as CommandFailureError).exitCode).toBe(5);
  });

  it('a raw failure with no prior document still emits one', async () => {
    // The other direction: without the wrapper writing, a failing --json run
    // would exit non-zero with empty stdout and tell the caller nothing.
    const { docs, thrown } = await documentsFrom(() =>
      runCommandWithFailureClassification('status', { json: true }, async () => {
        throw new ConfigError('bad yaml', 'PARSE');
      }, 'Status failed'));

    expect(docs).toHaveLength(1);
    const doc = docs[0] as { result: string; error: { code: string } };
    expect(doc.result).toBe('failed');
    expect(doc.error.code).toBe('usage');
    expect((thrown as CommandFailureError).exitCode).toBe(2);
  });

  it('writes nothing to stdout when --json was not requested', async () => {
    const { docs, thrown } = await documentsFrom(() =>
      runCommandWithFailureClassification('status', {}, async () => {
        throw new ConfigError('bad yaml', 'PARSE');
      }, 'Status failed'));

    expect(docs).toEqual([]);
    expect((thrown as CommandFailureError).exitCode).toBe(2);
  });

  it('carries diagnostics collected before the failure', async () => {
    // events: [] here would discard the very information explaining the failure.
    const { docs } = await documentsFrom(() =>
      runCommandWithFailureClassification('pull', { json: true }, async (collector) => {
        collector.emit({ level: 'warn', code: 'directory_unreachable', message: 'absent', data: { directory: 'docs' } });
        throw new Error('exploded after warning');
      }, 'Pull failed'));

    const doc = docs[0] as { diagnostics: Array<{ code: string }> };
    expect(doc.diagnostics.map((d) => d.code)).toContain('directory_unreachable');
  });

  it('a successful run emits nothing from the wrapper itself', async () => {
    const { docs, thrown } = await documentsFrom(() =>
      runCommandWithFailureClassification('pull', { json: true }, async () => { /* success */ }, 'Pull failed'));
    expect(docs).toEqual([]);
    expect(thrown).toBeUndefined();
  });
});

describe('CommandFailureError.reportWritten', () => {
  it('defaults to false so an ordinary failure still gets an envelope', () => {
    expect(new CommandFailureError('boom', 'internal').reportWritten).toBe(false);
  });

  it('does not disturb the category or exit code', () => {
    for (const [category, code] of [['usage', 2], ['auth', 3], ['transient', 4], ['findings', 5], ['partial', 6]] as const) {
      const error = new CommandFailureError('x', category, true);
      expect(error.exitCode).toBe(code);
      expect(error.reportWritten).toBe(true);
    }
  });
});
