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

## 3. Points are DERIVED end to end — established by controlled intervention

### The chain

```
rubric `maxscore` (rows where exclude !== true)
        │  ↓ summed per part
part `max_points`
        │  ↓ summed per assignment
assignment `total_points`
```

### The correlational baseline

**19 parts read** across the three courses: 6 rubric-bearing parts in 229752, the same 6 in
229751, 7 in 229677. Σ maxscore equalled `max_points` in every one, including the seven
zeroes.

Assignment `total_points` matched the part total in every case checked — elite scratch 15,
vnb scratch 15, Lab 3 25, and vocgit-migrated Lab 1 **0**. (The field is `total_points`;
`points` is undefined on every assignment in all three courses.)

### The interventions — each isolating one variable

All on part 5785279 (container arch) unless noted. Every row is an observed readback.

| control | operation | `max_points` |
|---|---|---|
| add | POST one 7-point criterion | 15 → **22** |
| delete | DELETE one 9-point criterion | 27 → **18** |
| **(b) maxscore only** | PUT `maxscore` 3 → 11, then revert | 18 → **26** → **18** |
| **(c) exclude only** | PUT `exclude` true → false, then revert | 18 → **22** → **18** |
| **(d) elite arch** | same add / exclude / un-exclude / delete on part 5785505 | 15 → **28** → **15** → **28** → **15** |

### The direct-write controls — both refused

| write | result |
|---|---|
| **(a)** `PUT part { max_points: "999" }` | **202**, transaction settled `success` / *"Part updated"* — and `max_points` still **18** |
| `PUT assignment { total_points: "777" }` | **400** — `No valid parameters to update the assignment` |
| `PUT assignment { points: "777" }` | **400** — same |

Control (a) is VOC-4003 reproduced under laboratory conditions: the platform reports the part
update as **successful** while discarding the value, because there is no such stored field.
At assignment level the API does not even recognise the parameter.

### Conclusion

`max_points` = Σ `maxscore` over criteria where `exclude !== true`, computed rather than
stored, on **both** elite and container architectures. `total_points` is the assignment-level
sum of it. Each variable was moved in isolation and reverted, so this is no longer inference
from correlation.

**Creating, updating and deleting rubric rows is the only mechanism found to set points.**
Direct writes were tried at both levels and refused. Not exhaustively excluded: a UI-only
path, or some third field name never surfaced by any response observed here.

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

**Reordering is impossible — now tested three ways, all negative:**

| attempt | result |
|---|---|
| single-row `{id, seqnum}` | 200, `seqnum` unchanged |
| **full array**, every row with a new `seqnum` | 200, order unchanged |
| **full array in reversed order**, no `seqnum` field | 200, order unchanged |

`seqnum` is a server-assigned monotonic counter, and it does **not** reuse freed values:
after deleting the row at `seqnum 3`, the next POST was assigned **6**, leaving the sequence
`1, 2, 4, 5, 6`. Gaps persist and cannot be closed.

So criterion order is **create-order only and immutable**. The sole way to reorder is
delete-and-recreate, which mints new ids — and therefore, presumably, severs whatever grade
history is keyed to them. Push cannot offer reordering without that trade.

### DELETE — collection-scoped, same as the others

| body | result |
|---|---|
| `DELETE .../rubrics/{id}` | **400** — `Cannot decode content - missing rubrics array` |
| `DELETE .../rubrics` with `{rubrics:[{id}]}` | **200** ✅ |

**All three write verbs share one shape: `{ rubrics: [ … ] }` on the collection URL.**
Batch delete works — three rows removed in a single call, response
`rubrics deleted successfully`.

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

## 6. What this means for VOC-4003

`max_points` was never storable. That is why a part `PUT` setting it returns success and
changes nothing — §3 control (a) reproduces exactly the behaviour VOC-4003 describes, and
shows the cause. At assignment level `total_points` is not even an accepted parameter.

**Rubric push support is therefore the remedy for VOC-4003's user-visible symptom**, not a
separate feature: rubric rows are the only mechanism found that moves a course's points.
A migrated course cannot be given its point values by any other route observed here.

Remaining limits, stated plainly: alternatives were tried at both part and assignment level
and refused, but a UI-only path or an unsurfaced third field cannot be excluded from the
outside. The derivation rule itself is now confirmed on both architectures.

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

1. **Answer §7 before designing push** — grade impact above all. It is the one question
   whose answer could make rubric sync unsafe rather than merely complex.
2. **Settle pagination** (§1). Still the only untested part of the read path, and
   `listRubrics`'s loop rests on it. Needs a part with >100 criteria, or a deliberate
   `size=1` request to force a second page.
3. **Decide the reordering trade.** Order is immutable without delete-and-recreate. Either
   push declines to reorder and says so, or it recreates and accepts the id churn.
4. **Stop sending `max_points`.** It reaches the part `PUT` only as a passenger inside
   `_unknown_settings`, when a settings update is already being sent for other reasons — the
   reconciler does not treat a `max_points` difference as a change, and the create path sends
   no settings payload. So not *every* push, but when sent it is ignored, and it should not
   be sent at all.

## Scratch state left behind

Two scratch assignments, both named for deletion. Their **rubric rows have been cleaned up**
(both parts verified back to the copied 2-criterion, `max_points: 15` state), but the
assignments themselves remain — the API offers no assignment delete, and AGENTS.md forbids
one.

| course | assignment | note |
|---|---|---|
| 229751 (vnb) | **5785278** "ZZ vocgit rubric probe (safe to delete)" | copy of Lab 1 |
| 229752 (elite) | **5785504** "ZZ vocgit elite rubric probe (safe to delete)" | copy of Lab 1 |

**Delete both by hand in the Vocareum UI.** No reference assignment in either course was
modified, and 229677 was never written to.
