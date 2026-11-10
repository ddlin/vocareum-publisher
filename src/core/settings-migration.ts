/**
 * Load-time migration of `_unknown_settings` entries that a newer vocgit
 * recognizes.
 *
 * `_unknown_settings` holds API fields vocgit did not understand when the repo
 * was pulled. When a later release classifies one of them, the pulled YAML
 * still carries it in the unknown bucket — and push's reserved-key filter
 * would then DROP it with a warning on every run until the next pull rewrote
 * the assignment. Instead, each load moves it to where the current
 * classification says it belongs:
 *
 *   known      → the top-level setting (only if the top level is absent, and
 *                only if the value passes that field's schema — otherwise it
 *                stays put, so one odd value can never make the whole config
 *                fail to load)
 *   observed   → `_observed_settings` (only if not already there)
 *   non-setting→ dropped (server identity/metadata; never pushed)
 *
 * An explicit top-level value always wins over a legacy unknown one. A value is
 * first normalized the way pull would map it from the API (so a legacy "1"
 * flag or lower-case enum is promoted like the boolean or upper-case value a
 * current pull writes), then checked against its field schema. Runs on the raw
 * YAML before schema validation, so promoted values are validated and coerced
 * like any other.
 *
 * A known key that cannot be promoted stays in `_unknown_settings` and is
 * returned, so the caller can warn: it is a reserved name now and is NOT sent
 * on push (the API would reject the value anyway).
 *
 * In memory only, but any command that writes vocareum.yaml (push, pull, fix
 * — updateConfig re-loads and re-dumps the whole file) writes it back in the
 * new layout.
 */

import type { ZodTypeAny } from 'zod';
import { mapPeerReviewSettings } from '../utils/settings';
import { AssignmentSettingsSchema, PartSettingsSchema } from '../types/config';
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  OBSERVED_ASSIGNMENT_SETTING_KEYS,
  OBSERVED_PART_SETTING_KEYS,
} from '../utils/known-settings';

interface Classification {
  known: ReadonlySet<string>;
  observed: ReadonlySet<string>;
  nonSetting: ReadonlySet<string>;
  fieldSchema: (key: string) => ZodTypeAny | undefined;
  /** Normalize a legacy raw API value the way pull's mapper would. */
  normalize: (key: string, value: unknown) => unknown;
}

type Shape = Record<string, ZodTypeAny>;

/** The object shape behind `z.object(...).optional()`. */
function shapeOf(schema: ZodTypeAny): Shape {
  let current: ZodTypeAny = schema;
  for (let i = 0; i < 4; i++) {
    const def = current._def as { typeName?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; shape?: () => Shape };
    if (def.typeName === 'ZodObject' && def.shape) { return def.shape(); }
    current = def.innerType ?? def.schema ?? current;
  }
  throw new Error('settings-migration: could not resolve settings schema shape');
}

const ASSIGNMENT_SHAPE = shapeOf(AssignmentSettingsSchema);
const PART_SHAPE = shapeOf(PartSettingsSchema);

const ASSIGNMENT: Classification = {
  known: KNOWN_ASSIGNMENT_SETTING_KEYS,
  observed: OBSERVED_ASSIGNMENT_SETTING_KEYS,
  nonSetting: NON_SETTING_FIELDS_ASSIGNMENT,
  fieldSchema: (key) => ASSIGNMENT_SHAPE[key],
  normalize: (key, value) => {
    const mapped: Record<string, unknown> = {};
    mapPeerReviewSettings({ [key]: value }, mapped);
    return key in mapped ? mapped[key] : value;
  },
};
const PART: Classification = {
  known: KNOWN_PART_SETTING_KEYS,
  observed: OBSERVED_PART_SETTING_KEYS,
  nonSetting: NON_SETTING_FIELDS_PART,
  fieldSchema: (key) => PART_SHAPE[key],
  normalize: (_key, value) => value,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A legacy known key that stayed in `_unknown_settings` because its value is invalid. */
export interface UnpromotedSetting {
  /** e.g. `lab1` or `lab1/part1` */
  location: string;
  key: string;
  value: unknown;
}

function migrateSettings(settings: unknown, c: Classification, location: string, out: UnpromotedSetting[]): void {
  if (!isRecord(settings) || !isRecord(settings._unknown_settings)) { return; }
  const unknown = settings._unknown_settings;
  for (const key of Object.keys(unknown)) {
    const value = unknown[key];
    if (c.known.has(key)) {
      if (settings[key] === undefined) {
        const normalized = c.normalize(key, value);
        const schema = c.fieldSchema(key);
        if (schema?.safeParse(normalized).success !== true) {
          out.push({ location, key, value });
          continue;
        }
        settings[key] = normalized;
      }
      delete unknown[key];
    } else if (c.observed.has(key)) {
      // A malformed (non-object) bucket is left for the schema to report
      // rather than silently replaced.
      if (settings._observed_settings !== undefined && !isRecord(settings._observed_settings)) { continue; }
      const observed = isRecord(settings._observed_settings) ? settings._observed_settings : {};
      if (observed[key] === undefined) { observed[key] = value; }
      settings._observed_settings = observed;
      delete unknown[key];
    } else if (c.nonSetting.has(key)) {
      delete unknown[key];
    }
  }
  if (Object.keys(unknown).length === 0) { delete settings._unknown_settings; }
}

/**
 * Apply the migration to every assignment and part in a raw (unvalidated)
 * config object, in place. Anything unexpected in shape is left untouched for
 * the schema to report.
 */
export function promoteRecognizedUnknownSettings(rawConfig: unknown): UnpromotedSetting[] {
  const unpromoted: UnpromotedSetting[] = [];
  if (!isRecord(rawConfig) || !Array.isArray(rawConfig.assignments)) { return unpromoted; }
  for (const assignment of rawConfig.assignments) {
    if (!isRecord(assignment)) { continue; }
    const asnLabel = typeof assignment.path === 'string' ? assignment.path : '?';
    migrateSettings(assignment.settings, ASSIGNMENT, asnLabel, unpromoted);
    if (!Array.isArray(assignment.parts)) { continue; }
    for (const part of assignment.parts) {
      if (!isRecord(part)) { continue; }
      const partLabel = typeof part.path === 'string' ? part.path : '?';
      migrateSettings(part.settings, PART, `${asnLabel}/${partLabel}`, unpromoted);
    }
  }
  return unpromoted;
}
