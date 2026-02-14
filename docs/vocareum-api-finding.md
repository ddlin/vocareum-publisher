# Vocareum API Findings & Recommendations

**Date:** February 2026
**Project:** vocareum-publisher (GitHub → Vocareum sync tool)
**Purpose:** Document API issues discovered during integration, with recommendations for Vocareum team.

---

## Summary

We built a CLI tool to sync assignment content from GitHub to Vocareum. During integration, we encountered several undocumented behaviors, inconsistencies, and gaps that required significant trial-and-error to resolve. This document captures our findings to help improve the API and documentation.

**What we tested:**
- Course, assignment, and part CRUD operations
- Content upload via multiple approaches
- Assignment copy/duplication
- Transaction polling for async operations
- All assignment and part settings fields

**Test environment:** Live API (`api.vocareum.com`), course `201303`

---

## Non-Standard API Patterns

The Vocareum API deviates from common REST conventions in several ways, which contributed to integration difficulty:

| Aspect | Standard Practice | Vocareum Pattern |
|--------|------------------|------------------|
| **Query param format** | `?dir=startercode` | `?dir=/voc/startercode` (full filesystem path) |
| **Listing vs download** | Different endpoints or HTTP verbs | Same endpoint, `list=true` param toggles behavior |
| **Auth header** | `Authorization: Bearer <token>` | `Authorization: Token <token>` |
| **Error responses** | Detailed validation errors with field info | Generic `400 Invalid Request` |
| **Directory abstraction** | API abstracts internal filesystem | API exposes internal paths (`/voc/`, `/work`) |
| **Endpoint structure** | Resource-based (`/assignments/{id}`) | Requires full context (`/courses/{cid}/assignments/{aid}`) |

**Why this matters:**

1. **The `/voc/` prefix is unusual** — Most APIs abstract internal filesystem structure. Exposing it means clients must know internal directory layout, and creates breaking change risk if Vocareum restructures internally. The difference between `startercode` and `/voc/startercode` is non-obvious.

2. **The `list=true` toggle is unusual** — Typically you'd have separate endpoints:
   - `GET /files` → list files
   - `GET /files/{filename}` → download file

   Instead of one endpoint that changes behavior based on a query param.

3. **Developers assume standard patterns** — Our initial implementation assumed industry-standard conventions, which is why it failed. The trial-and-error discovery process was necessary because the API isn't self-documenting and follows non-obvious conventions.

**Recommendation:** Consider adopting more conventional REST patterns, or at minimum document the non-standard behaviors prominently.

---

## Critical Issues

### 1. Direct endpoints return 400 (Undocumented)

**Problem:** The Postman docs suggest endpoints like `/api/v2/assignments/{id}` and `/api/v2/parts/{id}` exist, but they return `400 Invalid Request`.

**Discovery:** After many failed attempts, we found that **course-scoped endpoints** work:
- `/api/v2/courses/{courseId}/assignments/{assignmentId}` ✓
- `/api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}` ✓

**Recommendation:** Document that all operations require course-scoped paths. Remove or deprecate direct endpoints from docs if they don't work.

### 2. Content upload contract is non-obvious

**Problem:** We initially tried `POST /api/v2/upload`, multipart uploads, and various `/files` endpoint patterns. All returned `400 Invalid Request` with no guidance.

**Discovery:** Content upload uses the **part update endpoint** with a special payload:
```json
PUT /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}
{
  "update": 1,
  "content": [{
    "target": "startercode",
    "zipcontent": "<base64-zip>",
    "reset": 1
  }]
}
```

**Recommendation:** Add dedicated documentation for content upload including:
- The exact endpoint and payload schema
- Valid `target` values by scope (part-level vs course-level)
- Semantics of `reset` (0 vs 1)
- Maximum payload size limits
- Whether multiple `content[]` entries work in one request

### 3. Authentication format undocumented

**Problem:** We initially used `Authorization: Bearer <token>` (industry standard). It was rejected as "Missing Token".

**Discovery:** The correct format is `Authorization: Token <token>`.

**Recommendation:** Explicitly document the auth header format. If Bearer is intentionally unsupported, note that.

### 4. Generic error responses hinder debugging

