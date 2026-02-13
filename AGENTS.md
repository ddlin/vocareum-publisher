# AGENTS.md - Guide for AI Coding Agents

**Project:** Vocareum Publisher  
**Purpose:** This document guides AI coding agents (Claude Code, Cursor, GitHub Copilot, etc.) in implementing this project correctly.

---

## 🎯 Project Overview

You are building a **CLI tool and GitHub Action** that publishes assignment content from GitHub repositories to Vocareum using their API. This is an open-source tool that Vocareum customers will self-deploy.

**Core Principle:** GitHub is the source of truth. The tool synchronizes content FROM Git TO Vocareum, never the reverse.

---

## 📚 Required Reading (In Order)

Before starting ANY implementation, you MUST read these documents:

1. **PROJECT_SUMMARY.md** - High-level overview and key decisions
2. **PRD.md** - Complete product requirements and workflows
3. **ARCHITECTURE.md** - Detailed technical design and module specifications
4. **AI_IMPLEMENTATION_PROMPTS.md** - Step-by-step implementation instructions

These documents are the **source of truth**. If anything in code contradicts these specs, the specs are correct.

---

## ⚠️ Critical Constraints (Read First!)

### 1. **All IDs Are Strings**
```typescript
// ✅ CORRECT
assignment_id: "12345"
course_id: "67890"

// ❌ WRONG
assignment_id: 12345
course_id: 67890
```

**Why:** Vocareum API returns all IDs as strings. Using numbers will cause comparison failures.

### 2. **Content Upload Uses Part Update with Base64 Zip**
```typescript
// ✅ CORRECT - Use part update endpoint with zipcontent
await axios.put(
  `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}`,
  {
    name: 'Part 1',
    content: [{ target: 'startercode', zipcontent: base64Zip, reset: 0 }],
    update: 1
  }
);

// ❌ WRONG - Old multipart upload assumptions
axios.post('/api/v2/upload', formData)
```

**Why:** Vocareum Postman docs + live testing confirm part `PUT` with `content[].zipcontent`.

### 3. **Parts Are Ordered by `seqnum` (String)**
```typescript
// ✅ CORRECT - Parse string to number for sorting
const sorted = parts.sort((a, b) => parseInt(a.seqnum) - parseInt(b.seqnum));

// ❌ WRONG - String sorting gives wrong order
const sorted = parts.sort((a, b) => a.seqnum - b.seqnum);
```

**Why:** `seqnum` is a string like "0", "1", "2". Must parse for numeric sorting.

### 4. **Never Auto-Commit in CI/CD**
```yaml
# ✅ CORRECT - Local use only
auto_commit: false  # Default for CI/CD

# ❌ WRONG - Will cause state drift and duplicates
auto_commit: true  # NEVER in GitHub Actions
```

**Why:** Auto-commit in CI/CD causes permission issues, race conditions, and duplicate resource creation.

### 5. **Assignment Creation Is Local-Only**
```bash
# ✅ CORRECT - Create locally
vocareum-publish new lab1  # Local CLI
vocareum-publish           # Creates in Vocareum
git commit                 # Commit IDs
git push                   # CI/CD handles updates

# ❌ WRONG - Don't create in CI/CD
# GitHub Action tries to create assignment → state drift
```

**Why:** CI/CD creation leads to duplicate assignments if commit fails. See PRD "CI/CD Considerations."

### 6. **File Deletion Is Experimental**
```typescript
// ✅ CORRECT - Handle gracefully
try {
  await client.deleteFile(partId, dir, file);
} catch (error) {
  if (error.statusCode === 404 || error.statusCode === 405) {
    logger.warn('File deletion not supported by API');
    // Continue, don't fail
  }
}

// ❌ WRONG - Assume deletion works
await client.deleteFile(partId, dir, file);  // Will crash
```

**Why:** Vocareum API may not support file deletion. Must handle gracefully.

