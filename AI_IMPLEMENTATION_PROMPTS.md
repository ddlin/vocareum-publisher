# Vocareum Publisher - AI Agent Implementation Prompts

**Purpose:** Step-by-step prompts for AI coding agents (Claude Code, Cursor, etc.) to implement the Vocareum Publisher tool.

**Prerequisites:** Provide AI agent with access to:
1. Product Requirements Document (PRD)
2. Technical Architecture Document
3. Project Summary
4. Vocareum API Documentation: https://documenter.getpostman.com/view/6736336/S11Exg4b

---

## Phase 0: Project Setup

### Prompt 0.1: Initialize Project Structure

```
Create a new Node.js/TypeScript project for the Vocareum Publisher CLI tool with the following specifications:

PROJECT SETUP:
- Initialize npm project with name "vocareum-publisher"
- TypeScript 5.3+ with strict mode
- Target: ES2022, Module: CommonJS
- Node.js 18+ (LTS)

DIRECTORY STRUCTURE:
src/
  index.ts                 # CLI entry point
  commands/
    init.ts
    new.ts
    publish.ts
    validate.ts
    fix.ts
  core/
    config.ts
    validator.ts
    reconciler.ts
    publisher.ts
    uploader.ts
    mapper.ts
  api/
    client.ts
    courses.ts
    assignments.ts
    parts.ts
    content.ts
  utils/
    logger.ts
    git.ts
    files.ts
    prompts.ts
    validation.ts
  types/
    config.ts
    api.ts
    state.ts
action/
  action.yml
  index.ts
test/
  unit/
  integration/
  fixtures/
docs/
examples/
  sample-course/

DEPENDENCIES:
Install these exact versions:
- axios@^1.6.0
- form-data@^4.0.0
- chalk@^5.3.0
- commander@^11.1.0
- cosmiconfig@^9.0.0
- inquirer@^9.2.0
- js-yaml@^4.1.0
- ora@^7.0.0
- simple-git@^3.21.0
- zod@^3.22.0

DEV DEPENDENCIES:
- typescript@^5.3.0
- tsx@^4.7.0
- vitest@^1.0.0
- @types/node@^20.10.0
- @types/inquirer@^9.0.7
- @types/js-yaml@^4.0.9
- eslint@^8.56.0
- prettier@^3.1.0

CONFIGURATION FILES:
1. tsconfig.json with strict mode, outDir: ./dist, target: ES2022
2. package.json with bin pointing to dist/index.js
3. .eslintrc.js with TypeScript rules
4. .prettierrc with standard formatting
5. .gitignore (node_modules, dist, .env, etc.)

SCRIPTS in package.json:
- "build": "tsc"
- "dev": "tsx src/index.ts"
- "test": "vitest"
- "lint": "eslint src --ext .ts"
- "format": "prettier --write 'src/**/*.ts'"

Create all files and folders. Add package.json with correct metadata.
```

### Prompt 0.2: Setup Type Definitions

```
Create comprehensive TypeScript type definitions in src/types/ based on the Architecture document.

FILE: src/types/config.ts
Define all configuration types including:
- Config (main config structure)
- VocareumConfig
- Assignment
- Part
- PublishOptions
- PublishHistory
- DirectoryType (union: 'startercode' | 'scripts' | 'docs' | 'data')

CRITICAL REQUIREMENTS:
- All IDs must be string | null (not numbers)
- Use Zod schemas for runtime validation
- Export both Zod schemas and TypeScript types
- Include JSDoc comments for each field

FILE: src/types/api.ts
Define Vocareum API response types:
- VocareumPartResponse (with seqnum as string)
- PartsListResponse
- AssignmentCopyResponse
- Course, Assignment, Part API types
- Error response types

FILE: src/types/state.ts
Define internal state types:
- ValidationResult, ValidationError, ValidationWarning
- ReconciliationPlan, AssignmentAction, PartAction
- PublishResult, UploadResult
- PartMapping

Use the exact structures from the Architecture document.
```

---

## Phase 1: Core Infrastructure

### Prompt 1.1: Logger Utility

```
Implement src/utils/logger.ts with colored console output.

REQUIREMENTS:
- Use chalk for colors
- Support log levels: ERROR, WARN, INFO, DEBUG, TRACE
- Methods: error(), warn(), info(), success(), debug(), trace()
- Environment variable: VOCAREUM_LOG_LEVEL
- Symbols: ✓ (success), ✗ (error), ⚠ (warning), ℹ (info)
- Never log API keys or sensitive data
- Include timestamp in debug mode

EXAMPLE USAGE:
logger.success('Created assignment structure');
logger.error('Validation failed', { details: ... });
logger.warn('File deletion not supported by API');
```

### Prompt 1.2: File System Utilities

```
Implement src/utils/files.ts for file system operations.

FUNCTIONS TO IMPLEMENT:
1. readDirectory(path, excludePatterns): Promise<FileMap>
   - Read all files recursively
   - Apply exclude patterns (glob style)
   - Return { [relativePath]: Buffer }

2. calculateDirectoryHash(path, excludePatterns): Promise<string>
   - Calculate SHA256 of all files concatenated
   - Sort by path for consistency
   - Return hex string

3. getDirectories(path): Promise<string[]>
   - List immediate subdirectories only

4. validatePath(basePath, targetPath): void
   - Prevent path traversal attacks
   - Throw if targetPath escapes basePath

5. ensureDirectory(path): Promise<void>
   - Create directory recursively if doesn't exist

Use Node.js fs/promises. Include proper error handling.
```

### Prompt 1.3: Git Utilities

```
Implement src/utils/git.ts using simple-git library.

FUNCTIONS TO IMPLEMENT:
1. isGitRepo(): Promise<boolean>
   - Check if current directory is git repo

2. getCommitSha(): Promise<string>
   - Get current commit SHA (short)

3. getCurrentBranch(): Promise<string>
   - Get current branch name

4. commitChanges(message, files): Promise<void>
   - Stage specific files
   - Commit with message
   - Use [skip ci] in message

5. hasUncommittedChanges(): Promise<boolean>
   - Check if working directory is clean

Handle cases where git is not initialized.
```

