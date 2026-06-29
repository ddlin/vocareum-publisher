import { existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const repoRoot = join(__dirname, '..', '..');
const distEntry = join(repoRoot, 'dist', 'index.js');
let attempted = false;

/**
 * Ensure `dist/` is built before tests that execute the compiled CLI as a
 * subprocess (`node dist/index.js`).
 *
 * No-op when `dist/index.js` already exists — so in CI (which builds before the
 * test run) and after any local `npm run build`, this costs nothing. It only
 * triggers a build on a standalone `vitest run` with no prior build, so those
 * tests are self-contained and can't fail with MODULE_NOT_FOUND.
 */
export function ensureBuilt(): void {
  if (existsSync(distEntry)) { return; }
  if (attempted) { return; } // don't loop if a build failed
  attempted = true;
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}
