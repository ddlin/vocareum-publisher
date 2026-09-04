1. Severity: MAJOR

   Quote at issue: `older top-level values remain parseable but are not necessarily pushed.`

   Evidence: `src/types/config.ts:235-237` says writable and observed fields are accepted in `vocareum.yaml` and older top-level values remain parseable, but `PartSettingsSchema` has no `max_points` or `description` member and ends as a plain `z.object(...).optional()` at `src/types/config.ts:240-287`; `AssignmentSettingsSchema` likewise has no `total_points` member at `src/types/config.ts:360-407`. `loadConfig` returns the Zod-parsed data, not the raw YAML object, at `src/core/config.ts:61-70`. The legacy cleanup machinery only sees the parsed settings object: `hasObservedTopLevelSettings` checks `record[key] !== undefined` at `src/core/services/pull-service.ts:365-372`, and `clearObservedTopLevelSettings` deletes from that same parsed/merged object at `src/core/services/pull-service.ts:374-381`.

   Failure scenario: a user hand-writes:

   ```yaml
   parts:
     - part_id: "p1"
       path: "."
       settings:
         max_points: "40"
   ```

   and the remote part response omits `max_points` for that part. The mapper explicitly supports omission (`test/unit/settings.test.ts:370-375`). Because `max_points` is stripped during config parse, `hasObservedTopLevelSettings(configPart.settings, OBSERVED_PART_SETTING_KEYS)` at `src/core/services/pull-service.ts:797-800` cannot see the top-level value, `partObservedChanged` is false when the remote also has no observed value (`src/core/services/pull-service.ts:791-796`), and no settings update is queued (`src/core/services/pull-service.ts:802-813`). The stale top-level YAML is not migrated or warned about by the legacy-top-level machinery. If some unrelated update later rewrites the config, the value is silently dropped via the parsed config path instead of deliberately migrated.

   What is wrong: adding `max_points` / `total_points` to the observed key sets makes the pull-service legacy-top-level path appear to cover them, but real user YAML reaches that path only after schema parsing has already discarded those keys. The top-level behavior is therefore not the behavior documented in the config type comment, and it is not the same legacy-top-level behavior already tested for assignment `description`.

2. Severity: MAJOR

   Quote at issue: `Every row in the matrix must map to a test.`

   Evidence: AGENTS.md requires added, removed, changed-in-place, unchanged, and test coverage for each row at `AGENTS.md:778-786`, plus adversarial input tests or explicit out-of-scope documentation at `AGENTS.md:788-798`. The commit adds mapper-level tests for remote `max_points`/`total_points` appearing under `_observed_settings` (`test/unit/settings.test.ts:351-367`) and one mapper-level omission test for `max_points` (`test/unit/settings.test.ts:370-375`). It adds one payload test for `_unknown_settings.max_points` being dropped from a part payload (`test/unit/payload-helpers.test.ts:269-287`). The existing pull tests cover generic unknown drift and only assignment `description` legacy top-level migration (`test/unit/pull-command.test.ts:301-415`); `rg` finds no pull/apply test containing `max_points` or `total_points`.

   Failure scenario: an old-code config has:

   ```yaml
   settings:
     _unknown_settings:
       total_points: "25"
   parts:
     - settings:
         _unknown_settings:
           max_points: "25"
   ```

   and the new mapper reads remote `_observed_settings.total_points` / `_observed_settings.max_points`. The implementation appears intended to self-heal through `unknownsChanged` and `observedChanged` (`src/core/services/pull-service.ts:734-745`, `src/core/services/pull-service.ts:785-796`) and then delete stale `_unknown_settings` when the pulled remote settings do not include it (`src/core/services/pull-service.ts:1469-1473`, `src/core/services/pull-service.ts:1492-1496`). But no repository test exercises that migration for either derived point field. There is also no derived-field pull test for remote value change, remote disappearance from an existing `_observed_settings`, or unchanged observed values producing no false drift.

   What is wrong: the commit relies on live verification for the migration row it explicitly claims, but the mandatory round-trip matrix is not encoded in tests. The risky transitions for this exact state move are unguarded in the repo.

3. Severity: MAJOR

   Quote at issue: `vocgit records them so your config reflects the real server state`

   Evidence: README describes `_observed_settings` as reflecting server state at `README.md:187-194`. The schema accepts arbitrary observed values with `z.record(z.string(), z.unknown())` at `src/types/config.ts:223-229`, and the preserved-schema tests intentionally accept arbitrary observed values, including unrelated numeric values (`test/unit/config.test.ts:375-397`). Pull drift compares observed buckets with `valuesEqual` at `src/core/services/pull-service.ts:740-745` and `src/core/services/pull-service.ts:791-796`. `valuesEqual` treats a number and a numeric string as equal (`src/core/services/pull-service.ts:141-149`).

   Failure scenario: a user hand-writes:

   ```yaml
   settings:
     _observed_settings:
       max_points: 25
   ```

   while Vocareum returns `max_points: "25"` and `mapPartSettings` records the remote string under `_observed_settings` (`src/utils/settings.ts:202-204`). The observed comparison says the local number and remote string are equal, so no settings drift is reported and pull does not rewrite the YAML. The same applies to `total_points: 25` versus remote `"25"`.

   What is wrong: a user-editable observed bucket can hold the wrong type indefinitely with no warning and no self-heal, even though the API type and findings doc establish these point fields as strings (`src/types/api.ts:38-42`, `src/types/api.ts:81-86`; `docs/vocareum-api-rubrics-findings.md:35-36`, `docs/vocareum-api-rubrics-findings.md:73-79`). This is an adversarial-input gap for a user-editable structure, not just a cosmetic YAML difference, because the README tells users the bucket reflects server state.

