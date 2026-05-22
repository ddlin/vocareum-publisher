# Unknown Settings Pass-Through Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve unknown assignment and part settings returned by the Vocareum API under `_unknown_settings` in `vocareum.yaml`, pass them through on writes with a fallback ladder, and surface a per-run summary so users can file issues for new fields.

**Architecture:** Add a small per-scope allow-list + partition function. Extend Zod schemas to allow `_unknown_settings: Record<string, unknown>`. Thread an `UnknownFieldReporter` from the CLI command entrypoints down through the mappers. On writes, spread `_unknown_settings` into the outgoing API payload; on 400, fall back to the known-only payload using the existing ladder for parts and a new 2-step ladder for assignments. Course scope is deferred per spec.

**Tech Stack:** TypeScript, Zod, axios, vitest. No new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-21-unknown-settings-passthrough-design.md](../specs/2026-05-21-unknown-settings-passthrough-design.md)

---

## File Map

NEW:
- `src/utils/known-settings.ts` — per-scope known/non-settings sets + `partitionApiResponse()`
- `src/utils/unknown-field-reporter.ts` — `UnknownFieldReporter` class
- `test/unit/known-settings.test.ts`
- `test/unit/unknown-field-reporter.test.ts`

MODIFIED:
- `src/types/api.ts` — add `AssignmentSettingsPayload` / `PartSettingsPayload`, widen update signatures
- `src/types/config.ts` — add `_unknown_settings` to `AssignmentSettingsSchema` and `PartSettingsSchema`
- `src/api/assignments.ts` — widen `updateAssignment` settings param
- `src/api/parts.ts` — widen `updatePart` settings param
- `src/utils/settings.ts` — mappers accept `reporter?` + `resourceId?`, attach `_unknown_settings`
- `src/core/publisher.ts` — reporter param on `publish()`, spread `_unknown_settings` into assignment + part `full` payloads, 2-step assignment ladder, guard in `pushSettingChange()`
- `src/commands/pull.ts` — own reporter lifecycle (`try/finally`), pass into mapper call sites
- `src/commands/publish.ts` — own reporter lifecycle (`try/finally`), pass into `publish()`
- `test/unit/settings.test.ts` — extend with preservation + exclusion tests
- `test/unit/publisher.test.ts` — extend with assignment 2-step ladder and part-full-with-unknowns tests

---

## Task 1: Allow-lists and partition function

**Files:**
- Create: `src/utils/known-settings.ts`
- Create: `test/unit/known-settings.test.ts`

- [ ] **Step 1.1: Write failing tests for partition + invariants**

`test/unit/known-settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  KNOWN_COURSE_SETTING_KEYS,
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_COURSE,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  partitionApiResponse,
} from '../../src/utils/known-settings';

describe('partitionApiResponse', () => {
  it('routes known keys to knownFields', () => {
    const result = partitionApiResponse(
      { session_length: '60', labtype: 'Document' },
      KNOWN_PART_SETTING_KEYS,
      NON_SETTING_FIELDS_PART
    );
    expect(result.knownFields).toEqual({ session_length: '60', labtype: 'Document' });
    expect(result.unknownFields).toEqual({});
  });

  it('routes unknown keys to unknownFields', () => {
    const result = partitionApiResponse(
      { session_length: '60', new_vocareum_flag: true },
      KNOWN_PART_SETTING_KEYS,
      NON_SETTING_FIELDS_PART
    );
    expect(result.knownFields).toEqual({ session_length: '60' });
    expect(result.unknownFields).toEqual({ new_vocareum_flag: true });
  });

  it('drops non-settings keys entirely', () => {
    const result = partitionApiResponse(
      { id: '1', courseid: '2', assignmentid: '3', seqnum: '0', deleted: '0', part_url: 'x', name: 'P', description: 'D', session_length: '60' },
      KNOWN_PART_SETTING_KEYS,
      NON_SETTING_FIELDS_PART
    );
    expect(result.knownFields).toEqual({ session_length: '60' });
    expect(result.unknownFields).toEqual({});
  });

  it('routes a key to unknown when it is neither known nor non-setting', () => {
    const result = partitionApiResponse(
      { totally_new: 'x' },
      KNOWN_ASSIGNMENT_SETTING_KEYS,
      NON_SETTING_FIELDS_ASSIGNMENT
    );
    expect(result.unknownFields).toEqual({ totally_new: 'x' });
  });
});

describe('per-scope set invariants', () => {
  const scopes: Array<[string, ReadonlySet<string>, ReadonlySet<string>]> = [
    ['course', KNOWN_COURSE_SETTING_KEYS, NON_SETTING_FIELDS_COURSE],
    ['assignment', KNOWN_ASSIGNMENT_SETTING_KEYS, NON_SETTING_FIELDS_ASSIGNMENT],
    ['part', KNOWN_PART_SETTING_KEYS, NON_SETTING_FIELDS_PART],
  ];

  it.each(scopes)('%s: known and non-settings sets are disjoint', (_name, known, nonSettings) => {
    const intersection = [...known].filter((k) => nonSettings.has(k));
    expect(intersection).toEqual([]);
  });

  it.each(scopes)('%s: _unknown_settings is not in either set', (_name, known, nonSettings) => {
    expect(known.has('_unknown_settings')).toBe(false);
    expect(nonSettings.has('_unknown_settings')).toBe(false);
  });
});

describe('initial set contents', () => {
  it('course KNOWN set is {name, description} (defined for deferred phase)', () => {
    expect([...KNOWN_COURSE_SETTING_KEYS].sort()).toEqual(['description', 'name']);
  });

  it('assignment KNOWN set matches mapAssignmentSettings keys', () => {
    expect([...KNOWN_ASSIGNMENT_SETTING_KEYS].sort()).toEqual([
      'anonymous_grading', 'auto_submit', 'copy_startercode', 'description',
      'exam_duration', 'exam_mode', 'grading_on_submit', 'grading_visibility',
      'live_code_comments', 'noworkarea', 'nosubmit', 'num_attempts',
      'publish', 'publish_grades', 'send_webhook', 'show_end_exam_button',
      'uncompressupload', 'lti_on',
    ].sort());
  });

  it('part KNOWN set matches mapPartSettings keys', () => {
    expect([...KNOWN_PART_SETTING_KEYS].sort()).toEqual([
      'cloud_labs', 'container_image', 'databricks_maxusers', 'deadlinedate',
      'endlab', 'instant_aws_access', 'lab_interface', 'labtype',
      'late_penalty_percent', 'late_penalty_percent_rule', 'monthly_dollar',
      'monthly_time', 'number_of_submissions', 'session_length',
      'submission_filters', 'tags', 'total_dollar', 'total_time',
    ].sort());
  });
});

describe('publisher hand-written settings arrays exclude _unknown_settings', () => {
  // Spec test contract #15: the assignmentKeys and partKeys arrays in
  // publisher.ts (used for settings-change history diffing) must not include
  // _unknown_settings. We assert by reading the publisher.ts source as text —
  // a runtime check would require exporting those arrays, which we'd rather
  // not do just for this guard.
  it('publisher.ts does not include _unknown_settings in its keyof-typed arrays', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/core/publisher.ts', 'utf8');
    // Find the two declarations and assert they don't contain _unknown_settings.
    const assignmentKeysMatch = src.match(/assignmentKeys:\s*\(keyof[\s\S]*?\)\[\]\s*=\s*\[([\s\S]*?)\];/);
    const partKeysMatch = src.match(/partKeys:\s*\(keyof[\s\S]*?\)\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(assignmentKeysMatch).not.toBeNull();
    expect(partKeysMatch).not.toBeNull();
    expect(assignmentKeysMatch![1]).not.toContain('_unknown_settings');
    expect(partKeysMatch![1]).not.toContain('_unknown_settings');
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/known-settings.test.ts
```

Expected: FAIL with "Cannot find module '../../src/utils/known-settings'".

- [ ] **Step 1.3: Implement known-settings module**

`src/utils/known-settings.ts`:

