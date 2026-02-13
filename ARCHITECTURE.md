# Technical Architecture Document: Vocareum Publisher

**Version:** 1.1
**Date:** February 13, 2026
**Status:** Implementation Complete

### Part API Response Structure

Based on Vocareum API documentation, parts list returns:

```typescript
interface VocareumPartResponse {
  id: string;                    // Part ID
  courseid: string;
  assignmentid: string;
  name: string;
  seqnum: string;                // Sequence number as string: "0", "1", "2"
  deleted: string;               // "0" or "1"
  part_url: string;
  cloud_labs: boolean;
  instant_aws_access: boolean;
  session_length: string;
  monthly_dollar: string;
  monthly_time: string;
  total_time: string;
  total_dollar: string;
}

interface PartsListResponse {
  status: "success";
  parts: VocareumPartResponse[];
  total_records: number;
}
```

**Key Points:**
- `seqnum` is a string, not a number (must parse for sorting)
- `deleted: "0"` means active, `"1"` means deleted (filter these out)
- Parts should be sorted by `parseInt(seqnum)` for correct ordering

---

### 7. New Command Module (`commands/new.ts`)

**Purpose:** Create new assignment structure with folders and YAML entry.

**Key Responsibilities:**
- Interactive prompts for assignment details
- Create directory structure
- Generate YAML entry
- Provide next steps guidance

**Public API:**
```typescript
export interface NewAssignmentOptions {
  path: string; // Assignment folder name (user-specified)
  name?: string; // Assignment display name
  numParts?: number;
  partNames?: string[];
  directories?: DirectoryType[]; // Which dirs to create per part
  interactive?: boolean;
}

export async function createNewAssignment(
  options: NewAssignmentOptions,
  configPath: string
): Promise<void>
```

**Implementation:**
```typescript
async function createNewAssignment(
  options: NewAssignmentOptions,
  configPath: string
): Promise<void> {
  const config = await loadConfig(configPath);
  
  // Interactive prompts if not provided
  if (options.interactive) {
    options.name = await prompt('Assignment name:');
    options.numParts = await promptNumber('Number of parts:', 1);
    
    options.partNames = [];
    for (let i = 0; i < options.numParts; i++) {
      const partName = await prompt(`Part ${i + 1} name:`, `Part ${i + 1}`);
      options.partNames.push(partName);
    }
    
    const createAllDirs = await promptConfirm(
      'Create all directories (startercode, scripts, docs, data)?',
      true
    );
    
    if (!createAllDirs) {
      options.directories = await promptMultiSelect(
        'Select directories to create:',
        ['startercode', 'scripts', 'docs', 'data']
      );
    }
  }
  
  // Create directory structure
  const assignmentPath = path.join(process.cwd(), options.path);
  
  for (let i = 0; i < options.numParts; i++) {
    const partPath = path.join(assignmentPath, `part${i + 1}`);
    
    const dirs = options.directories || ['startercode', 'scripts', 'docs', 'data'];
    for (const dir of dirs) {
      await fs.mkdir(path.join(partPath, dir), { recursive: true });
      // Create .gitkeep to ensure empty dirs are tracked
      await fs.writeFile(path.join(partPath, dir, '.gitkeep'), '');
    }
  }
  
  // Add to config
  const newAssignment: Assignment = {
    assignment_id: null,
    name: options.name || options.path,
    path: options.path,
    create_from_template: true,
    parts: Array.from({ length: options.numParts }, (_, i) => ({
      part_id: null,
      path: `part${i + 1}`,
      name: options.partNames?.[i] || `Part ${i + 1}`,
      directories: options.directories
    }))
  };
  
  config.assignments.push(newAssignment);
  await updateConfig(configPath, config);
  
  logger.success(`Created assignment structure at ${options.path}/`);
  logger.success(`Added entry to vocareum.yaml`);
  logger.info('\nNext steps:');
  logger.info(`1. Add content to ${options.path}/part1/startercode/ etc.`);
  logger.info('2. Run: vocareum-publish validate');
  logger.info('3. Run: vocareum-publish (creates in Vocareum)');
  logger.info('4. Commit updated vocareum.yaml with new IDs');
}
```

---

### 8. Fix Command Module (`commands/fix.ts`)

**Purpose:** Interactively resolve validation issues.

**Key Responsibilities:**
- Detect validation issues
- Prompt user for resolution strategy
- Generate missing YAML entries or folders
- Update configuration

**Public API:**
```typescript
export interface FixOptions {
  nonInteractive?: boolean;
  generateYaml?: boolean; // Auto-generate YAML for orphaned folders
  createFolders?: boolean; // Auto-create folders for YAML entries
}

export async function fixValidationIssues(
  config: Config,
  validationResult: ValidationResult,
  options: FixOptions
): Promise<void>
```

**Implementation:**
```typescript
async function fixValidationIssues(
  config: Config,
  validationResult: ValidationResult,
  options: FixOptions
): Promise<void> {
  const fixes: Fix[] = [];
  
  // Handle orphaned folders
  for (const warning of validationResult.warnings) {
    if (warning.type === 'orphaned_folder') {
      const action = options.nonInteractive
        ? 'skip'
        : await promptChoice(
            `Folder "${warning.path}/" has no YAML entry. Action?`,
            ['Add YAML entry', 'Ignore', 'Skip']
          );
      
      if (action === 'Add YAML entry') {
        const name = await prompt('Assignment name:', warning.path);
        const numParts = await promptNumber('Number of parts:', 1);
        
        // Generate YAML entry
        fixes.push({
          type: 'add_yaml',
          path: warning.path,
          assignment: { name, numParts }
        });
      }
    }
  }
  
  // Handle missing folders
  for (const error of validationResult.errors) {
    if (error.type === 'missing_folder') {
      const action = options.nonInteractive
        ? 'skip'
        : await promptChoice(
            `${error.message}. Action?`,
            ['Create folder', 'Remove YAML entry', 'Skip']
          );
      
      if (action === 'Create folder') {
        fixes.push({
          type: 'create_folder',
          path: error.path
        });
      } else if (action === 'Remove YAML entry') {
        fixes.push({
          type: 'remove_yaml',
          path: error.path
        });
      }
    }
  }
  
  // Apply fixes
  await applyFixes(config, fixes);
  
  logger.success(`\nApplied ${fixes.length} fixes.`);
  logger.info('Run vocareum-publish validate to verify.');
}
```

---

### 9. Pull Command Module (`commands/pull.ts`)

**Purpose:** Manage assignment sync issues between local config and Vocareum.

**Key Responsibilities:**
- Scan for orphaned assignments (exist in Vocareum but not in config)
- Scan for stale assignments (exist in config but deleted from Vocareum)
- Interactive prompts to handle each issue
- Download assignment content and create local directory structure
- Add imported assignments to config
- Add excluded assignment IDs to `excluded_assignments` list
- Reset or remove stale assignments from config

**Public API:**
```typescript
export interface PullOptions {
  config?: string;
  nonInteractive?: boolean;
  verbose?: boolean;
}

export async function pullCommand(options: PullOptions): Promise<void>

// Utility functions (exported for testing)
export function slugify(name: string): string
export async function getUniqueDirectoryName(basePath: string, desiredName: string): Promise<string>
```

