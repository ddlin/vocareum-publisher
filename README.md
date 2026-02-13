# Vocareum Publisher

Publish assignment content from GitHub to Vocareum.

A CLI tool and GitHub Action that enables instructors to maintain assignment content in Git with full version control while seamlessly publishing to Vocareum.

## Features

- **Git-First Workflow**: GitHub is the source of truth for all assignment content
- **CLI Tool**: Local development and publishing via command line
- **GitHub Action**: Automated CI/CD publishing on push
- **Change Detection**: Only uploads changed content (efficient)
- **Template-Based Creation**: Create new assignments from templates
- **Validation**: Verify configuration before publishing

## Installation

```bash
npm install -g vocareum-publisher
```

## Quick Start

### 1. Initialize a Course Repository

```bash
mkdir my-course && cd my-course
git init
vocareum-publish init
```

### 2. Create an Assignment

```bash
vocareum-publish new lab1-intro
# Follow interactive prompts
```

### 3. Add Content

Add your files to the generated directory structure:

```
lab1-intro/
├── part1/
│   ├── startercode/   # Student-visible starter code
│   ├── scripts/       # Grading scripts
│   ├── lib/           # Grading libraries (hidden from students)
│   ├── asnlib/        # Assignment libraries
│   ├── docs/          # Documentation
│   └── data/          # Datasets
```

### 4. Validate and Publish

```bash
vocareum-publish validate
vocareum-publish
```

### 5. Commit and Push

```bash
git add .
git commit -m "Add Lab 1"
git push
```

## Configuration

All configuration is stored in `vocareum.yaml`:

```yaml
version: "1.0"

vocareum:
  org_id: "12345"
  course_id: "67890"
  template_assignment_id: "99999"
  excluded_assignments:       # Assignment IDs to hide from orphan detection
    - "111222"
    - "333444"
  course_settings:            # Optional course metadata sync
    name: "Intro to ML"
    description: "Spring section"

assignments:
  - assignment_id: "11111"
    name: "Lab 1: Introduction"
    path: "lab1-intro"
    settings:                       # Optional assignment settings
      description: "Introduction to the course"
      nosubmit: false
      publish: true
      auto_submit: false
      grading_on_submit: true
      exam_mode: "timed"            # timed, scheduled, or timed_scheduled
      exam_duration: 120
      num_attempts: 3
    parts:
      - part_id: "22222"
        path: "part1"
        name: "Part 1: Setup"
        settings:                   # Optional part settings
          submission_filters:
            include: ["*.py"]
            exclude: ["*.pyc"]
          session_length: "60"      # minutes
          late_penalty_percent: 10
          late_penalty_percent_rule: "max score"  # or "student score"
          deadlinedate: "2025-03-15T23:59:00Z"
          number_of_submissions: 5
          lab_interface:
            panels: ["Console"]
            controls: ["Reset"]
  - assignment_id: null
    name: "Lab 2: Classification"
    assignment_name_for_lookup: "Lab 2: Classification"  # Optional name-based ID discovery
    path: "lab2-classification"
    parts:
      - part_id: null
        path: "part1"
        name: "Part 1: Implementation"
        settings:
          cloud_labs: true
          session_length: "60"
          labtype: "JupyterLab"
          endlab: "stop"            # or "terminate"

publish_options:
  on_missing_id: "skip"
  auto_commit: false
  sync_deletes: false

publish_history:
  - timestamp: "2026-02-12T22:30:00Z"
    commit_sha: "abc123def456"
    published_by: "github-actions"
    status: "failed"   # success | failed
    content_state:
      "lab1-intro/part1/startercode": "9a7f..."
    failed:
      - type: "file"
        id: "22222/startercode/main.py"
        error: "Timed out after 30000ms waiting for part update (txn=123)"
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `vocareum-publish init` | Initialize a new course repository |
| `vocareum-publish new <path>` | Create new assignment structure |
| `vocareum-publish validate` | Validate configuration and structure |
| `vocareum-publish fix` | Interactively fix validation issues |
| `vocareum-publish pull` | Import or exclude orphaned assignments from Vocareum |
| `vocareum-publish` | Publish to Vocareum |

### Publish Options

```bash
vocareum-publish --dry-run           # Preview changes
vocareum-publish --assignment lab1   # Publish specific assignment
vocareum-publish --force-all         # Re-upload everything
vocareum-publish --sync-deletes      # Delete files not in Git (experimental)
vocareum-publish --non-interactive   # Skip confirmation prompt
vocareum-publish --verbose           # Detailed logging
```

### Pull Command

The `pull` command helps you manage assignment sync issues:

1. **Orphaned assignments** - exist in Vocareum but not in your local config
2. **Stale assignments** - exist in your config but were deleted from Vocareum

This is useful when:
- You've created assignments directly in the Vocareum UI
- You're onboarding an existing course to Git-based management
- Assignments were created or deleted by another team member

```bash
vocareum-publish pull                # Interactive mode
vocareum-publish pull --verbose      # Show detailed output
vocareum-publish pull --non-interactive  # Skip all issues
```

**For orphaned assignments** (in Vocareum, not in config):
- **Import**: Download content and add to your local repository
- **Exclude**: Hide from future scans (add to `excluded_assignments`)
- **Skip**: Do nothing

**For stale assignments** (in config, deleted from Vocareum):
- **Reset ID**: Clear assignment_id to allow re-creation from template
- **Remove**: Delete the assignment from config entirely
- **Exclude**: Keep in config but skip during sync
- **Skip**: Do nothing

Example workflow:

```
$ vocareum-publish pull

