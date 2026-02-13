/**
 * Configuration Module
 *
 * Parse, validate, and manage vocareum.yaml configuration files.
 */

import { cosmiconfig } from 'cosmiconfig';
import * as yaml from 'js-yaml';
import { promises as fs } from 'fs';
import { ConfigSchema, type Config, type ConfigUpdates, type Assignment } from '../types/config';
import type { ValidationResult, ValidationError } from '../types/state';
import { logger } from '../utils/logger';

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
      '.yaml': (_filepath, content) => yaml.load(content),
      '.yml': (_filepath, content) => yaml.load(content),
    },
  });

  try {
    const result = configPath
      ? await explorer.load(configPath)
      : await explorer.search();

    if (!result?.config) {
      throw new ConfigError('Configuration file not found', 'CONFIG_NOT_FOUND');
    }

    const validation = validateConfig(result.config);

    if (!validation.valid) {
      const errorMsg = validation.errors.map((e) => e.message).join('\n');
      throw new ConfigError(`Invalid configuration:\n${errorMsg}`, 'INVALID_CONFIG');
    }

    return result.config as Config;
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

  const errors: ValidationError[] = result.error.errors.map((err) => ({
    type: 'invalid_structure',
    path: err.path.join('.'),
    message: `${err.path.join('.')}: ${err.message}`,
  }));

  return {
    valid: false,
    errors,
    warnings: [],
  };
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
      } else if (update.path && update.name && update.parts) {
        // New assignment - validate required fields exist
        const newAssignment: Assignment = {
          path: update.path,
          name: update.name,
          assignment_id: update.assignment_id ?? null,
          create_from_template: update.create_from_template ?? false,
          settings: update.settings ?? {},
          parts: update.parts,
        };
        currentConfig.assignments.push(newAssignment);
      }
    }
  }

  if (updates.publish_history) {
    if (!currentConfig.publish_history) {
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
      sync_deletes: false,
      exclude_patterns: [] as string[]
    };

    const current = currentConfig.publish_options || defaults;

    currentConfig.publish_options = {
      ...current,
      ...updates.publish_options
    };
  }

  // 3. Write back
  const yamlStr = yaml.dump(currentConfig, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
  });

  await fs.writeFile(configPath, yamlStr, 'utf8');
  logger.debug(`Updated configuration at ${configPath}`);
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
