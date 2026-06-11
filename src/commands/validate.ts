/**
 * Validate Command
 *
 * Validate configuration and file structure consistency.
 */

import { loadConfig } from '../core/config';
import { validateStructure } from '../core/validator';
import { resolveWorkspaceContext } from '../core/workspace';
import { logger } from '../utils/logger';

export interface ValidateOptions {
  config?: string;
  /** Explicit workspace root (required when --config is not directly inside cwd) */
  root?: string;
  strict?: boolean;
  vocareum?: boolean;
}

/**
 * Execute the validate command
 */
export async function validateCommand(options: ValidateOptions): Promise<void> {
  const { configPath, workspaceRoot } = resolveWorkspaceContext({
    config: options.config,
    root: options.root,
  });

  try {
    logger.info('Validating configuration...');
    const config = await loadConfig(configPath);
    logger.success('Configuration is valid.');

    logger.info('Validating file structure...');
    const result = await validateStructure(config, workspaceRoot);

    if (result.valid) {
      logger.success('File structure is valid.');
    } else {
      logger.error('File structure validation failed:');
    }

    if (result.errors.length > 0) {
      result.errors.forEach(e => logger.error(`[${e.type}] ${e.message}`));
    }

    if (result.warnings.length > 0) {
      result.warnings.forEach(w => logger.warn(`[${w.type}] ${w.message}`));
    }

    if (!result.valid || (options.strict === true && result.warnings.length > 0)) {
      process.exit(1);
    }

  } catch (error) {
    logger.error(`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}
