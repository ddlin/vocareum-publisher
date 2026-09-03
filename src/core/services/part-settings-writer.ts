/**
 * Part Settings Writer — the part-settings fallback ladder.
 *
 * Vocareum's part-update endpoint rejects some payloads with a 400 (e.g. an
 * unrecognized `container_image`/`labtype` pair, or a field it doesn't
 * accept at all). Rather than surface that as a hard failure, push degrades
 * through progressively smaller payloads and reports exactly what was left
 * out, so a reduced write is never reported as an unqualified success.
 *
 * `update` is injected rather than imported so this ladder is testable
 * without a client, and so this module needs no knowledge of
 * course/assignment/part ids — it only knows payloads and outcomes.
 *
 * IMPORTANT: This file lives under src/core/services/, which the
 * architecture guard restricts (see AGENTS.md #12 and
 * test/unit/no-forbidden-imports.test.ts): no global logger, no config
 * loading/locking helpers, no direct API client construction. All output
 * goes through the injected EventSink.
 */

import type { EventSink } from './event-sink';
import type { PartSettings } from '../../types/config';
import type { PartSettingsPayload } from '../../types/api';
import {
  buildPartSettingsPayload,
  describeDroppedPartSettings,
  describeApiError,
  isHttp400,
  omitPlatformKeysForUpdate,
} from '../payload-helpers';

export type PartSettingsWriteOutcome =
  | 'full' | 'without-platform' | 'safe' | 'name-only' | 'none';

export interface PartSettingsWriteResult {
  outcome: PartSettingsWriteOutcome;
  /** Settings present in the full payload that were not sent. */
  dropped: string[];
}

/**
 * Apply part settings, degrading the payload only as far as the API forces.
 *
 * The rungs, in order:
 *   full              -- everything
 *   without-platform  -- minus labtype/container_image, the fields the write
 *                        API rejects; grading and interface settings survive
 *   safe              -- name/filters/session/budget only; loses max_points,
 *                        lab_interface, tags, instant_aws_access
 *   name-only         -- last resort
 *   none              -- give up, caller records a skip
 *
 * `update` is injected so the ladder is testable without a client, and so this
 * module needs no knowledge of course/assignment/part ids.
 *
 * Every degradation is reported through `events` naming exactly what was not
 * sent. A reduced write must never read as an unqualified success.
 */
export async function writePartSettingsWithFallback(
  update: (payload: PartSettingsPayload) => Promise<void>,
  partName: string,
  partSettings: PartSettings | undefined,
  fullPayload: PartSettingsPayload,
  events: EventSink,
): Promise<PartSettingsWriteResult> {
  const rungs: Array<{ outcome: PartSettingsWriteOutcome; payload: PartSettingsPayload }> = [
    { outcome: 'full', payload: fullPayload },
    { outcome: 'without-platform', payload: omitPlatformKeysForUpdate(fullPayload) },
    { outcome: 'safe', payload: buildPartSettingsPayload(partName, partSettings, 'safe', events) },
    { outcome: 'name-only', payload: { name: partName } },
  ];

  for (let i = 0; i < rungs.length; i++) {
    const { outcome, payload } = rungs[i];
    try {
      await update(payload);
      const dropped = describeDroppedPartSettings(fullPayload, payload);
      if (dropped.length > 0) {
        events.emit({
          level: 'warn',
          message:
            `Part ${partName} was updated WITHOUT these settings, which the API rejected: ` +
            `${dropped.join(', ')}. They remain as Vocareum has them.`,
        });
      }
      return { outcome, dropped };
    } catch (error) {
      // Only a 400 means "this payload is unacceptable". Anything else is a
      // real failure and degrading the payload would just hide it.
      if (!isHttp400(error)) { throw error; }
      const hasNext = i + 1 < rungs.length;
      const next = hasNext ? rungs[i + 1] : undefined;
      events.emit({
        level: 'warn',
        message:
          `Part settings update rejected (400) for ${partName} ` +
          `[API: ${describeApiError(error)}]` +
          (next !== undefined ? `; retrying as ${next.outcome}` : '; giving up'),
      });
    }
  }

  return {
    outcome: 'none',
    dropped: describeDroppedPartSettings(fullPayload, {}),
  };
}