**Implementation:**
```typescript
async function pullCommand(options: PullOptions): Promise<void> {
  const config = await loadConfig(options.config ?? 'vocareum.yaml');
  const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

  // Run reconciliation to find orphans
  const plan = await reconcile(config, client);

  if (plan.orphanedInVocareum.length === 0) {
    logger.success('No orphaned assignments found.');
    return;
  }

  const newAssignments: Assignment[] = [];
  const newExclusions: string[] = [];

  for (const orphan of plan.orphanedInVocareum) {
    if (options.nonInteractive) {
      // Skip in non-interactive mode
      continue;
    }

    const choice = await promptChoice('What would you like to do?', [
      'Import to local repository',
      'Exclude (hide from future scans)',
      'Skip (do nothing)',
    ]);

    if (choice === 'Import to local repository') {
      const defaultSlug = slugify(orphan.name);
      const dirName = await prompt('Local directory name:', defaultSlug);
      const uniqueDirName = await getUniqueDirectoryName('.', dirName);

      const assignment = await importAssignment(client, config.vocareum.course_id, orphan, uniqueDirName);
      newAssignments.push(assignment);
    } else if (choice === 'Exclude (hide from future scans)') {
      newExclusions.push(orphan.id);
    }
  }

  // Update config with new assignments and exclusions
  await updateConfig(options.config ?? 'vocareum.yaml', {
    assignments: newAssignments,
    excluded_assignments: newExclusions,
  });
}

async function importAssignment(
  client: VocareumClient,
  courseId: string,
  orphan: OrphanedEntity,
  localPath: string
): Promise<Assignment> {
  // Get parts for this assignment
  const parts = await listParts(client, courseId, orphan.id);
  const configParts: Part[] = [];

  for (const part of parts) {
    // Download content
    const files = await downloadContent(client, courseId, orphan.id, part.id);

    // Write files to local directory
    await writeFilesToDirectory(localPath, part.path, files);

    configParts.push({
      part_id: part.id,
      path: part.path,
      name: part.name,
      directories: detectDirectories(files),
      settings: {},
    });
  }

  return {
    assignment_id: orphan.id,
    name: orphan.name,
    path: localPath,
    create_from_template: false,
    settings: {},
    parts: configParts,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-');
}

async function getUniqueDirectoryName(basePath: string, desiredName: string): Promise<string> {
  let name = desiredName;
  let suffix = 1;

  while (await pathExists(path.join(basePath, name))) {
    suffix++;
    name = `${desiredName}-${suffix}`;
  }

  return name;
}
```

**Orphan and Stale Detection:**

The reconciler tracks both orphans and stale assignments:

```typescript
// Orphans: in Vocareum but not in config (filtered by excluded_assignments)
const excludedAssignments = new Set(config.vocareum.excluded_assignments ?? []);
for (const [id, assignment] of remoteAssignmentMap) {
  if (!excludedAssignments.has(id)) {
    orphanedInVocareum.push({
      type: 'assignment',
      id,
      name: assignment.name,
      message: 'Exists in Vocareum but not in local configuration'
    });
  }
}

// Stale: in config with ID but deleted from Vocareum
if (configAssignment.assignment_id && !remoteAssignmentMap.has(configAssignment.assignment_id)) {
  staleInConfig.push({
    assignment_id: configAssignment.assignment_id,
    name: configAssignment.name,
    path: configAssignment.path,
  });
}
```

**Stale Assignment Actions:**
- **Reset ID**: Clear `assignment_id` and set `create_from_template: true`
- **Remove**: Delete assignment from config entirely
- **Exclude**: Add to `excluded_assignments` to skip during sync

---

## Overview

This document describes the technical architecture for the Vocareum Publisher tool, including system design, module structure, API interactions, data flows, and implementation considerations.

---

## Architecture Principles

1. **Modularity:** Clear separation of concerns with well-defined module boundaries
2. **Testability:** All core logic unit-testable; integration tests for API interactions
3. **Extensibility:** Plugin architecture for future enhancements
4. **Error Resilience:** Graceful error handling with clear user feedback
5. **Idempotency:** Safe to re-run operations without side effects
6. **Security:** Never log credentials; validate all user input
7. **Performance:** Parallel uploads where appropriate; efficient file handling

---

## Technology Stack

### Core Technologies
- **Language:** TypeScript 5.3+
- **Runtime:** Node.js 18+ (LTS)
- **Build Tool:** TypeScript compiler (tsc)
- **Package Manager:** npm
- **CLI Framework:** Commander.js
- **HTTP Client:** Axios
- **Schema Validation:** Zod

### Key Dependencies

```json
{
  "dependencies": {
    "axios": "^1.6.0",           // HTTP client with retry support
    "chalk": "^5.3.0",           // Terminal colors and styling
    "commander": "^11.1.0",      // CLI framework
    "cosmiconfig": "^9.0.0",     // Config file loading
    "inquirer": "^9.2.0",        // Interactive prompts
    "js-yaml": "^4.1.0",         // YAML parsing/serialization
    "ora": "^7.0.0",             // Spinners and progress indicators
    "simple-git": "^3.21.0",     // Git operations
    "zod": "^3.22.0"             // Runtime type checking
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/inquirer": "^9.0.7",
    "@types/js-yaml": "^4.0.9",
    "typescript": "^5.3.0",
    "tsx": "^4.7.0",             // TS execution for development
    "vitest": "^1.0.0",          // Testing framework
    "@typescript-eslint/eslint-plugin": "^6.15.0",
    "@typescript-eslint/parser": "^6.15.0",
    "eslint": "^8.56.0",
    "prettier": "^3.1.0"
  }
}
```

---

## Project Structure

```
vocareum-publisher/
├── src/
│   ├── index.ts                    # CLI entry point
│   │
│   ├── commands/                   # Command implementations
│   │   ├── init.ts                # Init command (fresh + import)
│   │   ├── publish.ts             # Main publish command
│   │   ├── pull.ts                # Pull orphaned assignments from Vocareum
│   │   ├── validate.ts            # Validate config/structure
│   │   └── inspect.ts             # Inspect template/course
│   │
│   ├── core/                       # Core business logic
│   │   ├── config.ts              # Config parsing and validation
│   │   ├── reconciler.ts          # State reconciliation
│   │   ├── publisher.ts           # Publish orchestration
│   │   ├── uploader.ts            # Content upload logic
│   │   └── mapper.ts              # Part mapping logic
│   │
│   ├── api/                        # Vocareum API client
│   │   ├── client.ts              # Base HTTP client
│   │   ├── courses.ts             # Course operations
│   │   ├── assignments.ts         # Assignment operations
│   │   ├── parts.ts               # Part operations
│   │   └── content.ts             # Content upload/download
│   │
│   ├── utils/                      # Utility functions
│   │   ├── logger.ts              # Logging and output
│   │   ├── git.ts                 # Git operations
│   │   ├── files.ts               # File system utilities
│   │   ├── prompts.ts             # Interactive prompts
│   │   └── validation.ts          # Schema validation helpers
│   │
│   └── types/                      # TypeScript type definitions
│       ├── config.ts              # Config schema types
│       ├── api.ts                 # API request/response types
│       └── state.ts               # Internal state types
│
├── action/                         # GitHub Action wrapper
│   ├── action.yml                 # Action metadata
│   └── index.ts                   # Action entry point
│
├── test/                           # Test suites
│   ├── unit/                      # Unit tests
│   ├── integration/               # Integration tests
│   └── fixtures/                  # Test data
│
├── docs/                           # Documentation
│   ├── getting-started.md
│   ├── configuration.md
│   ├── api-reference.md
│   └── troubleshooting.md
│
├── examples/                       # Example repositories
│   └── sample-course/
│       ├── vocareum.yaml
│       └── assignment1/
│
├── package.json
├── tsconfig.json
├── .eslintrc.js
├── .prettierrc
├── LICENSE
└── README.md
```

