import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { ensureBuilt } from '../helpers/ensure-built';

beforeAll(ensureBuilt, 120_000);

describe('action smoke (built CLI)', () => {
  it('runs `status` against the sample fixture and exits 0', () => {
    const dist = join(__dirname, '../../dist/index.js');
    const out = execFileSync('node', [dist, 'status',
      '--config', 'test/fixtures/sample-course/vocareum.yaml',
      '--root', 'test/fixtures/sample-course'], { stdio: 'pipe' });
    expect(String(out)).toMatch(/Assignments/);
  });
});
