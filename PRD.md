# Product Requirements Document: GitHub to Vocareum Auto-Publisher

**Version:** 1.0  
**Date:** February 12, 2026  
**Status:** Draft for Review

---

## Executive Summary

An open-source CLI tool and GitHub Action that Vocareum customers can deploy in their own environments to automate publishing of assignment content from private GitHub repositories to Vocareum course workspaces using Vocareum's API.

**Key Value Proposition:** Enable instructors to maintain assignment content in Git with full version control while seamlessly publishing to Vocareum, eliminating manual synchronization and reducing errors.

---

## Problem Statement

Currently, publishing assignment content to Vocareum requires manual steps, creating several pain points:
- Difficult to keep assignment content in sync between GitHub (source of truth) and Vocareum
- Version control of assignment materials is disconnected from deployment
- Propagating updates across multiple assignments is time-consuming
- Risk of inconsistencies between local development and production content
- No audit trail of what was published when

---

## Goals

### Primary Goals
1. Provide a self-service tool that Vocareum customers can install and operate independently
2. Enable automated publishing from GitHub repos to Vocareum workspaces
3. Support triggered updates (manual trigger initially, extensible for CI/CD)
4. Maintain GitHub as the source of truth for assignment content
5. Preserve Vocareum's expected directory structure and settings
6. Support creation and configuration of Vocareum entities (courses, assignments, parts)

### Success Metrics
- Number of GitHub stars/forks (community adoption)
- Download/install statistics (npm)
- Time saved compared to manual publishing (customer feedback)
- Number of organizations successfully using the tool
- Issue resolution time and community contributions
- Documentation clarity (measured by support questions)

---

## Target Audience

- Universities and educational institutions using Vocareum
- Course instructors and teaching staff managing assignments
- DevOps/IT teams supporting educational infrastructure
- Instructional designers managing course content at scale

**Technical Profile:** Comfortable with Git, command line tools, and basic YAML configuration. May range from instructor-developers to dedicated DevOps teams.

---

## Non-Goals (Initial Release)

- Bi-directional sync (Vocareum → GitHub)
- Automatic conflict resolution
- Student submission handling
- Real-time synchronization
- Course operations (starting labs, enrolling learners, grading)
- Hosted/SaaS solution (customers self-host only)
- **Deletion of assignments/parts from Vocareum** (see Deletion Policy below)

---

## Deletion Policy

### Assignment/Part Deletion: Manual Only

**The tool will NOT delete assignments or parts from Vocareum**, even if they are removed from `vocareum.yaml`.

**Rationale:**
- **Data Safety:** Assignments may contain student submissions and grading data
- **Accidental Deletion Risk:** Removing a line from YAML could destroy critical educational data
- **Intentionality:** Deletion should be an explicit, manual operation in Vocareum UI

**Behavior:**
- If an assignment is removed from `vocareum.yaml`, it remains in Vocareum
- Tool logs a warning: "Assignment X exists in Vocareum but not in config"
- Users must manually archive/delete in Vocareum UI

### File Deletion: Opt-in Only

File-level deletion within workspace directories (startercode/, scripts/, etc.) is supported but **opt-in only** via `sync_deletes: true`.

**Default behavior:** Additive only (files deleted locally remain on Vocareum)  
**With sync_deletes:** Files mirror Git exactly (deleted locally = deleted on Vocareum)

See "File Deletion & Synchronization" section for details.

---

## Proposed Solution

### Deliverables

**1. GitHub Repository** containing:
   - CLI tool (Node.js/TypeScript)
   - GitHub Action for CI/CD integration
   - Comprehensive documentation
   - Example configurations
   - Installation guide

**2. Distribution:**
   - npm package (for CLI)
   - GitHub Action (via GitHub Marketplace)
   - Docker container (optional, Phase 2)

**3. Documentation:**
   - Quick start guide
   - API credential setup instructions
   - Repository structure guidelines
   - Troubleshooting guide
   - Example workflows

---

## Repository Structure

### Course Repository Layout

One repository per Vocareum course, containing multiple assignments with parts:

```
course-repo/
├── vocareum.yaml           # Configuration and metadata
├── .gitignore
├── README.md
├── assignment1/
│   ├── part1/
│   │   ├── startercode/   # Student-visible files
│   │   ├── scripts/       # Grading/setup scripts
│   │   ├── docs/          # Documentation
│   │   └── data/          # Datasets
│   └── part2/
│       └── ...
├── assignment2/
│   └── part1/
│       └── ...
└── assignment3/
    └── ...
```

### Configuration File (vocareum.yaml)

```yaml
version: "1.0"

vocareum:
  org_id: "12345"
  course_id: "67890"
  template_assignment_id: "99999"
  api_base_url: "https://api.vocareum.com"  # Optional

assignments:
  - assignment_id: "11111"
    name: "Lab 1: Introduction"
    path: "assignment1"
    settings:
      due_date: "2025-03-15T23:59:00Z"
      description: "Introduction to the course"
    parts:
      - part_id: "22222"
        path: "part1"
        name: "Part 1: Setup"
      - part_id: "33333"
        path: "part2"
        name: "Part 2: Analysis"
  
  - assignment_id: null  # Will be created
    name: "Lab 2: Classification"
    path: "assignment2"
    create_from_template: true
    settings:
      due_date: "2025-03-22T23:59:00Z"
    parts:
      - part_id: null
        path: "part1"
        name: "Part 1: Implementation"
        # Optional: specify which directories exist for this part
        directories: ["startercode", "scripts"]  # Omit docs/ and data/ if not needed
      - part_id: null
        path: "part1"
        name: "Part 1: Implementation"
        # Optional: specify which directories exist for this part
        directories: ["startercode", "scripts"]  # Omit docs/ and data/ if not needed

publish_options:
  on_missing_id: "skip"       # skip | abort
  auto_commit: false          # Auto-commit config updates (LOCAL USE ONLY)
  abort_on_error: false       # Continue on errors
  sync_deletes: false         # Delete files from Vocareum not in Git
  exclude_patterns:           # Files to exclude from upload
    - "*.tmp"
    - ".DS_Store"
    - "*.pyc"

publish_history:
  - timestamp: "2025-02-10T14:30:00Z"
    commit_sha: "abc123def456"
    published_by: "github-actions"
    content_state:
      # Directory-level hashes for change detection
      "assignment1/part1/startercode": "sha256:abc123..."
      "assignment1/part1/scripts": "sha256:def456..."
      "assignment1/part1/docs": "sha256:ghi789..."
      "assignment1/part1/data": "sha256:jkl012..."
      "assignment1/part2/startercode": "sha256:mno345..."
    created:
      - assignment: "44444"
        parts: ["55555"]
    updated:
      - assignment: "11111"
        parts: ["22222", "33333"]
```

---

## Core Workflows

### 1. Initial Setup Workflow

#### Option A: Fresh Start (New Course Content)

#### Option A: Fresh Start (New Course Content)

**Prerequisites:**
1. Vocareum course exists
2. Template assignment exists in Vocareum
3. Vocareum API credentials available

**Steps:**
```bash
# 1. Initialize repository
mkdir my-course-repo && cd my-course-repo
git init
vocareum-publish init

# 2. Follow interactive prompts
#    - Enter org_id, course_id, template_assignment_id
#    - Tool validates against Vocareum API
#    - Generates vocareum.yaml and directory structure

# 3. Create first assignment
cp -r example-assignment assignment1
# Edit vocareum.yaml to add assignment
# Add content to assignment1/part1/startercode/ etc.

# 4. Test and publish
vocareum-publish --dry-run
vocareum-publish

# 5. Commit to Git
git add .
git commit -m "Initial course content"
git push
```

---

### 2. Creating New Assignments (Local Workflow)

**Purpose:** Add new assignments to an existing course repository.

**Recommended Workflow (Local CLI):**

