/**
 * Status Command
 *
 * Shows current local repository status for Vocareum sync.
 */

import * as path from 'path';
import { loadConfig } from '../core/config';
import { resolveWorkspaceContext } from '../core/workspace';
import { loadDotEnvIfPresent, isCI, getCIProvider, getAuthModeEnv, getOAuthClientId, getOAuthClientSecret } from '../utils/env';
import { CommandFailureError } from '../utils/command-failure';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { InteractivePrompter } from '../core/services/context';
import { inspectStatus, renderStatusHuman } from '../core/services/status-service';
import type { RuntimeFacts } from '../core/services/context';

export interface StatusCommandOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  verbose?: boolean;
  /** Emit a machine-readable JSON report on stdout (consumed by the VS Code extension). */
  json?: boolean;
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

    const authMode = getAuthModeEnv() === 'oauth' ? 'oauth' : 'token';
    const credentialsConfigured = authMode === 'oauth'
      ? (getOAuthClientId() !== undefined && getOAuthClientSecret() !== undefined)
      : ((process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN ?? '') !== '');
    const credentialLabel = authMode === 'oauth' ? 'OAuth client credentials' : 'API key';
    const ci = isCI();
    const ciProvider = getCIProvider() ?? undefined;

    const runtime: RuntimeFacts = {
      ci,
      ciProvider,
      authMode,
      credentialLabel,
      credentialsConfigured,
    };

    const events = new LoggerEventSink();
    const ctx = {
      persistedConfig: config,
      effectiveConfig: config,
      configPath,
      workspaceRoot,
      events,
      prompter: new InteractivePrompter(),
      runtime,
    };

    const report = await inspectStatus(ctx, { scanContent: options.json === true });

    if (options.json === true) {
      // Pure JSON on stdout — consumers parse this; human output goes nowhere else.
      // Emit exactly the fields that match today's schema (no extra service fields).
      const jsonDoc = {
        schema_version: report.schema_version,
        scope: report.scope,
        generated_at: report.generated_at,
        config_path: report.config_path,
        course: report.course,
        auth: report.auth,
        runtime: report.runtime,
        git: report.git,
        last_push: report.last_push,
        assignments: report.assignments,
        summary: report.summary,
      };
      process.stdout.write(JSON.stringify(jsonDoc) + '\n');
      return;
    }

    // Compute template / excluded counts for human rendering
    const templates = config.vocareum.templates ?? [];
    const legacyTemplateIds = [
      ...(config.vocareum.template_assignment_id !== undefined ? [config.vocareum.template_assignment_id] : []),
      ...(config.vocareum.template_assignment_ids ?? []),
    ];
    const templateCount = templates.length + legacyTemplateIds.length;
    const excludedCount = config.vocareum.excluded_assignments?.length ?? 0;

    // Derive assignment/part counts from config — not from the scan — so that
    // human status stays fast (no filesystem traversal) and counts are correct
    // even when scanContent is false.
    const configAssignments = config.assignments ?? [];
    const configAssignmentCount = configAssignments.length;
    const configLinkedAssignmentCount = configAssignments.filter(
      a => typeof a.assignment_id === 'string' && a.assignment_id.trim() !== ''
    ).length;
    const configTotalPartCount = configAssignments.reduce(
      (sum, a) => sum + (a.parts?.length ?? 0),
      0
    );
    const configLinkedPartCount = configAssignments.reduce(
      (sum, a) => sum + (a.parts ?? []).filter(
        p => typeof p.part_id === 'string' && p.part_id.trim() !== ''
      ).length,
      0
    );

    // Config-derived per-assignment detail rows for the verbose section.
    const assignmentDetails = configAssignments.map(a => ({
      path: a.path,
      assignmentId: a.assignment_id,
      linkedParts: (a.parts ?? []).filter(
        p => typeof p.part_id === 'string' && p.part_id.trim() !== ''
      ).length,
      totalParts: a.parts?.length ?? 0,
    }));

    renderStatusHuman(report, events, {
      verbose: options.verbose,
      templateCount,
      excludedCount,
      assignmentCount: configAssignmentCount,
      linkedAssignmentCount: configLinkedAssignmentCount,
      totalPartCount: configTotalPartCount,
      linkedPartCount: configLinkedPartCount,
      assignmentDetails,
    });
  } catch (error) {
    if (error instanceof CommandFailureError) { throw error; }
    const { logger } = await import('../utils/logger');
    logger.error(`Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new CommandFailureError(`Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 1);
  }
}