### Prompt 1.4: Prompt Utilities

```
Implement src/utils/prompts.ts using inquirer library.

FUNCTIONS TO IMPLEMENT:
1. prompt(message, defaultValue): Promise<string>
   - Simple text input

2. promptNumber(message, defaultValue): Promise<number>
   - Number input with validation

3. promptConfirm(message, defaultValue): Promise<boolean>
   - Yes/no confirmation

4. promptChoice(message, choices): Promise<string>
   - Single choice from list

5. promptMultiSelect(message, choices): Promise<string[]>
   - Multiple selections

6. promptPassword(message): Promise<string>
   - Password input (hidden)

All prompts should have proper validation and error messages.
```

---

## Phase 2: Configuration Management

### Prompt 2.1: Config Parser

```
Implement src/core/config.ts for vocareum.yaml management.

REQUIREMENTS:
Based on Architecture document, implement:

1. loadConfig(path): Promise<Config>
   - Use cosmiconfig to find vocareum.yaml
   - Parse YAML with js-yaml
   - Validate against Zod schema from types/config.ts
   - Apply default values for optional fields
   - Throw ConfigError if invalid

2. validateConfig(config): ValidationResult
   - Validate schema version (must be "1.0")
   - Check required fields: org_id, course_id, template_assignment_id
   - Validate assignment and part structures
   - Return errors array

3. updateConfig(path, updates): Promise<void>
   - Read existing config
   - Merge updates (deep merge for nested objects)
   - Write back to file with proper formatting
   - Preserve comments if possible

4. migrateConfig(config, fromVersion): Config
   - Placeholder for future version migrations
   - Currently just validates version is "1.0"

ERROR HANDLING:
- ConfigError class extending Error
- Specific error codes: INVALID_YAML, MISSING_FIELD, INVALID_SCHEMA
- Include file path and line numbers in errors when possible
```

### Prompt 2.2: Structure Validator

```
Implement src/core/validator.ts for file structure validation.

REQUIREMENTS:
Based on Architecture document Module 0, implement:

1. validateStructure(config, basePath): Promise<ValidationResult>
   - Check each YAML assignment has corresponding folder
   - Check each part folder exists
   - Check required directories if specified in part.directories
   - Detect orphaned folders (no YAML entry) → WARNING
   - Return { valid, errors[], warnings[] }

2. validateWithVocareum(config, client): Promise<ValidationResult>
   - Verify course exists and is accessible
   - Verify template assignment exists
   - Verify assignment IDs in config exist (if not null)
   - Return validation result

3. displayValidationResult(result): void
   - Pretty print validation results
   - Use colors: red for errors, yellow for warnings
   - Show fix suggestions for each error
   - Format:
     ✓ Validation Passed
     or
     ❌ Validation Failed
     Errors (must fix):
       • Assignment "x" - folder not found
     Warnings (review):
       ⚠ Folder "y/" has no YAML entry

VALIDATION ERROR TYPES:
- missing_folder
- missing_yaml_entry
- invalid_structure
- missing_course
- invalid_id

VALIDATION WARNING TYPES:
- orphaned_folder
- orphaned_assignment
- optional_dir_missing
```

---

## Phase 3: Vocareum API Client

### Prompt 3.1: Base API Client

```
Implement src/api/client.ts as the base HTTP client for Vocareum API.

REQUIREMENTS from Architecture document:

CLASS: VocareumClient
Constructor(apiKey: string, baseUrl?: string)
- Default baseUrl: https://api.vocareum.com
- Store apiKey privately
- Initialize axios instance with:
  * baseURL
  * timeout: 30000ms
  * headers: { 'Authorization': 'Bearer {apiKey}' }

CRITICAL: All IDs are strings, not numbers!

METHODS TO IMPLEMENT:
1. private async request<T>(config): Promise<T>
   - Wrapper around axios with error handling
   - Retry logic for transient failures (3 retries, exponential backoff)
   - Rate limiting detection (429 status)
   - Sanitize logs (redact API keys)
   - Return response.data

2. Error handling:
   - Create VocareumError class with:
     * message, code, statusCode, details
   - Subclasses: APIError, AuthenticationError, RateLimitError, NotFoundError
   - Map HTTP status codes to error types

3. Retry logic:
   - Retry on: 429, 5xx, ECONNRESET, ETIMEDOUT
   - Don't retry on: 4xx (except 429)
   - Exponential backoff: 1s, 2s, 4s

Use TypeScript generics for type-safe responses.
```

### Prompt 3.2: Course Operations

```
Implement src/api/courses.ts for course-related API operations.

Extend VocareumClient with course methods.

METHODS:
1. async getCourse(courseId: string): Promise<Course>
   - GET /v1/courses/{courseId}
   - Return course details
   - Throw NotFoundError if 404

2. async updateCourse(courseId: string, settings: CourseSettings): Promise<Course>
   - PUT /v1/courses/{courseId}
   - Update course metadata
   - Return updated course

Use types from types/api.ts.
Validate all IDs are strings.
```

### Prompt 3.3: Assignment Operations

```
Implement src/api/assignments.ts for assignment operations.

METHODS:
1. async listAssignments(courseId: string): Promise<Assignment[]>
   - GET /v1/courses/{courseId}/assignments
   - Return array of assignments
   - Cache result for performance (Map<courseId, Assignment[]>)

2. async getAssignment(assignmentId: string): Promise<Assignment>
   - GET /v1/assignments/{assignmentId}
   - Return assignment details

3. async copyAssignment(templateId: string): Promise<AssignmentCopyResponse>
   - POST /v1/assignments/{templateId}/copy
   - Return new assignment_id and parts array with seqnum
   - CRITICAL: Verify seqnum is preserved in response

4. async updateAssignment(assignmentId: string, settings: AssignmentSettings): Promise<Assignment>
   - PUT /v1/assignments/{assignmentId}
   - Update assignment metadata
   - Support fields: name, due_date, description

Reference Vocareum API docs for exact endpoints.
```