```bash
# 1. Create assignment structure
vocareum-publish new lab3-neural-networks

# Interactive prompts:
? Assignment name: Lab 3: Neural Networks
? Number of parts: 2
? Part 1 name: Theory
? Part 2 name: Implementation
? Create all directories (startercode, scripts, docs, data)? [Y/n] Y

# Creates:
# - lab3-neural-networks/ folder with part structure
# - Entry in vocareum.yaml with assignment_id: null

✓ Created assignment structure at lab3-neural-networks/
✓ Added entry to vocareum.yaml

Next steps:
1. Add content to lab3-neural-networks/part1/startercode/ etc.
2. Run: vocareum-publish --validate
3. Run: vocareum-publish (creates in Vocareum)
4. Commit updated vocareum.yaml with new IDs

# 2. Add content to directories
# Edit files in lab3-neural-networks/part1/startercode/ etc.

# 3. Validate before publishing
vocareum-publish --validate

✓ Configuration valid
✓ All assignment folders exist
✓ All part folders exist

Ready to publish!

# 4. Publish to Vocareum (creates assignment, updates IDs)
vocareum-publish

# Tool creates assignment in Vocareum
# Updates vocareum.yaml with new assignment_id and part_ids
# Prompts: "Commit changes? [Y/n]"

# 5. Commit and push
git add .
git commit -m "Add Lab 3: Neural Networks"
git push

# 6. CI/CD handles future updates automatically
# (No need for creation in CI/CD since IDs now exist)
```

**Why Local Creation?**
- Avoids CI/CD complexity with auto-commit
- Clear, controlled process
- IDs stored before CI/CD runs
- No risk of duplicate creation

---

### 3. Publishing Workflow

**Prerequisites:**
1. Existing Vocareum course with assignments
2. Vocareum API credentials

**Steps:**
```bash
# 1. Initialize with import
mkdir my-course-repo && cd my-course-repo
git init
vocareum-publish init --import --course-id 67890

# 2. Follow interactive prompts
#    - Enter org_id
#    - Select template assignment from existing list
#    - Tool downloads all content to imported/ directories

# 3. Organize imported content
#    - Files are in assignment1/part1/imported/
#    - Manually move to startercode/, scripts/, docs/, data/
#    - Delete imported/ directories when done

# 4. Commit to Git
git add .
git commit -m "Initial import from Vocareum"
git push
```

---

### 3. Publishing Workflow

#### Content Update Process

**Stage 1: Parse and Validate**
- Read vocareum.yaml
- Validate schema version and required fields
- **Validate directory structure:**
  - For each YAML entry: Check folder exists at specified path
  - For each folder: Check if YAML entry exists (warn if orphaned)
  - For each part: Check part folder exists
  - Check required subdirectories exist (if specified in config)
- Generate validation report (errors block publish, warnings logged)

**Stage 2: Authenticate and Discover**
- Authenticate with Vocareum API
- Fetch existing course, assignments, and parts
- If `deterministic_lookup` enabled: Build name-to-ID mapping for assignments
- Build state map of what exists in Vocareum

**Stage 3: Reconciliation**
- Compare local config with Vocareum state
- For assignments with `assignment_id: null`:
  - Mark for creation via template copy
- For assignments with existing IDs:
  - Verify exists in Vocareum
  - Mark for update if exists
  - Error if ID not found in Vocareum
- Determine actions needed for each entity:
  - **Course**: Update if settings changed (never create)
  - **Assignment**: Create (via template copy) or update
  - **Part**: Create or update (IDs regenerated on copy)
  - **Content**: Detect changed directories, upload only changed content
- **Note:** Assignments in Vocareum but not in config are logged as warnings (not deleted)
- **Note:** Folders without YAML entries are logged as warnings (ignored)

**Stage 4: Display Plan**
```
📋 Publish Plan
═══════════════════════════════════════════════════════

Course: Introduction to Data Science (67890)
  Status: EXISTS - will update settings

Assignments:
  ✓ Lab 1: Linear Regression (11111)
    Status: EXISTS - will update content
    Parts:
      ✓ Part 1: Data Prep (22222) - will update
      ✓ Part 2: Modeling (33333) - will update
  
  + Lab 2: Classification (NEW)
    Status: WILL CREATE from template
    Parts:
      + Part 1: Implementation (NEW)

Summary:
  - 1 course to update
  - 1 assignment to update
  - 1 assignment to create
  - 3 parts to update/create
  - Estimated API calls: ~12

Continue? [y/N]
```