---

## Core Modules

### 0. Validator Module (`core/validator.ts`)

**Purpose:** Validate configuration and file structure consistency.

**Key Responsibilities:**
- Validate YAML structure matches filesystem
- Check for orphaned folders and missing YAML entries
- Verify required directories exist (if specified)
- Generate validation reports with errors and warnings

**Public API:**
```typescript
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  type: 'missing_folder' | 'missing_yaml_entry' | 'invalid_structure' | 
        'missing_course' | 'invalid_id';
  path: string;
  message: string;
  fix?: string; // Suggestion for fixing
}

export interface ValidationWarning {
  type: 'orphaned_folder' | 'orphaned_assignment' | 'optional_dir_missing';
  path: string;
  message: string;
}

export async function validateStructure(
  config: Config,
  basePath: string
): Promise<ValidationResult>

export async function validateWithVocareum(
  config: Config,
  client: VocareumClient
): Promise<ValidationResult>

export function displayValidationResult(result: ValidationResult): void
```

**Validation Logic:**
```typescript
async function validateStructure(
  config: Config,
  basePath: string
): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: []
  };
  
  // 1. Check each YAML assignment has corresponding folder
  for (const assignment of config.assignments) {
    const assignmentPath = path.join(basePath, assignment.path);
    if (!await fs.exists(assignmentPath)) {
      result.errors.push({
        type: 'missing_folder',
        path: assignment.path,
        message: `Assignment "${assignment.name}" references path "${assignment.path}" which doesn't exist`,
        fix: `Run: vocareum-publish new ${assignment.path}`
      });
      result.valid = false;
    }
    
    // Check each part folder
    for (const part of assignment.parts) {
      const partPath = path.join(assignmentPath, part.path);
      if (!await fs.exists(partPath)) {
        result.errors.push({
          type: 'missing_folder',
          path: `${assignment.path}/${part.path}`,
          message: `Part "${part.name || part.path}" folder not found`,
          fix: `Create directory: ${assignment.path}/${part.path}/`
        });
        result.valid = false;
      }
      
      // Check required directories (if specified)
      if (part.directories) {
        for (const dir of part.directories) {
          const dirPath = path.join(partPath, dir);
          if (!await fs.exists(dirPath)) {
            result.errors.push({
              type: 'invalid_structure',
              path: `${assignment.path}/${part.path}/${dir}`,
              message: `Required directory "${dir}" not found`,
              fix: `Create directory: mkdir -p ${assignment.path}/${part.path}/${dir}`
            });
            result.valid = false;
          }
        }
      }
    }
  }
  
  // 2. Check for orphaned folders (folders without YAML entries)
  const assignmentFolders = await getDirectories(basePath);
  const configPaths = new Set(config.assignments.map(a => a.path));
  
  for (const folder of assignmentFolders) {
    if (!configPaths.has(folder)) {
      result.warnings.push({
        type: 'orphaned_folder',
        path: folder,
        message: `Folder "${folder}/" has no entry in vocareum.yaml (will be ignored)`,
      });
    }
  }
  
  return result;
}
```

---

### 1. Config Module (`core/config.ts`)

**Purpose:** Parse, validate, and manage vocareum.yaml configuration files.

**Key Responsibilities:**
- Load and parse YAML configuration
- Validate against schema using Zod
- Handle config version migrations
- Update config with new entity IDs
- Apply default values

**Public API:**
```typescript
export interface Config {
  version: string;
  vocareum: VocareumConfig;
  assignments: Assignment[];
  publish_options?: PublishOptions;
  publish_history?: PublishHistory[];
}

export async function loadConfig(path: string): Promise<Config>
export function validateConfig(config: Config): ValidationResult
export function migrateConfig(config: any, fromVersion: string): Config
export async function updateConfig(
  path: string, 
  updates: ConfigUpdates
): Promise<void>
```

**Type Definitions:**
```typescript
interface VocareumConfig {
  org_id: string;
  course_id: string;
  template_assignment_id: string;
  api_base_url?: string;
  excluded_assignments?: string[];  // Assignment IDs to hide from orphan detection
  course_settings?: {
    name?: string;
    description?: string;
  };
}

interface AssignmentSettings {
  description?: string;
  nosubmit?: boolean;           // Disable student submissions
  publish?: boolean;            // Publish to students
  publish_grades?: string;      // Grades publishing setting
  auto_submit?: boolean;        // Enable automatic submission
  grading_on_submit?: boolean;  // Grade immediately on submit
  noworkarea?: boolean;         // Disable work area
  exam_mode?: 'timed' | 'scheduled' | 'timed_scheduled';
  exam_duration?: number;       // Exam duration in minutes
  num_attempts?: number;        // Number of attempts allowed
  show_end_exam_button?: boolean;
  copy_startercode?: boolean;   // Copy starter code on start
  uncompressupload?: boolean;   // Uncompress uploaded files
  lti_on?: boolean;             // Enable LTI integration
  anonymous_grading?: boolean;  // Enable anonymous grading
  grading_visibility?: 'all' | 'assigned';
  send_webhook?: boolean;       // Send webhook on events
  live_code_comments?: boolean; // Enable live code comments
}

interface Assignment {
  assignment_id: string | null;
  name: string;
  assignment_name_for_lookup?: string;
  path: string;
  create_from_template?: boolean;
  settings?: AssignmentSettings;
  parts: Part[];
}

interface PartSettings {
  submission_filters?: {    // Include/exclude patterns (passed to rsync)
    include?: string[];
    exclude?: string[];
    list?: string[];        // Explicit file list
  };
  cloud_labs?: boolean;           // Enable cloud labs (requires org permission)
  instant_aws_access?: boolean;   // Enable instant AWS (requires org permission)
  session_length?: string;        // Lab session length in minutes (e.g. "60")
  monthly_dollar?: string;        // Monthly dollar budget
  monthly_time?: string;          // Monthly time budget in minutes
  total_time?: string;            // Total time budget in minutes
  total_dollar?: string;          // Total dollar budget
  late_penalty_percent?: number;  // Late penalty percentage (0-100)
  late_penalty_percent_rule?: 'max score' | 'student score';
  deadlinedate?: string;          // Part deadline (ISO 8601)
  endlab?: 'stop' | 'terminate';  // Behavior on end lab
  labtype?: string;               // Lab type name (e.g., "JupyterLab", "Visual Studio Code")
  container_image?: string;       // Container image (must match labtype)
  number_of_submissions?: number; // Max submissions allowed
  lab_interface?: {               // Lab interface configuration
    panels?: string[];            // e.g., ["Console", "Html"]
    controls?: string[];          // e.g., ["Reset"]
    information?: string[];       // e.g., ["Assignments"]
    launch_behavior?: string[];
    grades?: string[];
  };
  databricks_maxusers?: number;   // Max users for Databricks labs
  tags?: string[];                // Tags for the part
}

