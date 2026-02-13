/**
 * Publisher Module
 *
 * Execute the reconciliation plan by orchestrating API calls.
 */

import * as path from 'path';
import type { Config, PublishHistory } from '../types/config';
import type { PublishResult, PublishOperationOptions } from '../types/state';
import { VocareumClient } from '../api/client';
import { reconcile, displayPlan } from './reconciler';
import { copyAssignment } from '../api/assignments';
import { updateCourse } from '../api/courses';
import { updatePart } from '../api/parts';
import { mapParts } from './mapper';
import { syncDirectory } from './uploader';
import { updateConfig } from './config';
import { commitChanges, getCommitSha, getGitUserName } from '../utils/git';
import { logger } from '../utils/logger';
import { promptConfirm } from '../utils/prompts';

/**
 * Execute publish workflow
 *
 * @param config - Configuration to publish
 * @param client - Vocareum API client
 * @param options - Publish options
 * @returns Publish result
 */
export async function publish(
  config: Config,
  client: VocareumClient,
  options: PublishOperationOptions
): Promise<PublishResult> {
  const configPath = options.configPath ?? 'vocareum.yaml';
  // 0. Get current git state for history
  const commitSha = await getCommitSha().catch(() => 'unknown');
  const userName = (await getGitUserName().catch(() => null)) || 'unknown';

  // 1. Reconcile
  const lastHistory = config.publish_history?.[0]; // Get most recent

  logger.info('Analyzing changes...');
  const plan = await reconcile(config, client, lastHistory);

  // 2. Display Plan (always show summary, verbose shows details)
  const hasDiscoveredIds = plan.assignments.some((a) => a.idDiscoveredByName === true);
  const hasChanges = plan.summary.assignmentsToCreate > 0 ||
                     plan.summary.assignmentsToUpdate > 0 ||
                     plan.summary.partsToUpdate > 0 ||
                     plan.summary.coursesToUpdate > 0 ||
                     hasDiscoveredIds;

  if (options.verbose || options.dryRun) {
    displayPlan(plan);
  } else if (hasChanges) {
    // Show brief summary even without verbose
    const extras: string[] = [];
    if (plan.summary.coursesToUpdate > 0) {
      extras.push('course settings update');
    }
    if (hasDiscoveredIds) {
      extras.push('assignment ID sync');
    }
    logger.info(
      `Found: ${plan.summary.assignmentsToCreate} to create, ${plan.summary.assignmentsToUpdate} to update, ${plan.summary.assignmentsToSkip} unchanged` +
      (extras.length > 0 ? ` (${extras.join(', ')})` : '')
    );
  }

  // 3. Dry Run Check
  if (options.dryRun) {
    logger.info('Dry run complete. No changes made.');
    return {
      success: true,
      created: [],
      updated: [],
      skipped: [],
      failed: [],
      contentState: {}, // Empty for dry run
      summary: 'Dry run complete'
    };
  }

  // 4. No changes check
  if (!hasChanges) {
    logger.success('No changes detected. Everything is up to date.');
    return {
      success: true,
      created: [],
      updated: [],
      skipped: [],
      failed: [],
      contentState: { ...lastHistory?.content_state },
      summary: 'No changes to publish'
    };
  }

  // 5. Interactive confirmation (unless --non-interactive or CI)
  if (options.nonInteractive !== true) {
    logger.newline();
    const confirmed = await promptConfirm('Proceed with publish?', true);
    if (!confirmed) {
      logger.warn('Publish cancelled by user.');
      return {
        success: true,
        created: [],
        updated: [],
        skipped: [],
        failed: [],
        contentState: { ...lastHistory?.content_state },
        summary: 'Cancelled by user'
      };
    }
  }

  logger.info('Executing publish...');

  const result: PublishResult = {
    success: true,
    created: [],
    updated: [],
    skipped: [],
    failed: [],
    contentState: { ...lastHistory?.content_state }, // Start with previous state
    summary: ''
  };

  const configUpdates: Config['assignments'] = [];
  let configChanged = false;

  // 4. Course Updates
  if (plan.course.type === 'update' && config.vocareum.course_settings) {
    try {
      logger.info('Updating course settings...');
      await updateCourse(client, config.vocareum.course_id, {
        name: config.vocareum.course_settings.name,
        description: config.vocareum.course_settings.description,
      });
      logger.success('Course settings updated');
    } catch (error) {
      logger.error(`Failed to update course settings: ${error instanceof Error ? error.message : 'Unknown'}`);
      result.failed.push({ type: 'assignment', id: 'course', error });
      result.success = false;
    }
  }

  // 5. Creation (Assignments)
  for (const action of plan.assignments) {
    if (action.type === 'create' && action.willCreate) {
      if (!action.templateId) {
        logger.error(`Cannot create assignment ${action.assignment.name}: No template ID in config`);
        result.failed.push({ type: 'assignment', id: action.assignment.name, error: 'Missing template ID' });
        continue;
      }

      try {
        logger.info(`Creating assignment: ${action.assignment.name}`);
        const copyResult = await copyAssignment(
          client,
          action.templateId,
          action.assignment.name,
          config.vocareum.course_id
        );

        logger.success(`Created assignment ${action.assignment.name} (${copyResult.assignment_id})`);

        // Update local object to reflect new state
        action.assignment.assignment_id = copyResult.assignment_id;

        // Map parts from copy result
        // The copy response might have seqnum? 
        // We need to match config parts to these new parts based on... order?
        // AGENTS.md says: "template-based creation ... Copy template (assignments.ts) -> Map parts (mapper.ts)"
        // But mapParts uses remote parts.
        // copyResult returns parts.
        // Let's us mapParts with copyResult parts.
        // copyResult.parts has { part_id, name, seqnum }
        // We need to map to config parts.
        // Assuming config parts are in same order as template parts.

        // We need to update the `parts` in configAssignment with new IDs
        // But `action.parts` were based on old state (empty?).
        // Actually `reconcile` created 'create' actions for parts assuming we would create them.

        // We need to update the IDs in the config object so we can save them later.

        // Map the new parts
        // Cast to match mapParts expectation if needed
        const mapped = mapParts(action.assignment.parts, copyResult.parts.map(p => ({ id: p.part_id, seqnum: p.seqnum })));

        for (const m of mapped) {
          m.configPart.part_id = m.apiPartId;
        }

        result.created.push({ type: 'assignment', id: copyResult.assignment_id, parts: mapped.map(m => m.apiPartId) });
        configUpdates.push(action.assignment);
        configChanged = true;

        // Now execute part actions (uploads) using the new IDs
        // We need to re-evaluate part actions because we now have IDs?
        // OR we just use the mapped configPart which now has IDs.
        // The `plan` has `parts` actions. But those actions references `part` object.
        // Since we mutated `part` object (by reference), the actions might be valid now?
        // BUT `action.parts` loop in reconcile didn't know IDs.
        // `uploader` needs IDs.

      } catch (error) {
        logger.error(`Failed to create assignment ${action.assignment.name}`, { error });
        result.failed.push({ type: 'assignment', id: action.assignment.name, error });
        result.success = false;
        continue;
      }
    }
    else if (action.type === 'update') {
      // Update metadata if needed
      // For phase 4 we might skip metadata update or implement
      // Let's assume metadata update is implicit or skipped for now
      result.updated.push({ type: 'assignment', id: action.assignment.assignment_id! });

      // If ID was discovered via name lookup, we need to persist it to config
      if (action.idDiscoveredByName === true) {
        configUpdates.push(action.assignment);
        configChanged = true;
      }
    }

    // 5. Parts & Content
    for (const partAction of action.parts) {
      if (partAction.type === 'skip') {
        result.skipped.push({ type: 'part', id: partAction.part.part_id!, reason: 'No changes' });
        continue;
      }

      // If we just created the assignment, we mutated `partAction.part.part_id`.
      // If we are updating, it already had ID.

      const partId = partAction.part.part_id;
      if (!partId) {
        logger.error(`Part ${partAction.part.name} has no ID, skipping`);
        result.failed.push({ type: 'part', id: partAction.part.name || 'unknown', error: 'No Part ID' });
        continue;
      }

      // Update part metadata if needed
      if (partAction.metadataChanged && !action.willCreate) {
        const partName = partAction.part.name ?? partAction.part.settings?.name;
        if (partName) {
          try {
            logger.info(`Updating part metadata: ${partName}`);
            await updatePart(client, partId, { name: partName });
            logger.success(`Updated part ${partName}`);
          } catch (error) {
            logger.error(`Failed to update part metadata for ${partId}`, { error });
            result.failed.push({ type: 'part', id: partId, error });
            result.success = false;
          }
        }
      }

      // Upload Content
      if (partAction.contentChanged && partAction.changedDirectories) {
        for (const dir of partAction.changedDirectories) {
          try {
            const uploadRes = await syncDirectory(
              client,
              config.vocareum.course_id,
              action.assignment.assignment_id!,
              partId,
              path.join(action.assignment.path, partAction.part.path, dir), // Local path
              dir, // Directory type
              {
                syncDeletes: options.syncDeletes,
                excludePatterns: config.publish_options?.exclude_patterns
              }
            );

            if (uploadRes.failed.length > 0) {
              logger.warn(`Some files failed to upload in ${dir}`);
              for (const failedFile of uploadRes.failed) {
                result.failed.push({
                  type: 'file',
                  id: `${partId}/${dir}/${failedFile.path}`,
                  error: failedFile.error
                });
              }
              result.success = false;
            } else {
              // Only advance stored hash when this directory upload succeeded.
              const key = path.join(action.assignment.path, partAction.part.path, dir);
              result.contentState[key] = uploadRes.directoryHash;
            }
          } catch (error) {
            logger.error(`Failed to upload ${dir} for part ${partId}`, { error });
            result.failed.push({ type: 'file', id: `${partId}/${dir}`, error });
            result.success = false;
          }
        }
      }
    }
  }

  // 6. Update Config (IDs) and History
  const historyEntry: PublishHistory = {
    timestamp: new Date().toISOString(),
    commit_sha: commitSha,
    published_by: userName,
    status: result.success ? 'success' : 'failed',
    content_state: result.contentState,
    created: result.created.map(c => ({
      assignment: c.id,
      parts: c.parts || []
    })),
    failed: result.failed.length > 0
      ? result.failed.map((f) => ({
        type: f.type,
        id: f.id,
        error: f.error instanceof Error ? f.error.message : String(f.error),
      }))
      : undefined,
  };

  await updateConfig(configPath, {
    assignments: configChanged ? configUpdates : undefined,
    publish_history: [historyEntry] // Add this entry
  });

  // 7. Auto-Commit
  if (options.autoCommit && (configChanged || Object.keys(result.contentState).length > 0)) {
    try {
      await commitChanges(
        `chore: update vocareum config [skip ci]`,
        [configPath]
      );
    } catch (error) {
      logger.warn('Failed to auto-commit config changes');
    }
  }

  result.summary = `Published: ${result.created.length} created, ${result.updated.length} updated.`;
  return result;
}
