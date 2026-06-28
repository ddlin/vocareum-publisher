/**
 * Status Command
 *
 * Shows current local repository status for Vocareum sync.
 */

import * as path from 'path';
import { loadConfig } from '../core/config';
import { scanLocalContent, latestHistoryEntry } from '../core/local-scan';
import { resolveWorkspaceContext } from '../core/workspace';
import { loadDotEnvIfPresent, isCI, getCIProvider, getAuthModeEnv, getOAuthClientId, getOAuthClientSecret } from '../utils/env';
import { getCurrentBranch, getCommitSha, hasUncommittedChanges, isGitRepo } from '../utils/git';
import { logger } from '../utils/logger';
import { CommandFailureError } from '../utils/command-failure';

export interface StatusCommandOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  verbose?: boolean;
  /** Emit a machine-readable JSON report on stdout (consumed by the VS Code extension). */
  json?: boolean;
}

/**
 * Version of the `status --json` schema. Bump when the shape changes so
 * consumers (VS Code extension) can detect incompatible CLIs.
 */
const STATUS_JSON_SCHEMA_VERSION = 1;

function hasNonEmptyId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Execute the status command
 */
export async function statusCommand(options: StatusCommandOptions): Promise<void> {
  const { configPath, workspaceRoot } = resolveWorkspaceContext({
    config: options.config,
    root: options.root,
  });

  try {
    loadDotEnvIfPresent(path.join(workspaceRoot, '.env'));
    const config = await loadConfig(configPath);

    const assignmentCount = config.assignments.length;
    const linkedAssignmentCount = config.assignments.filter(a => hasNonEmptyId(a.assignment_id)).length;
    const totalPartCount = config.assignments.reduce((sum, a) => sum + a.parts.length, 0);
    const linkedPartCount = config.assignments.reduce(
      (sum, a) => sum + a.parts.filter(p => hasNonEmptyId(p.part_id)).length,
      0
    );
    const excludedCount = config.vocareum.excluded_assignments?.length ?? 0;

    const templates = config.vocareum.templates ?? [];
    const legacyTemplateIds = [
      ...(config.vocareum.template_assignment_id !== undefined ? [config.vocareum.template_assignment_id] : []),
      ...(config.vocareum.template_assignment_ids ?? []),
    ];
    const templateCount = templates.length + legacyTemplateIds.length;

    // Same baseline the scanner and publisher use (publish_history[0]) so the
    // report's last_push can never disagree with the scan it accompanies.
    const lastPush = latestHistoryEntry(config);
    // Report credentials for the selected auth mode: token (v2) checks the API
    // key/token; oauth (v3) checks the client id + secret. Checking only the v2
    // key would report an OAuth-configured shell as "missing".
    const authMode = getAuthModeEnv() === 'oauth' ? 'oauth' : 'token';
    const credentialsConfigured = authMode === 'oauth'
      ? (getOAuthClientId() !== undefined && getOAuthClientSecret() !== undefined)
      : ((process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN ?? '') !== '');
    const credentialLabel = authMode === 'oauth' ? 'OAuth client credentials' : 'API key';
    const runtime = isCI() ? `CI (${getCIProvider() ?? 'unknown'})` : 'local';

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

    if (options.json === true) {
      const scan = await scanLocalContent(config, workspaceRoot);
      const report = {
        schema_version: STATUS_JSON_SCHEMA_VERSION,
        // Statuses reflect CONTENT change detection only (the same engine push
        // uses for uploads). Settings drift requires API calls and is NOT
        // included: a 'synced' assignment may still get settings updates on push.
        scope: 'content',
        generated_at: new Date().toISOString(),
        config_path: configPath,
        course: {
          org_id: config.vocareum.org_id,
          course_id: config.vocareum.course_id,
        },
        auth: { mode: authMode, configured: credentialsConfigured },
        runtime,
        git: insideRepo ? { repo: true, branch, commit, dirty } : { repo: false },
        last_push: lastPush === undefined ? null : {
          timestamp: lastPush.timestamp,
          status: lastPush.status ?? 'success',
          published_by: lastPush.published_by,
          commit_sha: lastPush.commit_sha,
        },
        assignments: scan.assignments,
        summary: scan.summary,
      };
      // Pure JSON on stdout — consumers parse this; human output goes nowhere else.
      process.stdout.write(JSON.stringify(report) + '\n');
      return;
    }

    const gitStatus = insideRepo ? `repo on ${branch} @ ${commit}${dirty ? ' (dirty)' : ''}` : 'not a git repository';

    logger.plain('Current Vocareum Publisher status');
    logger.newline();
    logger.plain('Readiness');
    logger.plain(`- Auth (${authMode}): ${credentialLabel} ${credentialsConfigured ? 'configured' : 'missing'}`);
    logger.plain(`- Runtime: ${runtime}`);

    logger.newline();
    logger.plain('Workspace');
    logger.plain(`- Config: ${configPath}`);
    logger.plain(`- Org/Course: ${config.vocareum.org_id}/${config.vocareum.course_id}`);
    logger.plain(`- Git: ${gitStatus}`);

    logger.newline();
    logger.plain('Sync Summary');
    if (lastPush === undefined) {
      logger.plain('- Last push: never');
    } else {
      logger.plain(`- Last push: ${lastPush.timestamp} (${lastPush.status ?? 'success'}) by ${lastPush.published_by} @ ${lastPush.commit_sha}`);
    }
    logger.plain(`- Assignments: ${assignmentCount} total (${linkedAssignmentCount} linked, ${assignmentCount - linkedAssignmentCount} pending create)`);
    logger.plain(`- Parts: ${totalPartCount} total (${linkedPartCount} linked, ${totalPartCount - linkedPartCount} pending map)`);
    logger.plain(`- Templates configured: ${templateCount}`);
    logger.plain(`- Excluded assignment IDs: ${excludedCount}`);

    if (options.verbose === true) {
      logger.newline();
      logger.plain('Assignment Details');
      for (const assignment of config.assignments) {
        const linkedParts = assignment.parts.filter(p => hasNonEmptyId(p.part_id)).length;
        const assignmentId = hasNonEmptyId(assignment.assignment_id) ? assignment.assignment_id : 'pending';
        logger.plain(`- ${assignment.path} (id=${assignmentId}, parts=${linkedParts}/${assignment.parts.length})`);
      }
    }
  } catch (error) {
    if (error instanceof CommandFailureError) { throw error; }
    logger.error(`Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new CommandFailureError(`Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 1);
  }
}