### Prompt 3.4: Part Operations

```
Implement src/api/parts.ts for part operations.

METHODS:
1. async listParts(assignmentId: string): Promise<Part[]>
   - GET /v1/assignments/{assignmentId}/parts
   - Return parts with seqnum field
   - Filter out deleted parts (deleted: "1")
   - Sort by parseInt(seqnum) for correct ordering

2. async getPart(partId: string): Promise<Part>
   - GET /v1/parts/{partId}
   - Return part details

3. async updatePart(partId: string, settings: PartSettings): Promise<Part>
   - PUT /v1/parts/{partId}
   - Update part metadata

Use VocareumPartResponse type from types/api.ts.
```

### Prompt 3.5: Content Operations

```
Implement src/api/content.ts for file upload/download operations.

CRITICAL: Content upload requires multipart/form-data format.

METHODS:
1. async uploadContent(
     courseId: string,
     assignmentId: string,
     partId: string,
     directory: DirectoryType,
     files: FileMap
   ): Promise<UploadResult>
   
   - Endpoint: POST /v1/courses/{cid}/assignments/{aid}/parts/{pid}/files
   - Use form-data library for multipart
   - Parameters:
     * type: directory ('startercode' | 'scripts' | 'docs' | 'data')
     * file: file content (multipart field)
   - Upload each file separately
   - Preserve file paths in filename/filepath
   - Return { succeeded[], failed[], directoryHash }

2. async downloadContent(partId: string): Promise<FileMap>
   - Download all files from part workspace
   - Return { [relativePath]: Buffer }
   - Handle large files efficiently

3. async listFiles(partId: string, directory: DirectoryType): Promise<FileInfo[]>
   - List files in workspace directory
   - May not be supported by API - handle gracefully
   - Return empty array if endpoint doesn't exist

4. async deleteFile(partId: string, directory: DirectoryType, filePath: string): Promise<void>
   - Delete specific file
   - May not be supported by API
   - Throw clear error if not supported

EXAMPLE uploadContent implementation:
```typescript
import FormData from 'form-data';

async uploadContent(...) {
  for (const [filePath, content] of Object.entries(files)) {
    const form = new FormData();
    form.append('type', directory);
    form.append('file', content, {
      filename: path.basename(filePath),
      filepath: filePath
    });
    
    await this.request({
      method: 'POST',
      url: `/v1/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`,
      data: form,
      headers: form.getHeaders()
    });
  }
}
```
```

---

## Phase 4: Core Business Logic

### Prompt 4.1: Part Mapper

```
Implement src/core/mapper.ts for mapping template parts to config parts.

Based on Architecture document Module 6.

FUNCTION: mapParts(configParts, apiParts): PartMapping[]

INPUT:
- configParts: Part[] (from config, array order matters)
- apiParts: Array<{ part_id: string, seqnum: string }>

LOGIC:
1. Validate part count matches (throw PartMappingError if not)
2. Sort apiParts by parseInt(seqnum) ascending
3. Map by position: configParts[i] → sortedApiParts[i]
4. Return array of { configPart, apiPartId, seqnum }

ERROR HANDLING:
- PartMappingError class with expectedCount, actualCount
- Clear error message showing mismatch

EXAMPLE:
```typescript
// Config defines 3 parts in order
configParts = [
  { path: "part1", name: "Setup" },
  { path: "part2", name: "Analysis" },
  { path: "part3", name: "Evaluation" }
]

// API returns after copy (possibly out of order)
apiParts = [
  { part_id: "222", seqnum: "1" },
  { part_id: "111", seqnum: "0" },
  { part_id: "333", seqnum: "2" }
]

// Sort by seqnum: [111, 222, 333]
// Map: part1→111, part2→222, part3→333
```

CRITICAL: seqnum is a string, must parseInt for sorting!
```

### Prompt 4.2: Content Uploader

```
Implement src/core/uploader.ts for content upload operations.

Based on Architecture document Module 5.

MAIN FUNCTION: syncDirectory(...)
Parameters:
- client: VocareumClient
- courseId, assignmentId, partId: string
- localPath: string
- directoryType: DirectoryType
- options: UploadOptions

LOGIC:
1. Read local files using readDirectory() from utils/files.ts
2. If sync_deletes enabled:
   - Try to list remote files via client.listFiles()
   - Determine files to delete (remote but not local)
   - Handle gracefully if listFiles not supported
3. Upload files in parallel (concurrency control)
4. Optionally delete removed files
5. Calculate directory hash for change detection
6. Return UploadResult

PARALLEL UPLOAD:
- Use Promise.all with concurrency limit (default 3)
- Queue-based worker pattern
- Track succeeded and failed uploads

SYNC_DELETES HANDLING:
```typescript
if (options.syncDeletes) {
  try {
    const remoteFiles = await client.listFiles(partId, directoryType);
    // determine deletions
    for (const file of toDelete) {
      try {
        await client.deleteFile(partId, directoryType, file);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 405) {
          logger.warn(`File deletion not supported by API`);
        }
      }
    }
  } catch (error) {
    logger.warn('Cannot list remote files - sync_deletes will not work');
  }
}
```

Return type: UploadResult with directoryHash
```

### Prompt 4.3: State Reconciler

