/**
 * What this build can do, and where it came from.
 *
 * A version number is not enough. On 2026-09-04 `vocgit --version` reported
 * 1.3.7 from a global npm install while the Elite path fix under test lived in
 * an unpublished 1.3.8 in a local dist/; nothing in the CLI said which binary
 * was running. resolved_from settles that in one call.
 *
 * A stale capability list is worse than none, so the list stays small and two
 * guard tests hold it honest in both directions.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const CAPABILITIES = [
  'output.json',
  'exit-codes.v1',
  'diagnostics.v1',
  'pull.rubrics',
  'pull.elite-resource-paths',
  // Shipped in 1.4.0 and user-visible (both are documented in the README), but
  // absent from the first draft of this list -- which is the failure mode the
  // list is supposed to prevent. An agent asking "can this build push rubrics?"
  // got no answer.
  'push.rubrics',
  'upload.chunked',
] as const;

export type Capability = typeof CAPABILITIES[number];

export interface BuildInfo {
  git_sha: string | null;
  dirty: boolean | null;
  built_at: string | null;
  provenance: 'stamped' | 'unavailable';
}

const UNAVAILABLE: BuildInfo = { git_sha: null, dirty: null, built_at: null, provenance: 'unavailable' };

/**
 * Read dist/build-info.json defensively.
 *
 * Never throws: a `--version` query that errors is worse than one that admits
 * ignorance. A missing, truncated or hand-edited stamp degrades to
 * `unavailable` while version and resolved_from stay accurate.
 *
 * A stamp from a checkout with no git legitimately carries git_sha: null, and
 * that still counts as stamped -- built_at is known and discarding it would
 * throw away the one fact such a build does have.
 */
export function readBuildInfo(
  // This module compiles to dist/core/capabilities.js and the stamp is written
  // to dist/build-info.json, so the default has to climb one level. Getting it
  // wrong is silent -- it just reports provenance "unavailable" forever -- which
  // is why there is a test asserting a real build resolves it.
  stampPath = join(__dirname, '..', 'build-info.json'),
): BuildInfo {
  try {
    if (!existsSync(stampPath)) { return UNAVAILABLE; }
    const parsed = JSON.parse(readFileSync(stampPath, 'utf8')) as Partial<BuildInfo> | null;
    if (parsed === null || typeof parsed !== 'object') { return UNAVAILABLE; }
    // All three fields are checked, not just git_sha. A stamp with
    // dirty: "not-bool" and built_at: 42 previously came back as
    // provenance: "stamped" with those fields silently nulled -- claiming
    // verified provenance for a stamp we could not actually read.
    const sha = parsed.git_sha;
    const dirty = parsed.dirty;
    const builtAt = parsed.built_at;
    if (sha !== null && sha !== undefined && typeof sha !== 'string') { return UNAVAILABLE; }
    if (dirty !== null && dirty !== undefined && typeof dirty !== 'boolean') { return UNAVAILABLE; }
    if (builtAt !== null && builtAt !== undefined && typeof builtAt !== 'string') { return UNAVAILABLE; }
    return {
      git_sha: sha ?? null,
      dirty: dirty ?? null,
      built_at: builtAt ?? null,
      provenance: 'stamped',
    };
  } catch {
    return UNAVAILABLE;
  }
}
