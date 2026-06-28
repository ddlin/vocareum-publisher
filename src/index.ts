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
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '1.0.0'; // Fallback
  }
}

const program = new Command();

program
  .name('vocgit')
  .description('Sync assignment content between GitHub and Vocareum')
  .version(getVersion());

import { addAuthOptions } from './api/auth/cli-auth-options';
import { initCommand, InitOptions } from './commands/init';
import { newCommand } from './commands/new';
import { publishCommand, PublishCommandOptions } from './commands/publish';
import { pullCommand, PullOptions } from './commands/pull';
import { statusCommand, StatusCommandOptions } from './commands/status';
import { ValidateOptions } from './commands/validate';
import { FixOptions } from './commands/fix';
import { logger } from './utils/logger';
import { CommandFailureError } from './utils/command-failure';

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
  $ vocgit init              # Interactive setup
  $ vocgit init --force      # Overwrite existing config
`)
  .action(async (options: InitOptions) => {
    try {
      await initCommand(options);
    } catch (error) {
      const msg = `Init failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
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
  $ vocgit new lab1          # Create lab1/ with default structure
  $ vocgit new               # Prompt for assignment name
`)
  .action(async (assignmentPath: string) => {
    try {
      await newCommand(assignmentPath);
    } catch (error) {
      const msg = `New assignment failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

import { validateCommand } from './commands/validate';
import { fixCommand } from './commands/fix';

// Validate command
program
  .command('validate')
  .description('Validate vocareum.yaml configuration and local folder structure')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)')
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
  $ vocgit validate           # Local validation only
  $ vocgit validate --strict  # Fail on warnings
  $ vocgit validate --vocareum  # Include API validation
`)
  .action(async (options: ValidateOptions) => {
    try {
      await validateCommand(options);
    } catch (error) {
      const msg = `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

// Fix command
program
  .command('fix')
  .description('Interactively detect and fix configuration or structure issues')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)')
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
  $ vocgit fix                  # Interactive mode
  $ vocgit fix --non-interactive  # Report only, no changes
`)
  .action(async (options: FixOptions) => {
    try {
      await fixCommand(options);
    } catch (error) {
      const msg = `Fix failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

const collectFlag = (value: string, acc: string[]): string[] => { acc.push(value); return acc; };

// Pull command - handle orphaned assignments
const pullCmd = program
  .command('pull')
  .description('Sync assignments from Vocareum: import orphans, detect drift, handle stale entries')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)')
  .option('--non-interactive', 'Skip all prompts (no changes made)')
  .option('--batch', 'Apply sensible defaults without prompting (import orphans, pull drift, skip stale)')
  .option('--skip-content', 'Reuse existing local content for orphan imports instead of re-downloading (recovers from failed pulls)')
  .option('--content', 'Detect content drift (downloads remote files to diff them; off by default)')
  .option('--assignment <name|id>', 'Limit --content drift to assignment(s); repeatable', collectFlag, [])
  .option('--part <part_id>', 'Limit --content drift to part(s) by part_id; requires exactly one --assignment', collectFlag, [])
  .option('--verbose', 'Show detailed output including file lists');
addAuthOptions(pullCmd);
pullCmd
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

    4. Content drift - Files in Vocareum differ from your local files
       Opt-in via --content (off by default; downloads remote files to diff).
       Scope with --assignment <name|id> (repeatable) and --part <part_id>
       (requires exactly one --assignment).

  Modes:
    --batch           Import orphans, pull settings drift, skip stale. No
                      prompts. Add --content to also pull content drift.
                      Ideal for bulk onboarding or CI sync.
    --non-interactive  Report issues only, make no changes.

  This is useful when:
    - Onboarding an existing course to Git-based management
    - Assignments were created/modified directly in Vocareum UI
    - Another team member made changes

Examples:
  $ vocgit pull               # Interactive sync (no content drift check)
  $ vocgit pull --batch       # Import orphans, pull settings drift, no prompts
  $ vocgit pull --verbose     # Show file details during import
  $ vocgit pull --non-interactive  # Report issues only
  $ vocgit pull --batch --skip-content  # Retry after failed pull; reuse existing local files
  $ vocgit pull --content     # also check content drift (downloads remote files)
  $ vocgit pull --batch --content   # batch sync including content drift
  $ vocgit pull --content --assignment lab1        # scope content drift to lab1
  $ vocgit pull --content --assignment lab1 --part <part_id>   # scope to one part
`)
  .action(async (options: PullOptions) => {
    try {
      await pullCommand(options);
    } catch (error) {
      const msg = `Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

// Status command (default action)
program
  .command('status', { isDefault: true })
  .description('Show current local sync status and last push details')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)')
  .option('--verbose', 'Show assignment-by-assignment details')
  .option('--json', 'Emit a machine-readable JSON report (for tooling, e.g. the VS Code extension)')
  .addHelpText('after', `
Description:
  Shows the current local state without changing anything.

  Includes:
    - Config + target org/course
    - Assignment/part mapping progress
    - Last push timestamp, status, and commit
    - Git branch/commit/dirty state
    - Environment details (CI/local, API key presence)

  With --json, prints a versioned JSON document on stdout including
  per-assignment/part/directory CONTENT sync status, computed with the
  same content change detection vocgit push uses. Offline — no API
  calls — so settings drift is not included: a "synced" assignment may
  still receive settings updates on push.

Examples:
  $ vocgit           # Default status view
  $ vocgit status
  $ vocgit status --verbose
  $ vocgit status --json
`)
  .action(async (options: StatusCommandOptions) => {
    try {
      await statusCommand(options);
    } catch (error) {
      const msg = `Status failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

// Push command
const pushCmd = program
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
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)');
addAuthOptions(pushCmd);
pushCmd
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
  $ vocgit push               # Push all changed assignments
  $ vocgit push --dry-run     # Preview without pushing
  $ vocgit push --assignment lab1  # Push only lab1
  $ vocgit push --force-all   # Re-upload everything
  $ vocgit push --non-interactive  # CI/CD mode (no prompts)
`)
  .action(async (options: PublishCommandOptions) => {
    try {
      await publishCommand(options);
    } catch (error) {
      // logger.error handled in publishCommand mostly, but top level catch safety
      const msg = `Unhandled error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

program.parseAsync().catch((error) => {
  if (error instanceof CommandFailureError) {
    process.exitCode = error.exitCode;   // command already rendered its error
  } else {
    logger.error(error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  }
});
