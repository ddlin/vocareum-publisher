# Vocareum rubrics API — probe findings

**Probed:** 2026-09-04, org 335, token `VOC_TOKEN_ORG335_READWRITE` (GET/POST/PUT; **no
DELETE scope**).
**Courses:** 229752 (DL TEST ELITE, elite arch, original content) · 229751 (DL TEST VNB,
container arch, *manually* migrated) · 229677 (migrated by vocgit).

This is the Task 2 Step 6 output deferred during the rubrics-pull build, and the spec input
for the push-side plan.

**How to read this document.** §2 and §5 are observations — request in, response out. §3 and
§6 are inferences drawn from them, and each states what would be needed to close the gap
between the two. Where a claim rests on a single observation, it says so. Nothing here has
been confirmed across more than one course architecture unless stated.

---

## 1. Read shape — confirmed, matches the plan's types

`GET /courses/229751/assignments/5785205/parts/5785206/rubrics` → 200. Body **abridged** —
one of six rows shown:

```json
{
  "status": "success",
  "parent": { "courseid": "229751", "assignmentid": "5785205", "partid": "5785206" },
  "rubrics": [
    { "id": "11596823", "name": "[Task 2] Guardrail exists with content filters",
      "seqnum": "1", "maxscore": "5", "exclude": false, "auto": true }
  ],
  "total_records": 6
}
```

`id`/`seqnum`/`maxscore` are strings; `exclude`/`auto` are real booleans. `VocareumRubricResponse`
as shipped is correct.

### ⚠️ Pagination is UNANSWERED

The bare request above returned all six rows, so nothing forced a second page. **`page=0`
vs `page=1` behaviour was never tested, and no part with more than one page of criteria was
found** (the largest observed is 6 rows). `listRubrics`'s pagination loop therefore still
rests on an inference from `listAssignments`, exactly as it did before this probe. This was
Task 2 Step 4 and it remains open. Its defensive shortfall guard is the mitigation, not a
substitute.

## 2. The gap is real and total

| course | assignments | parts w/ rubrics | rubric rows | points in rubrics |
|---|---|---|---|---|
| 229752 (elite source) | 7 | 6 | 22 | 120 |
| 229751 (manual migration) | 7 | 6 | 22 | 120 |
| **229677 (vocgit migration)** | 7 | **0** | **0** | **0** |

229752 and 229751 are rubric-identical per lab (2, 2, 6, 2, 5, 5 → 15, 20, 25, 15, 20, 25).
The manual migration preserved rubrics; vocgit's preserved none. This reproduces the
original gap report's figures (22 rows / 120 points).

## 3. `max_points` tracks rubric maxscore — observations, then inference

### The observations

**19 parts were read** across the three courses: 6 rubric-bearing parts in 229752, the same
6 in 229751, and 7 in 229677. Because the two source courses are rubric-identical, the
distinct configurations are 13 — six paired labs plus the seven zero-rubric parts:

| configuration | rubric rows | Σ maxscore | part `max_points` |
|---|---|---|---|
| Lab 1 (in both 229752 and 229751) | 2 | 15 | 15 |
| Lab 2 (both) | 2 | 20 | 20 |
| Lab 3 (both) | 6 | 25 | 25 |
| Lab 4 (both) | 2 | 15 | 15 |
| Lab 5 (both) | 5 | 20 | 20 |
| Lab 6 (both) | 5 | 25 | 25 |
| 229677, each of 7 parts | 0 | 0 | 0 |

Σ maxscore equalled `max_points` in every one, including the seven zeroes. Two interventions
on a scratch part then moved `max_points`; the full trace is in §5.

### The inference, and what would close it

The observations are consistent with **`max_points` being computed as Σ `maxscore` over
criteria where `exclude !== true`**, and that reading explains VOC-4003: a `PUT` setting
`max_points` is accepted and discarded because there is no such stored field.

One independent control already exists in the repo and was not run by me — CHANGELOG for
the part-settings work records that *"in the same `PUT` that successfully changed
`instant_aws_access`, `max_points` was ignored and the part still read its old value."* A
write that lands other fields while dropping this one is what a derived field looks like.

**But the observations equally fit weaker readings**, and none has been excluded:

