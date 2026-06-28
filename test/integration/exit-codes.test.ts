import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

const distIndex = join(__dirname, '../../dist/index.js');

const run = (args: string[]) => {
  try {
    execFileSync('node', [distIndex, ...args], { stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e: any) {
    return { code: e.status as number, stderr: String(e.stderr) };
  }
};

describe('exit codes (subprocess)', () => {
  it('exits non-zero with a single error line on a missing config', () => {
    const r = run(['status', '--config', 'definitely-missing.yaml']);
    expect(r.code).not.toBe(0);
    // Count occurrences of "Status failed:" — should appear exactly once, not double-logged
    const matches = (r.stderr.match(/Status failed:/gi) || []);
    expect(matches.length).toBe(1);
  });
});
