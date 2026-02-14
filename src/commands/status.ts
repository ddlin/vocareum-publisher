/**
 * Status Command
 *
 * Shows current local repository status for Vocareum sync.
 */

import { loadConfig } from '../core/config';
import { loadDotEnvIfPresent, isCI, getCIProvider } from '../utils/env';
import { getCurrentBranch, getCommitSha, hasUncommittedChanges, isGitRepo } from '../utils/git';
import { logger } from '../utils/logger';
import type { PublishHistory } from '../types/config';

export interface StatusCommandOptions {
  config?: string;
  verbose?: boolean;
}

function hasNonEmptyId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function getLastPushEntry(history: PublishHistory[] | undefined): PublishHistory | undefined {
  if (history === undefined || history.length === 0) {
    return undefined;
  }

  let latest = history[0];
  let latestTime = Date.parse(latest.timestamp);

  for (let i = 1; i < history.length; i += 1) {
    const entry = history[i];
    const entryTime = Date.parse(entry.timestamp);
    if (!Number.isNaN(entryTime) && (Number.isNaN(latestTime) || entryTime > latestTime)) {
      latest = entry;
      latestTime = entryTime;
    }
  }

  return latest;
}

/**
 * Execute the status command
 */
export async function statusCommand(options: StatusCommandOptions): Promise<void> {
  const configPath = options.config ?? 'vocareum.yaml';

  try {
    loadDotEnvIfPresent();
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

    const lastPush = getLastPushEntry(config.publish_history);
    const apiKeyConfigured =
      (process.env.VOCAREUM_API_KEY !== undefined && process.env.VOCAREUM_API_KEY !== '') ||
      (process.env.VOCAREUM_API_TOKEN !== undefined && process.env.VOCAREUM_API_TOKEN !== '');

    const insideRepo = await isGitRepo();
    let branch = 'n/a';
    let commit = 'n/a';
    let dirty = false;
    if (insideRepo) {
      try {
        branch = await getCurrentBranch();
      } catch {
        branch = 'unknown';
      }
      try {
        commit = await getCommitSha();
      } catch {
        commit = 'none';
      }
      dirty = await hasUncommittedChanges();
    }

    logger.plain('Current Vocareum Publisher status');
    logger.plain(`Config: ${configPath}`);
    logger.plain(`Org/Course: ${config.vocareum.org_id}/${config.vocareum.course_id}`);
    logger.plain(`Assignments: ${assignmentCount} total (${linkedAssignmentCount} linked, ${assignmentCount - linkedAssignmentCount} pending create)`);
    logger.plain(`Parts: ${totalPartCount} total (${linkedPartCount} linked, ${totalPartCount - linkedPartCount} pending map)`);
    logger.plain(`Templates configured: ${templateCount}`);
    logger.plain(`Excluded assignment IDs: ${excludedCount}`);
    if (lastPush === undefined) {
      logger.plain('Last push: never');
    } else {
      logger.plain(`Last push: ${lastPush.timestamp} (${lastPush.status ?? 'success'}) by ${lastPush.published_by} @ ${lastPush.commit_sha}`);
    }
    logger.plain(`Git: ${insideRepo ? `repo on ${branch} @ ${commit}${dirty ? ' (dirty)' : ''}` : 'not a git repository'}`);
    logger.plain(`Environment: ${isCI() ? `CI (${getCIProvider() ?? 'unknown'})` : 'local'}; API key ${apiKeyConfigured ? 'configured' : 'missing'}`);

    if (options.verbose === true) {
      logger.newline();
      logger.plain('Assignments:');
      for (const assignment of config.assignments) {
        const linkedParts = assignment.parts.filter(p => hasNonEmptyId(p.part_id)).length;
        const assignmentId = hasNonEmptyId(assignment.assignment_id) ? assignment.assignment_id : 'pending';
        logger.plain(`- ${assignment.path} (id=${assignmentId}, parts=${linkedParts}/${assignment.parts.length})`);
      }
    }
  } catch (error) {
    logger.error(`Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
