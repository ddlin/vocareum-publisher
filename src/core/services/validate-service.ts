/**
 * Validate Service — offline local validation orchestration.
 *
 * `validateWorkspace` runs local file-structure validation only.
 * It MUST NOT import logger or build a VocareumClient (offline only).
 * Human-readable output is emitted via ctx.events.
 */

import { validateStructure } from '../validator';
import type { ValidateContext } from './context';

/**
 * Flat-string report returned by validateWorkspace.
 * Callers render these strings however they need (human output, tests, JSON).
 */
export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

/**
 * Run offline (local) workspace validation.
 *
 * Emits progress and result messages via ctx.events.
 * Returns a flat ValidationReport for the caller to act on (--strict, etc.).
 */
export async function validateWorkspace(ctx: ValidateContext): Promise<ValidationReport> {
  const { effectiveConfig, workspaceRoot, events } = ctx;

  events.emit({ level: 'info', message: 'Validating file structure...' });

  const result = await validateStructure(effectiveConfig, workspaceRoot, events);

  if (result.valid) {
    events.emit({ level: 'success', message: 'File structure is valid.' });
  } else {
    events.emit({ level: 'error', message: 'File structure validation failed:' });
  }

  const errors: string[] = result.errors.map(e => `[${e.type}] ${e.message}`);
  const warnings: string[] = result.warnings.map(w => `[${w.type}] ${w.message}`);

  for (const msg of errors) {
    events.emit({ level: 'error', message: msg });
  }

  for (const msg of warnings) {
    events.emit({ level: 'warn', message: msg });
  }

  return { errors, warnings };
}
