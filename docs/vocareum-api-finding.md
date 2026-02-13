# Vocareum API Reference

Quick reference for Vocareum API v2 endpoints. Based on live testing (February 2026).

---

## Quick Reference

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Get course | GET | `/api/v2/courses/{courseId}` |
| List assignments | GET | `/api/v2/courses/{courseId}/assignments` |
| Get assignment | GET | `/api/v2/courses/{courseId}/assignments/{assignmentId}` |
| Update assignment | PUT | `/api/v2/courses/{courseId}/assignments/{assignmentId}` |
| Copy assignment | POST | `/api/v2/courses/{courseId}/assignments` |
| List parts | GET | `/api/v2/courses/{courseId}/assignments/{assignmentId}/parts` |
| Get part | GET | `/api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}` |
| Update part | PUT | `/api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}` |
| Upload content | PUT | `/api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}` |
| List files | GET | `.../parts/{partId}/files?dir={directory}` |
| Download file | GET | `.../parts/{partId}/files?dir={directory}&filename={path}` |
| Poll transaction | GET | `/api/v2/transaction/{transactionId}` |

**Authentication:** `Authorization: Token <token>` (not Bearer)

**Base URL:** `https://api.vocareum.com`

---

## Assignment Settings

**Endpoint:** `PUT /api/v2/courses/{courseId}/assignments/{assignmentId}`

### Working Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Assignment display name |
| `description` | string | Assignment description |
| `nosubmit` | boolean | Disable student submissions |
| `publish` | boolean | Publish to students |
| `publish_grades` | string | Grades publishing setting |
| `auto_submit` | boolean | Enable automatic submission |
| `grading_on_submit` | boolean | Grade immediately on submit |
| `noworkarea` | boolean | Disable work area for students |
| `exam_mode` | string | `"timed"`, `"scheduled"`, or `"timed_scheduled"` |
| `exam_duration` | integer | Exam duration in minutes |
| `num_attempts` | integer | Number of attempts allowed |
| `show_end_exam_button` | boolean | Show end exam button |
| `copy_startercode` | boolean | Copy starter code to workspace |
| `uncompressupload` | boolean | Uncompress uploaded files |
| `lti_on` | boolean | Enable LTI integration |
| `anonymous_grading` | boolean | Enable anonymous grading |
| `grading_visibility` | string | `"all"` or `"assigned"` |
| `send_webhook` | boolean | Send webhook on events |
| `live_code_comments` | boolean | Enable live code comments |

### Non-Working Fields

| Field | Error |
|-------|-------|
| `points` | "No valid parameters to update the assignment" |
| `due_date` | "No valid parameters to update the assignment" |
| `gradespublished` | "No valid parameters to update the assignment" |

---

## Part Settings

**Endpoint:** `PUT /api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}`

**Important:** `name` field is **required** for most update requests.

### Working Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Part display name (**required**) |
| `submission_filters` | object | Student submission filters (see below) |
| `session_length` | string | Lab session length in minutes (e.g., `"60"`) |
| `monthly_dollar` | string | Monthly dollar budget |
| `monthly_time` | string | Monthly time budget in minutes |
| `total_time` | string | Total time budget in minutes |
| `total_dollar` | string | Total dollar budget |
| `late_penalty_percent` | integer | Late penalty percentage (0-100) |
| `late_penalty_percent_rule` | string | `"max score"` or `"student score"` |
| `deadlinedate` | string | Part deadline (ISO 8601) |
| `endlab` | string | `"stop"` or `"terminate"` |
| `labtype` | string | Lab type (e.g., `"JupyterLab"`, `"Visual Studio Code"`) |
| `container_image` | string | Container image (must match labtype) |
| `number_of_submissions` | integer | Max submissions allowed |
| `lab_interface` | object | Lab interface configuration (see below) |
| `databricks_maxusers` | integer | Max users for Databricks labs |
| `tags` | array | Array of tag strings |

### Submission Filters Object

```json
{
  "submission_filters": {
    "include": ["*.py", "*.txt"],
    "exclude": ["*.pyc", "__pycache__"],
    "list": ["specific_file.py"]
  }
}
```

### Lab Interface Object

```json
{
  "lab_interface": {
    "panels": ["Console", "Html"],
    "controls": ["Reset"],
    "information": ["Assignments"],
    "launch_behavior": [],
    "grades": []
  }
}
```

### Org-Restricted Fields

| Field | Error |
|-------|-------|
| `cloud_labs` | "Cloud not allowed for the org" (if org lacks permission) |
| `instant_aws_access` | Same restriction as cloud_labs |

---

## Content Upload

