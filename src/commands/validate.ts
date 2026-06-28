/**
 * Validate Command
 *
 * Validate configuration and file structure consistency.
 */

import { loadConfig } from '../core/config';
import { resolveWorkspaceContext } from '../core/workspace';
import { validateWorkspace } from '../core/services/validate-service';
import { LoggerEventSink } from '../utils/logger-event-sink';
import { InteractivePrompter } from '../core/services/context';
import { CommandFailureError } from '../utils/command-failure';

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

  const events = new LoggerEventSink();

  try {
    events.emit({ level: 'info', message: 'Validating configuration...' });
    const config = await loadConfig(configPath);
    events.emit({ level: 'success', message: 'Configuration is valid.' });

    const ctx = {
      persistedConfig: config,
      effectiveConfig: config,
      configPath,
      workspaceRoot,
      events,
      prompter: new InteractivePrompter(),
    };

    const report = await validateWorkspace(ctx);

    const hasErrors = report.errors.length > 0;
    const hasWarnings = report.warnings.length > 0;

    if (hasErrors || (options.strict === true && hasWarnings)) {
      throw new CommandFailureError('Validation failed', 1);
    }

  } catch (error) {
    if (error instanceof CommandFailureError) { throw error; }
    events.emit({ level: 'error', message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
    throw new CommandFailureError(`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 1);
  }
}