interface Part {
  part_id: string | null;
  path: string;
  name?: string;
  directories?: DirectoryType[]; // Optional: specify which dirs exist
  settings?: PartSettings;
}

interface PublishOptions {
  on_missing_id?: 'skip' | 'abort';
  auto_commit?: boolean; // LOCAL USE ONLY
  abort_on_error?: boolean;
  sync_deletes?: boolean;
  exclude_patterns?: string[];
}

interface PublishHistory {
  timestamp: string;
  commit_sha: string;
  published_by: string;
  status: 'success' | 'failed';
  content_state: Record<string, string>; // directory path -> hash
  created?: CreatedEntity[];
  updated?: UpdatedEntity[];
  failed?: Array<{ type: 'assignment' | 'part' | 'file'; id: string; error: string }>;
}
```

---

### 2. API Client Module (`api/client.ts`)

**Purpose:** Provide typed interface to Vocareum REST API.

**Key Responsibilities:**
- HTTP request/response handling
- Authentication (API key injection)
- Error handling and retry logic
- Rate limiting and backoff
- Request/response logging (with credential redaction)

**Public API:**
```typescript
export class VocareumClient {
  constructor(apiKey: string, baseUrl?: string)
  
  // Course operations
  async getCourse(courseId: string): Promise<Course>
  async updateCourse(
    courseId: string, 
    settings: CourseSettings
  ): Promise<Course>
  
  // Assignment operations
  async listAssignments(courseId: string): Promise<Assignment[]>
  async getAssignment(assignmentId: string): Promise<Assignment>
  async copyAssignment(
    templateId: string
  ): Promise<AssignmentCopyResponse>
  async updateAssignment(
    assignmentId: string, 
    settings: AssignmentSettings
  ): Promise<Assignment>
  
  // Part operations
  async listParts(assignmentId: string): Promise<Part[]>
  // Returns parts with seqnum for ordering
  async getPart(partId: string): Promise<Part>
  async updatePart(
    partId: string, 
    settings: PartSettings
  ): Promise<Part>
  
  // Content operations
  async uploadContent(
    partId: string,
    directory: DirectoryType,
    files: FileMap
  ): Promise<UploadResult>
  
  async downloadContent(
    partId: string
  ): Promise<FileMap>
  
  async listFiles(
    partId: string,
    directory: DirectoryType
  ): Promise<FileInfo[]>
  
  async deleteFile(
    partId: string,
    directory: DirectoryType,
    filePath: string
  ): Promise<void>
}

// Part-level: startercode, scripts, lib, asnlib, docs
// Course-level: course, data, docs, scripts, private, startercode
type DirectoryType = 'startercode' | 'scripts' | 'docs' | 'data' | 'lib' | 'asnlib' | 'private' | 'course';

interface FileMap {
  [relativePath: string]: Buffer | string;
}

interface FileInfo {
  path: string;
  size: number;
  modifiedAt?: string;
}

interface AssignmentCopyResponse {
  assignment_id: string;
  parts: Array<{
    part_id: string;
    name: string;
    seqnum: string; // Sequence number for ordering (e.g., "0", "1", "2")
  }>;
}
```

**Error Handling:**
```typescript
export class VocareumError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'VocareumError';
  }
}

export class APIError extends VocareumError {}
export class AuthenticationError extends VocareumError {}
export class RateLimitError extends VocareumError {}
export class NotFoundError extends VocareumError {}
```

**Retry Logic:**
```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const backoff = options.backoff ?? 1000;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries - 1 || !isRetryable(error)) {
        throw error;
      }
      await sleep(backoff * Math.pow(2, attempt));
    }
  }
}

function isRetryable(error: any): boolean {
  return (
    error instanceof RateLimitError ||
    (error.statusCode >= 500 && error.statusCode < 600) ||
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT'
  );
}
```

---

### 3. Reconciler Module (`core/reconciler.ts`)

**Purpose:** Compare local configuration with Vocareum state to determine required actions.

**Key Responsibilities:**
- Fetch current state from Vocareum (list assignments and parts)
- Fetch full details for each assignment/part being compared (for accurate settings comparison)
- Compare with local configuration
- Generate action plan (create/update/skip)
- Detect orphaned assignments (in Vocareum but not in config)
- Detect stale assignments (in config but deleted from Vocareum)
- Estimate API call count

**Public API:**
```typescript
export interface ReconciliationPlan {
  config: Config;
  course: CourseAction;
  assignments: AssignmentAction[];
  summary: ReconciliationSummary;
  orphanedInVocareum: OrphanedEntity[];  // In Vocareum but not in config
  staleInConfig: StaleAssignment[];       // In config but deleted from Vocareum
}

export interface ReconciliationSummary {
  coursesToUpdate: number;
  assignmentsToCreate: number;
  assignmentsToUpdate: number;
  assignmentsWithDiscoveredIds: number;
  assignmentsToSkip: number;
  partsToCreate: number;
  partsToUpdate: number;
  estimatedApiCalls: number;
}

export interface AssignmentAction {
  type: ActionType;
  assignment: Assignment;
  parts: PartAction[];
  reason?: string;
  willCreate?: boolean;
  templateId?: string;
  idDiscoveredByName?: boolean;
}

export interface PartAction {
  type: ActionType;
  part: Part;
  contentChanged: boolean;
  changedDirectories?: DirectoryType[];
  metadataChanged?: boolean;
  reason?: string;
}

type ActionType = 'create' | 'update' | 'skip' | 'error';

export async function reconcile(
  config: Config,
  client: VocareumClient,
  lastPublishHistory?: PublishHistory
): Promise<ReconciliationPlan>

export function displayPlan(plan: ReconciliationPlan): void
```

**Settings Comparison:**

For accurate settings comparison, the reconciler fetches full details for each assignment and part:

```typescript
// For each assignment being updated
const fullAssignment = await getAssignment(client, courseId, assignmentId);
const metadataChanged = detectAssignmentSettingsChanged(configAssignment, fullAssignment);

// For each part being updated
const fullPart = await getPart(client, courseId, assignmentId, partId);
const partMetadataChanged = detectPartSettingsChanged(configPart, fullPart);
```

This ensures we compare against all available settings fields, not just those returned by list endpoints.

**Change Detection:**
```typescript
interface ChangeDetectionOptions {
  forceAll?: boolean;
  directories?: DirectoryType[];
  lastPublishHistory?: PublishHistory;
}

async function detectChangedDirectories(
  assignmentPath: string,
  partPath: string,
  lastPublishHistory?: PublishHistory
): Promise<DirectoryType[]> {
  if (!lastPublishHistory?.content_state) {
    // First publish - all directories changed
    return ['startercode', 'scripts', 'docs', 'data'];
  }
  
  const changedDirs: DirectoryType[] = [];
  const directories: DirectoryType[] = ['startercode', 'scripts', 'docs', 'data'];
  
  for (const dir of directories) {
    const fullPath = path.join(assignmentPath, partPath, dir);
    const key = `${assignmentPath}/${partPath}/${dir}`;
    
    const currentHash = await calculateDirectoryHash(fullPath);
    const previousHash = lastPublishHistory.content_state[key];
    
    if (currentHash !== previousHash) {
      changedDirs.push(dir);
    }
  }
  
  return changedDirs;
}