ℹ Scanning for assignment sync issues...
ℹ Found 1 orphaned assignment(s) in Vocareum.

[1/1] Lab 3: Advanced Topics (ID: 555666)
? What would you like to do? Import to local repository
? Local directory name: lab3-advanced
  Part 1/2: downloaded 5 files
  Part 2/2: downloaded 3 files
✓ Imported "Lab 3: Advanced Topics" to lab3-advanced/

ℹ Found 1 stale assignment(s) in config (deleted from Vocareum).

[1/1] Old Lab (ID: 777888, path: old-lab)
? This assignment was deleted from Vocareum. What would you like to do?
  Reset ID (allow re-creation from template)
✓ Reset ID for "Old Lab" - will be re-created on next publish

Summary:
  Imported: 1
  Excluded: 0
  Removed:  0
  Reset:    1
  Skipped:  0

ℹ Updated vocareum.yaml
```

## GitHub Action

```yaml
name: Publish to Vocareum
on:
  push:
    branches: [main]
    paths: ['lab*/**', 'vocareum.yaml']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Publish to Vocareum
        uses: ddlin/vocareum-publisher@v1
        with:
          config-file: vocareum.yaml
          api-key: ${{ secrets.VOCAREUM_API_KEY }}
          non-interactive: true
```

## Directory Structure

```
course-repo/
├── vocareum.yaml         # Configuration
├── lab1-intro/
│   └── part1/
│       ├── startercode/  # Student-visible starter code
│       ├── scripts/      # Grading scripts
│       ├── lib/          # Grading libraries (hidden)
│       ├── asnlib/       # Assignment libraries
│       ├── docs/         # Documentation
│       └── data/         # Datasets
└── lab2-analysis/
    └── ...
```

### Supported Directory Types

| Directory | Description |
|-----------|-------------|
| `startercode` | Student-visible starter files |
| `scripts` | Grading and setup scripts |
| `lib` | Grading libraries (hidden from students) |
| `asnlib` | Assignment libraries |
| `docs` | Documentation files |
| `data` | Datasets and resources |
| `private` | Private course files |
| `course` | Course-level shared files |

Configure which directories to sync per part:

```yaml
parts:
  - part_id: "123"
    path: "part1"
    directories: ["startercode", "scripts", "lib"]  # Only sync these
```

## Important Notes

### All IDs Are Strings

Vocareum API returns all IDs as strings. Always use string types:

```yaml
# Correct
assignment_id: "12345"

# Wrong
assignment_id: 12345
```

### Local Creation, CI/CD Updates

- **Create assignments locally** using `vocareum-publish new`
- **Commit IDs** to Git before CI/CD runs
- **CI/CD only updates** existing assignments

### Never Auto-Commit in CI/CD

The `auto_commit` option should only be used locally. In CI/CD it is force-disabled by the CLI.

### Publish Confirmation Behavior

- Local CLI prompts for confirmation before executing publish.
- `--non-interactive` skips prompts.
- CI/GitHub Actions automatically run non-interactive.

### API Contract Notes

- Authentication header: `Authorization: Token <token>`
- Base API path: `https://api.vocareum.com/api/v2/`
- Assignment copy: `POST /api/v2/courses/{courseId}/assignments` with body:
  - `{ "method": "copy", "source": "<templateAssignmentId>", "name": "<newName>" }`
  - Polls transaction endpoint for up to 60 seconds until complete
- Content updates: part `PUT` with `content[].zipcontent` (base64 zip)
  - Uses `reset: 1` to clear directory before upload (ensures exact Git state)
  - All files in directory uploaded together as a single ZIP
- Part updates may return `transactionid`; publisher polls `GET /api/v2/transaction/{id}`
- Failed publish runs are stored in `publish_history` with `status: failed` and `failed[]` entries

### ID Discovery

When an assignment or part ID is missing from config but exists in Vocareum:
- Assignment IDs are discovered by name lookup (prevents duplicate creation)
- Part IDs are discovered by seqnum mapping
- Discovered IDs are automatically saved to `vocareum.yaml`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VOCAREUM_API_KEY` | API key for authentication (supported) |
| `VOCAREUM_API_TOKEN` | API key for authentication (supported alias) |
| `VOCAREUM_LOG_LEVEL` | Log level: ERROR, WARN, INFO, DEBUG, TRACE |

## License

MIT License - see [LICENSE](LICENSE) for details.

## Links

- [Documentation](docs/)
- [Examples](examples/)
- [Vocareum API](https://documenter.getpostman.com/view/6736336/S11Exg4b)
- [Issues](https://github.com/ddlin/vocareum-publisher/issues)