```
Implement src/core/reconciler.ts for comparing local vs Vocareum state.

Based on Architecture document Module 3.

MAIN FUNCTION: reconcile(config, client, lastPublishHistory): Promise<ReconciliationPlan>

LOGIC:
1. Fetch current state from Vocareum:
   - Get course details
   - List all assignments
   - For each assignment, list parts

2. For each assignment in config:
   - If assignment_id is null → CREATE
   - If assignment_id exists:
     * Verify exists in Vocareum (error if not)
     * Detect changed directories using lastPublishHistory hashes
     * Mark for UPDATE

3. Detect orphaned assignments:
   - Assignments in Vocareum but not in config
   - Add to warnings (not deleted)

4. Generate ReconciliationPlan:
   - Course action (update if settings changed)
   - Assignment actions (create/update/skip)
   - Part actions with changed directories list
   - Summary counts

CHANGE DETECTION:
```typescript
function detectChangedDirectories(
  assignmentPath: string,
  partPath: string,
  lastPublishHistory?: PublishHistory
): DirectoryType[] {
  if (!lastPublishHistory) return ['startercode', 'scripts', 'docs', 'data'];
  
  const changedDirs: DirectoryType[] = [];
  for (const dir of ['startercode', 'scripts', 'docs', 'data']) {
    const key = `${assignmentPath}/${partPath}/${dir}`;
    const currentHash = await calculateDirectoryHash(...);
    const previousHash = lastPublishHistory.content_state[key];
    if (currentHash !== previousHash) {
      changedDirs.push(dir);
    }
  }
  return changedDirs;
}
```

DISPLAY FUNCTION: displayPlan(plan): void
- Pretty print the reconciliation plan
- Show what will be created/updated
- Show changed directories for each part
- Display warnings for orphaned resources
- Show estimated API call count
```

### Prompt 4.4: Publisher Orchestrator

```
Implement src/core/publisher.ts for executing the publish workflow.

Based on Architecture document Module 4.

MAIN FUNCTION: publish(config, client, options): Promise<PublishResult>

WORKFLOW:
1. Validate structure first (call validator)
2. Generate reconciliation plan
3. Display plan and get user confirmation (unless non-interactive)
4. Execute plan:
   - Update course settings if needed
   - Process assignments in order:
     * CREATE: Copy template → map parts → update → upload content
     * UPDATE: Update settings → upload changed content only
5. Collect all content hashes
6. Update vocareum.yaml with new IDs and hashes
7. Optionally auto-commit (if enabled and local use)
8. Return PublishResult

ASSIGNMENT CREATION:
```typescript
if (action.type === 'create') {
  // 1. Copy template
  const copyResult = await client.copyAssignment(templateId);
  
  // 2. Map parts
  const mappings = mapParts(action.parts, copyResult.parts);
  
  // 3. Update assignment settings
  await client.updateAssignment(copyResult.assignment_id, action.settings);
  
  // 4. Update parts and upload content
  for (const mapping of mappings) {
    await client.updatePart(mapping.apiPartId, mapping.configPart.settings);
    
    const dirs = mapping.configPart.directories || ['startercode', 'scripts', 'docs', 'data'];
    for (const dir of dirs) {
      const result = await syncDirectory(..., dir, ...);
      contentState[`${assignmentPath}/${mapping.configPart.path}/${dir}`] = result.directoryHash;
    }
  }
  
  // 5. Track created entity
  results.created.push({ assignment_id, part_ids });
}
```

CONFIG UPDATE:
- Write new IDs to assignments and parts arrays
- Append to publish_history (keep last 10)
- Include content_state hashes

Return comprehensive PublishResult
```

---

## Phase 5: CLI Commands

### Prompt 5.1: Init Command

```
Implement src/commands/init.ts for repository initialization.

Based on PRD Section "Initial Setup Workflow".

COMMAND: vocareum-publish init [--import --course-id <id>]

TWO MODES:

MODE 1: FRESH START (no --import flag)
Interactive prompts:
1. "Enter your Vocareum Organization ID:"
2. "Enter your Vocareum Course ID:"
3. Validate course exists via API
4. "Enter Template Assignment ID:"
5. Validate template exists via API

Generate files:
- vocareum.yaml (empty assignments array, basic structure)
- .gitignore (standard patterns)
- README.md (with course name, setup instructions)
- example-assignment/ structure

MODE 2: IMPORT (--import flag)
1. Prompt for org_id
2. Use provided course_id
3. Fetch all assignments from Vocareum
4. Prompt user to select template from list
5. Download all content to assignment folders in imported/ subdirectories
6. Generate vocareum.yaml with all existing IDs populated
7. Create IMPORT_GUIDE.md with instructions

GENERATED vocareum.yaml:
```yaml
version: "1.0"

vocareum:
  org_id: "{{ORG_ID}}"
  course_id: "{{COURSE_ID}}"
  template_assignment_id: "{{TEMPLATE_ID}}"

assignments: []
  # Add your assignments here
  # Example:
  # - assignment_id: null
  #   name: "Lab 1"
  #   path: "assignment1"
  #   create_from_template: true
  #   parts:
  #     - part_id: null
  #       path: "part1"

publish_options:
  on_missing_id: "skip"
  auto_commit: false
  abort_on_error: false
  sync_deletes: false

publish_history: []
```

Success output with next steps.
```

### Prompt 5.2: New Command

```
Implement src/commands/new.ts for creating new assignment structures.

Based on PRD Section "Creating New Assignments" and Architecture Module 7.

COMMAND: vocareum-publish new <assignment-path>

INTERACTIVE PROMPTS:
1. "Assignment name:" (default: path)
2. "Number of parts:" (default: 1)
3. For each part: "Part N name:" (default: "Part N")
4. "Create all directories (startercode, scripts, docs, data)? [Y/n]"
5. If no: Multi-select which directories to create

ACTIONS:
1. Create directory structure:
   - <assignment-path>/part1/startercode/
   - <assignment-path>/part1/scripts/
   - etc.
   - Add .gitkeep to empty directories

2. Add entry to vocareum.yaml:
```yaml
- assignment_id: null
  name: "{{NAME}}"
  path: "{{PATH}}"
  create_from_template: true
  parts:
    - part_id: null
      path: "part1"
      name: "{{PART_1_NAME}}"
      directories: ["startercode", "scripts"]  # if not all
```

3. Display success message with next steps:
```
✓ Created assignment structure at lab1-intro/
✓ Added entry to vocareum.yaml

Next steps:
1. Add content to lab1-intro/part1/startercode/ etc.
2. Run: vocareum-publish --validate
3. Run: vocareum-publish (creates in Vocareum)
4. Commit updated vocareum.yaml with new IDs
```

Handle errors: assignment already exists, invalid path, etc.
```

### Prompt 5.3: Validate Command