- the server *recomputes* `max_points` after rubric mutations while still storing it, so
  some other write path could set it;
- the part `GET` reports a derived display total while points live elsewhere;
- the behaviour is specific to these courses or to container architecture — every
  intervention ran on **one part of one container-arch course**.

**To close it:** (a) `PUT` `max_points` alone on a part with no rubrics and read back;
(b) change an existing criterion's `maxscore` and read back; (c) toggle `exclude` on one
criterion in isolation and read back; (d) repeat (b) and (c) on an elite-architecture part.
`scripts/probe-rubrics.mjs --points` now performs (b) and (c) automatically.

## 4. A structural difference in vocgit's migration

Assignment "GAIF parts probe" has **zero parts** in both 229752 and 229751
(`GET .../parts` → `{"status":"success","parts":[],"total_records":0}`), but vocgit's 229677
gave it **one part** (5784236). Unrelated to rubrics; worth a separate look.

## 5. The write contract — probed live, and the plan's inference was wrong

Probed on a scratch assignment **229751 / asn 5785278 / part 5785279**, created by copying
Lab 1 so no reference assignment was mutated.

> ⚠️ **Provenance caveat.** The plan required the write probe to run "only against a scratch
> course with no student submissions". 229751 is a *manually migrated* course, not a scratch
> course, and **whether it carries student submissions was not verified**. Writes were
> confined to a newly created assignment, and were authorised for these two courses. The
> guardrail was nonetheless not met as written.

### Assignment copy carries rubrics

Copying an assignment reproduced its rubrics with **new server ids** (source 11596xxx → copy
11597032/11597033) and matching `max_points`. `create_from_template` already preserves
rubrics; vocgit's gap is in *sync*, not create.

### POST — create

The plan's inferred bare-object body is wrong. In the order the API taught it:

| body | result |
|---|---|
| `{name, seqnum, maxscore}` | **400** — `Cannot decode content - missing rubrics array` |
| `{rubrics:[{name, seqnum, maxscore}]}` | **400** — `Invalid attribure post rubric request: seqnum` *(their typo)* |
| `{rubrics:[{name, maxscore}]}` | **200** ✅ |

**`POST` takes `{ rubrics: [ { name, maxscore, auto?, exclude? } ] }` and rejects `seqnum`
outright.** The server assigns `seqnum` by append order. Batch create works, and
`auto`/`exclude` are settable (defaults `auto:false`, `exclude:false`; copied rubrics carry
`auto:true`).

⚠️ In **two** POST responses observed, `id` and `seqnum` came back as **numbers**
(`"id": 11597034, "seqnum": 3`) while `GET` returns both as strings — a violation of AGENTS.md
constraint 1 at the seam push would consume. Two observations is not a universal contract;
coerce defensively rather than trusting either shape.

### PUT — update

| body | result |
|---|---|
| `PUT .../rubrics/{id}` with `{maxscore}` | **400** — `missing rubrics array` |
| `PUT .../rubrics` with `{rubrics:[{id, maxscore}]}` | **200** ✅ |

**PUT is collection-scoped, not per-row**, and is **partial** — sending only `maxscore`
preserved `name`.

**Reordering: one negative result, not a proof.** A single-element PUT of
`{id:"11597036", seqnum:"1"}` returned 200 with `seqnum` unchanged at `"5"`. **Not tested:**
sending the full array in the desired order, array order without `seqnum`, multi-row seqnum
swaps, or whether append order is the only ordering mechanism. `probe-rubrics.mjs --write`
now tests the full-array case. Do not design push around "reordering is impossible" until
that runs.

### DELETE — untestable with this token

Both `DELETE .../rubrics/{id}` and `DELETE .../rubrics` with `{rubrics:[{id}]}` returned
**403 `Access Forbidden (permission denied)`**. The token carries GET/POST/PUT only. The 403
says nothing about which shape is correct. **Re-probe with a DELETE-scoped token.**

### The intervention trace behind §3 and §6

Every step on part 5785279, in order:

