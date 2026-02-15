#!/usr/bin/env node
/**
 * Vocareum Publisher CLI
 *
 * Main entry point for the CLI tool that publishes assignment content
 * from GitHub repositories to Vocareum.
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read version from package.json
function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return '1.0.0'; // Fallback
  }
}

const program = new Command();

program
  .name('vocareum-publish')
  .description('Sync assignment content between GitHub and Vocareum')
  .version(getVersion());

import { initCommand, InitOptions } from './commands/init';
import { newCommand } from './commands/new';
import { publishCommand, PublishCommandOptions } from './commands/publish';
import { pullCommand, PullOptions } from './commands/pull';
import { statusCommand, StatusCommandOptions } from './commands/status';
import { ValidateOptions } from './commands/validate';
import { FixOptions } from './commands/fix';
import { logger } from './utils/logger';

// Init command - initialize a new course repository
program
  .command('init')
  .description('Initialize a new course repository with vocareum.yaml configuration')
  .option('--import', 'Import existing course from Vocareum')
  .option('--course-id <id>', 'Course ID for import')
  .option('--force', 'Force overwrite if config exists')
  .addHelpText('after', `
Description:
  Creates a new vocareum.yaml configuration file for managing course assignments.
  This is typically the first command you run when setting up a new course repository.

  You will be prompted to enter:
    - Organization ID (your Vocareum org)
    - Course ID (the target course for publishing)
    - Template assignment(s) with names and source course IDs

Examples:
  $ vocareum-publish init              # Interactive setup
  $ vocareum-publish init --force      # Overwrite existing config
`)
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
  .command('new [path]')
  .description('Create a new assignment with folder structure and config entry')
  .addHelpText('after', `
Description:
  Creates a new assignment directory structure and adds an entry to vocareum.yaml.
  If multiple templates are configured, you will be prompted to select one.

  Creates the following structure:
    <path>/
      part1/
        startercode/    # Student-visible starter files
        scripts/        # Grading scripts
        docs/           # Documentation
        data/           # Datasets

  The assignment is added to vocareum.yaml with:
    - assignment_id: null (will be assigned on first publish)
    - create_from_template: true
    - template_assignment_id: <selected template>

Examples:
  $ vocareum-publish new lab1          # Create lab1/ with default structure
  $ vocareum-publish new               # Prompt for assignment name
`)
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
  .description('Validate vocareum.yaml configuration and local folder structure')
  .option('--strict', 'Treat warnings as errors (exit code 1)')
  .option('--vocareum', 'Also validate against Vocareum API (checks IDs exist)')
  .addHelpText('after', `
Description:
  Validates your configuration and folder structure before publishing.

  Checks performed:
    - vocareum.yaml syntax and required fields
    - Each assignment path exists on disk
    - Each part path exists under its assignment
    - Required directories exist (if specified)
    - No orphaned folders (folders without config entries)

  With --vocareum flag, also checks:
    - Course ID exists and is accessible
    - Assignment IDs exist in Vocareum
    - Part IDs match remote parts

Examples:
  $ vocareum-publish validate           # Local validation only
  $ vocareum-publish validate --strict  # Fail on warnings
  $ vocareum-publish validate --vocareum  # Include API validation
`)
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
  .description('Interactively detect and fix configuration or structure issues')
  .option('--non-interactive', 'Skip all prompts (report issues only)')
  .addHelpText('after', `
Description:
  Detects validation issues and offers interactive fixes for each one.

  Issues that can be fixed:
    - Orphaned folders: Folders on disk without vocareum.yaml entries
      → Add config entry, or ignore
    - Missing folders: Config entries pointing to non-existent paths
      → Create folder structure, or remove config entry
    - Missing directories: Required directories (startercode, scripts, etc.) not found
      → Create directory

  Use --non-interactive to see issues without being prompted for fixes.

Examples:
  $ vocareum-publish fix                  # Interactive mode
  $ vocareum-publish fix --non-interactive  # Report only, no changes
`)
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
  .description('Sync assignments from Vocareum: import orphans, detect drift, handle stale entries')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--non-interactive', 'Skip all prompts (no changes made)')
  .option('--verbose', 'Show detailed output including file lists')
  .addHelpText('after', `
Description:
  Scans for sync issues between your local config and Vocareum, then offers
  interactive options to resolve each one.

  Issue types detected:
    1. Orphaned assignments - Exist in Vocareum but not in your config
       → Import (download content + add to config)
       → Exclude (hide from future scans)
       → Skip (do nothing)

    2. Stale assignments - In your config but deleted from Vocareum
       → Reset ID (clear assignment_id, will recreate from template)
       → Remove (delete from config entirely)
       → Skip (do nothing)

    3. Settings drift - Local settings differ from Vocareum
       → Pull (update local config with Vocareum values)
       → Keep (keep local, will overwrite Vocareum on publish)
       → Skip (do nothing)

  This is useful when:
    - Onboarding an existing course to Git-based management
    - Assignments were created/modified directly in Vocareum UI
    - Another team member made changes

Examples:
  $ vocareum-publish pull               # Interactive sync
  $ vocareum-publish pull --verbose     # Show file details during import
  $ vocareum-publish pull --non-interactive  # Report issues only
`)
  .action(async (options: PullOptions) => {
    try {
      await pullCommand(options);
    } catch (error) {
      logger.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Status command (default action)
program
  .command('status', { isDefault: true })
  .description('Show current local sync status and last push details')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--verbose', 'Show assignment-by-assignment details')
  .addHelpText('after', `
Description:
  Shows the current local state without changing anything.

  Includes:
    - Config + target org/course
    - Assignment/part mapping progress
    - Last push timestamp, status, and commit
    - Git branch/commit/dirty state
    - Environment details (CI/local, API key presence)

Examples:
  $ vocareum-publish           # Default status view
  $ vocareum-publish status
  $ vocareum-publish status --verbose
`)
  .action(async (options: StatusCommandOptions) => {
    try {
      await statusCommand(options);
    } catch (error) {
      logger.error(`Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

// Push command
program
  .command('push')
  .description('Push assignment content to Vocareum')
  .option('--dry-run', 'Preview changes without executing')
  .option('--assignment <path>', 'Push specific assignment only')
  .option('--part <path>', 'Push specific part only (requires --assignment)')
  .option('--force-all', 'Re-upload all content (ignore change detection)')
  .option('--sync-deletes', 'Delete remote files not in local (experimental)')
  .option('--on-missing-id <mode>', 'When assignment_id is null: skip or abort', 'skip')
  .option('--abort-on-error', 'Stop immediately on first error')
  .option('--auto-commit', 'Auto-commit vocareum.yaml changes (local use only)')
  .option('--non-interactive', 'Skip confirmation prompts')
  .option('--verbose', 'Show detailed logging')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .addHelpText('after', `
Description:
  Pushes assignment content from your local repository to Vocareum.
  This uploads content but does NOT publish to students (that's a separate
  step in Vocareum).

  What happens during push:
    1. Analyzes changes since last push (using content hashes)
    2. Shows a preview of what will be created/updated
    3. Prompts for confirmation (unless --non-interactive)
    4. For new assignments: copies from template, maps parts
    5. Uploads changed content (startercode, scripts, docs, data, etc.)
    6. Updates assignment/part settings if changed
    7. Saves push history and new IDs to vocareum.yaml

  Content directories synced per part:
    - startercode/  → Starter files
    - scripts/      → Grading scripts
    - lib/          → Grading libraries
    - asnlib/       → Assignment libraries
    - docs/         → Documentation files
    - data/         → Datasets

Options explained:
  --dry-run         See what would happen without making changes
  --force-all       Bypass change detection, re-upload everything
  --sync-deletes    Remove files from Vocareum that aren't in Git (careful!)
  --auto-commit     Commit vocareum.yaml after push (local dev only)

Examples:
  $ vocareum-publish push               # Push all changed assignments
  $ vocareum-publish push --dry-run     # Preview without pushing
  $ vocareum-publish push --assignment lab1  # Push only lab1
  $ vocareum-publish push --force-all   # Re-upload everything
  $ vocareum-publish push --non-interactive  # CI/CD mode (no prompts)
`)
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
