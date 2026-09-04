1. Severity: BLOCKER
   Quote: "**Rule: `max_points` = Σ `maxscore` over criteria where `exclude !== true`. It is computed, not stored.**"
   Evidence or reasoning: The document's support is 13 correlational observations in `docs/vocareum-api-rubrics-findings.md:46-58` plus two summarized interventions in `docs/vocareum-api-rubrics-findings.md:128-131`. No raw POST, PUT, GET-before, or GET-after bodies are pasted for the interventions, despite the plan requiring raw responses in `docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:278-280`.
   What is wrong: The causal claim is stronger than the evidence. The observations also fit "server recomputes/normalizes `max_points` after rubric mutations but stores/accepts it elsewhere", "part GET reports a derived display total while another write path stores assignment points", or "this specific course/architecture derives points while others may not." The missing controls are: a part `PUT` of `max_points` with no rubric changes and immediate readback; updating an existing criterion's `maxscore` and reading `max_points`; toggling `exclude` on the same criterion and reading `max_points`; and checking the same interventions on both elite and container/manual/vocgit-created courses.

2. Severity: BLOCKER
   Quote: "Creating rubric rows is the only way to set an assignment's points."
   Evidence or reasoning: The document tested rubric POST/PUT/DELETE shapes and a part `max_points` readback, not every assignment/part/course points path (`docs/vocareum-api-rubrics-findings.md:85-124`, `docs/vocareum-api-rubrics-findings.md:126-138`). The repository only documents that assignment `points` does not work via assignment update (`src/api/assignments.ts:223-226`) and that the part update payload's known writable fields do not include `max_points` (`src/api/parts.ts:82-95`, `src/types/api.ts:223-261`).
   What is wrong: "Only" is not established. The document has not ruled out UI-only point settings, another API field name, another endpoint, create/copy-time parameters, course architecture differences, or an assignment-level total separate from per-part `max_points`. The evidence supports at most that rubric rows affected the observed part `max_points` in the tested scratch assignment.

3. Severity: BLOCKER
   Quote: "Adding a 7-point criterion to a part with `max_points: \"15\"` moved it to **`\"22\"`** immediately."
   Evidence or reasoning: The checked-in probe script's max-points probe posts a bare object with `seqnum`: `http.post(rubricsUrl(c, a, p), { name: 'vocgit points probe', seqnum: '96', maxscore: '13' })` in `scripts/probe-rubrics.mjs:112-118`. The plan contains the same code in `docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:220-227`. The artifact says that exact bare-object/`seqnum` shape is rejected: `{name, seqnum, maxscore}` returns 400 and `{rubrics:[{name, seqnum, maxscore}]}` returns 400 (`docs/vocareum-api-rubrics-findings.md:91-96`).
   What is wrong: The strongest causal intervention cannot be traced to the checked-in probe path or to pasted raw responses. If the script was used as planned with `--points`, the documented POST shape says the create should have failed. If a different request was used, the document omits the request and response that establish it.

4. Severity: MAJOR
   Quote: "Then, with criteria of 10 + 5 + 9 + 3 and a fourth worth 4 marked `exclude: true`, `max_points` read **`\"27\"`**"
   Evidence or reasoning: The scratch state is later described as "5 rubric criteria (2 copied + 3 probe rows)" in `docs/vocareum-api-rubrics-findings.md:156-159`. Section 6 first says a 7-point criterion was added to 10+5, then later says the non-excluded rows are 10+5+9+3 and another 4-point row is excluded (`docs/vocareum-api-rubrics-findings.md:128-131`).
   What is wrong: The running mutation sequence is incomplete. To get from 10+5+7 to 10+5+9+3+excluded-4, the 7-point row must have been changed to 9, a 3-point row added, and a 4-point row added and excluded, or an equivalent sequence. Those intermediate operations and readbacks are not shown. The arithmetic 10+5+9+3=27 is internally correct, but the state transition that makes it evidence is missing.