**Endpoint:** `PUT /api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}`

### Request Body

```json
{
  "update": 1,
  "content": [
    {
      "target": "startercode",
      "zipcontent": "<base64-encoded-zip>",
      "reset": 1
    }
  ]
}
```

### Content Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `update` | number | Yes | Must be `1` |
| `content` | array | Yes | Array of upload objects |
| `content[].target` | string | Yes | Directory type |
| `content[].zipcontent` | string | Yes* | Base64-encoded ZIP |
| `content[].url` | string | No | Alternative: URL to fetch ZIP |
| `content[].reset` | number | No | `1` = clear first, `0` = append |

### Valid Target Values

**Part-level:** `startercode`, `scripts`, `docs`, `data`, `lib`, `asnlib`

**Course-level:** `course`, `data`, `docs`, `scripts`, `private`, `startercode`

---

## Assignment Copy

**Endpoint:** `POST /api/v2/courses/{courseId}/assignments`

### Request Body

```json
{
  "method": "copy",
  "source": "<source-assignment-id>",
  "name": "<new assignment name>"
}
```

### Response

Returns `202` with `transactionid`. Poll until complete to get final `objid` (new assignment ID).

---

## Transaction Polling

**Endpoint:** `GET /api/v2/transaction/{transactionId}`

### Response

```json
{
  "status": "success",
  "state": "pending | success | failed",
  "message": "optional error detail",
  "objid": "created-object-id"
}
```

### Polling Strategy

| Parameter | Value |
|-----------|-------|
| Poll interval | 1000ms |
| Max attempts | 30 |
| Timeout | 30s |

**States:** `pending` → keep polling, `success` → done, `failed` → throw error

---

## Important Behaviors

### Async Operations

All PUT operations return `transactionid` and require polling:
- Assignment updates
- Part updates
- Content uploads

### Rate Limiting

Rapid successive requests may fail with: "The previous corresponding API request is not yet complete"

**Solution:** Implement retry with backoff.

### ID Types

All IDs are **strings**, not numbers. Normalize in your client.

### Direct Endpoints Don't Work

These return `400 Invalid Request`:
- `/api/v2/assignments/{id}`
- `/api/v2/parts/{id}`

**Always use course-scoped endpoints.**

---

## curl Examples

### Setup

```bash
TOKEN="<your_token>"
CID="<course_id>"
AID="<assignment_id>"
PID="<part_id>"
BASE="https://api.vocareum.com"
```

### Read Operations

```bash
# Get course
curl -sS "$BASE/api/v2/courses/$CID" -H "Authorization: Token $TOKEN"

# List assignments
curl -sS "$BASE/api/v2/courses/$CID/assignments" -H "Authorization: Token $TOKEN"

# List parts
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts" -H "Authorization: Token $TOKEN"

# List files
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files?dir=startercode" \
  -H "Authorization: Token $TOKEN"
```

### Update Assignment

```bash
curl -sS -X PUT "$BASE/api/v2/courses/$CID/assignments/$AID" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Updated Name","description":"New description"}'
```

### Update Part

```bash
curl -sS -X PUT "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Part 1","session_length":"60","late_penalty_percent":10}'
```

### Upload Content

```bash
# Create and encode ZIP
echo "print('hello')" > /tmp/main.py
cd /tmp && zip upload.zip main.py && cd -
ZIP_B64=$(base64 -w 0 /tmp/upload.zip)

# Upload
curl -sS -X PUT "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"update\":1,\"content\":[{\"target\":\"startercode\",\"zipcontent\":\"$ZIP_B64\",\"reset\":1}]}"
```

### Copy Assignment

```bash
curl -sS -X POST "$BASE/api/v2/courses/$CID/assignments" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method":"copy","source":"'"$AID"'","name":"New Assignment"}'
```

### Poll Transaction

```bash
curl -sS "$BASE/api/v2/transaction/$TXN_ID" -H "Authorization: Token $TOKEN"
```

---

## Known Issues

| Issue | Workaround |
|-------|------------|
| IDs sometimes returned as numbers | Normalize to strings |
| JSON responses with `text/html` content-type | Parse response body, ignore content-type |
| Generic `400 Invalid Request` errors | Trial and error; check this doc |
| File download format varies | Try multiple response shapes |
| File deletion may not be supported | Use `reset: 1` on upload instead |

---

## Appendix: Testing Scope

Live API probes conducted February 2026 against:
- Base: `https://api.vocareum.com`
- Test course: `201303`
- Test assignment: `5137423`
- Test part: `5137424`

All fields documented as "working" were confirmed via actual API calls.