```ts
/**
 * Per-scope sets describing which keys in a Vocareum API response
 * count as "known settings" vs "non-settings" (identity, routed elsewhere,
 * intentionally dropped). Used by mappers to detect unknown drift.
 *
 * Course sets are defined but unused at runtime this phase (see spec
 * "Deferred" section); they exist so partition() and tests have hooks.
 */

export const KNOWN_COURSE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
]);

export const NON_SETTING_FIELDS_COURSE: ReadonlySet<string> = new Set([
  'id',
  'org_id',
]);

export const KNOWN_ASSIGNMENT_SETTING_KEYS: ReadonlySet<string> = new Set([
  'description',
  'nosubmit',
  'publish',
  'publish_grades',
  'auto_submit',
  'grading_on_submit',
  'noworkarea',
  'exam_mode',
  'exam_duration',
  'num_attempts',
  'show_end_exam_button',
  'copy_startercode',
  'uncompressupload',
  'lti_on',
  'anonymous_grading',
  'grading_visibility',
  'send_webhook',
  'live_code_comments',
]);

export const NON_SETTING_FIELDS_ASSIGNMENT: ReadonlySet<string> = new Set([
  'id',
  'courseid',
  'name',
  'due_date',
  'points',
  'deleted',
  'published',
]);

export const KNOWN_PART_SETTING_KEYS: ReadonlySet<string> = new Set([
  'submission_filters',
  'cloud_labs',
  'instant_aws_access',
  'session_length',
  'monthly_dollar',
  'monthly_time',
  'total_time',
  'total_dollar',
  'late_penalty_percent',
  'late_penalty_percent_rule',
  'deadlinedate',
  'endlab',
  'labtype',
  'container_image',
  'number_of_submissions',
  'lab_interface',
  'databricks_maxusers',
  'tags',
]);

export const NON_SETTING_FIELDS_PART: ReadonlySet<string> = new Set([
  'id',
  'courseid',
  'assignmentid',
  'name',
  'description',
  'seqnum',
  'deleted',
  'part_url',
]);

export interface PartitionResult {
  knownFields: Record<string, unknown>;
  unknownFields: Record<string, unknown>;
}

export function partitionApiResponse(
  response: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  nonSettingsKeys: ReadonlySet<string>
): PartitionResult {
  const knownFields: Record<string, unknown> = {};
  const unknownFields: Record<string, unknown> = {};
  for (const key of Object.keys(response)) {
    if (nonSettingsKeys.has(key)) {
      continue;
    }
    if (knownKeys.has(key)) {
      knownFields[key] = response[key];
    } else {
      unknownFields[key] = response[key];
    }
  }
  return { knownFields, unknownFields };
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
npx vitest run test/unit/known-settings.test.ts
```

Expected: PASS (all tests green).

- [ ] **Step 1.5: Commit**

```bash
git add src/utils/known-settings.ts test/unit/known-settings.test.ts
git commit -m "feat: add per-scope known-settings sets and partition function"
```

---

## Task 2: UnknownFieldReporter

**Files:**
- Create: `src/utils/unknown-field-reporter.ts`
- Create: `test/unit/unknown-field-reporter.test.ts`

- [ ] **Step 2.1: Write failing tests**

`test/unit/unknown-field-reporter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';

const makeLogger = () => ({
  warn: vi.fn(),
  plain: vi.fn(),
});

describe('UnknownFieldReporter', () => {
  let logger: ReturnType<typeof makeLogger>;
  beforeEach(() => {
    logger = makeLogger();
  });

  it('dedupes repeated (scope, field) pairs and counts occurrences', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('part', 'new_flag', true, '1');
    r.record('part', 'new_flag', false, '2');
    r.record('part', 'new_flag', true, '3');
    const summary = r.summary();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      scope: 'part',
      field: 'new_flag',
      exampleValue: true,
      count: 3,
      firstResourceId: '1',
    });
  });

  it('emits a warn line only on the first occurrence of a (scope, field) pair', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('assignment', 'foo', 1, 'a1');
    r.record('assignment', 'foo', 2, 'a2');
    r.record('assignment', 'bar', 3, 'a1');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toContain('foo');
    expect(logger.warn.mock.calls[1][0]).toContain('bar');
  });

  it('hasAny returns false when no records and true otherwise', () => {
    const r = new UnknownFieldReporter(logger);
    expect(r.hasAny()).toBe(false);
    r.record('part', 'x', 1, 'p1');
    expect(r.hasAny()).toBe(true);
  });

  it('summary sorts by scope then field', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('part', 'zeta', 1, 'p1');
    r.record('assignment', 'beta', 2, 'a1');
    r.record('part', 'alpha', 3, 'p2');
    r.record('assignment', 'alpha', 4, 'a2');
    const summary = r.summary();
    expect(summary.map((s) => `${s.scope}.${s.field}`)).toEqual([
      'assignment.alpha',
      'assignment.beta',
      'part.alpha',
      'part.zeta',
    ]);
  });

  it('printSummary prints nothing when no unknowns were recorded', () => {
    const r = new UnknownFieldReporter(logger);
    r.printSummary();
    expect(logger.plain).not.toHaveBeenCalled();
  });

  it('printSummary prints a block including field names and example values when unknowns exist', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('part', 'new_flag', true, 'p1');
    r.record('part', 'extra', 'abc', 'p2');
    r.printSummary();
    expect(logger.plain).toHaveBeenCalled();
    const printed = logger.plain.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('new_flag');
    expect(printed).toContain('extra');
    expect(printed).toContain('_unknown_settings');
    expect(printed).toContain('https://github.com/ddlin/vocareum-publisher/issues/new');
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/unknown-field-reporter.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 2.3: Implement UnknownFieldReporter**

`src/utils/unknown-field-reporter.ts`:

```ts
/**
 * Run-level collector for unknown Vocareum API fields encountered during
 * a single CLI command invocation. Ownership: command entrypoints
 * construct one instance, pass it down, and call printSummary() in
 * a try/finally at the command boundary. Lower layers only call record().
 */

export type UnknownFieldScope = 'assignment' | 'part'; // 'course' added in deferred phase

export interface UnknownFieldRecord {
  scope: UnknownFieldScope;
  field: string;
  exampleValue: unknown;
  count: number;
  firstResourceId: string;
}

interface MinimalLogger {
  warn: (msg: string) => void;
  plain: (msg: string) => void;
}

const ISSUE_URL = 'https://github.com/ddlin/vocareum-publisher/issues/new';

