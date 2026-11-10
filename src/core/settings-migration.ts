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
 * An explicit top-level value always wins over a legacy unknown one. Runs on
 * the raw YAML before schema validation, so promoted values are validated and
 * coerced like any other. Purely in memory: the file moves to the new layout
 * the next time pull rewrites that resource's settings.
 */

import type { ZodTypeAny } from 'zod';
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
}

type Shape = Record<string, ZodTypeAny>;

/** The object shape behind `z.object(...)[.superRefine(...)].optional()`. */
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
};
const PART: Classification = {
  known: KNOWN_PART_SETTING_KEYS,
  observed: OBSERVED_PART_SETTING_KEYS,
  nonSetting: NON_SETTING_FIELDS_PART,
  fieldSchema: (key) => PART_SHAPE[key],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrateSettings(settings: unknown, c: Classification): void {
  if (!isRecord(settings) || !isRecord(settings._unknown_settings)) { return; }
  const unknown = settings._unknown_settings;
  for (const key of Object.keys(unknown)) {
    const value = unknown[key];
    if (c.known.has(key)) {
      if (settings[key] === undefined) {
        const schema = c.fieldSchema(key);
        if (schema?.safeParse(value).success !== true) { continue; }
        settings[key] = value;
      }
      delete unknown[key];
    } else if (c.observed.has(key)) {
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
export function promoteRecognizedUnknownSettings(rawConfig: unknown): void {
  if (!isRecord(rawConfig) || !Array.isArray(rawConfig.assignments)) { return; }
  for (const assignment of rawConfig.assignments) {
    if (!isRecord(assignment)) { continue; }
    migrateSettings(assignment.settings, ASSIGNMENT);
    if (!Array.isArray(assignment.parts)) { continue; }
    for (const part of assignment.parts) {
      if (isRecord(part)) { migrateSettings(part.settings, PART); }
    }
  }
}