```
Implement src/commands/validate.ts for validating configuration and structure.

COMMAND: vocareum-publish --validate [--strict]

LOGIC:
1. Load config from vocareum.yaml
2. Run validateStructure() from validator
3. If --vocareum flag: also run validateWithVocareum()
4. Display results using displayValidationResult()
5. Exit with code 0 if valid, 1 if errors

--strict flag: Treat warnings as errors

OUTPUT EXAMPLES:

SUCCESS:
```
✓ Validation Passed

Configuration:
  ✓ Schema version 1.0
  ✓ All required fields present
  ✓ 3 assignments configured

Structure:
  ✓ assignment1/ exists with 2 parts
  ✓ assignment2/ exists with 1 part
  ✓ lab3-neural-networks/ exists with 2 parts

Ready to publish!
```

WITH WARNINGS:
```
⚠ Validation Warnings

Configuration: ✓
Structure: ⚠

Warnings (review but publish can proceed):
  ⚠ Folder "assignment_old/" has no YAML entry (will be ignored)
  ⚠ Folder "temp_lab/" has no YAML entry (will be ignored)

Suggestion: Remove orphaned folders or add YAML entries.
Use --fix to interactively resolve.

Continue with publish? [y/N]
```

FAILURES:
```
❌ Validation Failed

Errors (must fix before publish):
  ✗ Assignment "assignment3" references path "assignment3/" - folder not found
  ✗ Assignment "assignment1", Part "part3" - folder not found at assignment1/part3/

Fix these issues and run vocareum-publish --validate again.

Quick fixes:
  • Run: vocareum-publish new assignment3
  • Or remove invalid entries from vocareum.yaml
```
```

### Prompt 5.4: Fix Command

```
Implement src/commands/fix.ts for auto-fixing validation issues.

Based on Architecture Module 8.

COMMAND: vocareum-publish --fix

LOGIC:
1. Run validation to get errors and warnings
2. For each issue, prompt user for action:

ORPHANED FOLDER (warning):
```
? Folder "temp_lab/" has no YAML entry. What should we do?
  > Add YAML entry
    Ignore (add to exclude list)
    Skip for now

[If Add YAML entry selected]
? Assignment name: Temporary Lab
? Create from template? [Y/n] Y
? Number of parts detected: 1. Correct? [Y/n] Y
✓ Added YAML entry for temp_lab/
```

MISSING FOLDER (error):
```
? YAML entry for "assignment3" but folder missing. What should we do?
  > Create folder structure
    Remove YAML entry
    Skip for now

[If Create folder structure]
? How many parts? 2
? Part 1 path: part1
? Part 2 path: part2
✓ Created folder structure for assignment3/
```

3. Apply all fixes
4. Update vocareum.yaml
5. Display summary

SUMMARY:
```
✓ Applied 3 fixes:
  • Added YAML entry for temp_lab/
  • Created folder structure for assignment3/
  • Removed YAML entry for old_assignment/

Run vocareum-publish --validate to verify.
```

NON-INTERACTIVE MODE (--non-interactive):
- Skip orphaned folders
- Error on missing folders
- No user prompts
```

### Prompt 5.5: Publish Command

```
Implement src/commands/publish.ts as the main publish command.

COMMAND: vocareum-publish [options]

OPTIONS:
- --dry-run: Preview changes without executing
- --assignment <path>: Publish specific assignment only
- --part <path>: Publish specific part only
- --force-all: Re-upload everything (ignore change detection)
- --sync-deletes: Enable file deletion (experimental)
- --auto-commit: Auto-commit config updates (local use only)
- --non-interactive: No prompts (for CI/CD)
- --verbose: Detailed logging

WORKFLOW:
1. Load config
2. Validate structure (error if invalid)
3. Authenticate with Vocareum API
4. Generate reconciliation plan
5. Display plan
6. If not --dry-run and not --non-interactive:
   - Prompt: "Continue? [y/N]"
7. Execute publish
8. Display results
9. Update vocareum.yaml with new IDs and hashes
10. If --auto-commit (and not CI/CD):
    - Prompt: "Commit changes? [Y/n]"
    - Git commit with [skip ci]

DRY-RUN OUTPUT:
```
📋 Publish Plan (DRY RUN - no changes will be made)
═══════════════════════════════════════════════════════

Course: Introduction to Data Science (67890)
  Status: EXISTS - will update settings

Assignments:
  + Lab 2: Classification (NEW)
    Status: WILL CREATE from template
    Parts:
      + Part 1: Implementation (NEW)
        Directories to upload: startercode, scripts
  
  ✓ Lab 1: Introduction (11111)
    Status: EXISTS - will update
    Parts:
      ✓ Part 1 (22222) - changed: startercode
      ✓ Part 2 (33333) - no changes

Summary:
  - 1 assignment to create
  - 1 assignment to update
  - 3 parts to process
  - Estimated API calls: ~8
```

ACTUAL PUBLISH OUTPUT:
```
Publishing to Vocareum...

✓ Updated course settings
✓ Copied template assignment → 44444
✓ Mapped 1 part: [55555]
✓ Updated assignment settings
✓ Part 1 (55555)
  ↳ Uploaded startercode/ (15 files, 234 KB) - 2.3s
  ↳ Uploaded scripts/ (3 files, 12 KB) - 0.5s

✓ Publish complete! (8.7s)
✓ Updated vocareum.yaml with new IDs and content hashes

Commit changes? [Y/n]
```

ERROR HANDLING:
- Graceful failures with clear messages
- Continue vs abort based on --abort-on-error
- Log all errors for troubleshooting
```

### Prompt 5.6: Main CLI Entry Point

```
Implement src/index.ts as the main CLI entry point using Commander.js.

SETUP:
- #!/usr/bin/env node shebang
- Import commander
- Define program metadata (name, version, description)
- Register all commands
- Parse process.argv

COMMANDS TO REGISTER:
1. init [options]
2. new <assignment-path>
3. validate [options]
4. fix
5. publish (default command) [options]

GLOBAL OPTIONS:
- --config <path>: Path to vocareum.yaml (default: ./vocareum.yaml)
- --verbose: Enable debug logging
- --version: Show version
- --help: Show help

EXAMPLE STRUCTURE:
```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { newCommand } from './commands/new';
// ... other imports

