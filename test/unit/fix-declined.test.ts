/**
 * A "no" to creating a folder is respected even when another repair is inside
 * it. Before, declining `lab` and accepting `lab/sub` created `lab` anyway
 * (mkdir -p) and still reported `lab` as declined.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../src/utils/prompts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Decline the parent; accept everything else.
  promptConfirm: vi.fn(async (message: string) => !message.includes('"lab"')),
}));

import { fixCommand } from '../../src/commands/fix';
import { captureStdout } from '../helpers/capture';

describe('fix respects a declined folder', () => {
  it('does not create a declined folder through a repair inside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vocgit-fix-declined-'));
    writeFileSync(join(dir, 'vocareum.yaml'), [
      "version: '1.0'", 'vocareum:', "  org_id: '265'", "  course_id: '99999'",
      '  templates: []', '  excluded_assignments: []',
      'assignments:',
      '  - path: lab', '    name: Lab', "    assignment_id: '111'", '    parts: []',
      '  - path: lab/sub', '    name: Lab Sub', "    assignment_id: '112'", '    parts: []',
    ].join('\n'));

    await captureStdout(async () => {
      await fixCommand({ config: join(dir, 'vocareum.yaml'), root: dir }).catch(() => undefined);
    });

    expect(existsSync(join(dir, 'lab'))).toBe(false);
    expect(existsSync(join(dir, 'lab', 'sub'))).toBe(false);
  });
});