async function calculateDirectoryHash(
  directoryPath: string,
  excludePatterns: string[] = []
): Promise<string> {
  const files = await readDirectory(directoryPath, excludePatterns);
  
  // Sort files by path for consistent hashing
  const sortedPaths = Object.keys(files).sort();
  
  // Calculate hash for each file
  const fileHashes = await Promise.all(
    sortedPaths.map(async (filePath) => {
      const content = files[filePath];
      return crypto.createHash('sha256')
        .update(content)
        .digest('hex');
    })
  );
  
  // Hash the concatenated file hashes
  return crypto.createHash('sha256')
    .update(fileHashes.join(':'))
    .digest('hex');
}
```

---

### 4. Publisher Module (`core/publisher.ts`)

**Purpose:** Execute the reconciliation plan by orchestrating API calls.

**Key Responsibilities:**
- Execute actions in correct dependency order
- Handle assignment creation via template copy
- Map template parts to config parts
- Update entity settings
- Upload content
- Handle errors and partial failures
- Update local config with new IDs
- Generate publish report
- Prompt for confirmation by default (unless non-interactive)
- Persist failed-run details in publish history

**Public API:**
```typescript
export interface PublishOptions {
  dryRun?: boolean;
  nonInteractive?: boolean;
  autoCommit?: boolean; // LOCAL USE ONLY
  syncDeletes?: boolean;
  configPath?: string;
  assignment?: string;
  part?: string;
  forceAll?: boolean;
  verbose?: boolean;
}

export interface PublishResult {
  success: boolean;
  created: CreatedEntity[];
  updated: UpdatedEntity[];
  skipped: SkippedEntity[];
  failed: FailedEntity[];
  deleted?: DeletedEntity[];
  orphanedInVocareum?: OrphanedEntity[]; // Assignments in Vocareum not in config
  configUpdates?: ConfigUpdates;
  contentState: Record<string, string>; // For updating publish_history
  summary: string;
}

export async function publish(
  config: Config,
  client: VocareumClient,
  options: PublishOptions
): Promise<PublishResult>
```

**Execution Flow:**
```typescript
async function executePublish(
  plan: ReconciliationPlan,
  client: VocareumClient,
  options: PublishOptions
): Promise<PublishResult> {
  // hasChanges considers assignment/part updates, course metadata updates,
  // and assignment IDs discovered by name-based lookup.
  // If !options.nonInteractive, prompt user to confirm before executing.

  const results: PublishResult = {
    success: true,
    created: [],
    updated: [],
    skipped: [],
    failed: [],
    deleted: [],
    orphanedInVocareum: [],
    contentState: {}
  };
  
  // 1. Update course settings if needed
  if (plan.course.type === 'update') {
    await updateCourse(plan.course);
  }
  
  // 2. Detect orphaned assignments (in Vocareum but not in config)
  const vocareumAssignments = await client.listAssignments(plan.config.vocareum.course_id);
  const configAssignmentIds = new Set(
    plan.config.assignments
      .map(a => a.assignment_id)
      .filter(id => id !== null)
  );
  
  for (const vocAssignment of vocareumAssignments) {
    if (!configAssignmentIds.has(vocAssignment.id)) {
      results.orphanedInVocareum.push({
        type: 'assignment',
        id: vocAssignment.id,
        name: vocAssignment.name,
        message: 'Exists in Vocareum but not in config (not deleted - manual operation required)'
      });
    }
  }
  
  // 3. Process assignments in order
  for (const assignmentAction of plan.assignments) {
    if (assignmentAction.type === 'create') {
      // Copy from template
      const copyResult = await client.copyAssignment(
        plan.config.vocareum.template_assignment_id
      );
      
      // Map parts
      const partMappings = mapParts(
        assignmentAction.parts,
        copyResult.parts
      );
      
      // Update settings and content
      const uploadResult = await updateAssignmentAndParts(
        copyResult.assignment_id,
        assignmentAction,
        partMappings,
        options
      );
      
      // Store content hashes
      Object.assign(results.contentState, uploadResult.contentState);
      
      results.created.push({
        type: 'assignment',
        id: copyResult.assignment_id,
        parts: partMappings.map(m => m.apiPartId)
      });
    }
    else if (assignmentAction.type === 'update') {
      const uploadResult = await updateAssignmentAndParts(
        assignmentAction.assignment.assignment_id,
        assignmentAction,
        null, // Parts already have IDs
        options
      );
      
      // Store content hashes
      Object.assign(results.contentState, uploadResult.contentState);
      
      // Track deletions if sync_deletes enabled
      if (options.syncDeletes && uploadResult.deleted) {
        results.deleted.push(...uploadResult.deleted);
      }
      
      results.updated.push({
        type: 'assignment',
        id: assignmentAction.assignment.assignment_id
      });
    }
  }
  
  // Persist publish_history entry with:
  // - status: success | failed
  // - content_state hashes only for successful directory uploads
  // - failed[] details when any operation fails
  return results;
}
```

---

### 5. Uploader Module (`core/uploader.ts`)

**Purpose:** Handle file system operations and content uploads.

**Key Responsibilities:**
- Read files from local directories
- Apply exclude patterns
- Calculate checksums for change detection
- Upload content to Vocareum
- Progress reporting
- Parallel uploads with concurrency control

**Public API:**
```typescript
export interface UploadOptions {
  excludePatterns?: string[];
  forceAll?: boolean;
  syncDeletes?: boolean;
  concurrency?: number;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  directory: DirectoryType;
  current: number;
  total: number;
  fileName: string;
}

export interface UploadResult {
  succeeded: string[];
  failed: Array<{ path: string; error: any }>;
  deleted?: string[];
  directoryHash: string;
}

export async function uploadDirectory(
  client: VocareumClient,
  partId: string,
  localPath: string,
  directoryType: DirectoryType,
  options: UploadOptions
): Promise<UploadResult>

export async function syncDirectory(
  client: VocareumClient,
  partId: string,
  localPath: string,
  directoryType: DirectoryType,
  options: UploadOptions
): Promise<UploadResult>

export async function readDirectory(
  path: string,
  excludePatterns?: string[]
): Promise<FileMap>
```

**Parallel Upload Strategy:**
```typescript
async function syncDirectory(
  client: VocareumClient,
  partId: string,
  localPath: string,
  directoryType: DirectoryType,
  options: UploadOptions
): Promise<UploadResult> {
  // Read local files
  const localFiles = await readDirectory(localPath, options.excludePatterns);
  const localPaths = new Set(Object.keys(localFiles));
  
  const result: UploadResult = {
    succeeded: [],
    failed: [],
    deleted: [],
    directoryHash: ''
  };
  
  // Get remote files if sync_deletes enabled
  let remotePaths = new Set<string>();
  if (options.syncDeletes) {
    const remoteFiles = await client.listFiles(partId, directoryType);
    remotePaths = new Set(remoteFiles.map(f => f.path));
  }
  
  // Determine files to upload and delete
  const toUpload = Array.from(localPaths);
  const toDelete = options.syncDeletes
    ? Array.from(remotePaths).filter(p => !localPaths.has(p))
    : [];
  
  // Upload files in parallel
  await uploadFiles(
    localFiles,
    (path, content) => client.uploadFile(partId, directoryType, path, content),
    options.concurrency ?? 3,
    result
  );
  
  // Delete removed files
  if (options.syncDeletes) {
    for (const filePath of toDelete) {
      try {
        await client.deleteFile(partId, directoryType, filePath);
        result.deleted!.push(filePath);
      } catch (error) {
        result.failed.push({ path: filePath, error });
      }
    }
  }
  
  // Calculate directory hash
  result.directoryHash = await calculateDirectoryHash(localPath, options.excludePatterns);
  
  return result;
}