function readPackageVersion(): string {
  // Read the running CLI version. Avoid importing package.json at module
  // load time so unit tests don't depend on file layout.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export class UnknownFieldReporter {
  private records = new Map<string, UnknownFieldRecord>();

  constructor(private logger: MinimalLogger) {}

  record(
    scope: UnknownFieldScope,
    field: string,
    exampleValue: unknown,
    resourceId: string
  ): void {
    const key = `${scope}.${field}`;
    const existing = this.records.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.records.set(key, {
      scope,
      field,
      exampleValue,
      count: 1,
      firstResourceId: resourceId,
    });
    this.logger.warn(
      `Vocareum returned unknown ${scope} setting "${field}" (preserved under _unknown_settings)`
    );
  }

  hasAny(): boolean {
    return this.records.size > 0;
  }

  summary(): UnknownFieldRecord[] {
    return [...this.records.values()].sort((a, b) => {
      if (a.scope !== b.scope) { return a.scope < b.scope ? -1 : 1; }
      return a.field < b.field ? -1 : 1;
    });
  }

  printSummary(): void {
    if (!this.hasAny()) { return; }
    const lines: string[] = [];
    const divider = '─'.repeat(65);
    lines.push(divider);
    lines.push('Vocareum returned unsupported settings fields.');
    lines.push('');
    lines.push('These fields were preserved under _unknown_settings in vocareum.yaml');
    lines.push('and will be passed through on future updates, but vocgit does not');
    lines.push('understand them yet.');
    lines.push('');
    lines.push('Please file a bug or enhancement request so vocgit can promote these');
    lines.push('fields to formally supported settings.');
    lines.push('');
    lines.push(`  ${ISSUE_URL}`);
    lines.push('');
    lines.push('Include in the report:');
    lines.push(`  - vocgit version:    ${readPackageVersion()}`);
    const summary = this.summary();
    const byScope = new Map<string, UnknownFieldRecord[]>();
    for (const r of summary) {
      const arr = byScope.get(r.scope) ?? [];
      arr.push(r);
      byScope.set(r.scope, arr);
    }
    for (const [scope, recs] of byScope) {
      lines.push(`  - resource scope:    ${scope}`);
      lines.push(`  - field names:       ${recs.map((r) => r.field).join(', ')}`);
      lines.push(
        `  - example values:    ${recs
          .map((r) => `${r.field}=${JSON.stringify(r.exampleValue)}`)
          .join(', ')}`
      );
    }
    lines.push('  - redacted vocareum.yaml snippet showing _unknown_settings');
    lines.push(divider);
    for (const line of lines) {
      this.logger.plain(line);
    }
  }
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
npx vitest run test/unit/unknown-field-reporter.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Verify the `logger` module exports `plain`**

```bash
grep -n "plain\b" src/utils/logger.ts | head -5
```

Expected: at least one match showing `plain` is a public method on the logger. If not, look up the equivalent method (e.g., `info`, `log`) and replace `logger.plain` calls in `printSummary()` accordingly. If the existing logger has no plain-output method, add one as a tiny pass-through to `console.log`.

- [ ] **Step 2.6: Commit**

```bash
git add src/utils/unknown-field-reporter.ts test/unit/unknown-field-reporter.test.ts
git commit -m "feat: add UnknownFieldReporter for end-of-run drift summary"
```

---

## Task 3: SettingsPayload types and widened update signatures

**Files:**
- Modify: `src/types/api.ts` (add type aliases after line ~236)
- Modify: `src/api/assignments.ts:237-242` (widen `settings` parameter)
- Modify: `src/api/parts.ts:96-102` (widen `settings` parameter)

This task is type-only. No new tests; correctness is verified by `tsc --noEmit`.

- [ ] **Step 3.1: Add payload types to `src/types/api.ts`**

Append after the existing `ApiPartSettings` interface (around line 236):

```ts
/**
 * Outgoing payload types for update calls. The base interfaces above describe
 * the known/typed shape; the payload types additionally permit `_unknown_settings`
 * to be spread in at the top level so unknown fields returned from a previous
 * pull can be passed back through on writes without unsafe casts. See
 * docs/superpowers/specs/2026-05-21-unknown-settings-passthrough-design.md §5.
 */
export type AssignmentSettingsPayload = ApiAssignmentSettings & Record<string, unknown>;
export type PartSettingsPayload       = ApiPartSettings       & Record<string, unknown>;
```

- [ ] **Step 3.2: Widen `updateAssignment` signature in `src/api/assignments.ts`**

Locate `export async function updateAssignment(...)` (line 237). Change the `settings` parameter type:

```ts
import type {
  // ...existing imports...
  AssignmentSettingsPayload,
} from '../types/api';

export async function updateAssignment(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  settings: AssignmentSettingsPayload   // was: ApiAssignmentSettings
): Promise<void> {
```

Leave the rest of the function body unchanged.

- [ ] **Step 3.3: Widen `updatePart` signature in `src/api/parts.ts`**

Locate `export async function updatePart(...)` (line 96). Change the `settings` parameter type:

```ts
import type {
  // ...existing imports...
  PartSettingsPayload,
} from '../types/api';

export async function updatePart(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  settings: PartSettingsPayload   // was: ApiPartSettings
): Promise<void> {
```

- [ ] **Step 3.4: Run typecheck to verify no regressions**

```bash
npm run typecheck
```

Expected: PASS with no errors. (Existing call sites still pass `ApiAssignmentSettings` / `ApiPartSettings` shaped objects, which structurally satisfy the wider types.)

- [ ] **Step 3.5: Run full test suite to verify no behavioral regressions**

```bash
npm test
```

Expected: all tests still pass.

- [ ] **Step 3.6: Commit**

```bash
git add src/types/api.ts src/api/assignments.ts src/api/parts.ts
git commit -m "refactor: widen updateAssignment/updatePart payload types"
```

---

## Task 4: Add `_unknown_settings` to AssignmentSettingsSchema and PartSettingsSchema

**Files:**
- Modify: `src/types/config.ts:177-216` (PartSettingsSchema) and `src/types/config.ts:249-287` (AssignmentSettingsSchema)
- Modify: `test/unit/config.test.ts` (add round-trip tests)

- [ ] **Step 4.1: Write failing round-trip tests**

Append to `test/unit/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AssignmentSettingsSchema, PartSettingsSchema } from '../../src/types/config';

describe('_unknown_settings preservation in Zod schemas', () => {
  it('AssignmentSettingsSchema preserves _unknown_settings through parse', () => {
    const input = {
      nosubmit: true,
      _unknown_settings: { vendor_field: 'abc', new_flag: 42 },
    };
    const parsed = AssignmentSettingsSchema.parse(input);
    expect(parsed?._unknown_settings).toEqual({ vendor_field: 'abc', new_flag: 42 });
  });

  it('PartSettingsSchema preserves _unknown_settings through parse', () => {
    const input = {
      session_length: '60',
      _unknown_settings: { lab_extra: { nested: true }, arr: [1, 2, 3] },
    };
    const parsed = PartSettingsSchema.parse(input);
    expect(parsed?._unknown_settings).toEqual({
      lab_extra: { nested: true },
      arr: [1, 2, 3],
    });
  });

  it('AssignmentSettingsSchema accepts settings without _unknown_settings', () => {
    const parsed = AssignmentSettingsSchema.parse({ nosubmit: true });
    expect(parsed?._unknown_settings).toBeUndefined();
  });

  it('PartSettingsSchema accepts settings without _unknown_settings', () => {
    const parsed = PartSettingsSchema.parse({ session_length: '60' });
    expect(parsed?._unknown_settings).toBeUndefined();
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/config.test.ts -t "_unknown_settings"
```

Expected: FAIL — `_unknown_settings` is stripped by Zod because it isn't in the schema.

- [ ] **Step 4.3: Add `_unknown_settings` field to PartSettingsSchema**

In `src/types/config.ts`, inside `PartSettingsSchema` (line 177), add a new field just before the closing `})`:

```ts
    /** Pass-through bucket for settings vocgit does not formally understand.
     *  Populated by mapPartSettings from unknown API response fields; spread
     *  back into outgoing API payloads on publish. See spec
     *  docs/superpowers/specs/2026-05-21-unknown-settings-passthrough-design.md
     */
    _unknown_settings: z.record(z.string(), z.unknown()).optional(),
```

- [ ] **Step 4.4: Add `_unknown_settings` field to AssignmentSettingsSchema**

In `src/types/config.ts`, inside `AssignmentSettingsSchema` (line 249), add the same field just before the closing `})`:

```ts
    /** Pass-through bucket for settings vocgit does not formally understand.
     *  See PartSettingsSchema._unknown_settings for details.
     */
    _unknown_settings: z.record(z.string(), z.unknown()).optional(),
```

- [ ] **Step 4.5: Run tests to verify they pass**

```bash
npx vitest run test/unit/config.test.ts -t "_unknown_settings"
```

Expected: PASS.

- [ ] **Step 4.6: Run full test suite**

```bash
npm test
```

Expected: all tests still pass. (No existing code reads `_unknown_settings`; adding it as optional doesn't break anything.)

- [ ] **Step 4.7: Commit**

```bash
git add src/types/config.ts test/unit/config.test.ts
git commit -m "feat: allow _unknown_settings in assignment and part schemas"
```

---

## Task 5: Extend mappers to partition and report

**Files:**
- Modify: `src/utils/settings.ts` (both mappers)
- Modify: `test/unit/settings.test.ts` (add preservation + exclusion tests)

- [ ] **Step 5.1: Write failing tests**

Append to `test/unit/settings.test.ts`:

```ts
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';

const noopLogger = { warn: () => {}, plain: () => {} };

describe('mapAssignmentSettings — unknown settings preservation', () => {
  it('attaches unknown fields under _unknown_settings', () => {
    const result = mapAssignmentSettings(
      baseResponse({ nosubmit: true, vendor_field: 'abc' } as never)
    );
    expect(result._unknown_settings).toEqual({ vendor_field: 'abc' });
    expect(result.nosubmit).toBe(true);
  });

  it('does not add _unknown_settings when all response keys are known or non-settings', () => {
    const result = mapAssignmentSettings(baseResponse({ nosubmit: true }));
    expect(result._unknown_settings).toBeUndefined();
  });

  it('does not route non-settings fields (id, courseid, name, due_date, deleted, published) into _unknown_settings', () => {
    const result = mapAssignmentSettings(
      baseResponse({
        nosubmit: true,
        due_date: '2026-01-01',
        points: '100',
        published: '1',
      } as never)
    );
    expect(result._unknown_settings).toBeUndefined();
  });

  it('reports each unknown field once to the reporter', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    const spy = vi.spyOn(reporter, 'record');
    mapAssignmentSettings(
      baseResponse({ vendor_field: 'abc', other_new: 1 } as never),
      reporter,
      'a-1'
    );
    expect(spy).toHaveBeenCalledWith('assignment', 'vendor_field', 'abc', 'a-1');
    expect(spy).toHaveBeenCalledWith('assignment', 'other_new', 1, 'a-1');
  });
});

function basePart(extra: Partial<VocareumPartResponse>): VocareumPartResponse {
  return {
    id: 'p1',
    courseid: 'c1',
    assignmentid: 'a1',
    name: 'Part',
    seqnum: '0',
    deleted: '0',
    ...extra,
  } as VocareumPartResponse;
}

describe('mapPartSettings — unknown settings preservation', () => {
  it('attaches unknown fields under _unknown_settings', () => {
    const result = mapPartSettings(
      basePart({ session_length: '60', mystery: true } as never)
    );
    expect(result._unknown_settings).toEqual({ mystery: true });
    expect(result.session_length).toBe('60');
  });

  it('does not route non-settings fields (id, courseid, assignmentid, name, description, seqnum, deleted, part_url) into _unknown_settings', () => {
    const result = mapPartSettings(
      basePart({ session_length: '60', description: 'D', part_url: 'x' } as never)
    );
    expect(result._unknown_settings).toBeUndefined();
  });

  it('reports each unknown field once to the reporter', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    const spy = vi.spyOn(reporter, 'record');
    mapPartSettings(
      basePart({ mystery: true, extra: 'x' } as never),
      reporter,
      'p-1'
    );
    expect(spy).toHaveBeenCalledWith('part', 'mystery', true, 'p-1');
    expect(spy).toHaveBeenCalledWith('part', 'extra', 'x', 'p-1');
  });
});

describe('source-of-truth: every key in KNOWN_*_SETTING_KEYS is actually read by its mapper', () => {
  it('mapAssignmentSettings reads every KNOWN_ASSIGNMENT_SETTING_KEYS entry', () => {
    // Feed an API response that has a non-undefined value for every known key.
    // If the mapper reads them all, the output object must contain every key.
    // If the mapper is missing a read for some key, the test fails — which
    // catches the case where the set drifted ahead of the mapper.
    const inputs: Record<string, unknown> = {};
    for (const k of KNOWN_ASSIGNMENT_SETTING_KEYS) {
      // Provide a value that is unambiguously not-undefined for any coercion path:
      // booleans -> true, strings -> 'x', numbers -> 1, enums -> a valid member.
      if (k === 'exam_mode') { inputs[k] = 'timed'; }
      else if (k === 'grading_visibility') { inputs[k] = 'all'; }
      else if (k === 'exam_duration' || k === 'num_attempts') { inputs[k] = 1; }
      else if (k === 'publish_grades' || k === 'description') { inputs[k] = 'x'; }
      else if (k === 'lti_on') { inputs[k] = '1'; } // string per Vocareum quirk
      else { inputs[k] = true; }
    }
    const result = mapAssignmentSettings(baseResponse(inputs as never)) as Record<string, unknown>;
    for (const k of KNOWN_ASSIGNMENT_SETTING_KEYS) {
      expect(result, `mapAssignmentSettings did not copy "${k}" — KNOWN_ASSIGNMENT_SETTING_KEYS has drifted ahead of the mapper`).toHaveProperty(k);
    }
  });

  it('mapPartSettings reads every KNOWN_PART_SETTING_KEYS entry', () => {
    const inputs: Record<string, unknown> = {};
    for (const k of KNOWN_PART_SETTING_KEYS) {
      if (k === 'submission_filters') { inputs[k] = { include: ['*.py'] }; }
      else if (k === 'lab_interface') { inputs[k] = { panels: ['Html'] }; }
      else if (k === 'tags') { inputs[k] = { average_lab_time: 300 }; }
      else if (k === 'late_penalty_percent_rule') { inputs[k] = 'max score'; }
      else if (k === 'endlab') { inputs[k] = 'stop'; }
      else if (k === 'labtype' || k === 'container_image') { inputs[k] = 'x'; }
      else if (k === 'session_length' || k === 'monthly_dollar' || k === 'monthly_time' || k === 'total_time' || k === 'total_dollar' || k === 'deadlinedate') { inputs[k] = '60'; }
      else if (k === 'late_penalty_percent' || k === 'number_of_submissions' || k === 'databricks_maxusers') { inputs[k] = 1; }
      else { inputs[k] = true; } // cloud_labs, instant_aws_access
    }
    const result = mapPartSettings(basePart(inputs as never)) as Record<string, unknown>;
    for (const k of KNOWN_PART_SETTING_KEYS) {
      expect(result, `mapPartSettings did not copy "${k}" — KNOWN_PART_SETTING_KEYS has drifted ahead of the mapper`).toHaveProperty(k);
    }
  });
});
```

Add imports at the top of the file (if not already present):

```ts
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
} from '../../src/utils/known-settings';
```

Add the `vi` import to the top of the file if not already present:

```ts
import { describe, it, expect, vi } from 'vitest';
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/settings.test.ts -t "unknown settings preservation"
```

Expected: FAIL — `_unknown_settings` is undefined / mappers don't accept reporter.

- [ ] **Step 5.3: Modify mappers in `src/utils/settings.ts`**

Add imports at the top:

```ts
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  partitionApiResponse,
} from './known-settings';
import type { UnknownFieldReporter } from './unknown-field-reporter';
```

Modify `mapAssignmentSettings` (line 30):

```ts
export function mapAssignmentSettings(
  apiResponse: VocareumAssignmentResponse,
  reporter?: UnknownFieldReporter,
  resourceId?: string
): NonNullable<AssignmentSettings> {
  const settings: NonNullable<AssignmentSettings> = {};

  // ... existing known-field copy block unchanged ...

  // Partition response to detect unknown fields
  const { unknownFields } = partitionApiResponse(
    apiResponse as unknown as Record<string, unknown>,
    KNOWN_ASSIGNMENT_SETTING_KEYS,
    NON_SETTING_FIELDS_ASSIGNMENT
  );
  if (Object.keys(unknownFields).length > 0) {
    settings._unknown_settings = unknownFields;
    if (reporter && resourceId !== undefined) {
      for (const [field, value] of Object.entries(unknownFields)) {
        reporter.record('assignment', field, value, resourceId);
      }
    }
  }

  return settings;
}
```

Apply the same pattern to `mapPartSettings` (line 96) using `KNOWN_PART_SETTING_KEYS` / `NON_SETTING_FIELDS_PART` and `reporter.record('part', ...)`.

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
npx vitest run test/unit/settings.test.ts
```

Expected: PASS (including pre-existing tests that called the mappers with one argument — the new params are optional).

- [ ] **Step 5.5: Run full test suite**

```bash
npm test
```

Expected: PASS. Existing call sites in `publisher.ts` / `pull.ts` are unaffected because the new params are optional.

- [ ] **Step 5.6: Commit**

```bash
git add src/utils/settings.ts test/unit/settings.test.ts
git commit -m "feat: mappers partition unknown fields under _unknown_settings"
```

---

## Task 6: Guard `pushSettingChange()` against `_unknown_settings`

**Files:**
- Modify: `src/core/publisher.ts:121-129` (pushSettingChange function)
- Modify: `test/unit/publisher.test.ts` (add guard test)

- [ ] **Step 6.1: Write failing test**

Append to `test/unit/publisher.test.ts` (above the existing top-level `describe('publish', ...)`):

```ts
import { pushSettingChange } from '../../src/core/publisher';
import type { HistorySettingChange } from '../../src/types/config';

describe('pushSettingChange _unknown_settings guard', () => {
  it('does not push a change record when field is _unknown_settings', () => {
    const changes: HistorySettingChange[] = [];
    pushSettingChange(changes, {
      scope: 'assignment',
      assignment_id: 'a1',
      assignment_name: 'A1',
      field: '_unknown_settings',
      from: { foo: 1 },
      to: { foo: 2 },
    });
    expect(changes).toEqual([]);
  });

  it('still pushes a change record for normal fields', () => {
    const changes: HistorySettingChange[] = [];
    pushSettingChange(changes, {
      scope: 'assignment',
      assignment_id: 'a1',
      assignment_name: 'A1',
      field: 'nosubmit',
      from: false,
      to: true,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('nosubmit');
  });

  it('still no-ops when from equals to (existing behavior preserved)', () => {
    const changes: HistorySettingChange[] = [];
    pushSettingChange(changes, {
      scope: 'assignment',
      assignment_id: 'a1',
      assignment_name: 'A1',
      field: 'nosubmit',
      from: true,
      to: true,
    });
    expect(changes).toEqual([]);
  });
});
```

This test requires `pushSettingChange` to be exported. The next step makes both changes (export + guard) simultaneously.

- [ ] **Step 6.2: Run test to verify it fails**

```bash
npx vitest run test/unit/publisher.test.ts -t "_unknown_settings guard"
```

Expected: PASS only if `pushSettingChange` is exported AND guards. After making `pushSettingChange` exported (next step) but BEFORE adding the guard, the test will FAIL because the change will be appended.

- [ ] **Step 6.3: Export `pushSettingChange` and add the guard**

In `src/core/publisher.ts`, locate `function pushSettingChange` (line 121). Change to:

```ts
export function pushSettingChange(
  changes: HistorySettingChange[],
  change: HistorySettingChange
): void {
  // Guard: _unknown_settings is a pass-through bucket. We don't formally
  // understand the fields inside it, so reporting "_unknown_settings changed"
  // would be misleading noise in the structured change log. The reporter
  // summary (UnknownFieldReporter) communicates that unknowns were observed.
  if (change.field === '_unknown_settings') {
    return;
  }
  if (settingsEqual(change.from, change.to)) {
    return;
  }
  changes.push(change);
}
```

- [ ] **Step 6.4: Run test to verify it passes**

```bash
npx vitest run test/unit/publisher.test.ts -t "_unknown_settings guard"
```

Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/core/publisher.ts test/unit/publisher.test.ts
git commit -m "feat: pushSettingChange ignores _unknown_settings field"
```

---

## Task 7: Spread `_unknown_settings` into part `full` payload + thread reporter through publish()

**Files:**
- Modify: `src/core/publisher.ts` — `buildPartSettingsPayload` (line 70), `publish()` signature, part update block (line 632)
- Modify: `test/unit/publisher.test.ts`

- [ ] **Step 7.1: Write failing tests**

Append to `test/unit/publisher.test.ts`:

```ts
import { buildPartSettingsPayload } from '../../src/core/publisher';
import type { PartSettings } from '../../src/types/config';

describe('buildPartSettingsPayload — _unknown_settings handling', () => {
  it('full mode spreads _unknown_settings keys at the top level (without the wrapper)', () => {
    const settings: PartSettings = {
      session_length: '60',
      _unknown_settings: { vendor_flag: true, extra: 'x' },
    };
    const payload = buildPartSettingsPayload('PartName', settings, 'full') as Record<string, unknown>;
    expect(payload.session_length).toBe('60');
    expect(payload.vendor_flag).toBe(true);
    expect(payload.extra).toBe('x');
    expect(payload._unknown_settings).toBeUndefined();
  });

  it('safe mode does NOT include _unknown_settings keys', () => {
    const settings: PartSettings = {
      session_length: '60',
      _unknown_settings: { vendor_flag: true },
    };
    const payload = buildPartSettingsPayload('PartName', settings, 'safe') as Record<string, unknown>;
    expect(payload.vendor_flag).toBeUndefined();
    expect(payload._unknown_settings).toBeUndefined();
    expect(payload.session_length).toBe('60');
  });

  it('full mode with no _unknown_settings behaves identically to today', () => {
    const settings: PartSettings = { session_length: '60', labtype: 'Document' };
    const payload = buildPartSettingsPayload('PartName', settings, 'full') as Record<string, unknown>;
    expect(payload.session_length).toBe('60');
    expect(payload.labtype).toBe('Document');
    expect(Object.keys(payload).every((k) => !k.startsWith('vendor_'))).toBe(true);
  });
});

describe('part update full→safe ladder with _unknown_settings (integration-style via publish)', () => {
  // Verifies spec test contract #7: when the 'full' payload (with unknowns)
  // is rejected with 400, the safe retry succeeds, and _unknown_settings
  // stays in YAML (we don't write a config update that removes it).
  it('retries with safe payload when full is rejected 400, and updateConfig is not asked to remove _unknown_settings', async () => {
    // Use the existing mock infrastructure at the top of this file
    // (updatePartMock, reconcileMock, etc.).
    // Arrange:
    //   - config: assignment with one part whose settings include
    //     _unknown_settings: { vendor_flag: true }.
    //   - reconcileMock returns a plan that marks this part for 'update'.
    //   - updatePartMock: first call (full) rejects with { response: { status: 400 } };
    //     second call (safe) resolves.
    // Act: await publish(config, client, baseOptions, reporter)
    // Assert:
    //   - updatePartMock called at least twice
    //   - first call's settings arg has vendor_flag === true
    //   - second call's settings arg has vendor_flag === undefined
    //   - updateConfigMock was NOT called with any update that strips
    //     _unknown_settings from the assignment.parts[0].settings

    // Construct a config inline (don't reuse the top-level config object
    // since this test needs a non-null assignment_id and part_id):
    const localConfig: Config = {
      ...config,
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Lab 1',
          path: 'lab1',
          create_from_template: false,
          parts: [{
            part_id: 'p1',
            path: 'part1',
            settings: {
              session_length: '60',
              _unknown_settings: { vendor_flag: true },
            },
          }],
        },
      ],
    };

    const plan: ReconciliationPlan = {
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [{ type: 'update', part: localConfig.assignments[0].parts[0] }],
      }],
      orphanedInVocareum: [],
      staleInConfig: [],
    } as ReconciliationPlan;

    reconcileMock.mockResolvedValue(plan);
    displayPlanMock.mockReturnValue(undefined);
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: localConfig.vocareum.course_id, name: 'Lab 1', deleted: '0',
    });
    getPartMock.mockResolvedValue({
      id: 'p1', courseid: localConfig.vocareum.course_id, assignmentid: 'a1',
      name: 'part1', seqnum: '0', deleted: '0', session_length: '60',
    });
    readDirectoryMock.mockResolvedValue({});
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'h' });

    const http400 = Object.assign(new Error('rejected'), { response: { status: 400 } });
    updatePartMock
      .mockRejectedValueOnce(http400)  // full attempt
      .mockResolvedValueOnce(undefined); // safe retry

    await publish(localConfig, client, baseOptions);

    expect(updatePartMock).toHaveBeenCalledTimes(2);
    const firstSettings = updatePartMock.mock.calls[0][4] as Record<string, unknown>;
    const secondSettings = updatePartMock.mock.calls[1][4] as Record<string, unknown>;
    expect(firstSettings.vendor_flag).toBe(true);
    expect(secondSettings.vendor_flag).toBeUndefined();

    // updateConfig should not have been called with a payload that strips
    // _unknown_settings. If updateConfigMock was called for any reason, check
    // that none of its calls request removing or clearing _unknown_settings.
    for (const call of updateConfigMock.mock.calls) {
      const updates = call[1];
      if (updates?.assignments) {
        for (const a of updates.assignments) {
          if (a.parts) {
            for (const p of a.parts) {
              if (p.settings) {
                // If settings was updated by publish, _unknown_settings must
                // not have been removed.
                expect(p.settings._unknown_settings).toBeDefined();
              }
            }
          }
        }
      }
    }
  });
});
```

This test requires `buildPartSettingsPayload` and `publish` to be exported (publish already is). Make `buildPartSettingsPayload` exported in the next step.

- [ ] **Step 7.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/publisher.test.ts -t "buildPartSettingsPayload"
```

Expected: FAIL (function not exported, or `_unknown_settings` not spread).

- [ ] **Step 7.3: Modify `buildPartSettingsPayload` to spread `_unknown_settings` in full mode**

Locate `buildPartSettingsPayload` (line 70). Change signature to `export`, change return type to `PartSettingsPayload`, and modify the full-mode return value:

```ts
import type { PartSettingsPayload, AssignmentSettingsPayload } from '../types/api';

export function buildPartSettingsPayload(
  partName: string,
  partSettings: PartSettings | undefined,
  mode: 'full' | 'safe'
): PartSettingsPayload {
  const normalizedFilters = sanitizeSubmissionFilters(
    normalizeSubmissionFilters(partSettings?.submission_filters)
  );
  const base: PartSettingsPayload = {
    name: partName,
    submission_filters: normalizedFilters,
    session_length: nullToUndefined(partSettings?.session_length),
    monthly_dollar: nullToUndefined(partSettings?.monthly_dollar),
    monthly_time: nullToUndefined(partSettings?.monthly_time),
    total_time: nullToUndefined(partSettings?.total_time),
    total_dollar: nullToUndefined(partSettings?.total_dollar),
  };

  if (mode === 'safe') {
    return base;
  }

  const full: PartSettingsPayload = {
    ...base,
    cloud_labs: nullToUndefined(partSettings?.cloud_labs),
    instant_aws_access: nullToUndefined(partSettings?.instant_aws_access),
    late_penalty_percent: nullToUndefined(partSettings?.late_penalty_percent),
    late_penalty_percent_rule: nullToUndefined(partSettings?.late_penalty_percent_rule),
    deadlinedate: nullToUndefined(partSettings?.deadlinedate),
    endlab: nullToUndefined(partSettings?.endlab),
    labtype: nullToUndefined(partSettings?.labtype),
    container_image: nullToUndefined(partSettings?.container_image),
    number_of_submissions: nullToUndefined(partSettings?.number_of_submissions),
    lab_interface: nullToUndefined(partSettings?.lab_interface),
    databricks_maxusers: nullToUndefined(partSettings?.databricks_maxusers),
    tags: normalizeTags(partSettings?.tags),
  };

  // Spread _unknown_settings (NOT the wrapper key) into the top level.
  const unknown = partSettings?._unknown_settings;
  if (unknown && typeof unknown === 'object') {
    for (const [k, v] of Object.entries(unknown)) {
      full[k] = v;
    }
  }
  return full;
}
```

- [ ] **Step 7.4: Run tests to verify they pass**

```bash
npx vitest run test/unit/publisher.test.ts -t "buildPartSettingsPayload"
```

Expected: PASS.

- [ ] **Step 7.5: Add reporter parameter to `publish()` and thread to mapper call sites**

Locate the `publish` function signature (line 139) and add reporter:

```ts
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';

// In the PublishOperationOptions interface (src/types/state.ts), add:
//   reporter?: UnknownFieldReporter;
// OR pass it as a separate parameter to publish(). The latter is cleaner.

export async function publish(
  config: Config,
  client: VocareumClient,
  options: PublishOperationOptions,
  reporter?: UnknownFieldReporter
): Promise<PublishResult> {
```

Update the mapper calls inside `publish()` (lines 392, 402) to pass `reporter` and a `resourceId`:

```ts
// Line ~392 — template settings:
const templateSettings = mapAssignmentSettings(fullAssignment, reporter, fullAssignment.id);

// Line ~402 — template part settings:
const partSettings = mapPartSettings(fullPart, reporter, fullPart.id);
```

- [ ] **Step 7.6: Run typecheck and tests**

```bash
npm run typecheck && npm test
```

Expected: PASS. Existing call sites of `publish()` don't pass `reporter`, but it's optional so they still compile.

- [ ] **Step 7.7: Commit**

```bash
git add src/core/publisher.ts test/unit/publisher.test.ts
git commit -m "feat: spread _unknown_settings into part full payload, thread reporter"
```

---

## Task 8: Assignment 2-step ladder with `_unknown_settings`

**Files:**
- Modify: `src/core/publisher.ts:497-517` (assignment update block)
- Modify: `test/unit/publisher.test.ts` or `test/integration/publish.test.ts`

- [ ] **Step 8.1: Write failing test for assignment 2-step ladder**

Append to `test/unit/publisher.test.ts`:

```ts
describe('assignment update — 2-step ladder with _unknown_settings', () => {
  function makeConfigWithUnknownAsnSetting(): Config {
    return {
      ...config,
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Lab 1',
          path: 'lab1',
          create_from_template: false,
          parts: [{ part_id: 'p1', path: 'part1' }],
          settings: {
            nosubmit: true,
            _unknown_settings: { vendor_flag: true },
          },
        },
      ],
    };
  }

  function makePlanForUpdate(local: Config): ReconciliationPlan {
    return {
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: local.assignments[0],
        parts: [],
      }],
      orphanedInVocareum: [],
      staleInConfig: [],
    } as ReconciliationPlan;
  }

  function stubRemoteFetches(local: Config): void {
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: local.vocareum.course_id,
      name: 'Lab 1', deleted: '0', nosubmit: false,
    });
  }

  it('first attempt sends a payload that includes both known fields and the unknown_settings keys', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting();
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalled();
    const firstCallSettings = updateAssignmentMock.mock.calls[0][3] as Record<string, unknown>;
    expect(firstCallSettings.nosubmit).toBe(true);
    expect(firstCallSettings.vendor_flag).toBe(true);
  });

  it('retries with known-only payload when first attempt fails 400', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting();
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);

    const http400 = Object.assign(new Error('rejected'), { response: { status: 400 } });
    updateAssignmentMock
      .mockRejectedValueOnce(http400)
      .mockResolvedValueOnce(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalledTimes(2);
    const second = updateAssignmentMock.mock.calls[1][3] as Record<string, unknown>;
    expect(second.vendor_flag).toBeUndefined();
    expect(second.nosubmit).toBe(true);
  });

  it('non-400 errors are not retried (existing behavior preserved)', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting();
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);

    const http500 = Object.assign(new Error('server'), { response: { status: 500 } });
    updateAssignmentMock.mockRejectedValueOnce(http500);

    await expect(publish(localConfig, client, baseOptions)).rejects.toThrow();
    expect(updateAssignmentMock).toHaveBeenCalledTimes(1);
  });

  it('without _unknown_settings, makes only one attempt (existing behavior)', async () => {
    const localConfig: Config = {
      ...config,
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Lab 1',
          path: 'lab1',
          create_from_template: false,
          parts: [{ part_id: 'p1', path: 'part1' }],
          settings: { nosubmit: true },
        },
      ],
    };
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 8.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/publisher.test.ts -t "2-step ladder"
```

Expected: FAIL — assignments today use a single call; the unknown keys aren't sent and there's no retry.

- [ ] **Step 8.3: Modify the assignment update block in `publisher.ts`**

Locate the assignment update around line 497. Replace:

```ts
await updateAssignment(client, workingConfig.vocareum.course_id, action.assignment.assignment_id, {
  name: action.assignment.name,
  description: nullToUndefined(asnSettings?.description),
  // ... all known fields ...
  live_code_comments: nullToUndefined(asnSettings?.live_code_comments),
});
```

with a 2-step ladder:

```ts
const knownAssignmentPayload: AssignmentSettingsPayload = {
  name: action.assignment.name,
  description: nullToUndefined(asnSettings?.description),
  nosubmit: nullToUndefined(asnSettings?.nosubmit),
  publish: nullToUndefined(asnSettings?.publish),
  publish_grades: nullToUndefined(asnSettings?.publish_grades),
  auto_submit: nullToUndefined(asnSettings?.auto_submit),
  grading_on_submit: nullToUndefined(asnSettings?.grading_on_submit),
  noworkarea: nullToUndefined(asnSettings?.noworkarea),
  exam_mode: nullToUndefined(asnSettings?.exam_mode),
  exam_duration: nullToUndefined(asnSettings?.exam_duration),
  num_attempts: nullToUndefined(asnSettings?.num_attempts),
  show_end_exam_button: nullToUndefined(asnSettings?.show_end_exam_button),
  copy_startercode: nullToUndefined(asnSettings?.copy_startercode),
  uncompressupload: nullToUndefined(asnSettings?.uncompressupload),
  lti_on: nullToUndefined(asnSettings?.lti_on),
  anonymous_grading: nullToUndefined(asnSettings?.anonymous_grading),
  grading_visibility: nullToUndefined(asnSettings?.grading_visibility),
  send_webhook: nullToUndefined(asnSettings?.send_webhook),
  live_code_comments: nullToUndefined(asnSettings?.live_code_comments),
};