**Stage 5: Execute**
1. Update course settings (if changed)
2. For each assignment:
   - If creating: Copy from template → capture new assignment_id and part_ids
   - Update assignment settings
   - For each part:
     - Update part settings
     - Detect changed directories (using content_state from last publish)
     - Upload only changed content (startercode, scripts, docs, data)
     - If sync_deletes enabled: Delete files not present locally

**Stage 6: Update Config**
- Write new IDs to vocareum.yaml
- Calculate and store directory hashes in content_state
- Append to publish_history (keep last 10 entries)
- **If auto_commit enabled (LOCAL USE ONLY):** 
  - Commit changes with `[skip ci]` message
  - Prompt user for confirmation

**Validation Output Examples:**

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

```
⚠ Validation Warnings

Warnings (review but publish can proceed):
  ⚠ Folder "assignment_old/" has no YAML entry (will be ignored)
  ⚠ Folder "temp_lab/" has no YAML entry (will be ignored)

Suggestion: Remove orphaned folders or add YAML entries.
Use --fix to interactively resolve.

Continue with publish? [y/N]
```

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

---

### 4. Validation & Fix Workflow

**Validate Configuration:**
```bash
vocareum-publish --validate

# Checks:
# ✓ YAML syntax and schema
# ✓ All referenced folders exist
# ✓ All folders have YAML entries (warn if not)
# ✓ Part structure is valid
```

**Auto-Fix Issues:**
```bash
vocareum-publish --fix

# Interactive mode:
? Found orphaned folder "temp_lab/". What should we do?
  1) Add YAML entry
  2) Ignore (add to exclude list)
  3) Skip for now
  
Choice: 1

? Assignment name: Temporary Lab
? Create from template? [Y/n] Y
? Number of parts detected: 1. Correct? [Y/n] Y

✓ Added YAML entry for temp_lab/

? Found YAML entry for "assignment3" but folder missing. What should we do?
  1) Create folder structure
  2) Remove YAML entry
  3) Skip for now
  
Choice: 1

? How many parts? 2
? Part 1 path: part1
? Part 2 path: part2

✓ Created folder structure for assignment3/

Summary:
  • Added 1 YAML entry
  • Created 1 folder structure
  
Run vocareum-publish --validate to verify.
```

---

### 5. Template-Based Assignment Creation

**Key Behavior:**
- New assignments are created by copying a template assignment
- Template is a regular Vocareum assignment (can be active)
- Copy operation creates new assignment_id AND new part_ids
- Content from GitHub immediately overwrites template content

**Deterministic Lookup (Recommended for CI/CD):**
To avoid storing IDs and prevent duplicate creation:
```yaml
- assignment_id: null
  name: "Lab 2: Classification"
  create_from_template: true
  assignment_name_for_lookup: "Lab 2: Classification"
```

On each run:
1. Tool searches Vocareum for assignment named "Lab 2: Classification"
2. If found: Use existing ID (update content)
3. If not found: Create new assignment via template copy
4. This prevents duplicate creation even if config isn't updated with new ID

**Part Mapping:**
Template has parts A, B, C → Copy creates parts X, Y, Z → Config maps by position:
Config parts mapped by position → seqnum:
```yaml
parts:
  - part_id: null       # Position 0 → seqnum "0" → maps to ID "123"
    path: "part1"
    name: "Part 1: Setup"
  - part_id: null       # Position 1 → seqnum "1" → maps to ID "456"
    path: "part2"
    name: "Part 2: Analysis"
  - part_id: null       # Position 2 → seqnum "2" → maps to ID "789"
    path: "part3"
    name: "Part 3: Evaluation"
```

After successful creation, vocareum.yaml is updated:
```yaml
parts:
  - part_id: "123"      # Updated from null
    path: "part1"
    name: "Part 1: Setup"
  - part_id: "456"      # Updated from null
    path: "part2"
    name: "Part 2: Analysis"
  - part_id: "789"      # Updated from null
    path: "part3"
    name: "Part 3: Evaluation"
```