async function uploadFiles(
  files: FileMap,
  uploadFn: (path: string, content: Buffer) => Promise<void>,
  concurrency: number,
  result: UploadResult
): Promise<void> {
  const entries = Object.entries(files);
  const queue = [...entries];
  
  // Process files in parallel with concurrency limit
  const workers = Array(concurrency).fill(null).map(async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;
      
      const [path, content] = entry;
      try {
        await uploadFn(path, content);
        result.succeeded.push(path);
      } catch (error) {
        result.failed.push({ path, error });
      }
    }
  });
  
  await Promise.all(workers);
}
```

---

### 6. Mapper Module (`core/mapper.ts`)

**Purpose:** Map template parts to configuration parts after assignment copy using sequence numbers.

**Key Responsibilities:**
- Map parts by seqnum (sequence number from Vocareum API)
- Validate part count consistency
- Generate part mappings for content upload

**Public API:**
```typescript
export interface PartMapping {
  configPart: Part;
  apiPartId: string;
  seqnum: string; // From Vocareum API
}

export function mapParts(
  configParts: Part[],
  apiParts: Array<{ part_id: string; seqnum: string }>
): PartMapping[]

export class PartMappingError extends Error {
  constructor(
    message: string,
    public expectedCount: number,
    public actualCount: number
  ) {
    super(message);
  }
}
```

**Implementation:**
```typescript
export function mapParts(
  configParts: Part[],
  apiParts: Array<{ part_id: string; seqnum: string }>
): PartMapping[] {
  if (configParts.length !== apiParts.length) {
    throw new PartMappingError(
      `Part count mismatch: config has ${configParts.length} parts, ` +
      `template has ${apiParts.length} parts`,
      configParts.length,
      apiParts.length
    );
  }
  
  // Sort API parts by seqnum to ensure correct ordering
  const sortedApiParts = [...apiParts].sort((a, b) => 
    parseInt(a.seqnum) - parseInt(b.seqnum)
  );
  
  // Map config parts (by array position) to API parts (by seqnum order)
  return configParts.map((configPart, index) => ({
    configPart,
    apiPartId: sortedApiParts[index].part_id,
    seqnum: sortedApiParts[index].seqnum
  }));
}
```

**Example:**

Template copy returns:
```json
{
  "assignment_id": "12345",
  "parts": [
    {"part_id": "111", "seqnum": "0", "name": "Template Part 1"},
    {"part_id": "222", "seqnum": "1", "name": "Template Part 2"},
    {"part_id": "333", "seqnum": "2", "name": "Template Part 3"}
  ]
}
```

Config defines:
```typescript
const configParts = [
  { part_id: null, path: "part1", name: "Part 1: Setup" },      // Index 0
  { part_id: null, path: "part2", name: "Part 2: Analysis" },   // Index 1
  { part_id: null, path: "part3", name: "Part 3: Evaluation" }  // Index 2
];
```

Mapping result:
```typescript
[
  {
    configPart: { path: "part1", name: "Part 1: Setup" },
    apiPartId: "111",
    seqnum: "0"
  },
  {
    configPart: { path: "part2", name: "Part 2: Analysis" },
    apiPartId: "222",
    seqnum: "1"
  },
  {
    configPart: { path: "part3", name: "Part 3: Evaluation" },
    apiPartId: "333",
    seqnum: "2"
  }
]
```

**Critical Notes:**
- Seqnum is a string (e.g., "0", "1", "2"), not a number
- Must parse to integer for sorting
- Assumes seqnum is sequential (0, 1, 2, ...) without gaps
- If seqnum has gaps or duplicates, sorting still works but may need validation

---

## Data Flow

### 1. Init Flow (Fresh)

```
┌─────────────┐
│ User runs   │
│ init command│
└──────┬──────┘
       │
       v
┌──────────────────┐
│ Interactive      │
│ prompts for IDs  │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Validate IDs     │
│ against Vocareum │
│ API              │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Generate         │
│ vocareum.yaml    │
│ + directories    │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Write files      │
│ to disk          │
└──────────────────┘
```

### 2. Init Flow (Import)

```
┌─────────────┐
│ User runs   │
│ init --import│
└──────┬──────┘
       │
       v
┌──────────────────┐
│ Fetch assignments│
│ and parts from   │
│ Vocareum         │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ User selects     │
│ template         │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Download content │
│ to imported/     │
│ directories      │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Generate         │
│ vocareum.yaml    │
│ with all IDs     │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Write files      │
│ + guide          │
└──────────────────┘
```

### 3. Pull Flow

```
┌─────────────┐
│ User runs   │
│ pull        │
└──────┬──────┘
       │
       v
┌──────────────────┐
│ Load & validate  │
│ vocareum.yaml    │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Reconcile:       │
│ find orphaned    │
│ assignments      │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ For each orphan: │
│ prompt user      │
│ action           │
└──────┬───────────┘
       │
       ├───[Import]────────────┐
       │                       v
       │              ┌──────────────────┐
       │              │ Download content │
       │              │ from Vocareum    │
       │              └──────┬───────────┘
       │                     │
       │                     v
       │              ┌──────────────────┐
       │              │ Create local     │
       │              │ directories      │
       │              │ + write files    │
       │              └──────┬───────────┘
       │                     │
       │<────────────────────┘
       │
       ├───[Exclude]───────────┐
       │                       v
       │              ┌──────────────────┐
       │              │ Add ID to        │
       │              │ excluded_        │
       │              │ assignments      │
       │              └──────┬───────────┘
       │                     │
       │<────────────────────┘
       │
       v
┌──────────────────┐
│ Update           │
│ vocareum.yaml    │
│ with changes     │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Display summary  │
└──────────────────┘
```

### 4. Publish Flow

```
┌─────────────┐
│ User runs   │
│ publish     │
└──────┬──────┘
       │
       v
┌──────────────────┐
│ Load & validate  │
│ vocareum.yaml    │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Authenticate     │
│ with Vocareum    │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Fetch current    │
│ state from       │
│ Vocareum         │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Reconcile:       │
│ compare local    │
│ vs. remote       │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Display plan     │
│ + get            │
│ confirmation     │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Execute plan:    │
│ - Copy templates │
│ - Map parts      │
│ - Update settings│
│ - Upload content │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Update           │
│ vocareum.yaml    │
│ with new IDs     │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Optional:        │
│ auto-commit      │
│ changes          │
└──────┬───────────┘
       │
       v
┌──────────────────┐
│ Display summary  │
│ report           │
└──────────────────┘
```

---

## GitHub Action Integration

### Action Structure

**action.yml:**
```yaml
name: 'Vocareum Publisher'
description: 'Publish assignment content to Vocareum'
branding:
  icon: 'upload-cloud'
  color: 'blue'