const unknownAsn = asnSettings?._unknown_settings;
const fullAssignmentPayload: AssignmentSettingsPayload = unknownAsn
  ? { ...knownAssignmentPayload, ...unknownAsn }
  : knownAssignmentPayload;

try {
  await updateAssignment(
    client,
    workingConfig.vocareum.course_id,
    action.assignment.assignment_id,
    fullAssignmentPayload
  );
} catch (error) {
  if (!isHttp400(error) || !unknownAsn) {
    throw error;
  }
  logger.warn(
    `Assignment settings update rejected for ${action.assignment.name}; retrying without _unknown_settings`
  );
  await updateAssignment(
    client,
    workingConfig.vocareum.course_id,
    action.assignment.assignment_id,
    knownAssignmentPayload
  );
}
```

- [ ] **Step 8.4: Run tests to verify they pass**

```bash
npx vitest run test/unit/publisher.test.ts -t "2-step ladder"
```

Expected: PASS.

- [ ] **Step 8.5: Run full test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 8.6: Commit**

```bash
git add src/core/publisher.ts test/unit/publisher.test.ts
git commit -m "feat: assignment update 2-step ladder for _unknown_settings"
```

---

## Task 9: Command entrypoints own reporter lifecycle

**Files:**
- Modify: `src/commands/publish.ts:23-83` (publishCommand)
- Modify: `src/commands/pull.ts:847+` (pullCommand) and the mapper call sites at lines 392, 410, 604, 625
- Modify: `test/unit/publish-command.test.ts` and `test/unit/pull-command.test.ts`

- [ ] **Step 9.1: Write failing test for publishCommand reporter ownership**

First, read the existing top of `test/unit/publish-command.test.ts` to learn which modules it already mocks (loadConfig, publish, etc.) and match its setup. Then append:

```ts
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';

