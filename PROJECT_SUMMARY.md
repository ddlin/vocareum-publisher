# Vocareum Publisher - Project Summary

**Date:** February 12, 2026  
**Project Status:** Specification Complete - Ready for Implementation

---

## Project Overview

An open-source CLI tool and GitHub Action that Vocareum customers can deploy to automate publishing of assignment content from private GitHub repositories to Vocareum course workspaces using the Vocareum API.

**Core Value Proposition:** Enable instructors to maintain assignment content in Git with full version control while seamlessly publishing to Vocareum, eliminating manual synchronization and reducing errors.

---

## Key Deliverables

1. **CLI Tool** (Node.js/TypeScript, distributed via npm)
2. **GitHub Action** (for CI/CD integration)
3. **Comprehensive Documentation** (Getting started, configuration, troubleshooting)
4. **Example Repository** (Sample course structure)

---

## Major Design Decisions

### 1. Repository Structure: One Repo Per Course
- Each course repository contains multiple assignments
- Each assignment has multiple parts
- Standard directory structure: `startercode/`, `scripts/`, `docs/`, `data/` (optional per part)
- All configuration in `vocareum.yaml`

### 2. Creation Workflow: Local Only
**Critical Decision:** New assignments are created locally, NOT in CI/CD.

**Rationale:**
- Avoids CI/CD complexity with auto-commit
- Prevents state drift and duplicate resource creation
- Clear separation: creation (manual) vs. updates (automated)

**Workflow:**
1. Run `vocareum-publish new <assignment-name>` locally
2. Add content to generated folders
3. Run `vocareum-publish` to create in Vocareum
4. Commit updated `vocareum.yaml` with new IDs
5. CI/CD handles future updates automatically

### 3. Template-Based Assignment Creation
- New assignments created by copying a template assignment in Vocareum
- Template is a regular assignment (can be active)
- Copy generates new assignment_id and part_ids
- Parts mapped by `seqnum` (sequence number) from API
- Content from GitHub immediately overwrites template content

### 4. Change Detection via Content Hashes
- Directory-level SHA256 hashes stored in `vocareum.yaml` `publish_history`
- Only changed directories uploaded (efficient)
- Works in CI/CD because state is committed to Git
- Keeps last 10 history entries to prevent config bloat

### 5. Deletion Policy
**Assignments/Parts:** Never deleted from Vocareum (manual operation only)
- Prevents accidental loss of student submissions
- Deletion requires explicit intent in Vocareum UI

**Files:** Additive by default, optional sync_deletes (experimental)
- Default: deleted files remain on server (safe)
- `sync_deletes: true`: mirrors Git exactly (may not work due to API limitations)

### 6. Validation System
**Three-tier validation:**
- **Errors** (block publish): Missing folders, invalid YAML, broken references
- **Warnings** (allow publish): Orphaned folders, unexpected content
- **Auto-fix** (`--fix` command): Interactive resolution of issues

### 7. No Auto-Commit in CI/CD
**Critical:** Auto-commit disabled for CI/CD workflows.

**Problems with auto-commit in CI/CD:**
- Permission issues
- Race conditions
- Infinite loops (even with `[skip ci]`)
- State drift (API succeeds, commit fails → duplicates on retry)

**Solution:** Create locally, commit IDs, then CI/CD only updates.

---

## Technology Stack

### Core
- **Language:** TypeScript 5.3+
- **Runtime:** Node.js 18+ (LTS)
- **Distribution:** npm package

### Key Dependencies
- `axios` - HTTP client
- `form-data` - Multipart form-data for file uploads (API requirement)
- `commander` - CLI framework
- `inquirer` - Interactive prompts
- `js-yaml` - YAML parsing
- `zod` - Schema validation
- `simple-git` - Git operations
- `chalk` - Terminal colors
- `ora` - Progress indicators

---

## Critical API Constraints (From Postman Documentation Review)

### 1. All IDs Are Strings
- All resource IDs returned as strings, not numbers
- Config must use string types: `assignment_id: "12345"`

### 2. Content Upload Requires Multipart Form-Data
- Endpoint: `POST /v1/courses/{cid}/assignments/{aid}/parts/{pid}/files`
- Parameters: `type` (startercode/scripts/docs/data), `file` (multipart)
- Cannot use simple JSON payloads

### 3. No Search Endpoint for Assignments
- Must list all assignments and filter client-side
- Performance concern for large courses
- Mitigation: Cache assignment list during execution

### 4. File Deletion Not Confirmed
- Postman docs show upload but not DELETE endpoints
- `sync_deletes` feature is experimental
- May require manual cleanup in Vocareum UI