inputs:
  config-file:
    description: 'Path to vocareum.yaml'
    required: false
    default: 'vocareum.yaml'
  api-key:
    description: 'Vocareum API key'
    required: true
  dry-run:
    description: 'Preview changes without publishing'
    required: false
    default: 'false'
  assignment:
    description: 'Specific assignment to publish'
    required: false
  auto-commit:
    description: 'Auto-commit config updates'
    required: false
    default: 'false'
  sync-deletes:
    description: 'Delete files from Vocareum not in Git'
    required: false
    default: 'false'
  verbose:
    description: 'Enable verbose logging'
    required: false
    default: 'false'

outputs:
  summary:
    description: 'Publish summary'
  created-ids:
    description: 'JSON of newly created entity IDs'
  updated-ids:
    description: 'JSON of updated entity IDs'
  success:
    description: 'Whether publish succeeded (true/false)'

runs:
  using: 'node20'
  main: 'dist/action/index.js'
```

**action/index.ts:**
```typescript
import * as core from '@actions/core';
import * as github from '@actions/github';
import { publish } from '../core/publisher';
import { loadConfig } from '../core/config';
import { VocareumClient } from '../api/client';

async function run() {
  try {
    // Get inputs
    const configFile = core.getInput('config-file');
    const apiKey = core.getInput('api-key');
    const dryRun = core.getBooleanInput('dry-run');
    const assignment = core.getInput('assignment');
    const autoCommit = core.getBooleanInput('auto-commit');
    const syncDeletes = core.getBooleanInput('sync-deletes');
    const verbose = core.getBooleanInput('verbose');

    // Warn if auto-commit is enabled in CI/CD
    if (autoCommit) {
      core.warning(
        'auto-commit is enabled in CI/CD. This is not recommended. ' +
        'Create new assignments locally and commit IDs before using CI/CD.'
      );
    }

    // Load config
    const config = await loadConfig(configFile);
    
    // Create API client
    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);
    
    // Execute publish
    const result = await publish(config, client, {
      dryRun,
      assignment,
      autoCommit,
      syncDeletes,
      nonInteractive: true,
      verbose
    });

    // Set outputs
    core.setOutput('success', result.success.toString());
    core.setOutput('summary', result.summary);
    core.setOutput('created-ids', JSON.stringify(result.created));
    core.setOutput('updated-ids', JSON.stringify(result.updated));

    // Warn about orphaned assignments
    if (result.orphanedInVocareum && result.orphanedInVocareum.length > 0) {
      core.warning(
        `Found ${result.orphanedInVocareum.length} assignment(s) in Vocareum not in config. ` +
        'These were NOT deleted. Manual cleanup required if desired.'
      );
    }

    // Add job summary
    await core.summary
      .addHeading('Vocareum Publish Results')
      .addRaw(formatSummary(result))
      .write();

    if (!result.success) {
      core.setFailed('Publish failed. See summary for details.');
    }
  } catch (error: any) {
    core.setFailed(error.message);
    core.error(error.stack);
  }
}

run();
```

---

## Logging & Output

### Log Levels
```typescript
enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4
}

export class Logger {
  constructor(private level: LogLevel = LogLevel.INFO) {}
  
  error(message: string, meta?: any): void {
    console.error(chalk.red('✗'), message);
    if (meta && this.level >= LogLevel.DEBUG) {
      console.error(chalk.gray(JSON.stringify(meta, null, 2)));
    }
  }
  
  warn(message: string, meta?: any): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(chalk.yellow('⚠'), message);
    }
  }
  
  info(message: string): void {
    if (this.level >= LogLevel.INFO) {
      console.log(chalk.green('✓'), message);
    }
  }
  
  debug(message: string, meta?: any): void {
    if (this.level >= LogLevel.DEBUG) {
      console.log(chalk.gray('[DEBUG]'), message);
      if (meta) {
        console.log(chalk.gray(JSON.stringify(meta, null, 2)));
      }
    }
  }
}
```

### Output Examples

**Standard output (INFO level):**
```
✓ Loaded config from vocareum.yaml
✓ Authenticated with Vocareum API
✓ Found course: "Introduction to Data Science" (67890)
⚠ Template assignment has 3 parts but will create 2

📋 Publish Plan
═══════════════════════════════════════════════════════
  1 assignment to create
  2 parts to create
  Estimated API calls: 8

Continue? [y/N] y

Publishing...
✓ Copied template assignment → 44444
✓ Mapped 2 parts: [55555, 66666]
✓ Updated assignment settings
✓ Part 1 (55555)
  ↳ Uploaded startercode/ (15 files, 234 KB)
  ↳ Uploaded scripts/ (3 files, 12 KB)
✓ Part 2 (66666)
  ↳ Uploaded startercode/ (8 files, 156 KB)
  ↳ Uploaded docs/ (2 files, 45 KB)
  ↳ Deleted old_file.py (not in Git)

✓ Publish complete! (12.3s)
✓ Updated vocareum.yaml with content hashes

⚠ Warning: 1 assignment exists in Vocareum but not in config:
  - Lab 5: Extra Credit (67890) - not deleted, manual cleanup required

Commit changes? [Y/n]
```

**Debug output (--verbose):**
```
[DEBUG] Parsing config: vocareum.yaml
[DEBUG] Config version: 1.0
[DEBUG] Validating schema
[DEBUG] API request: GET /courses/67890
[DEBUG] Response: 200 OK (234ms)
[TRACE] Found 5 assignments in course
[DEBUG] API request: POST /api/v2/courses/67890/assignments
[DEBUG] Response: 202 Accepted (1.2s)
[DEBUG] API request: GET /api/v2/transaction/42
[DEBUG] Response: 200 OK (210ms)
[TRACE] Calculating file checksums for 15 files
[DEBUG] Checksum: abc123... (main.py)
```

---

## Testing Strategy

### Unit Tests

Test individual functions and modules in isolation:

```typescript
// Example: config validation
describe('validateConfig', () => {
  it('should accept valid config', () => {
    const config = {
      version: '1.0',
      vocareum: {
        org_id: '123',
        course_id: '456',
        template_assignment_id: '789'
      },
      assignments: []
    };
    
    expect(() => validateConfig(config)).not.toThrow();
  });
  
  it('should reject missing required fields', () => {
    const config = {
      version: '1.0',
      vocareum: {
        org_id: '123',
        // Missing course_id
      },
      assignments: []
    };
    
    expect(() => validateConfig(config)).toThrow(ValidationError);
  });
});