const program = new Command();

program
  .name('vocareum-publish')
  .description('Publish assignment content from GitHub to Vocareum')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize a new course repository')
  .option('--import', 'Import existing course')
  .option('--course-id <id>', 'Course ID for import')
  .action(initCommand);

program
  .command('new <path>')
  .description('Create new assignment structure')
  .action(newCommand);

// ... more commands

// Default command (publish)
program
  .argument('[options]', 'Publish options')
  .option('--dry-run', 'Preview changes')
  .option('--assignment <path>', 'Publish specific assignment')
  // ... more options
  .action(publishCommand);

program.parse();
```

Error handling with process.exit codes.
```

---

## Phase 6: GitHub Action

### Prompt 6.1: GitHub Action Wrapper

```
Implement action/index.ts for GitHub Action integration.

REQUIREMENTS:
- Use @actions/core for inputs/outputs/logging
- Use @actions/github for context
- Wrap CLI functionality

INPUTS (from action.yml):
- config-file: Path to vocareum.yaml (default: vocareum.yaml)
- api-key: Vocareum API key (required, from secrets)
- dry-run: Preview mode (default: false)
- assignment: Specific assignment to publish
- sync-deletes: Enable file deletion (default: false)
- auto-commit: Auto-commit updates (default: false, NOT RECOMMENDED)
- verbose: Verbose logging (default: false)

OUTPUTS:
- success: true/false
- summary: Publish summary text
- created-ids: JSON of created entities
- updated-ids: JSON of updated entities

IMPLEMENTATION:
```typescript
import * as core from '@actions/core';
import * as github from '@actions/github';
import { loadConfig } from '../src/core/config';
import { VocareumClient } from '../src/api/client';
import { publish } from '../src/core/publisher';

async function run() {
  try {
    const configFile = core.getInput('config-file');
    const apiKey = core.getInput('api-key', { required: true });
    const dryRun = core.getBooleanInput('dry-run');
    const autoCommit = core.getBooleanInput('auto-commit');
    
    // Warn if auto-commit enabled
    if (autoCommit) {
      core.warning(
        'auto-commit is enabled in CI/CD. This is not recommended. ' +
        'Create new assignments locally and commit IDs before using CI/CD.'
      );
    }
    
    // Load config
    const config = await loadConfig(configFile);
    
    // Create client
    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);
    
    // Execute publish
    const result = await publish(config, client, {
      dryRun,
      nonInteractive: true,
      autoCommit,
      syncDeletes: core.getBooleanInput('sync-deletes'),
      assignment: core.getInput('assignment'),
      verbose: core.getBooleanInput('verbose')
    });
    
    // Set outputs
    core.setOutput('success', result.success.toString());
    core.setOutput('summary', result.summary);
    core.setOutput('created-ids', JSON.stringify(result.created));
    core.setOutput('updated-ids', JSON.stringify(result.updated));
    
    // Add job summary
    await core.summary
      .addHeading('Vocareum Publish Results')
      .addRaw(formatSummaryMarkdown(result))
      .write();
    
    // Warn about orphaned assignments
    if (result.orphanedInVocareum?.length > 0) {
      core.warning(
        `Found ${result.orphanedInVocareum.length} assignment(s) in Vocareum not in config. ` +
        'These were NOT deleted. Manual cleanup required if desired.'
      );
    }
    
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

ERROR HANDLING:
- Catch all errors
- Set action as failed with clear message
- Log stack traces for debugging
```

### Prompt 6.2: GitHub Action Metadata

```
Create action/action.yml for GitHub Action marketplace.

CONTENT:
```yaml
name: 'Vocareum Publisher'
description: 'Publish assignment content from GitHub to Vocareum'
author: 'Vocareum'
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
  sync-deletes:
    description: 'Delete files from Vocareum not in Git (experimental)'
    required: false
    default: 'false'
  auto-commit:
    description: 'Auto-commit config updates (NOT RECOMMENDED for CI/CD)'
    required: false
    default: 'false'
  verbose:
    description: 'Enable verbose logging'
    required: false
    default: 'false'

outputs:
  success:
    description: 'Whether publish succeeded (true/false)'
  summary:
    description: 'Publish summary text'
  created-ids:
    description: 'JSON of newly created entity IDs'
  updated-ids:
    description: 'JSON of updated entity IDs'

runs:
  using: 'node20'
  main: 'dist/action/index.js'
```
```

---

## Phase 7: Documentation

### Prompt 7.1: README.md

```
Create comprehensive README.md for the project root.

SECTIONS:
1. Project Title and Description
2. Features
3. Installation (npm install -g vocareum-publisher)
4. Quick Start
5. Usage Examples (CLI and GitHub Action)
6. Configuration (vocareum.yaml structure)
7. Commands Reference
8. Workflows (creating assignments, updating content)
9. CI/CD Integration
10. Troubleshooting
11. Contributing
12. License

Use badges for:
- npm version
- CI status
- License
- Node version

Include code examples with syntax highlighting.
```

### Prompt 7.2: Documentation Site

```
Create docs/ folder with comprehensive documentation.

FILES TO CREATE:
1. docs/getting-started.md
   - Prerequisites
   - Installation
   - Initial setup (both fresh and import)
   - First publish

2. docs/configuration.md
   - vocareum.yaml schema
   - All configuration options
   - Examples for common scenarios

3. docs/commands.md
   - Complete CLI reference
   - All commands and options
   - Examples for each

4. docs/workflows.md
   - Creating new assignments
   - Updating content
   - Managing multiple assignments
   - Team workflows

5. docs/ci-cd.md
   - GitHub Actions setup
   - Best practices
   - Example workflows
   - Troubleshooting CI/CD issues

6. docs/api.md
   - Vocareum API integration details
   - Rate limiting
   - Error handling
   - Known limitations

7. docs/troubleshooting.md
   - Common errors and solutions
   - Debugging tips
   - FAQ

8. docs/architecture.md
   - High-level architecture
   - Module descriptions
   - Data flow diagrams

Use clear formatting, lots of examples, and link between docs.
```

---

## Phase 8: Testing

### Prompt 8.1: Unit Tests Setup

```
Set up Vitest for unit testing.

Create test/unit/ structure:
- config.test.ts
- validator.test.ts
- mapper.test.ts
- uploader.test.ts
- utils.test.ts

For each module, write tests covering:
1. Happy path
2. Error conditions
3. Edge cases
4. Input validation

EXAMPLE for mapper:
```typescript
import { describe, it, expect } from 'vitest';
import { mapParts, PartMappingError } from '../../src/core/mapper';

describe('mapParts', () => {
  it('should map parts by seqnum order', () => {
    const configParts = [
      { part_id: null, path: 'part1', name: 'Part 1' },
      { part_id: null, path: 'part2', name: 'Part 2' }
    ];
    
    const apiParts = [
      { part_id: '222', seqnum: '1' },
      { part_id: '111', seqnum: '0' }
    ];
    
    const result = mapParts(configParts, apiParts);
    
    expect(result).toHaveLength(2);
    expect(result[0].apiPartId).toBe('111'); // seqnum 0
    expect(result[1].apiPartId).toBe('222'); // seqnum 1
  });
  
  it('should throw on part count mismatch', () => {
    const configParts = [{ part_id: null, path: 'part1' }];
    const apiParts = [
      { part_id: '111', seqnum: '0' },
      { part_id: '222', seqnum: '1' }
    ];
    
    expect(() => mapParts(configParts, apiParts))
      .toThrow(PartMappingError);
  });
});
```

Aim for 80%+ code coverage.
```

### Prompt 8.2: Integration Tests

```
Create test/integration/ for API integration tests.

MOCK VOCAREUM API:
- Create mock server using msw or nock
- Simulate API responses based on Postman docs
- Test full workflows end-to-end

FILES:
- api-client.test.ts: Test VocareumClient
- publish-workflow.test.ts: Test full publish flow
- init-workflow.test.ts: Test init command

EXAMPLE:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { VocareumClient } from '../../src/api/client';
import { setupMockServer } from '../helpers/mock-server';

describe('VocareumClient integration', () => {
  let client: VocareumClient;
  let mockServer: MockServer;
  
  beforeEach(() => {
    mockServer = setupMockServer();
    client = new VocareumClient('test-key', 'http://localhost:3000');
  });
  
  it('should copy assignment and return new IDs', async () => {
    mockServer.mock('POST', '/v1/assignments/999/copy', {
      assignment_id: '123',
      parts: [
        { part_id: '456', seqnum: '0', name: 'Part 1' }
      ]
    });
    
    const result = await client.copyAssignment('999');
    
    expect(result.assignment_id).toBe('123');
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].seqnum).toBe('0');
  });
});
```

Test error conditions, retries, rate limiting.
```

