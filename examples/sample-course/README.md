# Sample Course Repository

This is an example course repository structure for use with the Vocareum Publisher tool.

## Structure

```
sample-course/
├── vocareum.yaml          # Configuration file
├── README.md              # This file
├── lab1-intro/            # Lab 1: Introduction
│   └── part1/
│       ├── startercode/   # Student-visible code
│       ├── scripts/       # Grading scripts
│       └── docs/          # Documentation
└── lab2-analysis/         # Lab 2: Data Analysis
    ├── part1/
    │   ├── startercode/
    │   ├── scripts/
    │   └── data/          # Dataset files
    └── part2/
        ├── startercode/
        └── scripts/
```

## Getting Started

1. Copy this folder to create your own course repository
2. Update `vocareum.yaml` with your actual Vocareum IDs:
   - `org_id`: Your organization ID
   - `course_id`: Your course ID
   - `template_assignment_id`: ID of an assignment to use as template

3. Replace assignment and part IDs with your actual IDs (or use `null` for new assignments)

4. Add your content to the appropriate folders:
   - `startercode/`: Files visible to students
   - `scripts/`: Grading and setup scripts
   - `docs/`: Documentation (if needed)
   - `data/`: Datasets (if needed)

5. Validate your configuration:
   ```bash
   vocgit --validate
   ```

6. Publish to Vocareum:
   ```bash
   vocgit
   ```

## Directory Types

- **startercode/**: Code that students start with and can edit
- **scripts/**: Automated scripts (grading, setup, teardown)
- **docs/**: Read-only documentation for students
- **data/**: Dataset files (usually read-only)

## Configuration

See `vocareum.yaml` for the full configuration. Key sections:

- `vocareum`: Connection settings (org, course, template IDs)
- `assignments`: List of assignments with parts
- `publish_options`: Behavior settings
- `publish_history`: Automatically updated after each publish

## Notes

- All IDs are strings (not numbers)
- Part order in YAML matches part order in template (by seqnum)
- Run `vocgit new <assignment-name>` to create new assignments
- Never enable `auto_commit` in CI/CD workflows
