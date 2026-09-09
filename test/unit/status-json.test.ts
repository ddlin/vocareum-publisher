import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { statusCommand } from '../../src/commands/status';

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    chunks.push(String(s));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

function workspaceWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vocgit-status-'));
  writeFileSync(join(dir, 'vocareum.yaml'), [
    'version: "1.0"',
    'vocareum:',
    "  org_id: '265'",
    "  course_id: '99999'",
    '  templates: []',
    '  excluded_assignments: []',
    'assignments: []',
  ].join('\n'));
  return dir;
}

describe('status --json (command level)', () => {
  it('writes exactly one JSON envelope to stdout', async () => {
    const dir = workspaceWithConfig();
    const out = await captureStdout(() =>
      statusCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    const lines = out.trim().split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const doc = JSON.parse(lines[0]) as {
      schema_version: unknown;
      command: string;
      payload: { payload_schema_version: unknown };
    };
    expect(doc.schema_version).toBe('1.0');
    expect(doc.command).toBe('status');
    expect(doc.payload.payload_schema_version).toBe(2);
    expect(typeof doc.schema_version).toBe('string');
    expect(typeof doc.payload.payload_schema_version).toBe('number');
  });

  it('emits empty collections rather than omitting them', async () => {
    const dir = workspaceWithConfig();
    const out = await captureStdout(() =>
      statusCommand({ config: join(dir, 'vocareum.yaml'), root: dir, json: true }));
    const doc = JSON.parse(out.trim()) as { diagnostics: unknown[]; error: unknown };
    expect(doc.diagnostics).toEqual([]);
    expect(doc.error).toBeNull();
  });

  it('writes nothing to stdout without --json', async () => {
    const dir = workspaceWithConfig();
    const out = await captureStdout(() =>
      statusCommand({ config: join(dir, 'vocareum.yaml'), root: dir }));
    expect(() => JSON.parse(out.trim())).toThrow();
  });
});