### 7. **Assignments/Parts Are Never Deleted**
```typescript
// ✅ CORRECT - Only warn about orphaned resources
if (vocareumAssignment && !configAssignment) {
  logger.warn(`Assignment ${id} exists in Vocareum but not config`);
  // Don't delete it!
}

// ❌ WRONG - Auto-delete from Vocareum
if (vocareumAssignment && !configAssignment) {
  await client.deleteAssignment(id);  // NEVER DO THIS
}
```

**Why:** Prevents accidental deletion of assignments with student submissions.

### 8. **Publish Is Interactive by Default**
```bash
# ✅ CORRECT - local interactive confirmation
vocareum-publish
# prompts: "Proceed with publish?"

# ✅ CORRECT - explicit non-interactive mode (CI/CD)
vocareum-publish --non-interactive
```

**Why:** Prevent accidental publishes locally while ensuring CI/CD can run unattended.

### 9. **Track Failed Runs in publish_history**
```yaml
# ✅ CORRECT
publish_history:
  - status: "failed"
    failed:
      - type: "file"
        id: "22222/startercode/main.py"
        error: "..."
```

**Why:** Preserves operational history and prevents silent failures; hashes should only advance for successful directory uploads.

---
## Compaction Summary Protocol

When a compaction occurs, save to `.claude/compaction-logs/compaction-YYYY-MM-DD-HHMMSS.md`

### On Session Start
Read the 3 most recent files in `.claude/compaction-logs/` to restore working context before proceeding with any task.


---
## 🏗️ Architecture Quick Reference

### Module Hierarchy (Build in This Order)

```
Phase 1: Foundation
├── utils/ (logger, files, git, prompts)
└── types/ (config, api, state)

Phase 2: Configuration
├── core/config.ts (parse YAML)
└── core/validator.ts (validate structure)

Phase 3: API Client
├── api/client.ts (base HTTP client)
├── api/courses.ts
├── api/assignments.ts
├── api/parts.ts
└── api/content.ts (part PUT with zipcontent payload)

Phase 4: Business Logic
├── core/mapper.ts (map parts by seqnum)
├── core/uploader.ts (parallel uploads)
├── core/reconciler.ts (compare states)
└── core/publisher.ts (orchestrate workflow)

Phase 5: Commands
├── commands/init.ts
├── commands/new.ts
├── commands/validate.ts
├── commands/fix.ts
├── commands/publish.ts
└── index.ts (CLI entry point)

Phase 6: GitHub Action
└── action/ (wrapper for CLI)
```

### Data Flow

```
User runs command
      ↓
Parse vocareum.yaml (config.ts)
      ↓
Validate structure (validator.ts)
      ↓
Authenticate with API (client.ts)
      ↓
Fetch Vocareum state (assignments.ts, parts.ts)
      ↓
Compare & reconcile (reconciler.ts)
      ↓
Display plan & confirm
      ↓
Execute:
  - Copy template (assignments.ts)
  - Map parts (mapper.ts)
  - Upload content (uploader.ts, content.ts)
      ↓
Update config with new IDs
      ↓
Calculate & store content hashes
      ↓
Optionally commit (git.ts)
```

---

## 🎨 Code Style Guidelines

### TypeScript Style

```typescript
// ✅ Use explicit types
async function loadConfig(path: string): Promise<Config> { }

// ✅ Use const for immutable
const config = await loadConfig('vocareum.yaml');

// ✅ Use meaningful names
const sortedParts = parts.sort((a, b) => parseInt(a.seqnum) - parseInt(b.seqnum));

// ✅ Handle errors explicitly
try {
  const result = await apiCall();
} catch (error) {
  if (error instanceof AuthenticationError) {
    logger.error('Invalid API key');
  } else {
    throw error;
  }
}

// ❌ Avoid 'any' type
const data: any = await loadConfig();  // BAD

// ❌ Don't use console.log directly
console.log('Publishing...');  // BAD - use logger.info()
```

### Error Handling

```typescript
// ✅ CORRECT - Custom error classes
export class ConfigError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

throw new ConfigError('Missing org_id', 'MISSING_FIELD');

// ✅ CORRECT - Actionable error messages
throw new ConfigError(
  'Assignment "lab3" references path "lab3/" which does not exist.\n\n' +
  'To fix:\n' +
  '  1. Create the folder: vocareum-publish new lab3\n' +
  '  2. Or update vocareum.yaml to use correct path',
  'MISSING_FOLDER'
);

// ❌ WRONG - Vague errors
throw new Error('Invalid config');
```