### 5. Part Ordering via Seqnum
- Parts have `seqnum` field (string: "0", "1", "2")
- Used for mapping template parts to config parts
- Must parse to integer for sorting
- Critical: seqnum must be preserved during copy

---

## Configuration Schema (vocareum.yaml)

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
    parts:
      - part_id: "22222"
        path: "part1"
        name: "Part 1: Setup"
        directories: ["startercode", "scripts"]  # Optional
      - part_id: "33333"
        path: "part2"
        name: "Part 2: Analysis"
  
  - assignment_id: null  # Will be created
    name: "Lab 2: Classification"
    path: "assignment2"
    create_from_template: true
    parts:
      - part_id: null
        path: "part1"

publish_options:
  on_missing_id: "skip"       # skip | abort
  auto_commit: false          # LOCAL USE ONLY
  abort_on_error: false
  sync_deletes: false         # Experimental
  exclude_patterns:
    - "*.tmp"
    - ".DS_Store"

publish_history:
  - timestamp: "2025-02-12T14:30:00Z"
    commit_sha: "abc123def456"
    published_by: "github-actions"
    content_state:
      "assignment1/part1/startercode": "sha256:abc123..."
      "assignment1/part1/scripts": "sha256:def456..."
    created:
      - assignment: "44444"
        parts: ["55555"]
    updated:
      - assignment: "11111"
        parts: ["22222", "33333"]
```

---

## Core Commands

```bash
# Initialize new repository
vocareum-publish init
vocareum-publish init --import --course-id 67890

# Create new assignment (local only)
vocareum-publish new <assignment-path>

# Validate configuration
vocareum-publish --validate
vocareum-publish --validate --strict

# Auto-fix validation issues
vocareum-publish --fix

# Publish (creates/updates in Vocareum)
vocareum-publish
vocareum-publish --dry-run
vocareum-publish --assignment assignment1

# Enable file deletion (experimental)
vocareum-publish --sync-deletes
```

---

## Recommended Workflows

### Initial Setup (Fresh Course)
```bash
# 1. Initialize repository
mkdir my-course && cd my-course
git init
vocareum-publish init
# Prompts for org_id, course_id, template_assignment_id

# 2. Create first assignment
vocareum-publish new lab1-intro
# Interactive prompts for details

# 3. Add content
# Edit files in lab1-intro/part1/startercode/ etc.

# 4. Validate and publish
vocareum-publish --validate
vocareum-publish

# 5. Commit updated config with IDs
git add .
git commit -m "Add Lab 1"
git push
```

### Updating Content (Local or CI/CD)
```bash
# Edit files in assignment folders
# ...

# Publish updates
vocareum-publish

# Or let CI/CD handle it automatically on push
```

### GitHub Action (CI/CD)
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
```

---

## Architecture Overview

### Core Modules

**0. Validator (`core/validator.ts`)**
- Validate YAML structure matches filesystem
- Check for orphaned folders and missing entries
- Generate validation reports

**1. Config (`core/config.ts`)**
- Parse and validate vocareum.yaml
- Schema validation using Zod
- Update config with new IDs

**2. API Client (`api/client.ts`)**
- HTTP client with multipart/form-data support
- Authentication and error handling
- All IDs treated as strings

**3. Reconciler (`core/reconciler.ts`)**
- Compare local config with Vocareum state
- Determine create/update/skip actions
- Detect changed directories via hashes

**4. Publisher (`core/publisher.ts`)**
- Execute reconciliation plan
- Orchestrate API calls
- Update config with new IDs

**5. Uploader (`core/uploader.ts`)**
- Read files from directories
- Upload via multipart/form-data
- Parallel uploads with concurrency control

**6. Mapper (`core/mapper.ts`)**
- Map template parts to config parts
- Use seqnum for ordering
- Validate part count consistency

**7. New Command (`commands/new.ts`)**
- Create assignment structure
- Generate YAML entry
- Interactive prompts

**8. Fix Command (`commands/fix.ts`)**
- Interactive resolution of validation issues
- Generate missing entries or folders

---

## Key Considerations & Tradeoffs

### Why Local Creation Only?
**Decision:** Create assignments locally, not in CI/CD.

**Tradeoffs:**
- ✅ No CI/CD complexity (auto-commit, permissions, race conditions)
- ✅ No state drift risk
- ✅ Clean, predictable workflow
- ❌ Cannot create purely through Git commits
- ❌ Requires local CLI execution

**Verdict:** Worth it - avoids entire class of CI/CD problems.

### Why Store Hashes in YAML?
**Decision:** Store content hashes in vocareum.yaml (committed to Git).

