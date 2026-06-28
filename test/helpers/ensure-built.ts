/**
 * Shared helper: ensures the TypeScript build is fresh before dist-based tests run.
 *
 * Exported as a `beforeAll`-ready function so each dist-dependent test file can
 * call it without coordinating with others.  A module-level flag prevents
 * redundant rebuilds when vitest runs multiple files in the same worker process.
 *
 * Usage (in a test file):
 *   import { ensureBuilt } from '../helpers/ensure-built';
 *   beforeAll(ensureBuilt, 120_000);
 */

import { execFileSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

let built = false;

export function ensureBuilt(): void {
  if (built) return;
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  built = true;
}