### Logging

```typescript
// ✅ CORRECT - Use logger utility
import { logger } from '../utils/logger';

logger.info('Publishing assignment...');
logger.success('Assignment created: 12345');
logger.warn('File deletion not supported');
logger.error('Failed to upload', { file: 'main.py', error });

// ✅ CORRECT - Never log sensitive data
logger.debug('API request', { 
  url: request.url,
  headers: { ...request.headers, authorization: '[REDACTED]' }
});

// ❌ WRONG - Direct console usage
console.log('Publishing...');
```

### File Operations

```typescript
// ✅ CORRECT - Use fs/promises
import { promises as fs } from 'fs';
const content = await fs.readFile(path, 'utf8');

// ✅ CORRECT - Validate paths
import { validatePath } from '../utils/files';
validatePath(basePath, userInput);  // Prevent path traversal

// ✅ CORRECT - Handle missing files
try {
  const content = await fs.readFile(path);
} catch (error) {
  if (error.code === 'ENOENT') {
    throw new ConfigError(`File not found: ${path}`, 'FILE_NOT_FOUND');
  }
  throw error;
}
```

---

## 🧪 Testing Requirements

### Every Module Must Have Tests

```typescript
// test/unit/mapper.test.ts
import { describe, it, expect } from 'vitest';
import { mapParts } from '../../src/core/mapper';

describe('mapParts', () => {
  it('should map parts by seqnum order', () => {
    const configParts = [
      { part_id: null, path: 'part1' },
      { part_id: null, path: 'part2' }
    ];
    const apiParts = [
      { part_id: '222', seqnum: '1' },  // Out of order!
      { part_id: '111', seqnum: '0' }
    ];
    
    const result = mapParts(configParts, apiParts);
    
    // Should sort by seqnum, so part1 → 111, part2 → 222
    expect(result[0].apiPartId).toBe('111');
    expect(result[1].apiPartId).toBe('222');
  });
  
  it('should throw on part count mismatch', () => {
    const configParts = [{ part_id: null, path: 'part1' }];
    const apiParts = [
      { part_id: '111', seqnum: '0' },
      { part_id: '222', seqnum: '1' }
    ];
    
    expect(() => mapParts(configParts, apiParts)).toThrow();
  });
});
```

### Test Coverage Requirements
- **Minimum:** 80% code coverage
- **Critical paths:** 100% coverage (API client, mapper, reconciler)
- **Error paths:** Test all error conditions
- **Edge cases:** Empty inputs, malformed data, API failures

---

## 📝 Documentation Requirements

### Code Comments

```typescript
// ✅ GOOD - Explain WHY, not WHAT
// Sort by seqnum because Vocareum parts may be returned out of order
const sorted = parts.sort((a, b) => parseInt(a.seqnum) - parseInt(b.seqnum));

// ✅ GOOD - Document assumptions
/**
 * Maps template parts to config parts by position.
 * 
 * CRITICAL: Assumes seqnum is sequential (0, 1, 2...) without gaps.
 * If seqnum has gaps, sorting still works but validation may be needed.
 * 
 * @throws PartMappingError if part counts don't match
 */
export function mapParts(configParts: Part[], apiParts: ApiPart[]): PartMapping[]

// ❌ BAD - Obvious comments
// Sort the parts
const sorted = parts.sort(...);
```

### JSDoc for Public APIs

```typescript
/**
 * Uploads content to a Vocareum workspace directory.
 * 
 * @param client - Vocareum API client
 * @param courseId - Course ID (string, not number!)
 * @param assignmentId - Assignment ID
 * @param partId - Part ID
 * @param directory - Directory type: startercode, scripts, docs, or data
 * @param files - Map of relative paths to file contents
 * @returns Upload result with succeeded/failed files and directory hash
 * 
 * @throws APIError if upload fails
 * @throws RateLimitError if API rate limit exceeded
 * 
 * @example
 * ```typescript
 * const result = await uploadContent(
 *   client,
 *   '12345',
 *   '67890',
 *   '11111',
 *   'startercode',
 *   { 'main.py': Buffer.from('print("hello")') }
 * );
 * console.log(`Uploaded ${result.succeeded.length} files`);
 * ```
 */
export async function uploadContent(...)
```