| # | operation | rubric state after | `max_points` |
|---|---|---|---|
| 0 | (copy of Lab 1) | 10, 5 | `"15"` observed |
| 1 | POST `{rubrics:[{name:"ZZ probe criterion A", maxscore:"7"}]}` → 200, id 11597034 | 10, 5, 7 | **`"22"` observed** |
| 2 | PUT `{rubrics:[{id:"11597034", maxscore:"9"}]}` → 200 | 10, 5, 9 | *not read* |
| 3 | POST two rows: B `maxscore:"3", auto:true`; C `maxscore:"4", exclude:true` → 200 | 10, 5, 9, 3, 4(excl) | *not read* |
| 4 | PUT `{rubrics:[{id:"11597036", seqnum:"1"}]}` → 200, seqnum unchanged | unchanged | **`"27"` observed** |

`27 = 10+5+9+3`, with C's excluded 4 omitted; 31 would include it. **The `exclude` reading
survives by elimination:** 27 uniquely selects that subset, and probe A (`auto:false`) *did*
count while probe B (`auto:true`) also counted — so `auto` is not the discriminator and
`exclude` is.

⚠️ Steps 2 and 3 were not read back individually, so the `exclude` conclusion rests on the
aggregate at step 4 rather than an isolated toggle. `probe-rubrics.mjs --points` now performs
that isolated toggle.

## 6. What this means for VOC-4003 — and the limit of the claim

If §3's reading is right, `max_points` was never storable, which is why a part `PUT` that
sets it is accepted and discarded. Rubric rows would then be the mechanism that determines a
part's point total, making rubric **push** support the remedy for VOC-4003's user-visible
symptom rather than a separate feature.

**Three limits on that, stated plainly:**

1. **This concerns part-level `max_points`, not assignment-level `points`.** Those are
   different fields. `VocareumAssignmentResponse.points` exists in the type, but it came back
   **undefined on all 7 assignments in all 3 courses** — it was never observed, and its
   relationship to part `max_points` was never tested. The repo separately documents
   assignment `points` as "must be set manually in Vocareum UI"
   ([src/types/config.ts](../src/types/config.ts)), which predates this probe.
2. **"The only way to set points" is NOT established.** No alternative was tried. Untested:
   a UI-only path, a differently named API field, another endpoint, a create/copy-time
   parameter, or an assignment-level total independent of parts.
3. **One part, one course, one architecture.** Every intervention ran on part 5785279 of
   container-arch 229751.

## 7. Known unknowns a push implementation still needs

None of these was probed, and each changes the design:

- **Identity and idempotency.** Re-running a push must not duplicate rows. The read side
  deliberately drops server ids, so push needs a matching rule — and `name`+`seqnum` breaks
  on duplicate names and renames.
- **Partial failure.** A multi-row POST or PUT that fails midway — atomic, or partially
  applied? Determines whether push can retry safely.
- **Concurrent edits.** No ETag/version field was observed. An instructor editing in the UI
  while push runs is unhandled.
- **Validation limits.** Max rows per part, max `name` length, and the behaviour of zero,
  negative, or non-numeric `maxscore` are all unknown.
- **Grade impact.** What happens to existing student grades when a criterion's `maxscore`
  changes, or when it is excluded, deleted, or recreated. This is the one that matters most
  and is entirely unexplored — and it collides with AGENTS.md constraint 7.

## 8. What to do next

1. **Re-probe DELETE** with a DELETE-scoped token — reconciliation design is blocked on it.
2. **Run `--points` and `--write` again** on a genuine scratch course to close §3's controls
   (b)/(c) and settle full-array reordering.
3. **Test the elite architecture**, so the rule is not asserted from container-arch alone.
4. **Answer §7 before designing push**, particularly grade impact.
5. **Stop sending `max_points`.** It reaches the part `PUT` only as a passenger inside
   `_unknown_settings` when a part-settings update is already being sent for other reasons —
   the reconciler does not treat a `max_points` difference as a change, and the create path
   sends no settings payload at all. So it is not sent on *every* push, but when it is sent
   it is ignored, and it should not be sent at all.

## Scratch state left behind

`229751 / 5785278` — "ZZ vocgit rubric probe (safe to delete)", 1 part, 5 rubric criteria
(2 copied + 3 probe rows). It could not be cleaned up: the token lacks rubrics DELETE.
**Delete it by hand in the Vocareum UI.** No reference assignment in 229751 or 229752 was
modified, and 229677 was never written to.
