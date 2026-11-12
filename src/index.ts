#!/usr/bin/env node
/**
 * Vocareum Publisher CLI
 *
 * Main entry point for the CLI tool that publishes assignment content
 * from GitHub repositories to Vocareum.
 */

import { Command, CommanderError, Option } from 'commander';
import { CAPABILITIES, readBuildInfo } from './core/capabilities';
import { writeJsonDocument } from './core/report';
import { readFileSync, realpathSync } from 'fs';
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

// --version --json: intercepted before Commander handles --version itself.
// Routed through report.ts's writeJsonDocument so stdout keeps exactly one
// writer (the purity guard allows only that file).
if (process.argv.includes('--version') && process.argv.includes('--json')) {
  const info = readBuildInfo();
  writeJsonDocument({
    version: getVersion(),
    ...info,
    resolved_from: ((): string | null => {
      // realpath throws if argv[1] is missing or unreadable; the version query
      // must still answer.
      try { return realpathSync(process.argv[1] ?? ''); } catch { return null; }
    })(),
    capabilities: CAPABILITIES,
  });
  process.exit(0);
}

const program = new Command();

// Without this, Commander prints its own error and calls process.exit() before
// any of our handling runs: an unknown flag exited 1 with empty stdout, so
// `--json` callers got nothing and the documented usage code (2) was
// unreachable for the most common malformed invocation there is.
program.exitOverride();

