/**
 * Status Service — pure data computation, no human rendering.
 *
 * `inspectStatus` returns a `StatusReport` capturing all information needed to
 * render the status command in any format (human, JSON). It MUST NOT emit human
 * log lines; the JSON path depends on this invariant (P1 #7).
 *
 * IMPORTANT: This file MUST NOT import logger or LoggerEventSink.
 */

import { getCurrentBranch, getCommitSha, hasUncommittedChanges, isGitRepo } from '../../utils/git';
import { scanLocalContent, latestHistoryEntry } from '../local-scan';
import type { AssignmentScan, LocalScanResult } from '../local-scan';
import type { StatusContext } from './context';
import type { EventSink } from './event-sink';

export interface InspectStatusOptions {
  /**
   * When true, run `scanLocalContent` to populate `assignments` and `summary`
   * (used by `status --json`). When false or omitted, the scan is skipped and
   * `assignments` is an empty array — the human renderer derives counts from
   * config-supplied options instead. Skipping keeps human `status` fast and
   * avoids unnecessary filesystem traversal.
   */
  scanContent?: boolean;
}

/**
 * Version of the `status --json` schema. Bump when the shape changes so
 * consumers (VS Code extension) can detect incompatible CLIs.
 */
const STATUS_JSON_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// StatusReport — mirrors today's JSON document shape exactly
// ---------------------------------------------------------------------------

export interface StatusReport {
  schema_version: typeof STATUS_JSON_SCHEMA_VERSION;
  /** Statuses cover CONTENT change detection only (settings drift needs the API). */
  scope: 'content';
  generated_at: string;
  config_path: string;
  course: {
    org_id: string;
    course_id: string;
  };
  auth: {
    mode: 'token' | 'oauth';
    configured: boolean;
  };
  runtime: string;
  git: { repo: true; branch: string; commit: string; dirty: boolean } | { repo: false };
  last_push: {
    timestamp: string;
    status: string;
    published_by: string;
    commit_sha: string;
  } | null;
  assignments: AssignmentScan[];
  summary: LocalScanResult['summary'];
}

function hasNonEmptyId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Compute the full status report from the workspace described by `ctx`.
 * Returns pure data — no human rendering, no logger calls.
 *
 * Pass `{ scanContent: true }` (i.e. `--json`) to populate `assignments` and
 * `summary` via a local filesystem scan. Omitting it (the human path) skips
 * the scan for performance — `assignments` will be an empty array and
 * `summary` will be all-zeros; the human renderer reads counts from its own
 * config-derived options instead.
 */
export async function inspectStatus(ctx: StatusContext, opts: InspectStatusOptions = {}): Promise<StatusReport> {
  const { configPath, workspaceRoot, persistedConfig: config } = ctx;
  const { authMode, credentialsConfigured, ci, ciProvider } = ctx.runtime;

  const runtimeLabel = ci ? `CI (${ciProvider ?? 'unknown'})` : 'local';

  const lastPush = latestHistoryEntry(config);

  const insideRepo = await isGitRepo(workspaceRoot);
  let branch = 'n/a';
  let commit = 'n/a';
  let dirty = false;
  if (insideRepo) {
    try {
      branch = await getCurrentBranch(workspaceRoot);
    } catch {
      branch = 'unknown';
    }
    try {
      commit = await getCommitSha(workspaceRoot);
    } catch {
      commit = 'none';
    }
    dirty = await hasUncommittedChanges(workspaceRoot);
  }

  const emptySummary: LocalScanResult['summary'] = {
    synced: 0, needs_publish: 0, unknown: 0, pending_create: 0, unlinked: 0, error: 0,
  };

  let assignments: AssignmentScan[] = [];
  let summary: LocalScanResult['summary'] = emptySummary;

  if (opts.scanContent === true) {
    const scan = await scanLocalContent(config, workspaceRoot);
    assignments = scan.assignments;
    summary = scan.summary;
  }

  return {
    schema_version: STATUS_JSON_SCHEMA_VERSION,
    scope: 'content',
    generated_at: new Date().toISOString(),
    config_path: configPath,
    course: {
      org_id: config.vocareum.org_id,
      course_id: config.vocareum.course_id,
    },
    auth: { mode: authMode, configured: credentialsConfigured },
    runtime: runtimeLabel,
    git: insideRepo ? { repo: true, branch, commit, dirty } : { repo: false },
    last_push: lastPush === undefined ? null : {
      timestamp: lastPush.timestamp,
      status: lastPush.status ?? 'success',
      published_by: lastPush.published_by,
      commit_sha: lastPush.commit_sha,
    },
    assignments,
    summary,
  };
}