5. Severity: MAJOR
   Quote: "Across all 13 parts examined:"
   Evidence or reasoning: The table combines "229752/229751 Lab 1" through "Lab 6" as six rows that each name two courses, then adds "229677 (all 7 parts)" as one row (`docs/vocareum-api-rubrics-findings.md:48-56`). The same document says both 229752 and 229751 have 7 assignments and 6 parts with rubrics each (`docs/vocareum-api-rubrics-findings.md:33-40`).
   What is wrong: The count is ambiguous and likely wrong as stated. If both source/manual courses were examined part-by-part, that is 12 rubric-bearing parts plus 7 vocgit parts, not 13. If paired labs were collapsed into six observations, then "parts examined" overstates the sample. This matters because the document uses 13/13 as evidentiary weight for a causal rule.

6. Severity: MAJOR
   Quote: "`GET /courses/{c}/assignments/{a}/parts/{p}/rubrics` -> 200:"
   Evidence or reasoning: The quoted response body shows a `rubrics` array containing one criterion while `total_records` is 6 (`docs/vocareum-api-rubrics-findings.md:14-25`). The plan required the findings doc to record raw responses and whether pagination works (`docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:174-188`, `docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:260-280`).
   What is wrong: The displayed body is not a complete raw response, or pagination/truncation is happening and not explained. Either way, the document does not answer whether the endpoint pages, whether `page=0` and `page=1` advance, or whether a bare request returns all rows. That leaves the current `listRubrics` pagination assumption in `src/api/rubrics.ts:86-153` without the evidence Task 2 was supposed to supply.

7. Severity: MAJOR
   Quote: "rubric **push** support is not a nicety. It is the fix for VOC-4003, and it is the only path by which a migrated course gets its point values."
   Evidence or reasoning: The plan's pre-probe wording was conditional: "If Task 2's points probe shows that creating rubric rows moves `max_points`, that is the push-side plan's most important input" (`docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:1788-1790`). The artifact has not proven the stronger "only path" claim for the reasons above.
   What is wrong: This stacks an unproven derived-field rule on top of an unproven exclusivity claim, then turns it into roadmap priority. A reader could build rubric push as the sole VOC-4003 fix while leaving the actual `max_points` write path, if one exists, uninvestigated.

8. Severity: MAJOR
   Quote: "**Reordering criteria appears to be impossible through this endpoint**"
   Evidence or reasoning: The document reports one PUT that sent `{id:\"11597036\", seqnum:\"1\"}` and read back `seqnum` still `"5"` (`docs/vocareum-api-rubrics-findings.md:114-117`). It immediately admits it is unresolved whether sending the whole array in desired order works (`docs/vocareum-api-rubrics-findings.md:116-117`).
   What is wrong: The evidence establishes only that a single-row `seqnum` field in one collection-scoped PUT was ignored. It does not test full-array ordering, array order without `seqnum`, multiple-row `seqnum` swaps, delete/recreate behavior, or whether POST append order is the only ordering mechanism. A push spec acting on this could wrongly conclude reorder support is impossible.

9. Severity: MAJOR
   Quote: "Drop `max_points` from the part-settings payload. vocgit currently ships it via `_unknown_settings`, where it is silently ignored on every push."
   Evidence or reasoning: `max_points` is not a known part setting in `src/types/config.ts:240-287` or `src/types/api.ts:223-261`, and it is not in `NON_SETTING_FIELDS_PART` in `src/utils/known-settings.ts:91-113`; therefore if a part GET includes it, `mapPartSettings` can place it under `_unknown_settings` (`src/utils/settings.ts:238-250`). `buildPartSettingsPayload` spreads filtered unknowns into full-mode payloads (`src/core/payload-helpers.ts:235-261`), and tests show `_unknown_settings.max_points` can survive payload construction (`test/unit/part-settings-writer.test.ts:10-18`, `test/unit/part-settings-writer.test.ts:34-49`). But push only builds/sends part settings payloads when part metadata is considered changed and the assignment is not being created (`src/core/services/push-service.ts:317-330`, `src/core/services/push-service.ts:834-921`), while the reconciler's part-settings comparison ignores `_unknown_settings.max_points` (`src/core/reconciler.ts:487-540`).
   What is wrong: "On every push" is false. The code can send `_unknown_settings.max_points` as a passenger on a part settings update, but `max_points` alone does not appear to trigger such an update, and create-path pushes do not send part settings payloads. The document's characterization is too broad.

