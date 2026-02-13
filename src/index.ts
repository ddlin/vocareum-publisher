#!/usr/bin/env node
/**
 * Vocareum Publisher CLI
 *
 * Main entry point for the CLI tool that publishes assignment content
 * from GitHub repositories to Vocareum.
 */

import { Command } from 'commander';

const program = new Command();

program
  .name('vocareum-publish')
  .description('Publish assignment content from GitHub to Vocareum')
  .version('1.0.0');

import { initCommand, InitOptions } from './commands/init';
import { newCommand } from './commands/new';
import { publishCommand, PublishCommandOptions } from './commands/publish';
import { pullCommand, PullOptions } from './commands/pull';
import { ValidateOptions } from './commands/validate';
import { FixOptions } from './commands/fix';
import { logger } from './utils/logger';

// Init command - initialize a new course repository
program
  .command('init')
  .description('Initialize a new course repository')
  .option('--import', 'Import existing course from Vocareum')
  .option('--course-id <id>', 'Course ID for import')
  .option('--force', 'Force overwrite if config exists')
  .action(async (options: InitOptions) => {
    try {
      await initCommand(options);
    } catch (error) {
      logger.error(`Init failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// New command - create new assignment structure
program
  .command('new <path>')
  .description('Create new assignment structure')
  .action(async (assignmentPath: string) => {
    try {
      await newCommand(assignmentPath);
    } catch (error) {
      logger.error(`New assignment failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

import { validateCommand } from './commands/validate';
import { fixCommand } from './commands/fix';

// Validate command
program
  .command('validate')
  .description('Validate configuration and structure')
  .option('--strict', 'Treat warnings as errors')
  .option('--vocareum', 'Also validate against Vocareum API')
  .action(async (options: ValidateOptions) => {
    try {
      await validateCommand(options);
    } catch (error) {
      logger.error(`Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Fix command
program
  .command('fix')
  .description('Interactively fix validation issues')
  .option('--non-interactive', 'Run without prompts')
  .action(async (options: FixOptions) => {
    try {
      await fixCommand(options);
    } catch (error) {
      logger.error(`Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Pull command - handle orphaned assignments
program
  .command('pull')
  .description('Import or exclude orphaned assignments from Vocareum')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--non-interactive', 'Skip all orphans without prompting')
  .option('--verbose', 'Show detailed output')
  .action(async (options: PullOptions) => {
    try {
      await pullCommand(options);
    } catch (error) {
      logger.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Publish command (default action)
program
  .command('publish', { isDefault: true })
  .description('Publish assignments to Vocareum')
  .option('--dry-run', 'Preview changes without executing')
  .option('--assignment <path>', 'Publish specific assignment only')
  .option('--part <path>', 'Publish specific part only')
  .option('--force-all', 'Re-upload everything (ignore change detection)')
  .option('--sync-deletes', 'Enable file deletion (experimental)')
  .option('--on-missing-id <mode>', 'Behavior when assignment_id is missing: skip|abort')
  .option('--abort-on-error', 'Stop publish immediately on first error')
  .option('--auto-commit', 'Auto-commit config updates (local use only)')
  .option('--non-interactive', 'Disable prompts')
  .option('--verbose', 'Enable verbose logging')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .action(async (options: PublishCommandOptions) => {
    try {
      await publishCommand(options);
    } catch (error) {
      // logger.error handled in publishCommand mostly, but top level catch safety
      logger.error(`Unhandled error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

program.parse();
