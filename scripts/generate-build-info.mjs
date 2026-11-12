#!/usr/bin/env node
/**
 * Stamp dist/build-info.json at build time.
 *
 * Written inside dist/ deliberately: package.json `files` already publishes
 * dist, so no allowlist change is needed and the stamp travels with the package.
 * Tolerates a source checkout with no git.
 */
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const git = (cmd) => {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
};

const sha = git('git rev-parse --short HEAD');
const status = git('git status --porcelain');

mkdirSync('dist', { recursive: true });
writeFileSync(join('dist', 'build-info.json'), JSON.stringify({
  git_sha: sha,
  dirty: status === null ? null : status.length > 0,
  built_at: new Date().toISOString(),
}, null, 2) + '\n');