describe('publishCommand — reporter lifecycle', () => {
  it('constructs an UnknownFieldReporter and passes it as the 4th argument to publish()', async () => {
    // publishMock is the existing mock for ../../src/core/publisher (publish).
    // If this mock does not exist in the file yet, add it following the same
    // vi.hoisted + vi.mock pattern used in publisher.test.ts.
    publishMock.mockResolvedValue({ success: true, failed: [], succeeded: [] });
    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: { org_id: '1', course_id: '1', api_base_url: 'https://api.vocareum.com' },
      assignments: [],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    });

    await publishCommand({ config: 'vocareum.yaml' });

    expect(publishMock).toHaveBeenCalled();
    const fourthArg = publishMock.mock.calls[0][3];
    expect(fourthArg).toBeInstanceOf(UnknownFieldReporter);
  });

  it('calls reporter.printSummary even when publish() throws', async () => {
    const printSpy = vi.spyOn(UnknownFieldReporter.prototype, 'printSummary');
    publishMock.mockRejectedValue(new Error('boom'));
    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: { org_id: '1', course_id: '1', api_base_url: 'https://api.vocareum.com' },
      assignments: [],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    });

    // publishCommand calls process.exit(1) in its catch — stub it to throw instead
    // so the test can observe it without killing the runner.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(publishCommand({ config: 'vocareum.yaml' })).rejects.toThrow();

    expect(printSpy).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
    printSpy.mockRestore();
  });
});
```

If `publishMock` and `loadConfigMock` don't already exist in `publish-command.test.ts`, add them via `vi.hoisted` + `vi.mock('../../src/core/publisher', () => ({ publish: publishMock }))` and `vi.mock('../../src/core/config', () => ({ loadConfig: loadConfigMock }))`, modeling on the pattern in `test/unit/publisher.test.ts` lines 7-78.

- [ ] **Step 9.2: Run tests to verify they fail**

```bash
npx vitest run test/unit/publish-command.test.ts -t "reporter lifecycle"
```

Expected: FAIL.

- [ ] **Step 9.3: Modify `publishCommand` to own reporter lifecycle**

In `src/commands/publish.ts`:

```ts
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';