**Validation:**
- Part count must match: Config defines N parts, template must have N parts
- Parts are matched by order/position (config array index → seqnum)
- If mismatch, publish fails with clear error

---

## Usage Patterns

### CLI Tool

```bash
# Initialize new repository
vocareum-publish init

# Initialize by importing existing course
vocareum-publish init --import --course-id 67890

# Create new assignment with folder structure and YAML entry
vocareum-publish new <assignment-path>
# Example: vocareum-publish new lab3-neural-networks
# Interactive prompts for name, parts, etc.

# Validate configuration and structure
vocareum-publish --validate

# Validate with strict mode (warnings become errors)
vocareum-publish --validate --strict

# Attempt to auto-fix validation issues
vocareum-publish --fix

# Publish entire course
vocareum-publish

# Publish with dry-run (preview only)
vocareum-publish --dry-run

# Publish specific assignment
vocareum-publish --assignment assignment1

# Publish specific part
vocareum-publish --assignment assignment1 --part part1

# Force re-upload all content (ignore change detection)
vocareum-publish --force-all

# Non-interactive mode (for CI/CD)
vocareum-publish --non-interactive

# Enable file deletion (mirrors Git exactly)
vocareum-publish --sync-deletes

# Auto-commit config updates (LOCAL USE ONLY - not recommended for CI/CD)
vocareum-publish --auto-commit

# Verbose logging
vocareum-publish --verbose
```

### GitHub Action

```yaml
name: Publish to Vocareum
on:
  workflow_dispatch:  # Manual trigger
  push:
    branches:
      - main
    paths:
      - 'assignment*/**'
      - 'vocareum.yaml'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Publish to Vocareum
        uses: vocareum/publish-action@v1
        with:
          config-file: vocareum.yaml
          api-key: ${{ secrets.VOCAREUM_API_KEY }}
          dry-run: false
          non-interactive: true
          # No auto-commit needed - only updates existing assignments
```

---

## Key Design Decisions

### 1. Technology Stack
**Decision:** Node.js/TypeScript  
**Rationale:** Best GitHub Actions integration, npm distribution, strong typing, async-native

### 2. Scope of Operations
**Decision:** Content and settings management only (no course operations)  
**Rationale:** Focus on authoring workflow, not runtime operations

### 3. Entity Management
**Decision:** Create and update entities; never auto-create courses  
**Rationale:** Courses are high-level and risky; assignments/parts can be safely templated

### 4. Conflict Handling
**Decision:** Last-write-wins (GitHub is source of truth)  
**Rationale:** Simplicity; users must not edit in Vocareum UI