**Problem:** Many different failure modes return the same `400 Invalid Request` with no details:
- Missing required field
- Invalid field value
- Wrong endpoint structure
- Unsupported operation

**Recommendation:** Return field-level validation errors. Example:
```json
{
  "status": "error",
  "code": "VALIDATION_ERROR",
  "errors": [
    {"field": "target", "message": "Invalid value 'foo'. Valid: startercode, scripts, ..."}
  ]
}
```

### 5. Some assignment fields don't work via API

**Problem:** These fields return "No valid parameters to update the assignment":
- `points`
- `due_date`
- `gradespublished`

**Discovery:** These may require a different endpoint or workflow not documented.

**Recommendation:** Either enable these fields on the existing endpoint, document the correct approach, or explicitly mark them as UI-only.

### 6. Org-restricted fields fail silently

**Problem:** `cloud_labs` and `instant_aws_access` return "Cloud not allowed for the org" only after attempting the update.

**Recommendation:** Provide a capabilities endpoint or include org permissions in course/assignment responses so clients can check before attempting.

---

## Inconsistencies

### 1. ID type varies between string and number

**Problem:** The same ID field returns different JSON types depending on context.

**Examples:**
```json
// Assignment listing returns string IDs
GET /api/v2/courses/192814/assignments
→ { "assignments": [{ "id": "4959500", "name": "Lab 1" }] }

// But some nested contexts return numeric IDs
{ "courseid": 192814, "assignmentid": 4959500 }  // numbers, not strings
```

**Impact:** JavaScript `===` comparison fails: `"4959500" !== 4959500`. Clients must normalize all IDs to strings.

**Our workaround:** Convert all IDs to strings immediately upon receipt.

**Recommendation:** Consistently return all IDs as JSON strings.

---

### 2. Content-Type header doesn't match response body

**Problem:** Some endpoints return JSON with incorrect Content-Type header.

**Example:**
```
HTTP/1.1 200 OK
Content-Type: text/html; charset=UTF-8

{"status":"success","assignments":[...]}
```

**Impact:** HTTP clients with strict content-type validation reject valid responses. Libraries like axios may not auto-parse JSON.

**Our workaround:** Parse response body as JSON regardless of Content-Type header.

**Recommendation:** Return `Content-Type: application/json` for all JSON responses.

---

### 3. File listing requires undocumented `/voc/` prefix and `list=true` parameter

**Problem:** Intuitive request format returns error.

**What we tried:**
```
GET .../files?dir=startercode
→ 400: "startercode doesn't exist"

GET .../files?dir=startercode&list=true
→ 400: "startercode doesn't exist"
```

**What actually works:**
```
GET .../files?dir=/voc/startercode&list=true
→ {"files": ["main.py", "utils.py"]}
```

**Key discoveries:**
- Directory must have `/voc/` prefix (e.g., `/voc/startercode`, `/voc/scripts`)
- `list=true` parameter is required to get file listing
- Without `list=true`, the endpoint behaves differently (attempts download)
- Exception: `/work` directory doesn't use `/voc/` prefix

**Our workaround:** `toApiDirPath()` helper function adds `/voc/` prefix automatically.

**Recommendation:** Document the exact parameter format, or accept both formats.

---

### 4. File download uses different format than file listing

**Problem:** File listing and download use incompatible parameter formats.

**Listing (works):**
```
GET .../files?dir=/voc/scripts&list=true
→ {"files": ["grade.sh", "run.sh"]}
```

**Download attempt with same format (fails):**
```
GET .../files?dir=/voc/scripts&filename=grade.sh
→ {"transactionid": "12345"}  // Starts async ZIP download of entire part
```

**What actually works for single-file download:**
```
GET .../files?filename=scripts/grade.sh
→ {"files": [{"download_url": "https://...signed-s3-url..."}]}

// Then fetch from download_url (no auth needed)
GET https://...signed-s3-url...
→ (file content)
```

**Key discoveries:**
- Single-file download uses `filename={dir}/{file}` (no `/voc/` prefix, no `dir` param)
- Response contains `download_url` - a signed S3 URL
- Must make second HTTP request to download actual content
- Using `dir=/voc/...` triggers async transaction returning ZIP of entire part