4. Severity: MINOR

   Quote at issue: `vocgit previously captured both under _unknown_settings, sent them on every part-settings update that ran for other reasons`

   Evidence: The changelog addition says this at `CHANGELOG.md:92-94`. The findings doc is narrower: it says only `max_points` reaches the part `PUT` as a passenger inside `_unknown_settings`, and specifically says the create path sends no settings payload (`docs/vocareum-api-rubrics-findings.md:293-297`). The assignment update path is separate from part settings and builds assignment payloads in `src/core/services/push-service.ts:251-280` / `src/core/services/push-service.ts:745-779`; part payloads are built separately at `src/core/payload-helpers.ts:214-262` and sent through `updatePart` at `src/core/services/push-service.ts:919-925`.

   Failure scenario: a user reads the changelog and concludes both `max_points` and assignment `total_points` were previously sent on part-settings updates. That cannot be true for `total_points`: it is assignment-scoped and, when present in assignment `_unknown_settings`, would be considered only on an assignment metadata update path, not in the part-settings `PUT`.

   What is wrong: the documentation overstates and conflates the prior behavior. The supported source doc only recommends stopping `max_points` from reaching the part `PUT`; it does not support the claim that both fields were sent on every part-settings update.

5. Severity: MINOR

   Quote at issue: `The grading weight is the one that matters most: a silently zeroed max_points changes what students are scored out of.`

   Evidence: In `test/unit/push-settings-fallback.test.ts:22-24`, that comment now precedes `expect(dropped).toContain('cleanup_time')`. The same fixture swap changed `test/unit/part-settings-writer.test.ts:10-18` from `_unknown_settings.max_points` to `_unknown_settings.cleanup_time`; assertions now check `cleanup_time` surviving/dropping at `test/unit/part-settings-writer.test.ts:46-64`, `test/unit/part-settings-writer.test.ts:87-99`, and `test/unit/part-settings-writer.test.ts:126-142`. The fallback ladder comment still says the safe rung loses `max_points` at `src/core/services/part-settings-writer.ts:45-50`, and `payload-helpers` still has generic helper tests that manually place `max_points` in an already-built payload (`test/unit/payload-helpers.test.ts:87-101`, `test/unit/payload-helpers.test.ts:130-138`).

   Failure scenario: a future reviewer uses the fallback tests as evidence that the ladder still protects/report-detects loss of a grading weight. It no longer does; the asserted field is an arbitrary unknown `cleanup_time`, while `max_points` is filtered before payload construction in the real builder (`src/core/payload-helpers.ts:251-260`) because `RESERVED_PART_KEYS` now includes observed keys (`src/core/payload-helpers.ts:43-50`, `src/utils/known-settings.ts:90-97`).

   What is wrong: the fixture swap preserved the mechanical rung coverage, but it did not preserve the semantic coverage described by the comments. The tests now verify “some unknown is dropped by safe mode,” not “grading weight loss is reported.”

Checked and found sound:

- I traced outgoing assignment payloads through `planPush` and `executePush`; `_observed_settings` is not serialized there because both paths hand-build known-field payloads and only spread filtered `_unknown_settings` (`src/core/services/push-service.ts:251-280`, `src/core/services/push-service.ts:745-779`).
- I traced outgoing part payloads through `buildPartSettingsPayload`, `omitPlatformKeysForUpdate`, and `writePartSettingsWithFallback`; `_observed_settings` is not serialized there because the builder omits it and the safe/name-only rungs also omit it (`src/core/payload-helpers.ts:214-262`, `src/core/services/part-settings-writer.ts:76-80`, `src/core/services/push-service.ts:919-925`). This guarantee is by omission in hand-built payloads, not by a final explicit `_observed_settings` filter.
- I traced assignment creation/copy; `copyAssignment` sends only `method`, `source`, `name`, and optional `source_course_id`, then pulls settings back into config after creation (`src/api/assignments.ts:113-137`, `src/core/services/push-service.ts:643-674`).
- The probe findings support the core classification: `max_points` is derived from rubric maxscore and ignored on part direct write; `total_points` is assignment-level derived state rejected on direct write (`docs/vocareum-api-rubrics-findings.md:59-114`, `docs/vocareum-api-rubrics-findings.md:293-297`).
