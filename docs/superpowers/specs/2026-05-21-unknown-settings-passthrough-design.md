# Unknown Settings Pass-Through — Design

**Date:** 2026-05-21
**Status:** Implemented (commits `10b3249..f3173f5`). Updated 2026-05-22 to retrofit Round-Trip Matrix and Adversarial-Input Contract sections — these were missing in the original spec and the gaps were caught by post-implementation review.
**Author:** David Lin (vocgit maintainer)

## Problem

Vocareum's API returns settings on `assignments` and `parts` that vocgit maps into local `vocareum.yaml` via `mapAssignmentSettings()` / `mapPartSettings()` (and read paths in `pull.ts` / `publisher.ts`). These mappers explicitly copy a fixed allow-list of known fields. Today, any field Vocareum returns that vocgit does not recognize is **silently dropped** during pull, and YAML config does not preserve unknown keys.

(Course settings are also a Vocareum surface. The pull command only calls `getCourse()` indirectly via `reconcile()` ([reconciler.ts:44](../../../src/core/reconciler.ts#L44)) to compare configured `name`/`description` against the remote; it does not map or persist course settings into YAML. Course scope is **deferred** to a follow-up — see the "Deferred" section. The per-scope sets are still defined here so the partition function and tests have hooks ready.)

Two consequences:

1. **Silent loss on read.** When Vocareum adds a new setting (or a per-tenant custom setting is returned), vocgit's pull writes a YAML that no longer represents the true server state.
2. **Silent loss on write.** Even if a user hand-adds an unknown field to YAML, the Zod config schemas and the payload builders strip it before sending. The user has no way to push a setting vocgit hasn't formally adopted.

Result: customers can hit subtle drift between Vocareum and local config, vocgit fails to surface that drift, and we have no easy channel to learn what new fields the API is producing.

## Goals (in priority order)

Scope this phase: **assignment and part settings only.** Course scope is deferred (see "Deferred" section).

1. **Never fail publish because Vocareum added a field.** Drift must be tolerated, not fatal.
2. **Never silently discard an unknown assignment or part field returned by Vocareum.** Preserve unknowns in YAML under a clear marker.
3. **Tell the user, exactly once per run, what unknown fields we saw**, and direct them to file a bug/enhancement issue so vocgit can promote the field to a supported setting.
4. **Round-trip survivability for assignments and parts.** Pull → edit → push should not destroy unknown settings on the Vocareum side.
5. Keep the implementation small, mirror existing patterns, no new runtime dependencies.

## Non-Goals

- Runtime validation of every API response (no Zod migration of `src/types/api.ts`).
- Detecting drift in **known field values** — only unknown field **names** are in scope. (Examples we are NOT catching: a known `endlab` field returning a new enum value `'pause'`, or `session_length` switching from string to number.)
- Drift detection on non-settings responses (transaction envelopes, error shapes, file listings, course list metadata).
- Nested-shape drift inside known structured fields (`lab_interface`, `submission_filters`, `tags`). Phase 1 is top-level keys per scope only. These nested objects are already passed through their existing structural typing, so values inside them survive pull/push; we just won't flag new sub-keys.

## Design

### 1. Allow-lists per scope

Add a new module `src/utils/known-settings.ts` exporting per-scope known-settings and per-scope non-settings sets:

```ts
export const KNOWN_COURSE_SETTING_KEYS: ReadonlySet<string>;
export const KNOWN_ASSIGNMENT_SETTING_KEYS: ReadonlySet<string>;
export const KNOWN_PART_SETTING_KEYS: ReadonlySet<string>;

// Per-scope fields that are part of the API response but are NOT settings.
// These are either resource identifiers (id, courseid, ...), top-level config
// fields routed elsewhere in vocareum.yaml (assignment `name`), or fields the
// mapper intentionally drops (`due_date`, `points` for assignments). A field
// in this set is silently passed over by partition() — it is neither a known
// setting nor "unknown" drift.
export const NON_SETTING_FIELDS_COURSE: ReadonlySet<string>;
export const NON_SETTING_FIELDS_ASSIGNMENT: ReadonlySet<string>;
export const NON_SETTING_FIELDS_PART: ReadonlySet<string>;
```

The per-scope split (instead of a single global `IDENTITY_FIELD_KEYS`) is required because the same field name is a setting in one scope and identity in another. For example, course `name` and `description` are writable course settings ([publisher.ts:302-308](../../../src/core/publisher.ts#L302-L308), [courses.ts:42-58](../../../src/api/courses.ts#L42-L58)), but assignment `name` is a top-level config field and part `description` is not a setting at all.

Initial set contents:

| Scope | KNOWN_* | NON_SETTING_FIELDS_* | In scope this phase? |
|---|---|---|---|
| course | `name`, `description` | `id`, `org_id` | **No** — sets defined for partition/tests only; no runtime use. See Deferred. |
| assignment | `description`, `nosubmit`, `publish`, `publish_grades`, `auto_submit`, `grading_on_submit`, `noworkarea`, `exam_mode`, `exam_duration`, `num_attempts`, `show_end_exam_button`, `copy_startercode`, `uncompressupload`, `lti_on`, `anonymous_grading`, `grading_visibility`, `send_webhook`, `live_code_comments` | `id`, `courseid`, `name`, `due_date`, `points`, `deleted`, `published` | Yes |
| part | `submission_filters`, `cloud_labs`, `instant_aws_access`, `session_length`, `monthly_dollar`, `monthly_time`, `total_time`, `total_dollar`, `late_penalty_percent`, `late_penalty_percent_rule`, `deadlinedate`, `endlab`, `labtype`, `container_image`, `number_of_submissions`, `lab_interface`, `databricks_maxusers`, `tags` | `id`, `courseid`, `assignmentid`, `name`, `description`, `seqnum`, `deleted`, `part_url` | Yes |

The `KNOWN_*_SETTING_KEYS` sets must contain **exactly** the keys read by the corresponding mapper today. A vitest unit test asserts this — if a contributor extends `mapPartSettings()` to read a new key without adding it to `KNOWN_PART_SETTING_KEYS`, the test fails. This is the drift alarm for vocgit's own type definitions.

The `KNOWN_*` and `NON_SETTING_FIELDS_*` sets per scope must be disjoint (assertion in a unit test). `_unknown_settings` itself must never appear in any of these sets (assertion in a unit test — guards against future code that adds `_unknown_settings` to a `keyof NonNullable<AssignmentSettings>` array).

### 2. Partition function

```ts
// src/utils/known-settings.ts
export interface PartitionResult {
  knownFields: Record<string, unknown>;    // keys present in knownKeys
  unknownFields: Record<string, unknown>;  // keys not in knownKeys and not in nonSettingsKeys
}

export function partitionApiResponse(
  response: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  nonSettingsKeys: ReadonlySet<string>
): PartitionResult;
```

Logic: for each key in `response`,
- if `nonSettingsKeys.has(key)` → drop (caller routes elsewhere or intentionally ignores).
- else if `knownKeys.has(key)` → goes to `knownFields`.
- else → goes to `unknownFields`.

Callers pass the per-scope pair: `(KNOWN_PART_SETTING_KEYS, NON_SETTING_FIELDS_PART)`, etc.

### 3. YAML shape: `_unknown_settings`

Extend the Zod schemas in `src/types/config.ts` (`AssignmentSettingsSchema`, `PartSettingsSchema`) to allow an optional `_unknown_settings` field. `CourseSettingsConfigSchema` is **not** modified this phase (deferred).

```yaml
parts:
  - part_id: "5403070"
    name: "Lecture - Moving Data"
    settings:
      session_length: "240"
      labtype: "Document"
      _unknown_settings:
        new_vocareum_flag: true
        vendor_added_field: "abc"
```

Schema:

```ts
_unknown_settings: z.record(z.string(), z.unknown()).optional()
```

The leading underscore signals to the user: "vocgit doesn't formally understand this — handle with care." YAML key ordering should write `_unknown_settings` last in the settings block so the known/supported fields remain prominent.

### 4. Read path (pull / publish-time refresh)

Modify the mappers in `src/utils/settings.ts`:

- `mapAssignmentSettings(apiResponse, reporter?, resourceId?)` — after copying known fields, call `partitionApiResponse(apiResponse, KNOWN_ASSIGNMENT_SETTING_KEYS, NON_SETTING_FIELDS_ASSIGNMENT)` and if `unknownFields` is non-empty, attach it as `settings._unknown_settings` and call `reporter.record('assignment', field, value, resourceId)` per field.
- `mapPartSettings(apiResponse, reporter?, resourceId?)` — same pattern with the part sets.

No `mapCourseSettings()` is added this phase. The course sets exist only for partition/test scaffolding.

Reporter and resourceId are **optional** so unit tests can call the mappers without constructing a reporter. The command entrypoints (§6) supply both in production.

### 5. Write path (publish)

**Type changes ([src/types/api.ts:164](../../../src/types/api.ts#L164)):**

`ApiAssignmentSettings` and `ApiPartSettings` are closed object types today. Spreading arbitrary `_unknown_settings` keys into them would require unsafe casts. Define explicit payload types:

```ts
// src/types/api.ts
export type AssignmentSettingsPayload = ApiAssignmentSettings & Record<string, unknown>;
export type PartSettingsPayload       = ApiPartSettings       & Record<string, unknown>;
```

Then widen the signatures: `updateAssignment(..., settings: AssignmentSettingsPayload)`, `updatePart(..., settings: PartSettingsPayload)`. `buildPartSettingsPayload()` returns `PartSettingsPayload`. This keeps every known field strongly typed while permitting documented pass-through of unknowns. `updateCourse()` is **not** widened this phase.

The widened types live in `src/types/api.ts` and are imported wherever the update functions are called.

**Course updates** — unchanged this phase. The existing single `updateCourse(client, courseId, {name, description})` call at [publisher.ts:302-308](../../../src/core/publisher.ts#L302-L308) is left as-is. See Deferred section.

**Assignment updates** ([publisher.ts:497-517](../../../src/core/publisher.ts#L497-L517)):
- Currently a single `updateAssignment` call with no fallback.
- New behavior: 2-step ladder.
  1. **Full attempt:** known assignment settings + `..._unknown_settings` spread in.
  2. **On 400:** retry once with known fields only (today's behavior). Warn that unknown fields were rejected.
  3. **On retry failure:** existing failure path (this is the only way to fail-loud on assignment updates, and it matches today's behavior for the known-fields case).
- `_unknown_settings` is **never dropped from YAML** based on write rejection. A field could be readable but read-only, or permission-gated for this tenant, or only writable in a different context — none of those mean the user should lose visibility into it.

**Part updates** ([publisher.ts:632-663](../../../src/core/publisher.ts#L632-L663)):
- `mode: 'full'` payload includes `..._unknown_settings` spread into the top level of the outgoing API object (now typed as `PartSettingsPayload`).
- `mode: 'safe'` payload (existing) does NOT include `_unknown_settings`.
- The existing ladder full → safe → name-only is unchanged in shape; the change is only that `full` now carries unknowns. Safe is the fallback when full (with unknowns) is rejected.

### 6. Run-level collector + end-of-run summary

A new module `src/utils/unknown-field-reporter.ts`:

```ts
export interface UnknownFieldRecord {
  scope: 'assignment' | 'part';   // 'course' added in deferred phase
  field: string;
  exampleValue: unknown;       // first observed value, for the bug report
  count: number;               // how many times seen this run
  firstResourceId: string;     // first resource where seen, for the bug report
}

export class UnknownFieldReporter {
  record(scope, field, value, resourceId): void;
  hasAny(): boolean;
  summary(): UnknownFieldRecord[];   // deduped, sorted by scope then field
  printSummary(logger): void;        // formatted block per §6.1
}
```

**Ownership and lifecycle:**

The reporter is instantiated **at the command entrypoint** — the top-level CLI handler in `src/commands/pull.ts` and `src/commands/publish.ts` (or wherever publish is invoked from). The handler:

1. Constructs the reporter.
2. Passes it as a parameter into the workflow function (`publish()`, the orphan-handling pipeline, `reconcile()`, etc.).
3. Wraps the workflow call in `try { ... } finally { reporter.printSummary(logger); }` so the summary prints even when `loadConfig()`, `reconcile()`, an API call, or any other step throws before normal return.

Lower layers (mappers, publisher, reconciler) only call `reporter.record()`. They never call `printSummary()`. This guarantees exactly one summary per command invocation, on every exit path.

On first occurrence of a (scope, field) pair, the reporter's `record()` emits a single `logger.warn` line:
```
warn: Vocareum returned unknown part setting "new_vocareum_flag" (preserved under _unknown_settings)
```

In `finally`, if `reporter.hasAny()`, print the summary:

```
─────────────────────────────────────────────────────────────────
Vocareum returned unsupported settings fields.

These fields were preserved under _unknown_settings in vocareum.yaml
and will be passed through on future updates, but vocgit does not
understand them yet.

Please file a bug or enhancement request so vocgit can promote these
fields to formally supported settings.

  https://github.com/ddlin/vocareum-publisher/issues/new

Include in the report:
  - vocgit version:    1.0.19
  - resource scope:    part
  - field names:       new_vocareum_flag, vendor_added_field
  - example values:    new_vocareum_flag=true, vendor_added_field="abc"
  - redacted vocareum.yaml snippet showing _unknown_settings
─────────────────────────────────────────────────────────────────
```

For the assignment-write-rejection case (per §5), the summary block additionally includes:

```
Vocareum rejected unknown assignment settings for "Lab 1".
Retried with supported settings only and continued.
```

### 7. File-by-file change list

| File | Change |
|---|---|
| `src/utils/known-settings.ts` | NEW. Exports per-scope `KNOWN_*_SETTING_KEYS` and `NON_SETTING_FIELDS_*` sets (including course sets, defined but unused at runtime this phase), plus `partitionApiResponse()`. |
| `src/utils/unknown-field-reporter.ts` | NEW. `UnknownFieldReporter` class with `record()` / `hasAny()` / `summary()` / `printSummary()`. |
| `src/utils/settings.ts` | Modify `mapAssignmentSettings` and `mapPartSettings` to accept optional `reporter` and `resourceId`, attach `_unknown_settings` to output. (No `mapCourseSettings` this phase.) |
| `src/types/api.ts` | Add `AssignmentSettingsPayload`, `PartSettingsPayload` (= base type `& Record<string, unknown>`). Widen `updateAssignment` / `updatePart` parameter types accordingly. (Not `updateCourse` this phase.) |
| `src/types/config.ts` | Add optional `_unknown_settings: z.record(z.string(), z.unknown())` to `AssignmentSettingsSchema` and `PartSettingsSchema`. (Not `CourseSettingsConfigSchema` this phase.) |
| `src/api/assignments.ts` | Widen `updateAssignment` settings parameter to `AssignmentSettingsPayload`. |
| `src/api/parts.ts` | Widen `updatePart` settings parameter to `PartSettingsPayload`. |
| `src/core/publisher.ts` | Accept a `reporter` parameter. Spread `_unknown_settings` into assignment full payload. Add 2-step ladder to assignment update. Spread `_unknown_settings` into `'full'` part payload (existing 3-step ladder is unchanged in shape). Add explicit guard in `pushSettingChange()` against `field === '_unknown_settings'`. (Course update at lines 302-308 unchanged.) |
| `src/commands/pull.ts` | Own reporter lifecycle: construct, pass into workflow, print summary in `finally`. |
| `src/commands/publish.ts` | Same as pull — own reporter lifecycle with `try/finally`. |
| `test/unit/utils/known-settings.test.ts` | NEW. Partition logic, per-scope set membership (course sets included), disjoint-sets invariant, `_unknown_settings`-not-in-any-set invariant. |
| `test/unit/utils/settings.test.ts` | Extend with `_unknown_settings` preservation tests for assignment + part scopes, non-settings-fields-excluded tests, source-of-truth match (KNOWN_*_SETTING_KEYS = keys read by mapper, for assignment + part). |
| `test/unit/utils/unknown-field-reporter.test.ts` | NEW. Dedup, summary format, empty case, called-in-finally behavior. |
| `test/integration/publisher.test.ts` | Extend with: full→safe ladder including unknowns, assignment 2-step ladder, settings-change history excludes `_unknown_settings`. |

### 8. Test contract

The following behaviors must be covered by tests (skill: test-driven-development):

**Read path:**
1. Unknown assignment setting from API → preserved under `_unknown_settings` in YAML.
2. Unknown part setting from API → preserved under `_unknown_settings` in YAML.
3. Non-settings fields per scope (`id`, `courseid`, `seqnum`, `deleted`, assignment `name`, part `description`, etc.) → NOT routed to `_unknown_settings`.
4. `_unknown_settings` survives config load → save (round-trip via Zod).

**Write path:**
5. Publish full-mode part payload includes `_unknown_settings` keys flattened at top level.
6. Publish safe-mode part payload does NOT include `_unknown_settings` keys.
7. Publish full → safe → name-only ladder: when full (with unknowns) rejected with 400, retry without unknowns succeeds, `_unknown_settings` stays in YAML.
8. Assignment 2-step ladder: full with unknowns rejected → retry without unknowns succeeds, `_unknown_settings` stays in YAML.

**Reporter:**
9. Reporter dedupes repeated occurrences of the same (scope, field) pair.
10. Reporter summary block is emitted exactly once per command, in `finally`, even when the workflow throws.
11. Reporter summary is NOT emitted when no unknowns were seen (no empty noise block).

**Invariants (drift alarms for vocgit itself):**
12. Source-of-truth match: `KNOWN_PART_SETTING_KEYS` exactly matches the set of keys read by `mapPartSettings()`. Same for `mapAssignmentSettings`. Fails loudly if drifted. (No course mapper this phase, so no course source-of-truth assertion.)
13. Per-scope `KNOWN_*` and `NON_SETTING_FIELDS_*` sets are disjoint (course sets included — pure data check, no runtime dependency).
14. `_unknown_settings` is never present in any `KNOWN_*_SETTING_KEYS` or `NON_SETTING_FIELDS_*` set.
15. The hand-written `assignmentKeys` and `partKeys` arrays in `publisher.ts` ([line 454](../../../src/core/publisher.ts#L454), [line 582](../../../src/core/publisher.ts#L582)) — used today for settings-change history diffing — do NOT contain `_unknown_settings`.
16. `pushSettingChange()` rejects (with an assertion / early return) any change where `field === '_unknown_settings'`. This guards against future code that loops `Object.keys(settings)` or `keyof NonNullable<AssignmentSettings>` and naively iterates everything.

**History diff behavior:**
17. Changes to `_unknown_settings` content between local YAML and remote API response do NOT appear in `settingChanges` (the structured change log surfaced to users). Rationale: we don't formally understand these fields, so we can't meaningfully diff them; presenting noise as a "settings change" would mislead. The fact that unknowns were observed is communicated by the reporter summary instead.

## Risks & Mitigations

- **Risk:** Unknown fields that are actually identity/system fields slip past the per-scope `NON_SETTING_FIELDS_*` set and pollute `_unknown_settings`.
  - **Mitigation:** Explicit per-scope non-settings list with unit tests covering each scope. New fields on `VocareumXResponse` types require the contributor to make an explicit classification choice — known setting (add to KNOWN), routed elsewhere (add to NON_SETTING_FIELDS), or accept as unknown drift. The source-of-truth test fails if a key is read by the mapper but missing from KNOWN.

- **Risk:** Sending unknown fields to Vocareum on the full payload causes more 400s than today (since some new fields may be read-only).
  - **Mitigation:** Fallback ladder absorbs the rejection. End-of-run summary surfaces it to the user.

- **Risk:** `_unknown_settings` becomes a permanent dumping ground because nobody files the issues we ask for.
  - **Mitigation:** Out of scope for this design — it's a process problem, not a code problem. The summary block makes filing as low-friction as we can.

- **Risk:** YAML diffs get noisier when `_unknown_settings` appears under random parts.
  - **Mitigation:** Writing `_unknown_settings` last keeps the prominent fields stable. Empty `_unknown_settings` is never written (omitted from output).

## Deferred (follow-up phase)

**Course scope is deferred.** Reasons:

1. The pull command only calls `getCourse()` indirectly through `reconcile()` ([reconciler.ts:44](../../../src/core/reconciler.ts#L44)), which uses it for name/description comparison only. There is no mapping or persistence of course settings into YAML today. Preserving "unknown course settings on read" requires adding a new map-and-persist step that doesn't exist, which is a product-shape change beyond drift handling.
2. `ConfigUpdates` ([config.ts:478-487](../../../src/types/config.ts#L478-L487)) has no `course_settings` branch, and `updateConfig()` ([core/config.ts:130](../../../src/core/config.ts#L130)) has no path to write `vocareum.course_settings`. Adding these is a non-trivial extension to the configuration update protocol.
3. `KNOWN_COURSE_SETTING_KEYS = {name, description}` is tiny; the practical risk of unknown fields surfacing on the course endpoint and going un-handled is low compared to assignments/parts.

What is **defined but unused** this phase: `KNOWN_COURSE_SETTING_KEYS` and `NON_SETTING_FIELDS_COURSE` in `src/utils/known-settings.ts`, plus their disjoint-sets and `_unknown_settings`-not-in-any-set test coverage. These exist so the partition function has scaffolding ready and so the follow-up phase doesn't re-relitigate the set contents.

What a follow-up phase would add:
- `mapCourseSettings(apiResponse, reporter?, resourceId?)`.
- Extend `ConfigUpdates` with `course_settings?: Partial<CourseSettingsConfig>` (or wider `vocareum?: Partial<VocareumConfig>` — to be decided in that phase).
- An `updateConfig()` branch that merges course settings into `vocareum.course_settings`.
- A new course-pull step in `pull.ts` that calls `getCourse()` → `mapCourseSettings()` and schedules a course-settings update when `_unknown_settings` is non-empty.
- `CourseSettingsPayload` in `src/types/api.ts`, widened `updateCourse()` signature, and a 2-step ladder for the course update at [publisher.ts:302-308](../../../src/core/publisher.ts#L302-L308).
- Extend `CourseSettingsConfigSchema` with optional `_unknown_settings`.
- Test contract items for course (read preservation, course write ladder, source-of-truth match for `mapCourseSettings`).

## Round-Trip Matrix

The piece of state this feature introduces is `_unknown_settings` (per assignment, per part). Every meaningful transition of that state must be tested. The original spec listed only the "added" transition; the missing "removed" and "overridden" transitions are how the post-implementation review found bugs.

State machine for `_unknown_settings`:

| # | Local state | Remote returns | Required outcome | Test |
|---|---|---|---|---|
| 1 | absent | absent | no drift, no YAML change | covered by "no false drift" tests |
| 2 | absent | `{foo: 1}` | drift detected, YAML gains `_unknown_settings: {foo: 1}`, reporter warns | covered by mapper + pull tests |
| 3 | `{foo: 1}` | `{foo: 1}` (identical) | no drift, no YAML change, no warning | covered by "identical unknowns" test |
| 4 | `{foo: 1}` | `{foo: 2}` (value changed) | drift detected, YAML updated, reporter warns | partially covered; same key→new value |
| 5 | `{foo: 1}` | `{foo: 1, bar: 2}` (key added) | drift detected, YAML gains bar, reporter warns | covered |
| 6 | `{foo: 1}` | `{}` or absent (remote shrinks) | drift detected, YAML loses `_unknown_settings` entirely | **MISSED initially — caused "stale unknowns" bug** |
| 7 | `{foo: 1}` | server rejects on push with 400 | retry without `_unknown_settings`, keep YAML intact | covered by ladder tests |
| 8 | user-edited, sends to server | server accepts | round-trip clean | covered |
| 9 | user-edited containing reserved key like `name` | n/a | filter strips it, warning logged, server-controlled value wins | **MISSED initially — caused "override" bug** |
| 10 | user-edited containing nested `_unknown_settings` | n/a | wrapper key filtered, not leaked to API | **MISSED initially — caused "wrapper leak" bug** |

**Discipline for future state-bearing specs:** when introducing any piece of state, draw this table FIRST. Every row must map to a test.

## Adversarial-Input Contract

`_unknown_settings` is **user-editable YAML**. Treat it as untrusted input even though it lives in the user's own repo — the user can be careless or misinformed, and a config that round-tripped through pull may have been hand-edited before push.

For any user-editable structure in this codebase, document the threat model and required defenses:

| Adversarial input | Source of risk | Required defense | Test |
|---|---|---|---|
| Reserved field name in bucket (`name`, `id`, `nosubmit`, etc.) | User confused about which fields go where; renamed field collision | Filter against `RESERVED_*_KEYS`; warn on collision | covered |
| Wrapper key nested inside itself (`{_unknown_settings: {...}}`) | User confused by YAML structure; accidental nesting | Include `_unknown_settings` in `RESERVED_*_KEYS` | covered (post-fix) |
| Type mismatch (e.g., `_unknown_settings: "string"`) | Hand-edit error | Zod schema rejects at config load | covered by schema definition |
| Deeply nested object | Malformed input from a previous tool | Object literal accepted as-is; passed through API; no recursion required | not enforced; document if it bites |
| Very large object (DoS via memory) | Hostile input | Out of scope — vocareum.yaml is user-owned | not enforced |
| Function/symbol values via JSON.stringify | Cannot occur via YAML (YAML doesn't have functions); only relevant if a future code path constructs values programmatically | `safeStringify` in reporter | covered |

**Discipline for future user-editable structures:** before merging, list every adversarial input you can think of and either (a) defend against it with a test, or (b) explicitly document why it's out of scope.

## What this does NOT do

To be very explicit, since "graceful handling of unexpected API responses" is a phrase that could cover much more:

- Does not validate response types or shapes at runtime. A response with the wrong type for a known field (e.g., string instead of boolean) is still processed through the existing coercion logic in `mapAssignmentSettings` / `mapPartSettings`, which silently tolerates many such mismatches today. That stays unchanged.
- Does not detect new enum values inside known fields.
- Does not detect new sub-keys inside `lab_interface`, `submission_filters`, or `tags`. Their values pass through structurally.
- Does not catch unknown fields from non-settings endpoints (transactions, file listings, list-envelope metadata).
- Does not handle course scope (see Deferred section above).

Any of these would be a follow-up.