// `status` is registered { isDefault: true }, so Commander routes an
// unrecognised first argument INTO status as a positional rather than
// rejecting it. `vocgit bogus` therefore printed a status page and exited 0 --
// and `vocgit pus --json` (a typo for push) made automation report success
// while pushing nothing. Silent success on a typo is the exact failure this
// whole feature exists to eliminate.
//
// Checked here rather than by dropping isDefault, so bare `vocgit` still shows
// status. Only a non-flag first argument that is not a known command is
// rejected.
// `help` is Commander's built-in command (`vocgit help push`): not registered
// with .command(), but listed by `vocgit --help`, so it must pass the guard.
const KNOWN_COMMANDS = new Set(['init', 'new', 'validate', 'fix', 'pull', 'status', 'push', 'help']);
const firstArg = process.argv[2];
if (firstArg !== undefined && !firstArg.startsWith('-') && !KNOWN_COMMANDS.has(firstArg)) {
  const message = `unknown command '${firstArg}'`;
  if (process.argv.includes('--json')) {
    writeJsonDocument({
      schema_version: '1.0',
      // null, not 'status': no command ran, and naming one would tell an agent
      // that `status` failed when the typo was for `push`.
      command: null,
      result: 'failed',
      generated_at: new Date().toISOString(),
      retryable: false,
      payload: { payload_schema_version: 1 },
      diagnostics: [],
      error: { code: 'usage', message, retryable: false },
    });
  } else {
    // process.stderr directly, not logger: this guard runs at module top level,
    // before the logger import below has initialized, and using it here crashed
    // the CLI with "Cannot access 'logger_1' before initialization" for every
    // unknown argument. stderr is not the guarded channel -- only stdout is --
    // so writing to it here is legitimate as well as safe.
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(2);
}

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
  .addOption(new Option('--region <region>', 'Vocareum tenant: na (api.vocareum.com, default) or eu (api.eu.vocareum.com)').choices(['na', 'eu']))
  .option('--api-base-url <url>', 'Explicit v2 API host to write as api_base_url (must be a known Vocareum host)')
  .addHelpText('after', `
Description:
  Creates a new vocareum.yaml configuration file for managing course assignments.
  This is typically the first command you run when setting up a new course repository.

  You will be prompted to enter:
    - Region (NA or EU tenant) — skipped when --region, --api-base-url,
      or VOCAREUM_API_BASE_URL is set
    - Organization ID (your Vocareum org)
    - Course ID (the target course for publishing)
    - Template assignment(s) with names and source course IDs

  The region sets vocareum.api_base_url in vocareum.yaml: the host that
  pull and push send your API key to.
    na  https://api.vocareum.com      (default)
    eu  https://api.eu.vocareum.com
  Both are allowlisted; no VOCAREUM_ALLOW_CUSTOM_BASE_URL override is needed.

Examples:
  $ vocgit init              # Interactive setup (prompts for region, NA default)
  $ vocgit init --region eu  # EU tenant
  $ vocgit init --force      # Overwrite existing config
`)
  .action(async (options: InitOptions) => {
    try {
      await initCommand(options);
    } catch (error) {
      if (error instanceof CommandFailureError) { throw error; }
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
      if (error instanceof CommandFailureError) { throw error; }
      const msg = `New assignment failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      logger.error(msg);
      throw new CommandFailureError(msg);
    }
  });

import { validateCommand } from './commands/validate';
import { fixCommand } from './commands/fix';
import { runCommandWithFailureClassification } from './utils/command-runner';


// Validate command
program
  .command('validate')
  .description('Validate vocareum.yaml configuration and local folder structure')
  .option('--json', 'Emit a machine-readable report on stdout')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)')
  .option('--strict', 'Treat warnings as errors (exit code 5: findings outstanding)')
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
    await runCommandWithFailureClassification('validate', options, (collector) => validateCommand({ ...options, eventCollector: collector }), 'Validation failed');
  });

// Fix command
program
  .command('fix')
  .description('Interactively detect and fix configuration or structure issues')
  .option('--json', 'Emit a machine-readable report on stdout')
  .option('--config <path>', 'Path to vocareum.yaml', 'vocareum.yaml')
  .option('--root <path>', 'Workspace root that assignment paths resolve against (required when --config is not directly inside the current directory)')
  .option('--non-interactive', 'Apply every fix without prompting (this WRITES)')
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

  Use --non-interactive to apply every fix without being prompted. It writes;
  there is no dry-run mode.

Examples:
  $ vocgit fix                  # Interactive mode
  $ vocgit fix --non-interactive  # Apply all fixes without prompting
`)
  .action(async (options: FixOptions) => {
    await runCommandWithFailureClassification('fix', options, (collector) => fixCommand({ ...options, eventCollector: collector }), 'Fix failed');
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
  .option('--json', 'Emit a machine-readable report on stdout (implies --non-interactive)')
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

  API host:
    Token auth uses vocareum.api_base_url from vocareum.yaml (written by
    vocgit init; NA https://api.vocareum.com or EU https://api.eu.vocareum.com).
    Override per run with --api-base-url or VOCAREUM_API_BASE_URL
    (precedence: flag > env > vocareum.yaml > NA default).

  Exit status:
    1 when the pull is incomplete: an import could not download some files
    (it is still saved, marked INCOMPLETE, and counted under "Not downloaded"),
    an import failed outright ("Import failed"), or --content could not finish
    the drift check for an assignment.

  Incomplete imports:
    Push refuses directories an incomplete pull left behind (uploading them
    would delete the missing files on Vocareum). Complete them with
      vocgit pull --batch --content --assignment <name>
    Raise the 5,000-file download cap with VOCAREUM_MAX_DOWNLOAD_FILES.
    A failed import was not saved: re-run vocgit pull --batch.

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
    await runCommandWithFailureClassification('pull', options, (collector) => pullCommand({ ...options, eventCollector: collector }), 'Pull failed');
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
    - Directories an incomplete pull left blocked from push, if any
    - API host and region (NA/EU) that pull/push will target, and where
      it came from (VOCAREUM_API_BASE_URL or vocareum.yaml)

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
    await runCommandWithFailureClassification('status', options, (collector) => statusCommand({ ...options, eventCollector: collector }), 'Status failed', 2);
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
  .option('--json', 'Emit a machine-readable report on stdout (implies --non-interactive)')
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

  Push never uploads a directory that a pull left incomplete (marked
  incomplete-pull in publish_history): uploading clears the directory on
  Vocareum first, which would delete the files the pull missed. It is reported
  as failed until \`vocgit pull --batch --content --assignment <name>\` completes it.
  --api-base-url    v2 API host for this run, e.g. https://api.eu.vocareum.com
                    (precedence: flag > VOCAREUM_API_BASE_URL > vocareum.yaml
                    api_base_url > NA default). Run "vocgit status" to see
                    which tenant (NA/EU) a push will target.

Examples:
  $ vocgit push               # Push all changed assignments
  $ vocgit push --dry-run     # Preview without pushing
  $ vocgit push --assignment lab1  # Push only lab1
  $ vocgit push --force-all   # Re-upload everything
  $ vocgit push --non-interactive  # CI/CD mode (no prompts)
`)
  .action(async (options: PublishCommandOptions) => {
    await runCommandWithFailureClassification('push', options, (collector) => publishCommand({ ...options, eventCollector: collector }), 'Push failed');
  });

/** The five commands that emit an envelope; used to label a pre-dispatch usage error. */
const JSON_COMMANDS = new Set(['pull', 'push', 'status', 'validate', 'fix']);

/**
 * The failure document for an invocation that never reached a command. `command`
 * names the intended command when argv shows one, and is null otherwise: an
 * agent that asked for --json gets a document either way, never empty stdout,
 * and never a document that names a command that did not run.
 */
function writeUsageEnvelope(message: string): void {
  const requested = process.argv.slice(2).find((a) => JSON_COMMANDS.has(a)) ?? null;
  writeJsonDocument({
    schema_version: '1.0',
    command: requested,
    result: 'failed',
    generated_at: new Date().toISOString(),
    retryable: false,
    payload: { payload_schema_version: 1 },
    diagnostics: [],
    error: { code: 'usage', message, retryable: false },
  });
}

/**
 * `vocgit status --config --json`: Commander takes `--json` as the VALUE of
 * --config, so the command runs without JSON mode and a failure writes no
 * document. Reject it as a usage error before parsing.
 */
function jsonSwallowedByOption(): string | undefined {
  const valueFlags = new Set<string>();
  for (const cmd of [program, ...program.commands]) {
    for (const opt of cmd.options) {
      if (opt.required || opt.optional) {
        if (opt.long !== undefined) { valueFlags.add(opt.long); }
        if (opt.short !== undefined) { valueFlags.add(opt.short); }
      }
    }
  }
  const argv = process.argv.slice(2);
  const i = argv.findIndex((a, idx) => a === '--json' && idx > 0 && valueFlags.has(argv[idx - 1]));
  return i === -1 ? undefined : argv[i - 1];
}

const swallowedBy = jsonSwallowedByOption();
if (swallowedBy !== undefined) {
  const message = `option '${swallowedBy}' needs a value; '--json' was taken as its value`;
  writeUsageEnvelope(message);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
} else program.parseAsync().catch((error) => {
  if (error instanceof CommandFailureError) {
    process.exitCode = error.exitCode;   // command already rendered its error
    return;
  }

  // Commander throws for --help and --version too; those are successful exits
  // and must not be dressed up as failures.
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) { process.exitCode = 0; return; }

    // A malformed invocation is a usage error (exit 2), not an internal one.
    // Emit an envelope when --json was asked for AND the intended command is
    // identifiable from argv -- the envelope's `command` field is a closed set,
    // so an invocation with no recognisable command gets the exit code without
    // a document rather than a document with an invented command.
    if (process.argv.includes('--json')) {
      writeUsageEnvelope(error.message);
    }
    process.exitCode = 2;
    return;
  }

  logger.error(error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