// Example: part mapping
describe('mapParts', () => {
  it('should map parts by position', () => {
    const configParts = [
      { part_id: null, path: 'part1', name: 'Part 1' },
      { part_id: null, path: 'part2', name: 'Part 2' }
    ];
    
    const apiParts = [
      { part_id: 'abc', position: 0 },
      { part_id: 'def', position: 1 }
    ];
    
    const mappings = mapParts(configParts, apiParts);
    
    expect(mappings[0].apiPartId).toBe('abc');
    expect(mappings[1].apiPartId).toBe('def');
  });
  
  it('should throw on part count mismatch', () => {
    const configParts = [
      { part_id: null, path: 'part1' }
    ];
    
    const apiParts = [
      { part_id: 'abc', position: 0 },
      { part_id: 'def', position: 1 }
    ];
    
    expect(() => mapParts(configParts, apiParts))
      .toThrow(PartMappingError);
  });
});
```

### Integration Tests

Test API interactions with mocked client:

```typescript
describe('publish workflow', () => {
  let mockClient: jest.Mocked<VocareumClient>;
  
  beforeEach(() => {
    mockClient = createMockClient();
  });
  
  it('should create assignment from template', async () => {
    mockClient.copyAssignment.mockResolvedValue({
      assignment_id: '44444',
      parts: [
        { part_id: '55555', name: 'Part 1', position: 0 }
      ]
    });
    
    mockClient.updateAssignment.mockResolvedValue({} as any);
    mockClient.uploadContent.mockResolvedValue({ succeeded: [], failed: [] });
    
    const config = createTestConfig();
    const result = await publish(config, mockClient, { dryRun: false });
    
    expect(mockClient.copyAssignment).toHaveBeenCalledWith('99999');
    expect(result.created).toHaveLength(1);
    expect(result.created[0].id).toBe('44444');
  });
  
  it('should handle upload failures gracefully', async () => {
    mockClient.uploadContent.mockRejectedValue(
      new Error('Network error')
    );
    
    const config = createTestConfig();
    const result = await publish(config, mockClient, { 
      dryRun: false,
      abortOnError: false 
    });
    
    expect(result.success).toBe(false);
    expect(result.failed).toHaveLength(1);
  });
});
```

### E2E Tests (Phase 2)

Test against sandbox Vocareum instance:

```typescript
describe('end-to-end publish', () => {
  let sandboxClient: VocareumClient;
  let testCourseId: string;
  
  beforeAll(async () => {
    sandboxClient = new VocareumClient(
      process.env.VOCAREUM_TEST_API_KEY!,
      'https://sandbox.vocareum.com/api'
    );
    testCourseId = process.env.VOCAREUM_TEST_COURSE_ID!;
  });
  
  it('should publish full course', async () => {
    const config = await loadConfig('test/fixtures/sample-course.yaml');
    const result = await publish(config, sandboxClient, { dryRun: false });
    
    expect(result.success).toBe(true);
    
    // Verify in Vocareum
    const assignments = await sandboxClient.listAssignments(testCourseId);
    expect(assignments).toHaveLength(config.assignments.length);
  });
});
```

---

## Security Considerations

### API Key Protection

```typescript
// Never log API keys
function sanitizeForLog(obj: any): any {
  const sanitized = { ...obj };
  if (sanitized.headers?.authorization) {
    sanitized.headers.authorization = '[REDACTED]';
  }
  if (sanitized.apiKey) {
    sanitized.apiKey = '[REDACTED]';
  }
  return sanitized;
}

logger.debug('Making API request', sanitizeForLog(requestConfig));
```

### Input Validation

```typescript
// Validate all user inputs
function validateApiKey(key: string): void {
  if (!key || key.length < 20 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ValidationError('Invalid API key format');
  }
}

// Prevent path traversal
function validatePath(basePath: string, targetPath: string): void {
  const resolved = path.resolve(basePath, targetPath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new ValidationError(
      `Invalid path: ${targetPath} escapes base directory`
    );
  }
}
```

### Dependency Security

```typescript
// Regular dependency audits
npm audit

// Use lock file
package-lock.json

// Automated updates
dependabot.yml
```

---

## Performance Optimization

### Parallel Uploads

```typescript
async function uploadMultipleParts(
  parts: PartAction[],
  concurrency: number = 3
): Promise<UploadResult[]> {
  const queue = [...parts];
  const results: UploadResult[] = [];
  
  const workers = Array(concurrency).fill(null).map(async () => {
    while (queue.length > 0) {
      const part = queue.shift();
      if (part) {
        const result = await uploadPartContent(part);
        results.push(result);
      }
    }
  });
  
  await Promise.all(workers);
  return results;
}
```

### File Chunking for Large Files

```typescript
async function uploadLargeFile(
  filePath: string,
  uploadFn: (chunk: Buffer, index: number) => Promise<void>,
  chunkSize: number = 5 * 1024 * 1024 // 5MB
): Promise<void> {
  const fileSize = (await fs.stat(filePath)).size;
  const numChunks = Math.ceil(fileSize / chunkSize);
  
  for (let i = 0; i < numChunks; i++) {
    const chunk = await readFileChunk(filePath, i * chunkSize, chunkSize);
    await uploadFn(chunk, i);
  }
}
```

### Caching and Change Detection

```typescript
// Cache file checksums to avoid re-uploading unchanged files
interface FileChecksum {
  path: string;
  sha256: string;
  mtime: number;
}

async function calculateChecksum(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function hasFileChanged(
  filePath: string,
  lastChecksum?: string
): Promise<boolean> {
  if (!lastChecksum) return true;
  
  const currentChecksum = await calculateChecksum(filePath);
  return currentChecksum !== lastChecksum;
}
```

---

## Build and Distribution

### Build Configuration

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**package.json scripts:**
```json
{
  "scripts": {
    "build": "tsc",
    "build:action": "tsc && cp action/action.yml dist/action/",
    "dev": "tsx src/index.ts",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "eslint src --ext .ts",
    "lint:fix": "eslint src --ext .ts --fix",
    "format": "prettier --write 'src/**/*.ts'",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run build"
  }
}
```

### npm Package Configuration

```json
{
  "name": "vocareum-publisher",
  "version": "1.0.0",
  "description": "Publish assignment content from GitHub to Vocareum",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "vocareum-publish": "./dist/index.js"
  },
  "files": [
    "dist",
    "action",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": [
    "vocareum",
    "education",
    "assignments",
    "publishing",
    "cli"
  ]
}
```

---

## Development Workflow

### Local Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- init

# Run tests
npm test

# Run tests in watch mode
npm run test -- --watch

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Format code
npm run format
```

### Release Process

```bash
# 1. Update version
npm version patch  # or minor, major

# 2. Build
npm run build

# 3. Test
npm test

# 4. Publish to npm
npm publish

# 5. Tag and push
git push --tags
git push

# 6. Create GitHub release with changelog
gh release create v1.0.0 --notes "Release notes here"
```

---

## Open Technical Questions

1. **Vocareum API Endpoints:** Need complete API documentation to finalize endpoint implementations
2. **Authentication Method:** Confirmed `Authorization: Token <token>`
3. **Rate Limiting:** What are the rate limits? How should we handle 429 responses?
4. **Content Upload Format:** Confirmed part `PUT` with `content[].zipcontent` base64 zip payload
5. **Content Download Format:** How is content returned during import? Zip, individual files, or structured JSON?
6. **Part Ordering:** How are parts ordered in the API response? Is `position` field reliable?
7. **Assignment Copy Behavior:** Does copying preserve all settings? Are there any limitations?
8. **Error Response Format:** What's the structure of error responses? Standard format or varies by endpoint?
9. **Webhook Support:** Does Vocareum support webhooks for triggering publishes on external events?
10. **API Versioning:** Is the API versioned? How should we handle version changes?

---

## Next Steps

1. **API Investigation:** Review Vocareum API documentation in detail
2. **Prototype:** Build proof-of-concept for core publish workflow
3. **API Contract Definition:** Define TypeScript interfaces for all API operations
4. **Test Suite Setup:** Establish testing infrastructure and mock client
5. **Documentation:** Begin writing user-facing documentation
6. **Pilot Testing:** Identify early adopters for beta testing

---

**Document Version History:**
- v1.0 (2026-02-12): Initial architecture draft for team review