export interface RenderStatusHumanOptions {
  verbose?: boolean;
  /** Total configured templates (legacy + new). Required for human rendering. */
  templateCount: number;
  /** Number of excluded assignment IDs. Required for human rendering. */
  excludedCount: number;
  /**
   * Config-derived assignment/part counts. Callers MUST compute these from
   * the persisted config (not from `report.assignments`) so that human status
   * does not depend on a content scan.
   */
  assignmentCount: number;
  linkedAssignmentCount: number;
  totalPartCount: number;
  linkedPartCount: number;
}

/**
 * Render the status report as human-readable lines via `events`.
 * Assignment/part counts come from `options` (config-derived by the caller)
 * rather than from `report.assignments` — the human path skips the content
 * scan, so `report.assignments` may be empty.
 * `templateCount` and `excludedCount` must be supplied by the caller as they
 * are not included in the JSON document.
 */
export function renderStatusHuman(
  report: StatusReport,
  events: EventSink,
  options: RenderStatusHumanOptions
): void {
  // Counts come from config-derived options, not the (potentially empty) scan.
  const assignmentCount = options.assignmentCount;
  const linkedAssignmentCount = options.linkedAssignmentCount;
  const totalPartCount = options.totalPartCount;
  const linkedPartCount = options.linkedPartCount;

  const authMode = report.auth.mode;
  const credentialLabel = authMode === 'oauth' ? 'OAuth client credentials' : 'API key';

  const gitStatus = report.git.repo
    ? `repo on ${report.git.branch} @ ${report.git.commit}${report.git.dirty ? ' (dirty)' : ''}`
    : 'not a git repository';

  events.emit({ level: 'plain', message: 'Current Vocareum Publisher status' });
  events.emit({ level: 'newline' });
  events.emit({ level: 'plain', message: 'Readiness' });
  events.emit({ level: 'plain', message: `- Auth (${authMode}): ${credentialLabel} ${report.auth.configured ? 'configured' : 'missing'}` });
  events.emit({ level: 'plain', message: `- Runtime: ${report.runtime}` });

  events.emit({ level: 'newline' });
  events.emit({ level: 'plain', message: 'Workspace' });
  events.emit({ level: 'plain', message: `- Config: ${report.config_path}` });
  events.emit({ level: 'plain', message: `- Org/Course: ${report.course.org_id}/${report.course.course_id}` });
  events.emit({ level: 'plain', message: `- Git: ${gitStatus}` });

  events.emit({ level: 'newline' });
  events.emit({ level: 'plain', message: 'Sync Summary' });
  if (report.last_push === null) {
    events.emit({ level: 'plain', message: '- Last push: never' });
  } else {
    events.emit({ level: 'plain', message: `- Last push: ${report.last_push.timestamp} (${report.last_push.status}) by ${report.last_push.published_by} @ ${report.last_push.commit_sha}` });
  }
  events.emit({ level: 'plain', message: `- Assignments: ${assignmentCount} total (${linkedAssignmentCount} linked, ${assignmentCount - linkedAssignmentCount} pending create)` });
  events.emit({ level: 'plain', message: `- Parts: ${totalPartCount} total (${linkedPartCount} linked, ${totalPartCount - linkedPartCount} pending map)` });

  events.emit({ level: 'plain', message: `- Templates configured: ${options.templateCount}` });
  events.emit({ level: 'plain', message: `- Excluded assignment IDs: ${options.excludedCount}` });

  if (options.verbose === true && report.assignments.length > 0) {
    events.emit({ level: 'newline' });
    events.emit({ level: 'plain', message: 'Assignment Details' });
    for (const a of report.assignments) {
      const linkedParts = a.parts.filter(p => hasNonEmptyId(p.part_id)).length;
      const assignmentId = hasNonEmptyId(a.assignment_id) ? a.assignment_id : 'pending';
      events.emit({ level: 'plain', message: `- ${a.path} (id=${assignmentId}, parts=${linkedParts}/${a.parts.length})` });
    }
  }
}