**Our workaround:** Two-step download: get `download_url`, then fetch from it.

**Recommendation:** Document the file download contract clearly; consider returning content directly.

---

### 5. Part `seqnum` is a string, not integer

**Problem:** Sequence numbers are returned as strings.

**Example:**
```json
{
  "parts": [
    { "id": "111", "name": "Part 1", "seqnum": "0" },
    { "id": "222", "name": "Part 2", "seqnum": "1" },
    { "id": "333", "name": "Part 10", "seqnum": "10" }
  ]
}
```

**Impact:** String sorting gives wrong order: `"10" < "2"` in lexicographic sort.

**Our workaround:** `parts.sort((a, b) => parseInt(a.seqnum) - parseInt(b.seqnum))`

**Recommendation:** Return `seqnum` as JSON number, or document string format.

---

### 6. Numeric fields returned as strings

**Problem:** Several numeric fields are returned as JSON strings instead of numbers.

**Example:**
```json
{
  "databricks_maxusers": "250",    // Should be: 250
  "session_length": "600",         // Should be: 600
  "monthly_dollar": "0",           // Should be: 0
  "monthly_time": "0",
  "total_time": "1200",
  "total_dollar": "0"
}
```

**Impact:**
- Schema validation fails if expecting integers
- Comparison `250 !== "250"` returns false positive drift
- Arithmetic operations require parsing: `parseInt(session_length) + 60`

**Our workaround:**
- Schema uses `z.coerce.number()` to accept both formats
- Comparison functions handle string/number equivalence

**Recommendation:** Return all numeric fields as JSON numbers.

---

### 7. `submission_filters` format differs between read and write

**Problem:** API returns one format but expects another for updates.

**What API returns (array):**
```json
{
  "submission_filters": ["*.py", "*.txt"]
}
```

**What update endpoint expects (object):**
```json
{
  "submission_filters": {
    "include": ["*.py"],
    "exclude": ["*.pyc"]
  }
}
```

**Impact:** Cannot round-trip data without transformation.

**Our workaround:** `normalizeSubmissionFilters()` converts between formats.

**Recommendation:** Accept both formats on write, or standardize on one format for both.

---

### 8. Null handling differs between read and write

**Problem:** API returns `null` but rejects it on update.

**What API returns:**
```json
{
  "container_image": null,
  "labtype": null,
  "session_length": "600"
}
```

**Update with null (fails):**
```
PUT .../parts/123
{ "container_image": null }
→ 400: "Invalid Request"
```

**Update without field (works):**
```
PUT .../parts/123
{ "name": "Part 1" }  // omit null fields entirely
→ 200: Success
```

**Impact:** Clients must strip all `null` values before sending updates.

**Our workaround:** `nullToUndefined()` helper filters nulls before API calls.

**Recommendation:** Either accept `null` on updates, or omit null fields from responses.

---

### 9. Unset fields represented inconsistently

**Problem:** Unset optional fields appear in three different forms.

**Examples from same response type:**
```json
// Field completely absent
{ "name": "Part 1" }

// Field present with null
{ "name": "Part 1", "container_image": null }

// Field present with empty string
{ "name": "Part 1", "description": "" }
```

**Impact:** Comparison logic must treat `undefined`, `null`, and `""` as equivalent to avoid false positives.

**Our workaround:** `settingsDiffer()` normalizes all three to `undefined` before comparing.

**Recommendation:** Standardize: either always omit unset fields, or always include with `null`.

---

## Known Limitations

### Course directory (`/voc/course`) not synced

We explicitly exclude the `course` directory from listing and download operations.

**Reason:** The `course` directory contains course-wide shared files that are symlinked across all assignments in a course. On the Vocareum side, these appear as symbolic links, but the file listing API may return them as actual files/directories.

**Problem if synced:**
1. Changes to `course` files would affect ALL assignments in the course
2. Each assignment sync would detect "drift" in course files
3. This creates infinite update loops: sync assignment A → course file changes → assignment B detects drift → sync B → etc.