### Prompt 8.3: Test Fixtures

```
Create test/fixtures/ with sample data for testing.

FILES:
1. valid-config.yaml
   - Complete valid vocareum.yaml
   - Multiple assignments and parts
   - All optional fields

2. invalid-configs/
   - missing-required-fields.yaml
   - invalid-version.yaml
   - malformed.yaml

3. sample-course/
   - Complete course structure
   - Multiple assignments with content
   - For testing file operations

4. api-responses/
   - course.json
   - assignments-list.json
   - parts-list.json
   - copy-response.json

Use realistic data matching Vocareum API format.
```

---

## Phase 9: Examples and Templates

### Prompt 9.1: Example Course Repository

```
Create examples/sample-course/ as a complete working example.

STRUCTURE:
sample-course/
├── vocareum.yaml (complete with 2 assignments)
├── README.md (explains the example)
├── lab1-introduction/
│   ├── part1/
│   │   ├── startercode/
│   │   │   ├── main.py
│   │   │   └── README.md
│   │   ├── scripts/
│   │   │   └── grade.sh
│   │   ├── docs/
│   │   │   └── instructions.md
│   │   └── data/
│   │       └── sample.csv
│   └── part2/
│       └── ... (similar structure)
└── lab2-analysis/
    └── part1/
        └── ... (similar structure)

CONTENT:
- lab1 should be a simple "Hello World" style introduction
- lab2 should demonstrate data analysis with pandas
- Include realistic grading scripts
- Include clear instructions for students

This serves as both example and template for users.
```

### Prompt 9.2: GitHub Action Workflow Templates

```
Create examples/workflows/ with common GitHub Action workflows.

1. basic-publish.yml
   - Trigger on push to main
   - Publish all changes
   - Non-interactive mode

2. manual-trigger.yml
   - Workflow dispatch
   - Allow specifying assignment to publish
   - Optional dry-run

3. pr-preview.yml
   - Trigger on pull request
   - Dry-run only (no actual publish)
   - Comment results on PR

4. scheduled-sync.yml
   - Scheduled daily sync
   - Check for drift between Git and Vocareum
   - Alert if differences found

Each with detailed comments explaining configuration.
```

---

## Phase 10: Final Polish

### Prompt 10.1: Error Messages and UX

```
Review and improve all user-facing messages throughout the codebase.

REQUIREMENTS:
1. Error messages should be:
   - Clear and actionable
   - Include suggested fixes
   - Reference documentation when helpful
   - Never expose internal details

2. Progress indicators:
   - Use ora spinners for long operations
   - Show file counts and sizes
   - Display timing information

3. Confirmations:
   - Always confirm destructive operations
   - Provide clear [Y/n] or [y/N] defaults
   - Allow --yes flag to skip confirmations

4. Help text:
   - Every command should have detailed help
   - Include examples in help text
   - Cross-reference related commands

EXAMPLES OF GOOD ERROR MESSAGES:
```
❌ Error: Assignment folder not found

Assignment "lab3-ml" references path "lab3-ml/" which doesn't exist.

