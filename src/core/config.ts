/**
 * Configuration Module
 *
 * Parse, validate, and manage vocareum.yaml configuration files.
 */

import { cosmiconfig } from 'cosmiconfig';
import * as yaml from 'js-yaml';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { ConfigSchema, type Config, type ConfigUpdates, type Assignment } from '../types/config';
import type { ValidationResult, ValidationError } from '../types/state';
import { logger } from '../utils/logger';
import { promoteRecognizedUnknownSettings } from './settings-migration';

/**
 * js-yaml's default schema minus implicit timestamps. With timestamps on, an
 * unquoted `2026-02-30` is silently built as 2 March and `2026-12-01T23:30-08:00`
 * as 2 December, before any validation sees the text. Every date-like field in
 * vocareum.yaml is a string, so keeping the scalar as written lets the schema
 * reject what Vocareum would reject. Merge keys and the explicit tags stay.
 */
const CONFIG_YAML_SCHEMA = ((): yaml.Schema => {
  // js-yaml keeps a schema's types on `implicit` / `explicit` (not in @types).
  type Tagged = yaml.Type & { tag: string };
  const def = yaml.DEFAULT_SCHEMA as unknown as { implicit: Tagged[]; explicit: Tagged[] };
  const core = yaml.CORE_SCHEMA as unknown as { implicit: Tagged[]; explicit: Tagged[] };
  const inCore = (t: Tagged, list: Tagged[]): boolean => list.some(c => c.tag === t.tag);
  return yaml.CORE_SCHEMA.extend({
    implicit: def.implicit.filter(t => t.tag !== 'tag:yaml.org,2002:timestamp' && !inCore(t, core.implicit)),
    explicit: def.explicit.filter(t => !inCore(t, core.explicit)),
  });
})();

/** loadConfig runs several times per command (updateConfig re-loads); warn once per value. */
const warnedUnpromoted = new Set<string>();
function warnUnpromotedOnce(id: string, message: string): void {
  if (warnedUnpromoted.has(id)) { return; }
  warnedUnpromoted.add(id);
  logger.warn(message);
}

/**
 * Custom error for configuration issues
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load and parse vocareum.yaml configuration
 *
 * @param configPath - Path to vocareum.yaml file
 * @returns Parsed and validated configuration
 * @throws ConfigError if file is invalid
 */
