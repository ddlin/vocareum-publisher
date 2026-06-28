import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join } from 'path';

describe('action smoke (built CLI)', () => {
  it('runs `status` against the sample fixture and exits 0', () => {
    const dist = join(__dirname, '../../dist/index.js');
    const out = execFileSync('node', [dist, 'status',
      '--config', 'test/fixtures/sample-course/vocareum.yaml',
      '--root', 'test/fixtures/sample-course'], { stdio: 'pipe' });
    expect(String(out)).toMatch(/Assignments/);
  });
});