**Tradeoffs:**
- ✅ Works in CI/CD (state available)
- ✅ No external state storage
- ✅ Efficient - only changed content uploaded
- ❌ Config file grows (mitigated: keep last 10)
- ❌ Potential merge conflicts (rare in practice)

**Verdict:** Best solution for stateless CI/CD.

### Why No Auto-Commit in CI/CD?
**Decision:** Disable auto-commit for GitHub Actions.

**Tradeoffs:**
- ✅ Avoids permission issues
- ✅ Avoids race conditions
- ✅ Avoids infinite loops
- ✅ Avoids state drift
- ❌ Requires local creation first

**Verdict:** Necessary constraint - auto-commit in CI/CD is fundamentally problematic.

### Why Template-Based Creation?
**Decision:** Copy existing template assignment rather than create from scratch.

**Tradeoffs:**
- ✅ Preserves Vocareum settings not exposed in API
- ✅ Consistent configuration across assignments
- ✅ Simpler than full settings management
- ❌ Requires template assignment setup
- ❌ Template must have correct part count

**Verdict:** More practical given API limitations.

---

## Open Questions for Vocareum Team

1. **Assignment Copy Behavior:** Does copying preserve seqnum values for parts?
2. **File Deletion API:** Is there a DELETE endpoint for workspace files?
3. **Assignment Settings:** What fields does PUT /assignments support? Format for due_date?
4. **Authentication:** Confirm API key format and header requirements.
5. **Rate Limiting:** What are the limits? How to handle 429 responses?
6. **Seqnum Reliability:** Always sequential or can have gaps/duplicates?
7. **Part Operations:** Can parts be added/removed post-creation?
8. **Content Download:** How is content returned during import? Format?

---

## Implementation Phases

### Phase 1: MVP (8-12 weeks)
**Core Features:**
- `init`, `new`, `publish`, `validate`, `fix` commands
- Template-based assignment creation
- Content upload with change detection
- GitHub Action wrapper
- Basic documentation

**Deliverables:**
- Working CLI tool (npm package)
- GitHub Action (marketplace)
- Documentation site
- Example repository

### Phase 2: Enhanced Features (8-12 weeks)
- Smart content categorization for imports
- Enhanced validation and error messages
- Performance optimizations
- Comprehensive test suite
- Video tutorials

### Phase 3: Community & Polish (Ongoing)
- Community feedback integration
- Additional examples and templates
- Extended API coverage
- Integration guides

---

## Success Criteria

**MVP Launch:**
- ✅ CLI can initialize fresh repositories
- ✅ CLI can import existing courses
- ✅ CLI can create assignments from templates
- ✅ CLI can update existing assignments
- ✅ GitHub Action works in CI/CD
- ✅ Documentation covers all workflows
- ✅ One pilot customer successfully uses tool

**Long-term Success:**
- 100+ GitHub stars within 6 months
- 10+ organizations actively using
- 90%+ publish success rate
- 2+ hours saved per course update
- Community contributions

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| API changes | Version API calls; document dependencies |
| Limited API coverage | Phase features based on capabilities; document limitations |
| File deletion unsupported | Make experimental; graceful fallback; clear warnings |
| Complex customer environments | Provide Docker option; comprehensive troubleshooting |
| Security vulnerabilities | Regular dependency updates; security audit |
| Low adoption | Focus on docs; provide examples; engage pilots early |

---

## Next Steps

1. ✅ **Complete Specifications** (Done)
2. **API Validation** - Confirm open questions with Vocareum team
3. **Prototype** - Build proof-of-concept for core workflows
4. **Pilot Testing** - Identify early adopter customers
5. **MVP Development** - 8-12 week implementation
6. **Documentation** - User guides, API reference, troubleshooting
7. **Beta Launch** - Limited release to pilot customers
8. **Public Release** - npm, GitHub Action marketplace, announcement

---

## Files Delivered

1. **Product Requirements Document (PRD)** - Complete specification of features, workflows, and decisions
2. **Technical Architecture Document** - Detailed module design, API integration, implementation guidance
3. **Project Summary** - This document

**Status:** Ready for implementation. All major design decisions finalized. Open questions documented for Vocareum team clarification.

---

## Contact & Resources

**Vocareum API Documentation:** https://documenter.getpostman.com/view/6736336/S11Exg4b

**Recommended Repository Structure:**
```
vocareum-publisher/
├── src/               # Source code
├── action/            # GitHub Action wrapper
├── test/              # Test suites
├── docs/              # Documentation
├── examples/          # Example course repositories
├── PRD.md            # Product requirements
├── ARCHITECTURE.md   # Technical architecture
└── README.md         # Getting started
```

---

**Document Version:** 1.0  
**Last Updated:** February 12, 2026  
**Status:** Specification Complete - Ready for Implementation