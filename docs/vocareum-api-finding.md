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

### ID type varies

- Most responses return IDs as strings (`"12345"`)
- Some contexts return IDs as numbers (`12345`)

**Impact:** Comparison bugs if client doesn't normalize.

**Recommendation:** Consistently return all IDs as strings.

### Content-Type header inconsistent

- Some JSON responses are served with `Content-Type: text/html; charset=UTF-8`

**Impact:** Breaks strict content-type validation in HTTP clients.

**Recommendation:** Return `Content-Type: application/json` for all JSON responses.

### File listing requires specific format

**Problem:** `GET .../files?dir=startercode` returns `400 Invalid Request` with message "startercode doesn't exist".

**Discovery:** The correct format requires:
- Full path with `/voc/` prefix: `dir=/voc/startercode`
- The `list=true` parameter to get file listing (without it, returns download URL)

**Working examples:**
```
GET .../files?dir=/voc/startercode&list=true  → {"files": ["main.py", "utils.py"]}
GET .../files?dir=/voc/scripts&list=true      → {"files": ["grade.sh"]}
GET .../files?dir=/work&list=true             → {"files": ["notebook.ipynb"]}
```

**Recommendation:** Document the `/voc/` prefix requirement and the `list=true` parameter clearly.

### File download format varies

`GET .../files?dir=...&filename=...` returns different shapes:
- Sometimes raw string content
- Sometimes a Buffer
- Sometimes JSON with `content`, `data`, `file`, or `base64` field

**Recommendation:** Standardize on one format (suggest: always base64 in JSON wrapper, or always raw bytes with Content-Disposition header).

### Part `seqnum` is a string

`seqnum` values are strings like `"0"`, `"1"`, `"2"` rather than integers.

**Impact:** Must parse to int for sorting; string sort gives wrong order (`"10"` < `"2"`).

**Recommendation:** Return as integers, or document the string format clearly.

### `submission_filters` format varies

API responses return `submission_filters` in array format:
```json
"submission_filters": ["*.py", "*.txt"]
```

But the update endpoint accepts object format:
```json
"submission_filters": { "include": ["*.py"], "exclude": ["*.pyc"] }
```

**Impact:** Clients must normalize between formats when reading then writing.

**Recommendation:** Accept both formats on write, or standardize on one format.

### Null vs undefined in responses and requests

API responses return `null` for unset optional fields:
```json
{ "container_image": null, "labtype": null }
```

But update requests reject `null` values - must omit the field entirely (undefined).

**Impact:** Clients must filter out null values before sending updates, or get validation errors.

**Recommendation:** Either:
- Accept `null` on updates (treat as "clear this field")
- Return absent fields as undefined (omit from response) instead of null

### Field presence inconsistent

When reading assignment/part settings, some unset fields are:
- Completely absent from response (undefined)
- Present with `null` value
- Present with empty string `""`

**Impact:** Comparison logic must treat null, undefined, and absent as equivalent to avoid false positives.

**Recommendation:** Standardize on one representation for "unset" (suggest: omit field entirely).

---

## Documentation Gaps

### Missing from Postman/API docs:

| Topic | What's needed |
|-------|---------------|
| Content upload | Full schema for `content[]` payload |
| Valid `target` values | List by scope (part vs course) |
| File listing | `dir=/voc/{directory}` format, `list=true` parameter |
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
| ID type varies | Normalize all IDs to strings |
| Content-Type inconsistent | Parse body regardless of Content-Type |
| File download format varies | Try multiple response shapes, fallback gracefully |
| Rate limiting on rapid requests | Retry with exponential backoff |
| Async operations | Poll `/api/v2/transaction/{id}` until complete |
| `submission_filters` format varies | `normalizeSubmissionFilters()` converts array to object format |
| Null values in responses | `nullToUndefined()` helper filters nulls before API calls |
| Null/undefined comparison | `settingsDiffer()` treats null and undefined as equivalent |

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