10. Severity: MAJOR
    Quote: "Plan push around `{rubrics:[…]}` for both POST and PUT"
    Evidence or reasoning: The plan's open questions include removal policy and matching identity, warning that name+seqnum matching breaks on duplicate names and renames and that storing `rubric_id` may be the established pattern (`docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:100-107`). The current read-only implementation deliberately drops server rubric ids (`src/utils/rubrics.ts:21-37`, `src/types/config.ts:291-320`). The artifact only says DELETE was 403 and must be re-probed (`docs/vocareum-api-rubrics-findings.md:119-124`, `docs/vocareum-api-rubrics-findings.md:146-150`).
    What is wrong: The document does not provide enough reconciliation requirements for push. It does not answer identity/idempotency, duplicate names, rename-vs-delete semantics, concurrent UI edits, partial success of multi-row POST/PUT, rollback/transaction behavior, validation limits, or what happens to existing student grades when a criterion is changed, excluded, deleted, or recreated.

11. Severity: MAJOR
    Quote: "Probed on a scratch assignment (229751 / asn **5785278** \"ZZ vocgit rubric probe\", part **5785279**), created by copying Lab 1 so no reference content was touched."
    Evidence or reasoning: The artifact identifies 229751 as "manual migration" in `docs/vocareum-api-rubrics-findings.md:3-5`. The plan said the write probe must run "only against a scratch course with no student submissions" and later "Do not point this at 227714 or any migrated course" (`docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:150-151`, `docs/superpowers/plans/2026-09-04-rubrics-pull-support.md:270-276`).
    What is wrong: The document does not establish that 229751 is a scratch course with no student submissions; it calls it a manually migrated course. "No reference content was touched" is not the same safety condition. This weakens confidence in the provenance of write findings and contradicts the probe plan's guardrail.

12. Severity: MINOR
    Quote: "**The POST response types `id` and `seqnum` as NUMBERS** (`\"id\": 11597034, \"seqnum\": 3`)"
    Evidence or reasoning: The document provides one inline example, not a pasted raw POST response (`docs/vocareum-api-rubrics-findings.md:100-102`). AGENTS.md requires all ids be handled as strings, and the current read-side API types use strings (`src/types/api.ts:123-153`).
    What is wrong: Coercing POST response ids/seqnums to strings is the safe implementation choice, but the flat API-shape claim is based on one summarized observation. The document should not imply this is a universal response contract across every POST shape and course architecture without raw responses.

13. Severity: MINOR
    Quote: "The decisive observation." / "That is the whole of VOC-4003."
    Evidence or reasoning: These phrases appear in `docs/vocareum-api-rubrics-findings.md:46` and `docs/vocareum-api-rubrics-findings.md:136`. The same sections rely on summarized correlations and omitted intervention bodies rather than complete raw evidence.
    What is wrong: The presentation uses confident, formulaic lead-ins and finality to substitute for evidence. The default em-dash connector appears repeatedly in argumentative claims, for example `docs/vocareum-api-rubrics-findings.md:31`, `docs/vocareum-api-rubrics-findings.md:74`, and `docs/vocareum-api-rubrics-findings.md:126`. This is an AI-writing tell, but the material issue is that the certainty is higher than the documented proof.

Checked and found sound:

- The read-only release characterization is consistent with the shipped code and README: `push` does not create, update, or delete rubric rows, while `pull` records them under `parts[].rubrics` (`README.md:211-224`, `src/types/config.ts:326-336`, `src/api/rubrics.ts:74-153`).
- The read-side `VocareumRubricResponse` shape for GET is consistent with the one displayed row: `id`, `seqnum`, and `maxscore` are strings, while `auto` and `exclude` are booleans (`docs/vocareum-api-rubrics-findings.md:16-29`, `src/types/api.ts:123-153`).
- The arithmetic statement `10+5+9+3 = 27` is numerically correct; the break is the missing mutation trace, not that sum.