export async function loadConfig(configPath: string): Promise<Config> {
  const explorer = cosmiconfig('vocareum', {
    searchPlaces: ['vocareum.yaml', 'vocareum.yml'],
    loaders: {
      '.yaml': (_filepath, content) => yaml.load(content, { schema: CONFIG_YAML_SCHEMA }),
      '.yml': (_filepath, content) => yaml.load(content, { schema: CONFIG_YAML_SCHEMA }),
    },
  });

  try {
    const result = configPath
      ? await explorer.load(configPath)
      : await explorer.search();

    if (result === null || result === undefined || result.config === undefined) {
      throw new ConfigError(
        'Configuration file (vocareum.yaml) not found.\n\n' +
        'To fix:\n' +
        '  Run "vocgit init" to create a new configuration, or\n' +
        '  Make sure you are in a directory with a vocareum.yaml file.',
        'CONFIG_NOT_FOUND'
      );
    }

    // Settings a newer vocgit recognizes may still sit in `_unknown_settings`
    // from an older pull; move them where they belong before validation.
    for (const u of promoteRecognizedUnknownSettings(result.config)) {
      warnUnpromotedOnce(`${configPath}:${u.location}:${u.key}:${JSON.stringify(u.value)}`,
        `${u.location}: _unknown_settings.${u.key} = ${JSON.stringify(u.value)} is not a valid ${u.key} value, ` +
        `so it is not pushed. Set ${u.key} in settings (or remove it), or run \`vocgit pull\` to refresh it from Vocareum.`);
    }
    const parsed = ConfigSchema.safeParse(result.config);

    if (!parsed.success) {
      const errorMsg = zodErrorsToValidationErrors(parsed.error).map((e) => e.message).join('\n');
      throw new ConfigError(`Invalid configuration:\n${errorMsg}`, 'INVALID_CONFIG');
    }

    // Return the parsed data (not the raw YAML object) so schema defaults,
    // transforms (e.g. lowercase exam_mode → uppercase), and coercions apply.
    return parsed.data;
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Failed to load configuration: ${message}`,
      'LOAD_ERROR'
    );
  }
}

/**
 * Validate configuration against schema
 *
 * @param config - Configuration to validate
 * @returns Validation result with errors
 */
export function validateConfig(config: unknown): ValidationResult {
  const result = ConfigSchema.safeParse(config);

  if (result.success) {
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  return {
    valid: false,
    errors: zodErrorsToValidationErrors(result.error),
    warnings: [],
  };
}

/**
 * Convert Zod issues into ValidationError records with user-facing hints.
 */
function zodErrorsToValidationErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((err) => {
    const path = err.path.join('.');
    let message = `${path}: ${err.message}`;
    // zod 4 words these as "Invalid input: expected string, received number".
    const text = err.message.toLowerCase();

    // Add helpful hints for common errors
    if (path.includes('tags') && text.includes('expected')) {
      message += '\n  Hint: tags should be an object like { key: "value" } or an empty array []';
    } else if ((path.includes('_id') || path.includes('Id')) && text.includes('expected string') && !text.includes('received undefined')) {
      // zod 4 reports a missing field as "expected string, received undefined"
      // (zod 3 said "Required"); quoting is not the fix for an absent ID.
      message += '\n  Hint: All IDs must be quoted strings (e.g., "12345" not 12345)';
    } else if (text.includes('expected array, received object')) {
      message += '\n  Hint: This field expects an array [...] but got an object {...}';
    } else if (text.includes('expected object, received array') || text.includes('expected record, received array')) {
      // zod 4 names z.record fields "record" where zod 3 said "object".
      message += '\n  Hint: This field expects an object {...} but got an array [...]';
    }

    return {
      type: 'invalid_structure' as const,
      path,
      message,
    };
  });
}

/**
 * Update configuration file with new values
 *
 * @param configPath - Path to vocareum.yaml
 * @param updates - Updates to apply
 */
export async function updateConfig(configPath: string, updates: ConfigUpdates): Promise<void> {
  // 1. Load current raw config to preserve comments/structure involved in other parts?
  // Ideally we'd use a parser that preserves comments, but js-yaml doesn't.
  // For now, we'll read, parse, update, and stringify.

  const currentConfig = await loadConfig(configPath);

  // 2. Apply updates
  if (updates.assignments) {
    for (const update of updates.assignments) {
      const existing = currentConfig.assignments.find((a) => a.path === update.path);
      if (existing) {
        // Update existing assignment
        Object.assign(existing, update);
      } else if (update.path !== undefined && update.path !== '' &&
        update.name !== undefined && update.name !== '' &&
        update.parts !== undefined) {
        // New assignment - validate required fields exist
        const newAssignment: Assignment = {
          path: update.path,
          name: update.name,
          assignment_id: update.assignment_id ?? null,
          create_from_template: update.create_from_template ?? false,
          template_assignment_id: update.template_assignment_id,
          settings: update.settings ?? {},
          parts: update.parts,
        };
        currentConfig.assignments.push(newAssignment);
      }
    }
  }

  if (updates.publish_history !== undefined) {
    if (currentConfig.publish_history === undefined) {
      currentConfig.publish_history = [];
    }

    currentConfig.publish_history.push(...updates.publish_history);

    currentConfig.publish_history.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    if (currentConfig.publish_history.length > 10) {
      currentConfig.publish_history = currentConfig.publish_history.slice(0, 10);
    }
  }

  if (updates.publish_options) {
    // We manually construct the object to satisfy type checker, supplying defaults if missing
    const defaults = {
      on_missing_id: 'skip' as const,
      auto_commit: false,
      abort_on_error: false,
      sync_settings: true,
      sync_rubrics: true,
      sync_deletes: false,
      exclude_patterns: [] as string[]
    };

    const current = currentConfig.publish_options ?? defaults;

    currentConfig.publish_options = {
      ...current,
      ...updates.publish_options
    };
  }

  if (updates.excluded_assignments !== undefined) {
    // Merge new exclusions with existing, avoiding duplicates
    const existing = currentConfig.vocareum.excluded_assignments ?? [];
    const merged = [...new Set([...existing, ...updates.excluded_assignments])];
    currentConfig.vocareum.excluded_assignments = merged;
  }

  if (updates.remove_assignments !== undefined) {
    // Remove assignments by path
    const pathsToRemove = new Set(updates.remove_assignments);
    currentConfig.assignments = currentConfig.assignments.filter(
      a => !pathsToRemove.has(a.path)
    );
  }

  if (updates.reset_assignment_ids !== undefined) {
    // Reset assignment and part IDs by path
    const pathsToReset = new Set(updates.reset_assignment_ids);
    for (const assignment of currentConfig.assignments) {
      if (pathsToReset.has(assignment.path)) {
        assignment.assignment_id = null;
        assignment.create_from_template = true;
        for (const part of assignment.parts) {
          part.part_id = null;
        }
      }
    }
  }

  // 3. Validate before write to catch any mutations that produced an invalid config
  const validation = validateConfig(currentConfig);
  if (!validation.valid) {
    const errorMsg = validation.errors.map((e) => e.message).join('\n');
    throw new ConfigError(`Config update would produce invalid configuration:\n${errorMsg}`, 'INVALID_CONFIG');
  }

  // 4. Write back
  const yamlStr = yaml.dump(currentConfig, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });

  await atomicWriteFile(configPath, yamlStr);
  logger.debug(`Updated configuration at ${configPath}`);
}

/**
 * Write a file atomically: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write can no longer truncate
 * vocareum.yaml, which doubles as the publish-state store.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const existingMode = await fs.stat(filePath)
    .then((stat) => stat.mode & 0o777)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw error;
    });
  const handle = await fs.open(tmpPath, 'wx', existingMode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await fs.rename(tmpPath, filePath);
    // Persist the directory entry where supported. Some platforms/filesystems
    // reject directory fsync, but the rename has still completed atomically.
    const directoryHandle = await fs.open(path.dirname(filePath), 'r').catch(() => undefined);
    if (directoryHandle !== undefined) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close().catch(() => undefined);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Run an operation while holding an exclusive lock next to the config file.
 *
 * Prevents two concurrent vocgit runs (e.g. overlapping CI jobs) from
 * interleaving read-modify-write cycles on vocareum.yaml — which loses publish
 * history — or both creating the same assignment. The lock is advisory: it
 * only guards vocgit against itself.
 */
export async function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const token = randomUUID();
  const payload = JSON.stringify({
    token,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  });

  try {
    await fs.writeFile(lockPath, payload, { flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
    throw new ConfigError(
      `Configuration is locked by another vocgit run (${lockPath} exists).\n\n` +
      'If no other vocgit process is running, delete the lock file and retry.\n' +
      'For CI, serialize runs (e.g. a GitHub Actions concurrency group) to avoid\n' +
      'concurrent publishes corrupting vocareum.yaml or creating duplicate assignments.',
      'CONFIG_LOCKED'
    );
  }

  try {
    return await fn();
  } finally {
    // Never remove a replacement lock created by another process after manual
    // recovery or external interference.
    const currentPayload = await fs.readFile(lockPath, 'utf8').catch(() => undefined);
    if (currentPayload === payload) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}

/**
 * Migrate configuration from older version
 *
 * @param config - Configuration to migrate
 * @param fromVersion - Source version
 * @returns Migrated configuration
 */
export function migrateConfig(config: unknown, fromVersion: string): Config {
  // Currently only version 1.0 exists, so no migration needed.
  // Check if version matches
  if (fromVersion === '1.0') {
    return config as Config;
  }

  throw new ConfigError(`Unsupported config version: ${fromVersion}`, 'INVALID_VERSION');
}