export async function publishCommand(options: PublishCommandOptions): Promise<void> {
  const configPath = options.config ?? 'vocareum.yaml';
  const reporter = new UnknownFieldReporter(logger);

  try {
    loadDotEnvIfPresent();
    const config = await loadConfig(configPath);
    const apiKey = getApiKeyOrThrow();
    const client = new VocareumClient(apiKey, config.vocareum.api_base_url);

    // ... existing option setup unchanged ...

    const result = await publish(config, client, publishOptions, reporter);

    // ... existing result handling unchanged ...

  } catch (error) {
    logger.error(`Publish failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  } finally {
    reporter.printSummary();
  }
}
```

Note: `process.exit(1)` inside `catch` will run `finally` first — Node executes finally blocks before process exit triggered by a synchronous call. (If a test relies on the precise ordering, verify by reading the test setup; on Node, `process.exit` will run finally before terminating.)

- [ ] **Step 9.4: Write failing test for pullCommand reporter ownership**

Append to `test/unit/pull-command.test.ts` (match existing module-mock setup):

```ts
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';

describe('pullCommand — reporter lifecycle', () => {
  it('calls reporter.printSummary even when an internal step throws', async () => {
    const printSpy = vi.spyOn(UnknownFieldReporter.prototype, 'printSummary');
    // Make loadConfig throw immediately to exercise the catch path
    loadConfigMock.mockRejectedValue(new Error('config bad'));

    await expect(pullCommand({ config: 'vocareum.yaml' })).rejects.toThrow();
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  it('threads the reporter into detectSettingsDrift', async () => {
    // detectSettingsDrift is internal to pull.ts. Easiest observable:
    // mock mapAssignmentSettings and assert reporter is passed in.
    // The mock for ../../src/utils/settings already exists; assert its
    // second positional argument is an UnknownFieldReporter.
    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: { org_id: '1', course_id: '1', api_base_url: 'https://api.vocareum.com' },
      assignments: [{
        assignment_id: 'a1',
        name: 'Lab 1', path: 'lab1',
        create_from_template: false,
        parts: [],
      }],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    });
    reconcileMock.mockResolvedValue({
      course: { type: 'skip' },
      assignments: [],
      orphanedInVocareum: [],
      staleInConfig: [],
    });
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: '1', name: 'Lab 1', deleted: '0',
    });
    listPartsMock.mockResolvedValue([]);
    mapAssignmentSettingsMock.mockReturnValue({});

    // Force non-interactive to avoid prompts
    await pullCommand({ config: 'vocareum.yaml', nonInteractive: true });

    expect(mapAssignmentSettingsMock).toHaveBeenCalled();
    const secondArg = mapAssignmentSettingsMock.mock.calls[0][1];
    expect(secondArg).toBeInstanceOf(UnknownFieldReporter);
  });
});
```

If `loadConfigMock`, `reconcileMock`, `getAssignmentMock`, `listPartsMock`, `mapAssignmentSettingsMock` don't already exist in this test file, add them via `vi.hoisted` + `vi.mock` blocks, mirroring `test/unit/publisher.test.ts` lines 7-78.

- [ ] **Step 9.5: Run tests to verify they fail**

```bash
npx vitest run test/unit/pull-command.test.ts -t "reporter lifecycle"
```

Expected: FAIL.

- [ ] **Step 9.6: Modify `pullCommand` and pull's mapper call sites**

In `src/commands/pull.ts`, modify `pullCommand` (line 847) to construct + use the reporter:

```ts
import { UnknownFieldReporter } from '../utils/unknown-field-reporter';

export async function pullCommand(options: PullOptions): Promise<void> {
  const configPath = options.config ?? 'vocareum.yaml';
  // ... existing local vars unchanged ...
  const reporter = new UnknownFieldReporter(logger);

  try {
    // ... ALL existing try-block contents unchanged ...
  } catch (error) {
    logger.error(`Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  } finally {
    reporter.printSummary();
  }
}
```

Then update each `mapAssignmentSettings(...)` and `mapPartSettings(...)` call inside `pull.ts` to pass `reporter` and the resource id:

- `pull.ts:392` — `mapAssignmentSettings(remoteAssignment, reporter, remoteAssignment.id)`
- `pull.ts:410` — `mapPartSettings(fullRemotePart, reporter, fullRemotePart.id)`
- `pull.ts:604` — `mapAssignmentSettings(fullAssignment, reporter, fullAssignment.id)`
- `pull.ts:625` — `mapPartSettings(fullPart, reporter, fullPart.id)`

The reporter variable is declared inside `pullCommand`, so these call sites — which live in helper functions called from `pullCommand` — need the reporter passed in as a parameter to each helper. The mapper calls are inside two helper functions, both with current signatures:

```ts
// pull.ts:369
async function detectSettingsDrift(
  config: { assignments: Assignment[]; vocareum: { course_id: string; excluded_assignments?: string[]; architecture?: 'elite' | 'container' } },
  client: VocareumClient,
  skipAssignmentIds: Set<string>
): Promise<AssignmentSettingsDrift[]>

// pull.ts:591
async function importAssignment(
  client: VocareumClient,
  courseId: string,
  orphan: OrphanedEntity,
  localPath: string,
  verbose: boolean,
  architecture?: 'elite' | 'container',
  skipContent = false
): Promise<ImportResult>
```

Add `reporter?: UnknownFieldReporter` as a trailing parameter to both, then update all call sites in `pullCommand` (grep `detectSettingsDrift(` and `importAssignment(` within pull.ts) to pass it.

Also check call sites of `mapAssignmentSettings` / `mapPartSettings` in:
- `src/core/publisher.ts:392, 402` — these run inside `publish()`, which already receives `reporter` via Task 7's change. Update those calls to pass it through.

Re-grep after edits to verify no remaining unparameterized calls:

```bash
grep -n "mapAssignmentSettings\|mapPartSettings" src/
```

Every call site should either receive a reporter argument or be in a code path that has no reporter available (e.g., a low-level utility test). For this task, all production call sites must pass the reporter.

- [ ] **Step 9.7: Run tests to verify they pass**

```bash
npx vitest run test/unit/pull-command.test.ts test/unit/publish-command.test.ts -t "reporter"
```

Expected: PASS.

- [ ] **Step 9.8: Run full test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 9.9: Manual smoke check (optional but recommended)**

Build and run pull against a real Vocareum course (or a recorded fixture) to confirm:
- The reporter summary prints at the end when unknown fields are present.
- It does NOT print when no unknowns were seen.

```bash
npm run build
node dist/index.js pull --config <path-to-test-config>
```

- [ ] **Step 9.10: Commit**

```bash
git add src/commands/publish.ts src/commands/pull.ts test/unit/publish-command.test.ts test/unit/pull-command.test.ts
git commit -m "feat: commands own reporter lifecycle with try/finally"
```

---

## Task 10: Final verification + integration test for history-diff exclusion

**Files:**
- Modify: `test/integration/publish.test.ts`

- [ ] **Step 10.1: Add an integration test asserting `_unknown_settings` does not appear in `settingChanges`**

Most of the equivalent coverage already exists at the unit level (Task 6's `pushSettingChange` guard + Task 8's ladder tests). This step verifies the behavior end-to-end against the integration test scaffolding.

Read the existing patterns in `test/integration/publish.test.ts` first to mirror its setup style (it may use different mock plumbing than the unit tests). Then append a test of this shape:

```ts
describe('publish — settings change history excludes _unknown_settings', () => {
  it('does not record a settings-change entry when only _unknown_settings content differs', async () => {
    // Arrange (using whatever helpers exist in this file):
    //   - Local config: assignment with settings { nosubmit: true,
    //     _unknown_settings: { foo: 1 } }
    //   - Remote assignment response (returned by getAssignment mock):
    //     { id: 'a1', courseid: 'c1', name: 'Lab', deleted: '0',
    //       nosubmit: true, foo: 2 }
    //   - updateAssignment mock resolves successfully.
    //
    // Act: run publish() (or whatever entrypoint this test file uses).
    //
    // Assert:
    //   - Inspect the publish result / history. The structured settings-change
    //     list MUST NOT contain an entry whose field === '_unknown_settings'.
    //   - updateAssignment was still called with a payload whose top-level
    //     `foo` key equals the local value (1).
    //
    // If publish() in this test file returns the full PublishResult including
    // a `settings_changes` (or similar) array, assert on that array directly.
    // If not, observe via the updateConfig mock's calls — the
    // publish_history entry passed to updateConfig should have no
    // _unknown_settings change record.
  });
});
```

The unit-level guard test in Task 6 already provides the strongest direct coverage. This step exists to confirm the guard holds end-to-end. If reading the integration test file reveals that this coverage is fully redundant with the unit tests AND adding it would require non-trivial new fixture plumbing, you may skip this step and document the decision in the commit message.

- [ ] **Step 10.2: Run integration tests**

```bash
npx vitest run test/integration/publish.test.ts
```

Expected: PASS.

- [ ] **Step 10.3: Final full suite + lint + typecheck**

```bash
npm run lint && npm run typecheck && npm test
```

Expected: all green.

- [ ] **Step 10.4: Commit**

```bash
git add test/integration/publish.test.ts
git commit -m "test: integration coverage for settings-change history exclusion"
```

---

## Out of Scope (per spec "Deferred" section)

The following are explicitly NOT in this plan and require a follow-up phase:

- `mapCourseSettings()` function
- `ConfigUpdates.course_settings` extension and `updateConfig()` branch
- New course-pull step in `pull.ts` that persists course settings
- `CourseSettingsPayload` type and widened `updateCourse()` signature
- 2-step ladder for course update at `publisher.ts:302-308`
- `CourseSettingsConfigSchema._unknown_settings` extension
- Course-scope source-of-truth test for `mapCourseSettings`

The course sets (`KNOWN_COURSE_SETTING_KEYS`, `NON_SETTING_FIELDS_COURSE`) ARE included in this phase as data-only artifacts so the partition function and invariant tests have hooks ready.