**Our approach:**
- `downloadContent()` skips the `course` directory
- Pull command ignores `course` directory files
- Only part-level directories are synced: `startercode`, `scripts`, `docs`, `data`, `lib`, `asnlib`, `private`

**If you need course-wide files:** Manage them directly in the Vocareum UI, not through this sync tool.

---

## Documentation Gaps

### Missing from Postman/API docs:

| Topic | What's needed |
|-------|---------------|
| Content upload | Full schema for `content[]` payload |
| Valid `target` values | List by scope (part vs course) |
| File listing | `dir=/voc/{directory}` format, `list=true` parameter |
| File download | Two-step process: get `download_url`, then fetch |
| Transaction polling | Endpoint, states, recommended intervals |
| Assignment copy | Full request/response schema |
| Required fields | `name` required for part updates |
| Async behavior | Which operations return `transactionid` |
| Rate limiting | Limits and retry guidance |
| Auth format | `Token` vs `Bearer` clarification |

### Fields we confirmed working (not all documented):

**Assignment settings:**
`name`, `description`, `nosubmit`, `publish`, `publish_grades`, `auto_submit`, `grading_on_submit`, `noworkarea`, `exam_mode`, `exam_duration`, `num_attempts`, `show_end_exam_button`, `copy_startercode`, `uncompressupload`, `lti_on`, `anonymous_grading`, `grading_visibility`, `send_webhook`, `live_code_comments`

**Part settings:**
`name`, `submission_filters`, `session_length`, `monthly_dollar`, `monthly_time`, `total_time`, `total_dollar`, `late_penalty_percent`, `late_penalty_percent_rule`, `deadlinedate`, `endlab`, `labtype`, `container_image`, `number_of_submissions`, `lab_interface`, `databricks_maxusers`, `tags`

---

## Recommendations Summary

| Priority | Recommendation |
|----------|----------------|
| High | Document content upload contract (endpoint + payload schema) |
| High | Return detailed validation errors instead of generic 400 |
| High | Document that course-scoped endpoints are required |
| High | Document auth header format (`Token` not `Bearer`) |
| Medium | Publish OpenAPI/Swagger spec |
| Medium | Standardize ID types as strings |
| Medium | Standardize JSON Content-Type headers |
| Medium | Document which fields work via API vs UI-only |
| Medium | Standardize null handling (accept null on updates or omit from responses) |
| Medium | Standardize `submission_filters` format (array vs object) |
| Medium | Return numeric fields as JSON numbers, not strings |
| Low | Add capabilities/introspection endpoint |
| Low | Standardize file download response format |

---

## Workarounds We Implemented

| Issue | Our workaround |
|-------|----------------|
| Direct endpoints don't work | Always use course-scoped paths |
| Upload contract undocumented | Discovered via Postman collection + trial-and-error |
| Generic 400 errors | Extensive probing to find valid field combinations |
| File listing format undocumented | Use `dir=/voc/{directory}&list=true` format |
| File download format undocumented | Use `filename={dir}/{file}` to get `download_url`, then fetch |
| ID type varies | Normalize all IDs to strings |
| Content-Type inconsistent | Parse body regardless of Content-Type |
| Rate limiting on rapid requests | Retry with exponential backoff |
| Async operations | Poll `/api/v2/transaction/{id}` until complete |
| `submission_filters` format varies | `normalizeSubmissionFilters()` converts array to object format |
| Null values in responses | `nullToUndefined()` helper filters nulls before API calls |
| Null/undefined comparison | `settingsDiffer()` treats null and undefined as equivalent |
| Numeric fields as strings | `z.coerce.number()` in schema, type-aware comparison in `valuesEqual()` |

---

## Testing Methodology

1. **Endpoint discovery:** Tried documented endpoints, then variations until finding working patterns
2. **Field probing:** Tested each settings field individually via curl to confirm which work
3. **Error analysis:** Catalogued all error responses to understand failure modes
4. **Live verification:** All "working" fields confirmed via actual API calls against course `201303`

**Probe script:** `scripts/probe-vocareum-api.mjs` (in our repo) contains reproducible tests for all findings.

---

## Contact

For questions about these findings or our integration approach, see the [vocareum-publisher](https://github.com/ddlin/vocareum-publisher) repository.
