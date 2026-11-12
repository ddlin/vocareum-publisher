import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules/.bin/tsx');
const CLI = join(process.cwd(), 'src/index.ts');

describe('status --json failure envelope through the real CLI', () => {
  it('prints one failed envelope for malformed config instead of empty stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocgit-status-bad-config-'));
    const configPath = join(dir, 'vocareum.yaml');
    writeFileSync(configPath, 'version: "1.0"\nvocareum: [\n');

    let stdout = '';
    let status: number | undefined;
    try {
      execFileSync(TSX, [CLI, 'status', '--json', '--config', configPath, '--root', dir], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status;
      stdout = failure.stdout ?? '';
    }

    expect(status).toBe(2);
    const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]) as {
      command: string;
      result: string;
      error: { code: string; retryable: boolean };
    };
    expect(doc.command).toBe('status');
    expect(doc.result).toBe('failed');
    expect(doc.error).toMatchObject({ code: 'usage', retryable: false });
  });
});

describe('a malformed --json invocation still gets exactly one document', () => {
  function run(args: string[]): { status: number | undefined; docs: Array<{ command: string | null; result: string; error: { code: string } }> } {
    let stdout = '';
    let status: number | undefined = 0;
    try {
      stdout = execFileSync(TSX, [CLI, ...args], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status;
      stdout = failure.stdout ?? '';
    }
    const docs = stdout.trim().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as never);
    return { status, docs };
  }

  it.each([
    [['--bogus', '--json'], null],
    [['status', '--config', '--json'], 'status'],
    [['push', '--assignment', '--json'], 'push'],
    [['pus', '--json'], null],
  ] as const)('%j → exit 2, one usage document, command %s', (args, command) => {
    const { status, docs } = run([...args]);
    expect(status).toBe(2);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ command, result: 'failed', error: { code: 'usage' } });
  });

  it('`help push` is a known command (exit 0)', () => {
    const out = execFileSync(TSX, [CLI, 'help', 'push'], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/Usage: vocgit push/);
  });
});