---

## 🐛 Common Pitfalls to Avoid

### 1. Type Confusion
```typescript
// ❌ WRONG - Treating IDs as numbers
if (assignment.id === 12345) { }  // Will never match "12345"

// ✅ CORRECT
if (assignment.id === "12345") { }
```

### 2. Seqnum Sorting
```typescript
// ❌ WRONG - String sorting
parts.sort((a, b) => a.seqnum - b.seqnum);  // "10" comes before "2"

// ✅ CORRECT
parts.sort((a, b) => parseInt(a.seqnum) - parseInt(b.seqnum));
```

### 3. Async/Await
```typescript
// ❌ WRONG - Not awaiting promises
const config = loadConfig('vocareum.yaml');  // Returns Promise, not Config!

// ✅ CORRECT
const config = await loadConfig('vocareum.yaml');
```

### 4. Error Handling in Loops
```typescript
// ❌ WRONG - One failure breaks everything
for (const file of files) {
  await uploadFile(file);  // If one fails, rest don't upload
}

// ✅ CORRECT - Collect failures, continue
const results = { succeeded: [], failed: [] };
for (const file of files) {
  try {
    await uploadFile(file);
    results.succeeded.push(file);
  } catch (error) {
    results.failed.push({ file, error });
  }
}
```

### 5. Missing Null Checks
```typescript
// ❌ WRONG - Assumes value exists
const hash = history.content_state[key].substring(0, 8);

// ✅ CORRECT
const hash = history.content_state?.[key]?.substring(0, 8) || 'none';
```

### 6. Console.log Instead of Logger
```typescript
// ❌ WRONG
console.log('Uploading...');
console.error('Failed');

// ✅ CORRECT
logger.info('Uploading...');
logger.error('Failed', { details });
```

### 7. Hardcoded Values
```typescript
// ❌ WRONG
const baseUrl = 'https://api.vocareum.com';

// ✅ CORRECT
const baseUrl = config.vocareum.api_base_url || 'https://api.vocareum.com';
```

---

## ✅ Definition of Done

Before marking any phase as complete, verify:

### Code Quality
- [ ] All TypeScript strict mode checks pass
- [ ] No `any` types (except where truly necessary)
- [ ] All public functions have JSDoc comments
- [ ] No console.log (use logger instead)
- [ ] Error handling covers all failure cases
- [ ] Async operations properly awaited

### Testing
- [ ] Unit tests written and passing
- [ ] Integration tests for complex workflows
- [ ] Edge cases tested
- [ ] Error paths tested
- [ ] Coverage meets requirements (80%+ overall)

### Documentation
- [ ] README accurate for new functionality
- [ ] Inline comments explain non-obvious code
- [ ] Examples updated if needed
- [ ] Types exported and documented

### Specification Compliance
- [ ] Matches PRD requirements exactly
- [ ] Follows Architecture design
- [ ] Respects all Critical Constraints above
- [ ] Handles all error scenarios from specs

---

## 🚀 Quick Start for AI Agents

### First Time Setup
1. Read this file completely (AGENTS.md)
2. Read PROJECT_SUMMARY.md for context
3. Skim PRD.md and ARCHITECTURE.md for familiarity
4. Start with Phase 0 from AI_IMPLEMENTATION_PROMPTS.md

### For Each Implementation Phase
1. Read the prompt from AI_IMPLEMENTATION_PROMPTS.md
2. Reference ARCHITECTURE.md for detailed module design
3. Reference PRD.md for user-facing behavior
4. Implement according to specifications
5. Write tests as you go
6. Verify against Critical Constraints (above)
7. Run all tests before moving to next phase

