/**
 * Rubric Fetcher — a rubric read that cannot break the run.
 *
 * The rubrics token permission is OPTIONAL at token creation (README,
 * "Required Permissions"), so most existing tokens do not have it. The caller
 * that needs rubrics — detectSettingsDrift — wraps each assignment in a single
 * try/catch that warns and continues, so a throw from here would silently
 * discard that assignment's ENTIRE settings drift. A missing optional scope
 * would then read to the user as "settings drift detection stopped working".
 *
 * So this never throws. It returns undefined, and on a 403 it latches off for
 * the remainder of the run after exactly one warning, rather than warning once
 * per part across a hundred assignments.
 *
 * IMPORTANT: This file lives under src/core/services/, which the architecture
 * guard restricts (AGENTS.md #12, test/unit/no-forbidden-imports.test.ts): no
 * global logger, no config loading/locking, no client construction. The client
 * and the warn callback are injected.
 */

import type { VocareumClient } from '../../api/client';
import { ForbiddenError } from '../../api/client';
import { listRubrics } from '../../api/rubrics';
import { mapRubrics } from '../../utils/rubrics';
import type { Rubric } from '../../types/config';

export interface RubricFetcher {
  /** Rubrics for the part, or undefined when they could not be read. */
  fetch(assignmentId: string, partId: string): Promise<Rubric[] | undefined>;
}

export function createRubricFetcher(
  client: VocareumClient,
  courseId: string,
  enabled: boolean,
  warnFn: (msg: string) => void
): RubricFetcher {
  let available = enabled;

  return {
    async fetch(assignmentId: string, partId: string): Promise<Rubric[] | undefined> {
      if (!available) { return undefined; }

      try {
        return mapRubrics(await listRubrics(client, courseId, assignmentId, partId));
      } catch (error) {
        if (error instanceof ForbiddenError) {
          available = false;
          warnFn(
            'Rubrics could not be read with this API token. Rubric changes will not be ' +
            'reported for the rest of this run. If this course uses rubrics, regenerate ' +
            'the token with the rubrics GET permission enabled (it is optional at token ' +
            'creation) and pull again.'
          );
          return undefined;
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        warnFn(`Could not fetch rubrics for part ${partId}: ${message}`);
        return undefined;
      }
    },
  };
}
