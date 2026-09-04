# Vocareum rubrics API — probe findings

**Probed:** 2026-09-04, org 335, token `VOC_TOKEN_ORG335_READWRITE`.
**Courses:** 229752 (DL TEST ELITE, elite arch, original content) · 229751 (DL TEST VNB,
container arch, *manually* migrated) · 229677 (migrated by vocgit).

This is the Task 2 Step 6 output deferred during the rubrics-pull build, and it is the
spec input for the push-side plan.

---

## 1. Read shape — confirmed, matches the plan's types

`GET /courses/{c}/assignments/{a}/parts/{p}/rubrics` → 200:

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

## 2. The gap is real and total

| course | assignments | parts w/ rubrics | rubric rows | points in rubrics |
|---|---|---|---|---|
| 229752 (elite source) | 7 | 6 | 22 | 120 |
| 229751 (manual migration) | 7 | 6 | 22 | 120 |
| **229677 (vocgit migration)** | 7 | **0** | **0** | **0** |

229752 and 229751 are rubric-identical — same counts per lab (2, 2, 6, 2, 5, 5) and same
point totals (15, 20, 25, 15, 20, 25). **The manual migration preserved rubrics perfectly;
vocgit's migration preserved none.** This reproduces the original gap report's numbers
exactly (22 rows / 120 points).

## 3. `max_points` appears to be DERIVED from rubrics, not independently settable

The decisive observation. Across all 13 parts examined:

| part | rubric rows | Σ maxscore | part `max_points` |
|---|---|---|---|
| 229752/229751 Lab 1 | 2 | 15 | **15** |
| 229752/229751 Lab 2 | 2 | 20 | **20** |
| 229752/229751 Lab 3 | 6 | 25 | **25** |
| 229752/229751 Lab 4 | 2 | 15 | **15** |
| 229752/229751 Lab 5 | 5 | 20 | **20** |
| 229752/229751 Lab 6 | 5 | 25 | **25** |
| 229677 (all 7 parts) | 0 | 0 | **0** |

Σ maxscore == max_points in 13/13 cases, including the seven zero cases.

If this is causal rather than correlated, it explains **VOC-4003** completely: `max_points`
is a *computed* field, so a `PUT` that sets it is accepted and discarded because the value
is derived from rubric rows. That would make rubric creation the **only** way to set an
assignment's points — turning rubric push support from a nicety into the fix for VOC-4003.

Causality is tested in §5 below.

## 4. A structural difference in vocgit's migration

Assignment "GAIF parts probe" has **zero parts** in both 229752 and 229751
(`GET .../parts` → `{"status":"success","parts":[],"total_records":0}`), but vocgit's
229677 gave it **one part** (5784236). vocgit appears to create a part where the source
has none. Unrelated to rubrics; worth a separate look.

## 5. The write contract — probed live, and the plan's inference was wrong

Probed on a scratch assignment (229751 / asn **5785278** "ZZ vocgit rubric probe", part
**5785279**), created by copying Lab 1 so no reference content was touched.

### Assignment copy carries rubrics

Copying an assignment reproduces its rubrics with **new server ids** (source ids
11596xxx → copy ids 11597032/11597033) and the copy's `max_points` matches. So
`create_from_template` already preserves rubrics; the vocgit gap is in *sync*, not create.

### POST — create

**The plan's inferred bare-object body is wrong.** Findings, in the order the API taught them:

| body | result |
|---|---|
| `{name, seqnum, maxscore}` | **400** — `Cannot decode content - missing rubrics array` |
| `{rubrics:[{name, seqnum, maxscore}]}` | **400** — `Invalid attribure post rubric request: seqnum` *(their typo)* |
| `{rubrics:[{name, maxscore}]}` | **200** ✅ |

So: **`POST` takes `{ rubrics: [ { name, maxscore, auto?, exclude? } ] }` and rejects
`seqnum` outright.** The server assigns `seqnum` by append order. Multiple criteria in one
call work, and `auto`/`exclude` are both settable on create (defaults: `auto:false`,
`exclude:false` — note copied rubrics carry `auto:true`).

⚠️ **The POST response types `id` and `seqnum` as NUMBERS** (`"id": 11597034, "seqnum": 3`)
while `GET` returns both as **strings**. That violates AGENTS.md constraint 1 at exactly the
seam a push implementation would consume. Any push code must coerce.

### PUT — update

| body | result |
|---|---|
| `PUT .../rubrics/{id}` with `{maxscore}` | **400** — `missing rubrics array` |
| `PUT .../rubrics` with `{rubrics:[{id, maxscore}]}` | **200** ✅ |

**PUT is collection-scoped, not per-row**, takes the same wrapped array keyed by `id`, and
is a **partial** update — sending only `maxscore` preserved `name`.

⚠️ **`seqnum` is accepted but silently ignored on PUT.** Sending `{id:"11597036",
seqnum:"1"}` returned 200 with `seqnum` still `"5"`. **Reordering criteria appears to be
impossible through this endpoint** — unresolved whether sending the whole array in the
desired order works.

### DELETE — untestable with this token

Both `DELETE .../rubrics/{id}` and `DELETE .../rubrics` with `{rubrics:[{id}]}` returned
**403 `Access Forbidden (permission denied)`**. `VOC_TOKEN_ORG335_READWRITE` carries rubrics
GET/POST/PUT but not DELETE. **Re-probe with a DELETE-scoped token before designing
reconciliation.**

## 6. `max_points` is derived — VOC-4003 explained, and the causality is now proven

Adding a 7-point criterion to a part with `max_points: "15"` moved it to **`"22"`**
immediately. Then, with criteria of 10 + 5 + 9 + 3 and a fourth worth 4 marked
`exclude: true`, `max_points` read **`"27"`** — i.e. `10+5+9+3`, with the excluded row
omitted.

**Rule: `max_points` = Σ `maxscore` over criteria where `exclude !== true`. It is computed,
not stored.**

That is the whole of VOC-4003. `max_points` is accepted on a part `PUT` and "discarded"
because it is a derived field — there was never a value to store. **Creating rubric rows is
the only way to set an assignment's points.**

Consequence for the roadmap: rubric **push** support is not a nicety. It is the fix for
VOC-4003, and it is the only path by which a migrated course gets its point values. The
read-only release shipped today makes the loss *visible*; it does not stop it.

## 7. What to do next

1. **Re-probe DELETE** with a token carrying the rubrics DELETE scope. Reconciliation design
   is blocked on knowing whether delete is per-row or collection-shaped.
2. **Resolve reordering.** If `seqnum` is truly unwritable, push must either accept that
   criterion order is create-order only, or delete-and-recreate to reorder — which destroys
   grade associations and collides with AGENTS.md constraint 7.
3. **Drop `max_points` from the part-settings payload.** vocgit currently ships it via
   `_unknown_settings`, where it is silently ignored on every push. It should not be sent.
4. **Plan push around `{rubrics:[…]}` for both POST and PUT**, coercing the numeric `id`/
   `seqnum` in POST responses back to strings.

## Scratch state left behind

`229751 / 5785278` — "ZZ vocgit rubric probe (safe to delete)", 1 part, 5 rubric criteria
(2 copied + 3 probe rows). It could not be cleaned up: the token lacks rubrics DELETE.
**Delete it by hand in the Vocareum UI.** No reference content in 229751 or 229752 was
modified, and 229677 was never written to.
