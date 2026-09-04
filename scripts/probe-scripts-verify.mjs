#!/usr/bin/env node
/**
 * Round-trip audit: does a pulled workspace directory match what Vocareum holds?
 *
 * For every part in each course's vocareum.yaml, this lists the remote directory,
 * re-fetches each file, and compares its byte count against the local file the
 * pull wrote. It answers questions a pull cannot answer about itself:
 *
 *   - Is a zero-byte local file genuinely empty upstream, or did the download
 *     silently return nothing?
 *   - Is anything present remotely but absent locally? (The failure mode of
 *     the Elite /resource path bug: a pull reporting success while leaving
 *     every grade.sh on the server.)
 *
 * Written after that bug to confirm the fix on 12 Elite courses: 115 parts,
 * 460/460 files matching, 365 of them legitimately zero bytes upstream.
 *
 * Usage:
 *   node scripts/probe-scripts-verify.mjs --workspace <dir> <course-id>...
 *   PROBE_DIR=startercode node scripts/probe-scripts-verify.mjs -w . 12345
 *
 * <course-id> names a subdirectory of --workspace holding a vocareum.yaml.
 * PROBE_DIR selects the directory to audit (default: scripts).
 *
 * Auth: VOCAREUM_API_TOKEN (or VOCAREUM_API_KEY), else .env in the working
 * directory. When courses span organizations, set VOCAREUM_API_TOKEN_ORG<id>
 * per org and each course uses the one matching its org_id.
 *
 * Read-only: issues GETs only, and never writes to Vocareum or to the workspace.
 */
import axios from 'axios';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

function loadDotEnvIfNeeded() {
  if (!existsSync('.env')) { return; }
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { continue; }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) { continue; }
    const key = trimmed.slice(0, idx).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) { process.env[key] = value; }
  }
}

function argValue(...flags) {
  for (const flag of flags) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) { return process.argv[idx + 1]; }
  }
  return undefined;
}

/** Per-org token when the run spans organizations, else the standard token. */
function tokenForOrg(orgId) {
  return process.env[`VOCAREUM_API_TOKEN_ORG${orgId}`]
    ?? process.env.VOCAREUM_API_TOKEN
    ?? process.env.VOCAREUM_API_KEY;
}

loadDotEnvIfNeeded();

const DIR = process.env.PROBE_DIR ?? 'scripts';
const workspace = argValue('--workspace', '-w') ?? process.cwd();
const courses = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('-') && all[i - 1] !== '--workspace' && all[i - 1] !== '-w');

if (courses.length === 0) {
  console.error('usage: node scripts/probe-scripts-verify.mjs --workspace <dir> <course-id>...');
  process.exit(2);
}

let exitCode = 0;

for (const course of courses) {
  const configPath = path.join(workspace, course, 'vocareum.yaml');
  if (!existsSync(configPath)) {
    console.error(`${course}: no vocareum.yaml at ${configPath}`);
    exitCode = 1;
    continue;
  }
  const config = yaml.load(readFileSync(configPath, 'utf8'));
  const courseId = config.vocareum.course_id;
  const token = tokenForOrg(String(config.vocareum.org_id));
  if (!token) {
    console.error(`${course}: no token (set VOCAREUM_API_TOKEN or VOCAREUM_API_TOKEN_ORG${config.vocareum.org_id})`);
    exitCode = 1;
    continue;
  }

  const api = axios.create({
    baseURL: config.vocareum.api_base_url
      ? `${config.vocareum.api_base_url.replace(/\/$/, '')}/api/v2`
      : 'https://api.vocareum.com/api/v2',
    timeout: 30000,
    headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
  });

  let parts = 0, files = 0, remoteEmpty = 0, match = 0, mismatch = 0, missingLocal = 0, dirs = 0;
  const problems = [];

  for (const assignment of config.assignments ?? []) {
    for (const part of assignment.parts ?? []) {
      if (!part.part_id) { continue; }
      const endpoint =
        `/courses/${courseId}/assignments/${assignment.assignment_id}/parts/${part.part_id}/files`;

      let listed;
      try {
        const res = await api.get(endpoint, { params: { dir: `/resource/${DIR}`, list: 'true' } });
        listed = res.data?.files ?? [];
      } catch {
        continue; // directory absent for this part
      }
      if (listed.length === 0) { continue; }
      parts++;

      const localDir = path.join(
        workspace, course, assignment.path, part.path === '.' ? '' : part.path, DIR
      );

      for (const name of listed) {
        const localPath = path.join(localDir, name);

        // The listing gives names with no type information. An entry that is
        // really a subdirectory fails to download; the pull recurses into it,
        // so treat a local directory of that name as correct rather than a miss.
        let remoteBytes;
        try {
          const res = await api.get(endpoint, { params: { filename: `${DIR}/${name}` } });
          if (res.data?.status === 'error') { throw new Error('not a file'); }
          const url = res.data?.files?.[0]?.download_url;
          if (!/^https?:\/\//i.test(url ?? '')) { throw new Error('no download url'); }
          const body = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
          remoteBytes = body.data.byteLength;
        } catch (error) {
          if (existsSync(localPath) && statSync(localPath).isDirectory()) { dirs++; continue; }
          problems.push(`${assignment.path}/${name}: ${String(error.message).slice(0, 60)}`);
          exitCode = 1;
          continue;
        }

        files++;
        if (remoteBytes === 0) { remoteEmpty++; }

        if (!existsSync(localPath)) {
          missingLocal++;
          problems.push(`${assignment.path}/${name}: remote ${remoteBytes}B, MISSING LOCALLY`);
          exitCode = 1;
          continue;
        }
        const localBytes = statSync(localPath).size;
        if (localBytes === remoteBytes) { match++; }
        else {
          mismatch++;
          problems.push(`${assignment.path}/${name}: local ${localBytes}B vs remote ${remoteBytes}B`);
          exitCode = 1;
        }
      }
    }
  }

  console.log(
    `${course} (${DIR}/): parts=${parts} files=${files} remote_empty=${remoteEmpty} ` +
    `match=${match} mismatch=${mismatch} missing_local=${missingLocal} subdirs=${dirs}`
  );
  for (const problem of problems.slice(0, 20)) { console.log(`    ! ${problem}`); }
}

process.exit(exitCode);