### 5. Delete Handling
**Decision:** Additive-only by default; optional sync_deletes flag for full synchronization  
**Rationale:** Safe by default (can't accidentally delete); power users can opt-in to exact Git mirroring

### 6. Repository Structure
**Decision:** One repo per course, multiple assignments/parts  
**Rationale:** Natural grouping; easier to manage shared resources

### 6. Partial Updates
**Decision:** Support selective directory updates with smart defaults  
**Rationale:** Efficiency for large assignments; safety through defaults

### 8. Change Detection
**Decision:** Store directory-level hashes in vocareum.yaml publish_history (committed to Git)  
**Rationale:** Works in CI/CD; no external state needed; only changed directories uploaded

### 9. Assignment/Part Deletion
**Decision:** Never delete assignments/parts from Vocareum (manual operation only)  
**Rationale:** Prevents accidental data loss (student submissions); deletion requires explicit intent in UI

### 10. Auto-Commit Usage
**Decision:** Support auto-commit for local CLI use only; never in CI/CD  
**Rationale:** Avoids permission issues, race conditions, and state drift; creation is local workflow

### 11. Creation Workflow
**Decision:** New assignments created locally with `vocareum-publish new`, then published; CI/CD only updates  
**Rationale:** Avoids CI/CD complexity; clear separation of creation vs. updates; no duplicate risk

### 12. Validation Strictness
**Decision:** Orphaned folders and missing YAML entries are warnings (not errors); errors only for critical issues  
**Rationale:** Flexible; users can have temporary folders; validation doesn't block workflow unnecessarily

### 13. Directory Requirements
**Decision:** Allow optional directories per part; not all parts need all four directories  
**Rationale:** Flexibility; some assignments may not need data/ or docs/; explicit in config

### 14. Versioning Strategy
**Decision:** No auto-tagging; track history in vocareum.yaml  
**Rationale:** Avoids Git complexity; users can tag manually if desired

### 10. Support Model
**Decision:** GitHub Issues only  
**Rationale:** Simple, searchable, no additional infrastructure

### 9. Testing Strategy
**Decision:** Dry-run mode with comprehensive validation  
**Rationale:** Practical without requiring test Vocareum instances

### 12. Backwards Compatibility
**Decision:** Strict semver with config version field and migration guides  
**Rationale:** Clear expectations; formal migration process

### 18. Import Content Organization
**Decision:** Flat import to `imported/` directories with manual sorting  
**Rationale:** Simplicity for MVP; users have full control; smart categorization in Phase 2

---

## Validation System

### Purpose
Ensure configuration and file structure are consistent before publishing to prevent runtime errors and provide clear feedback.

### Validation Checks

**Configuration Validation:**
- ✓ YAML syntax is valid
- ✓ Schema version is supported
- ✓ Required fields present (org_id, course_id, template_assignment_id)
- ✓ Assignment and part structures are valid

**Structure Validation:**
- ✓ Each YAML assignment entry has corresponding folder
- ⚠ Each folder has corresponding YAML entry (warn if orphaned)
- ✓ Each part path exists within assignment folder
- ✓ Required directories exist (if specified in config)
- ⚠ Unexpected folders exist (warn)

**Vocareum State Validation (during publish):**
- ✓ Course exists and is accessible
- ✓ Template assignment exists
- ✓ Assignment IDs in config exist in Vocareum (if not null)
- ⚠ Assignments exist in Vocareum but not in config

### Validation Levels

**Errors (block publish):**
- Missing required configuration fields
- Invalid YAML syntax
- Assignment folder referenced in config doesn't exist
- Part folder referenced in config doesn't exist
- Course or template assignment doesn't exist in Vocareum
- Assignment ID in config not found in Vocareum

**Warnings (log but allow publish):**
- Folder exists but has no YAML entry (ignored during publish)
- Assignment exists in Vocareum but not in config (not deleted)
- Optional directories missing (if not specified as required)

### Auto-Fix Capabilities

The `--fix` flag provides interactive resolution:

**Can Fix:**
- Generate YAML entries for orphaned folders
- Create missing folder structures for YAML entries
- Add missing directories to existing parts
- Standardize directory naming

**Cannot Fix (user decision required):**
- Delete anything (too dangerous)
- Resolve conflicting assignment names
- Decide which orphaned folders to keep vs. remove

### Commands

```bash
# Validate only
vocareum-publish --validate

# Validate with warnings as errors
vocareum-publish --validate --strict

# Interactive fix
vocareum-publish --fix

# Validate before publish (automatic)
vocareum-publish  # Runs validation first
```

---

## CI/CD Considerations & Best Practices

### Recommended CI/CD Workflow

**Assignment Creation:** Local only (not in CI/CD)  
**Assignment Updates:** Automated via CI/CD

```yaml
name: Publish to Vocareum
on:
  push:
    branches: [main]
    paths: ['assignment*/**', 'lab*/**', 'vocareum.yaml']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Publish to Vocareum
        uses: vocareum/publish-action@v1
        with:
          config-file: vocareum.yaml
          api-key: ${{ secrets.VOCAREUM_API_KEY }}
          non-interactive: true
          # Only updates existing assignments (no creation in CI/CD)
```

### Why Not Create in CI/CD?

**The Problem with Creation in CI/CD:**
1. **State Drift:** API creates assignment → ID generated → Commit fails → Next run creates duplicate
2. **Permission Issues:** Actions may not have write permissions
3. **Race Conditions:** Multiple concurrent workflows
4. **Complexity:** Requires auto-commit with all its pitfalls

**The Solution:**
- Create assignments locally with `vocareum-publish new`
- Publish locally to get IDs
- Commit updated vocareum.yaml with IDs
- CI/CD only handles updates (IDs already exist)

**Benefits:**
- ✅ Simple, predictable workflow
- ✅ No duplicate creation risk
- ✅ No commit-back complexity
- ✅ Clear separation: creation (manual) vs. updates (automated)

---

## API Scope

### In Scope (Content/Settings Management)
- Content upload (startercode, scripts, docs, data)
- Content download (for import)
- Course/assignment/part creation and settings updates
- Metadata management (names, descriptions, due dates)
- Assignment copying (template functionality)

### Out of Scope (Course Operations)
- Lab session management (start/stop)
- User/learner enrollment
- Grading/submission review
- Analytics or reporting
- Any runtime operations

---

## Error Handling

### Error Scenarios and Recovery

**Orphaned ID in Config:**
- Config references assignment_id that doesn't exist in Vocareum
- Action: Alert user, offer to skip or abort (no silent failures)

**Orphaned Assignment in Vocareum:**
- Vocareum has assignment not in config (e.g., removed from YAML)
- Action: Log warning; **assignment remains in Vocareum** (not deleted)
- User must manually archive/delete in Vocareum UI if desired

**Orphaned Folder:**
- Folder exists in repository but no YAML entry
- Action: Log warning; folder ignored during publish
- User can use `--fix` to add YAML entry or manually remove folder

**Missing Folder:**
- YAML entry exists but folder not found
- Action: Error; cannot publish
- User can use `--fix` to create folder structure or remove YAML entry

**New Assignment in Vocareum:**
- Vocareum has assignments created outside the tool
- Action: Log informational message; future feature to import back to config

**API Failure Mid-Publish:**
- Assignment created but part creation fails
- Action: Log new IDs immediately; don't rollback; user can re-run
- **With deterministic lookup:** Re-run will find existing assignment and continue

**Content Upload Failure:**
- Assignment/part exists but file upload fails
- Action: Continue with other assignments (unless --abort-on-error); detailed error log

**Part Count Mismatch:**
- Template has different number of parts than config
- Action: Fail with clear error and resolution steps

**CI/CD State Drift:**
- Not applicable with local creation workflow
- IDs are committed before CI/CD runs
- CI/CD only updates existing assignments

---

## Security & Authentication

### API Credentials
- Customers provide their own Vocareum API credentials
- Support multiple storage methods:
  - Environment variables (recommended)
  - GitHub Secrets (for Actions)
  - Config file (with security warnings)
- Never log or expose credentials
- Clear documentation on security best practices

### File System Safety
- Validate all paths to prevent traversal attacks
- Respect .gitignore patterns
- Sanitize user input

---

## Distribution & Maintenance

### Release Strategy
- Semantic versioning (semver)
- GitHub Releases with detailed changelogs
- npm package releases
- GitHub Action version tags
- Docker images (Phase 2)

### Documentation
- Comprehensive docs site (GitHub Pages)
- API reference
- Troubleshooting guide
- Video tutorials (Phase 2)
- Migration guides for version updates

### Community Support
- GitHub Issues for bugs and feature requests
- Clear SUPPORT.md routing users appropriately
- Contributing guidelines
- Code of conduct
- Security policy for vulnerability disclosure

### License
- Open source license: MIT or Apache 2.0
- Clear in README and LICENSE file

---

## Timeline & Phasing

### Phase 1: MVP (8-12 weeks)
**Core Features:**
- `vocareum-publish init` (fresh + import modes)
- `vocareum-publish` (main publish command)
- Template-based assignment creation
- Content upload for all four directories
- Basic settings management
- GitHub Action wrapper
- Essential documentation
- Example repository

**Deliverables:**
- Working CLI tool (npm package)
- GitHub Action (marketplace listing)
- Documentation site
- Sample course repository

### Phase 2: Enhanced Features (8-12 weeks)
**Additional Features:**
- Smart content categorization for imports
- Enhanced validation and error messages
- Dry-run improvements and preview mode
- Multiple template support
- Advanced settings management
- Performance optimizations
- Comprehensive test suite
- Video tutorials

### Phase 3: Community & Polish (Ongoing)
- Address community feedback
- Additional examples and templates
- Extended API coverage
- Integration guides for different CI/CD systems
- Advanced workflows and automation
- Analytics and reporting

---

## Dependencies & Requirements

### Customer Requirements
- GitHub account with private repository access
- Vocareum account with API access enabled
- Basic familiarity with Git and command line or GitHub Actions
- Node.js 18+ installed (for CLI usage)

### Vocareum API Requirements
- Content upload endpoints for workspace files
- Content download endpoints (for import)
- Assignment copy endpoint (template functionality)
- Course/assignment/part creation and update endpoints
- Entity listing and retrieval endpoints
- Authentication mechanism
- Rate limiting information
- Error code documentation

### Development Requirements
- Access to Vocareum API documentation
- Test Vocareum instance for development
- Sample assignment structures
- Understanding of Vocareum's workspace model

---

## Open Questions for Team Review

1. **Vocareum API Coverage:** What specific API endpoints are available? Are there any limitations we should be aware of?

2. **Content Download Format:** How does the Vocareum API return downloaded content? (Zip file, individual files, API responses?)

3. **File Metadata:** Does Vocareum provide metadata about files that could help with categorization during import?

4. **Rate Limiting:** What are the API rate limits? How should we handle throttling?

5. **Authentication:** What authentication method does the API use? (API key, OAuth, other?)

6. **Template Limitations:** Are there any restrictions on which assignments can be used as templates?

7. **Settings Coverage:** Which course/assignment/part settings are exposed via the API? Are there important settings that cannot be managed programmatically?

8. **Testing Environment:** Is there a sandbox/test Vocareum environment available for development and testing?

9. **Beta Testing:** Are there pilot customers willing to test early versions?

10. **Documentation Access:** Can we access detailed Vocareum API documentation beyond the Postman collection?

11. **File Deletion API:** Does the Vocareum API support listing and deleting individual files within workspace directories?

12. **Part API Details:** Confirm the parts list API returns `seqnum` field and that it's reliable for ordering. Are there any edge cases where seqnum might be non-sequential or duplicated?

---

## Success Criteria

### MVP Launch Criteria
- [ ] CLI tool can initialize fresh repositories
- [ ] CLI tool can import existing courses
- [ ] CLI tool can create assignments from templates
- [ ] CLI tool can update existing assignments and parts
- [ ] CLI tool can upload content to all four directories
- [ ] GitHub Action can trigger publishes from CI/CD
- [ ] Documentation covers all major workflows
- [ ] At least one pilot customer successfully uses the tool
- [ ] Test suite covers core functionality

### Long-term Success Indicators
- 100+ GitHub stars within 6 months
- 10+ organizations actively using the tool
- 90%+ publish success rate
- Average time saved: 2+ hours per course update
- Community contributions (PRs, issues, discussions)
- Positive customer testimonials

---

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Vocareum API changes | High | Version API calls; document API version dependencies |
| Limited API coverage | Medium | Phase features based on API capabilities; document limitations |
| Complex customer environments | Medium | Provide Docker option; comprehensive troubleshooting docs |
| Security vulnerabilities | High | Regular dependency updates; security audit; vulnerability disclosure policy |
| Low adoption | Medium | Focus on documentation; provide examples; engage pilot users early |
| Breaking changes needed | Medium | Strict semver; migration guides; deprecation warnings |

---

## Appendix

### Glossary
- **Course:** Top-level Vocareum entity containing assignments
- **Assignment:** Collection of parts representing a lab or homework
- **Part:** Individual workspace within an assignment
- **Template Assignment:** Assignment used as blueprint for creating new assignments
- **Reconciliation:** Process of comparing local config with Vocareum state
- **Publish:** Uploading content and updating settings in Vocareum

### References
- Vocareum API Documentation: https://documenter.getpostman.com/view/6736336/S11Exg4b
- GitHub Actions Documentation: https://docs.github.com/en/actions
- Semantic Versioning: https://semver.org/

---

**Document Version History:**
- v1.0 (2026-02-12): Initial draft for team review