### When Stuck
1. Re-read the relevant section in ARCHITECTURE.md
2. Check if issue is addressed in Critical Constraints
3. Look at similar code in existing modules
4. Check test fixtures for examples
5. Ask human for clarification (don't guess!)

### When Specifications Conflict
**Priority Order:**
1. ARCHITECTURE.md (technical details)
2. PRD.md (requirements and behavior)
3. PROJECT_SUMMARY.md (high-level decisions)
4. Code comments (may be outdated)

If documents genuinely conflict, ask human to clarify.

---

## 🎓 Key Concepts to Understand

### 1. Template-Based Creation
New assignments are created by **copying** an existing template assignment in Vocareum. This preserves settings not exposed in the API. After copying:
- New assignment_id generated
- New part_ids generated (with preserved seqnum)
- GitHub content overwrites template content

### 2. Part Mapping by Seqnum
Config parts (array position) map to API parts (seqnum order):
```
Config[0] → API part with seqnum="0"
Config[1] → API part with seqnum="1"
Config[2] → API part with seqnum="2"
```

### 3. Change Detection via Hashes
Only changed directories are uploaded:
- Hash each directory (startercode, scripts, docs, data)
- Store hashes in vocareum.yaml publish_history
- Compare current hash to last publish
- Upload only if hash changed

### 4. State Management for CI/CD
vocareum.yaml stores ALL state:
- Assignment/part IDs (what exists)
- Content hashes (what's current)
- Publish history (what was deployed when)

No external state storage → works in CI/CD.

### 5. Local Creation, CI/CD Updates
- **Create:** Run `vocareum-publish new` locally → generates structure
- **Publish:** Run `vocareum-publish` locally → creates in Vocareum, updates IDs
- **Commit:** Commit vocareum.yaml with IDs to Git
- **CI/CD:** GitHub Actions only updates existing assignments (no creation)

---

## 📞 Getting Help

### Resources
1. **Specifications:** PRD.md, ARCHITECTURE.md, PROJECT_SUMMARY.md
2. **Vocareum API:** https://documenter.getpostman.com/view/6736336/S11Exg4b
3. **Implementation Guide:** AI_IMPLEMENTATION_PROMPTS.md
4. **This Guide:** AGENTS.md (you are here)

### When to Ask Human
- Specifications are ambiguous or contradictory
- Vocareum API behavior is unclear
- Design decision needs to be made
- Tests reveal fundamental issue with design
- Implementation seems impossible given constraints

### What NOT to Do
- ❌ Ignore Critical Constraints and "fix later"
- ❌ Deviate from specifications without asking
- ❌ Skip tests "to move faster"
- ❌ Use console.log instead of logger
- ❌ Treat IDs as numbers
- ❌ Assume API features work without checking

---

## 🎯 Success Criteria

You've successfully implemented the project when:

- ✅ All commands work as specified in PRD
- ✅ All Critical Constraints respected
- ✅ All tests passing (80%+ coverage)
- ✅ No TypeScript errors
- ✅ Documentation complete
- ✅ Example repository works end-to-end
- ✅ GitHub Action works in real repository
- ✅ npm package installs and runs correctly
- ✅ No security vulnerabilities (npm audit clean)
- ✅ Performance acceptable (< 30s for typical publish)

---

## 📋 Quick Reference Checklist

Before committing any code, verify:

```
Technical:
[ ] TypeScript strict mode passes
[ ] All IDs treated as strings
[ ] Part `PUT` with `content[].zipcontent` used for uploads
[ ] Seqnum parsed before sorting
[ ] Error handling comprehensive
[ ] Logger used (no console.log)
[ ] Paths validated (no traversal)
[ ] Tests written and passing

Specifications:
[ ] Matches PRD requirements
[ ] Follows ARCHITECTURE design
[ ] Respects Critical Constraints
[ ] Documentation updated

Quality:
[ ] No hardcoded values
[ ] No 'any' types
[ ] JSDoc on public APIs
[ ] Error messages actionable
[ ] Code formatted (prettier)
[ ] No security issues
```

---

**Remember:** These specifications were carefully designed to avoid real-world pitfalls. Follow them exactly, don't "optimize" or "simplify" without asking. Every constraint has a reason.

Good luck! 🚀