To fix:
  1. Create the folder: vocareum-publish new lab3-ml
  2. Or update vocareum.yaml to use correct path
  3. Or remove this assignment from vocareum.yaml

See: docs/troubleshooting.md#missing-folders
```

Review every console.log, throw new Error, and user-facing text.
```

### Prompt 10.2: Performance Optimization

```
Optimize performance throughout the codebase.

AREAS TO OPTIMIZE:
1. File operations:
   - Use streaming for large files
   - Implement file caching where appropriate
   - Parallelize directory reads

2. API calls:
   - Cache assignment lists during single execution
   - Implement request batching if API supports
   - Use connection pooling

3. Change detection:
   - Only calculate hashes for directories in config
   - Skip unchanged directories entirely
   - Cache hash calculations

4. Validation:
   - Short-circuit validation on first critical error
   - Parallelize independent validation checks

EXAMPLE optimizations:
```typescript
// Before: Sequential hash calculation
for (const dir of directories) {
  hashes[dir] = await calculateHash(dir);
}

// After: Parallel hash calculation
const hashPromises = directories.map(dir => 
  calculateHash(dir).then(hash => [dir, hash])
);
const hashEntries = await Promise.all(hashPromises);
hashes = Object.fromEntries(hashEntries);
```

Add timing logs in verbose mode to identify bottlenecks.
```

### Prompt 10.3: Security Audit

```
Review codebase for security issues.

CHECK:
1. Input validation:
   - All user inputs validated
   - Path traversal prevented
   - Command injection prevented
   - YAML parsing safe (no eval)

2. Credentials:
   - API keys never logged
   - No credentials in error messages
   - Environment variables used correctly
   - No hardcoded secrets

3. File operations:
   - No arbitrary file writes
   - Proper permissions on created files
   - Temp files cleaned up

4. Dependencies:
   - Run npm audit
   - Check for known vulnerabilities
   - Keep dependencies up to date

5. API interactions:
   - HTTPS enforced
   - Request validation
   - Response validation
   - Rate limiting respected

Document security considerations in README.
```

---

## Phase 11: Release Preparation

### Prompt 11.1: Build and Package

```
Prepare for npm release.

TASKS:
1. Update package.json:
   - Set version to 1.0.0
   - Add keywords for npm search
   - Set repository, bugs, homepage URLs
   - Add author and contributors
   - Set license (MIT or Apache 2.0)

2. Build process:
   - Run TypeScript compiler
   - Verify bin entry points work
   - Test in clean environment

3. Create .npmignore:
   - Exclude src/, test/, docs/, examples/
   - Include dist/, README.md, LICENSE
   - Keep package small

4. Test local installation:
   ```bash
   npm pack
   npm install -g vocareum-publisher-1.0.0.tgz
   vocareum-publish --version
   vocareum-publish --help
   ```

5. Verify all commands work after installation
```

### Prompt 11.2: Release Checklist

```
Create RELEASE_CHECKLIST.md with all steps for releasing.

CONTENT:
- [ ] All tests passing
- [ ] Documentation complete and reviewed
- [ ] Examples tested and working
- [ ] CHANGELOG.md updated
- [ ] Version bumped in package.json
- [ ] Build successful (npm run build)
- [ ] Package tested locally (npm pack)
- [ ] Security audit clean (npm audit)
- [ ] License file present
- [ ] README accurate
- [ ] GitHub Action tested in real repository
- [ ] Tagged in git (v1.0.0)
- [ ] Published to npm (npm publish)
- [ ] GitHub release created with notes
- [ ] Marketplace listing updated (for Action)
- [ ] Documentation site deployed
- [ ] Announcement prepared

Include detailed instructions for each step.
```

---

## Usage Instructions for AI Agent

### How to Use These Prompts:

1. **Sequential Execution**: Run prompts in order (Phase 0 → Phase 11)

2. **Provide Context**: For each prompt, give the AI agent access to:
   - The three specification documents (PRD, Architecture, Summary)
   - Previous implementation (if iterating on a phase)
   - Vocareum API documentation

3. **Verify Output**: After each phase:
   - Review generated code
   - Run tests
   - Check against specifications
   - Iterate if needed

4. **Iterative Refinement**: If output doesn't match specs:
   ```
   The implementation of [module] doesn't match the specification in [document].
   
   Specifically:
   - [Issue 1]
   - [Issue 2]
   
   Please revise to match the exact requirements in the Architecture document, Section [X].
   ```

5. **Testing Between Phases**: After completing core phases (1-4), run integration tests before proceeding to commands.

6. **Documentation Review**: Have AI agent review all user-facing text for clarity and consistency.

---

## Notes for Development

- **Type Safety**: Enforce strict TypeScript throughout
- **Error Handling**: Every async operation needs try-catch
- **Logging**: Use logger utility consistently, never console.log directly
- **Testing**: Write tests as you implement, not after
- **Documentation**: Keep inline comments focused on "why", not "what"
- **Git Commits**: Commit after each successful phase

---

## Estimated Timeline

- **Phase 0-1**: 1-2 days (Setup & Infrastructure)
- **Phase 2**: 2-3 days (Configuration & Validation)
- **Phase 3**: 3-4 days (API Client)
- **Phase 4**: 4-5 days (Core Business Logic)
- **Phase 5**: 3-4 days (CLI Commands)
- **Phase 6**: 1-2 days (GitHub Action)
- **Phase 7**: 2-3 days (Documentation)
- **Phase 8**: 3-4 days (Testing)
- **Phase 9**: 1-2 days (Examples)
- **Phase 10**: 2-3 days (Polish)
- **Phase 11**: 1-2 days (Release)

**Total: 8-12 weeks** (with testing and iteration)

---

## Success Criteria

Implementation is complete when:
- ✅ All commands work as specified in PRD
- ✅ All tests passing (80%+ coverage)
- ✅ Documentation complete and accurate
- ✅ Example repository works end-to-end
- ✅ GitHub Action works in real repository
- ✅ No security vulnerabilities
- ✅ Performance acceptable (< 30s for typical publish)
- ✅ Error messages clear and actionable