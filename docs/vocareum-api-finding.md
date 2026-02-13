# Vocareum API Findings

Date: February 13, 2026
Repository: `voc-github-actions`
Purpose: Internal reference for implementation + external feedback to Vocareum team.

## Scope of Testing

We ran live API probes against:

- Base host: `https://api.vocareum.com`
- Auth mode: token from local `.env` (never logged)
- Test course: `201303`
- Sample assignment: `5137423`
- Sample part: `5137424`

Testing covered endpoint discovery, auth behavior, response shape, request contract probing, and live upload/copy verification.

## Confirmed Findings

### 1. API namespace

- `/api/v2/...` endpoints are active.
- `/v1/...` endpoint variants returned `404 Not Found` in our probes.

### 2. Authentication header format

- Working format is:
  - `Authorization: Token <token>`
- `Authorization: Bearer <token>` is not accepted (treated as missing token).

### 3. Working read endpoints

- `GET /api/v2/courses/{course_id}`
  - Example: `/api/v2/courses/201303`
  - Returns success payload with `courses` array.
- `GET /api/v2/courses/{course_id}/assignments`
  - Example: `/api/v2/courses/201303/assignments`
  - Returns assignment list.
- `GET /api/v2/courses/{course_id}/assignments/{assignment_id}/parts`
  - Example: `/api/v2/courses/201303/assignments/5137423/parts`
  - Returns parts list including `id`, `seqnum`, `deleted`, `part_url`, etc.

### 4. Files endpoint behavior

- Route exists:
  - `GET /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files`
- Requires at least one query parameter:
  - `dir` or `filename`
- Observed responses:
  - Missing both -> `400` with: `Parameter dir or filename must be specified`
  - Unknown filename -> `400` with: `specified source does not exist <filename>`
  - Unknown dir -> `400` with: `<dir> doesn't exist`
- File listing with `?dir=<directory>` returns `{ files: FileInfo[] }` where each `FileInfo` has `path`, `size`, and optionally `modifiedAt`.
- Single file download with `?dir=<directory>&filename=<path>` returns file content (format varies — may be raw string, buffer, or object with `content`/`data`/`file`/`base64` field).

### 5. Content upload contract (confirmed and implemented)

Upload uses the **part update endpoint**, not a separate file upload route.

**Endpoint:**

```
PUT /api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}
```

**Headers:**

```
Authorization: Token <token>
Content-Type: application/json
```

**Body:**

```json
{
  "update": 1,
  "content": [
    {
      "target": "<directory>",
      "zipcontent": "<base64-encoded-zip>",
      "reset": 1
    }
  ]
}
```

**Field details:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `update` | `number` | Yes | Must be `1` to signal content update |
| `content` | `array` | Yes | Array of directory upload objects |
| `content[].target` | `string` | Yes | Directory type (see below) |
| `content[].zipcontent` | `string` | Yes* | Base64-encoded ZIP archive of files |
| `content[].url` | `string` | No | Alternative: URL to fetch ZIP from |
| `content[].reset` | `number` | No | `1` = clear directory before writing, `0` = append/overwrite |

**Supported `target` values (by scope):**

- Part-level: `startercode`, `scripts`, `docs`, `data`, `lib`, `asnlib`
- Course-level: `course`, `data`, `docs`, `scripts`, `private`, `startercode`

**Response behavior:**

- Synchronous success: `{ status: "success" }`
- Asynchronous processing: `{ status: "success", transactionid: "<id>" }` — requires polling (see section 5.1)
- Direct failure: `{ status: "success", state: "failed", message: "..." }`

**Implementation decision:** We use `zipcontent` (base64 ZIP) with `reset: 1` for every upload. This ensures the remote directory exactly matches the local Git state (no leftover files from previous uploads). Files are packaged using a custom ZIP builder that produces standard ZIP format with CRC32 checksums, UTF-8 filenames, and Unix-normalized paths.

**Upload timeout:** 60 seconds (configurable at client level).

### 5.1 Transaction polling for async uploads

Some uploads return a `transactionid` instead of completing synchronously. The client must poll until completion.

**Endpoint:**

```
GET /api/v2/transaction/{transactionId}
```

**Response:**

```json
{
  "status": "success",
  "state": "pending" | "success" | "failed",
  "message": "optional error detail"
}
```

**Polling behavior:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| Poll interval | 1000ms | Time between polls |
| Max attempts | 30 | Maximum polls before timeout |
| Effective timeout | 30s | Max wait before throwing |

**State transitions:**

- `pending` → keep polling
- `success` → upload complete, stop polling
- `failed` → throw error with `message` (or default message if absent)
- Timeout → throw error after `maxAttempts * delayMs` milliseconds

### 5.2 Upload endpoint discovery history

Before discovering the correct contract via the Vocareum Postman collection, we tested several candidate patterns that all returned `400 Invalid Request`:

- `POST /api/v2/upload` (multipart + JSON variants)
- `POST/PUT/PATCH .../parts/{pid}/files` with `type`, `dir`, `filename` combinations
- Raw body vs multipart form data

These are **not** the correct upload contract. The correct approach is the part PUT endpoint documented above.

### 6. File deletion (experimental)

```
DELETE /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files?dir={directory}&filename={filePath}
```

**Observed behavior:**

- Endpoint may not be supported on all Vocareum deployments.
- Returns `404` or `405` when not available.
- Our implementation handles these gracefully (logs warning, continues).

**Current usage:** Optional, controlled by `syncDeletes` flag. When enabled, our tool lists remote files, compares with local, and deletes remote-only files. However, since we use `reset: 1` on uploads, the directory is cleared server-side before writing — so explicit deletion is typically redundant for files within uploaded directories.

### 7. Assignment copy contract (confirmed via live test)

**Endpoint:**

```
POST /api/v2/courses/{courseId}/assignments
```

**Body:**

```json
{
  "method": "copy",
  "source": "<source-assignment-id>",
  "name": "<new assignment name>"
}
```

**Response:**

- `202`, `status=success`, `message=Started`, with `transactionid`
- Poll `GET /api/v2/transaction/{transactionid}` until `success`
- On success, `objid` contains the new assignment ID

**Important nuance:**

- Initial copy response may include an `objid` placeholder (observed as course ID), not final assignment ID.
- Client should always poll when `transactionid` is present and trust `objid` from the completed transaction.

Live-tested on `courseId=201303` with `source=5137423`: copy returned `202`, transaction progressed `pending → success`, final `objid` contained the new assignment ID.

### 7.1 Assignment and part settings update contracts (CONFIRMED via live probes)

**Date confirmed:** February 13, 2026

**Critical finding:** Direct endpoints (`/api/v2/assignments/{id}`, `/api/v2/parts/{id}`)
return 400 Invalid Request. Use **course-scoped** endpoints instead.

#### Assignment settings update

**Endpoint:** `PUT /api/v2/courses/{courseId}/assignments/{assignmentId}`

**Fields that WORK (return 202 with transactionid):**
- `name` — assignment display name (string)
- `description` — assignment description (string)
- `nosubmit` — disable student submissions (boolean)
- `auto_submit` — automatic submission (boolean)
- `grading_on_submit` — grade immediately on submit (boolean)

**Fields that DO NOT WORK:**
- `published` — returns "No valid parameters to update the assignment"
- `points` — returns "No valid parameters to update the assignment"
- `due_date` — returns "No valid parameters to update the assignment"
- `gradespublished` — returns "No valid parameters to update the assignment"

**Note:** Publishing assignments and setting points/due dates appears to require
a different endpoint or workflow not yet documented.

#### Part settings update

**Endpoint:** `PUT /api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}`

**Fields that WORK (return 202 with transactionid):**
- `name` — part display name (string, **required** for most update requests)
- `submission_filters` — student submission filters (object)
  - `include` — array of glob patterns (e.g. `["*.py", "*.txt"]`)
  - `exclude` — array of glob patterns (e.g. `["*.pyc", "__pycache__"]`)
  - `list` — explicit file list (array of filenames)
- `session_length` — lab session length in seconds (string, e.g. `"3600"`)
- `monthly_dollar` — monthly dollar budget for cloud resources (string)
- `monthly_time` — monthly time budget for cloud resources (string)
- `total_time` — total time budget for cloud resources (string)
- `total_dollar` — total dollar budget for cloud resources (string)

**Fields that require org permissions:**
- `cloud_labs` — returns "Cloud not allowed for the org" if org lacks cloud feature
- `instant_aws_access` — likely same restriction as cloud_labs

**Important behaviors:**
1. Updates are asynchronous — response includes `transactionid`
2. Rapid successive requests may fail with "The previous corresponding API request
   is not yet complete" — implement retry with backoff
3. `name` field appears to be required for part updates (missing it causes errors)
4. Verify updates by polling GET endpoint after transaction completes

#### GET endpoints for reading current state

- `GET /api/v2/courses/{courseId}/assignments/{assignmentId}` — returns assignment details
- `GET /api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}` — returns part details

Response includes all fields shown above plus read-only fields like `id`, `courseid`,
`deleted`, `masterid`, `create_method`, `labtype`, `container_image`, etc.

## Data Contract Observations

### 1. ID typing inconsistency risk

- Most API docs/assumptions indicate IDs are strings.
- In assignment list responses, `part_ids` were observed as numeric values.
- We normalize all IDs to strings in our tool to avoid comparison bugs.

### 2. Content-Type inconsistency

- Some successful responses containing JSON were served with `text/html; charset=UTF-8`.
- This can break strict client parsers and content-type guards.

### 3. Error semantics

- Many different invalid states collapse to the same:
  - `400` + `Invalid Request`
- This makes integration significantly harder and increases trial-and-error.

### 4. Download response format inconsistency

- File download responses vary by file type and server behavior:
  - Sometimes raw string content
  - Sometimes a Buffer
  - Sometimes a JSON object with `content`, `data`, `file`, or `base64` fields
- Our implementation attempts all known response shapes and falls back gracefully.

## Implementation Decisions We Applied

Based on confirmed behavior, this project now uses:

- `Authorization: Token <token>`
- `api/v2` route family
- Parts route with course scope:
  - `/api/v2/courses/{cid}/assignments/{aid}/parts`
- Content upload via part PUT:
  - `PUT /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}`
  - With `content[].zipcontent` (base64 ZIP) and `reset: 1`
- Transaction polling:
  - `GET /api/v2/transaction/{txnId}`
  - 30-attempt max, 1s interval
- File listing:
  - `GET /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files?dir=<dir>`
- File download:
  - `GET /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files?dir=<dir>&filename=<path>`
- File deletion (experimental):
  - `DELETE /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files?dir=<dir>&filename=<path>`
- Assignment copy:
  - `POST /api/v2/courses/{cid}/assignments` with `method: "copy"`, `source`, `name`

## Feedback for Vocareum Team (Recommended Improvements)

### 1. Publish official OpenAPI/Swagger spec

- Include exact routes, required params, accepted methods, and request body schemas.
- Mark required vs optional fields per endpoint.

### 2. Improve error detail for write operations

- Replace generic `Invalid Request` with field-level validation details.
- Example:
  - missing `dir`
  - unsupported `type`
  - invalid course/assignment/part scope
  - incorrect content type

### 3. Standardize auth documentation

- Explicitly document accepted header format (e.g., `Authorization: Token ...`).
- Clarify whether Bearer is supported.

### 4. Standardize response content types

- JSON responses should consistently return `Content-Type: application/json`.

### 5. Clarify upload API contract publicly

- The `PUT /parts/{pid}` with `content[].zipcontent` payload is non-obvious.
- Documenting this clearly would save significant integration effort:
  - Exact schema for `content[]` objects
  - Valid `target` values per lab type and scope
  - Max file/payload size limits
  - Exact semantics of `reset` (0 vs 1) and `update` flags
  - Whether multiple `content[]` entries in a single request are supported

### 6. Standardize download response format

- File download via `GET .../files?dir=...&filename=...` returns different shapes depending on context.
- A consistent format (e.g., always base64 in a JSON wrapper, or always raw bytes with Content-Disposition) would simplify clients.

### 7. Improve status code usage

- Distinguish:
  - `401` invalid token
  - `403` token scope mismatch
  - `404` missing resource
  - `422` validation failure

### 8. Add minimal endpoint introspection

- A version/capabilities endpoint would allow safer client auto-detection:
  - supported features (copy/upload/delete/list)
  - API version
  - auth mode

## Reproducible curl Probes

Notes:

- Do not paste real tokens in shared logs.
- Replace placeholders before running.

Setup:

```bash
TOKEN="<your_token>"
CID="201303"
AID="5137423"
PID="5137424"
BASE="https://api.vocareum.com"
```

### 1. Auth format check

```bash
# Expected: 400 + "Missing Token" (Bearer not accepted in our probes)
curl -sS "$BASE/api/v2/courses/$CID" \
  -H "Authorization: Bearer $TOKEN"

# Expected: 200 success (or 403 scope restricted if wrong course)
curl -sS "$BASE/api/v2/courses/$CID" \
  -H "Authorization: Token $TOKEN"
```

### 2. Confirm route family (v1 vs api/v2)

```bash
# Expected: 404
curl -sS -i "$BASE/v1/courses/$CID" \
  -H "Authorization: Token $TOKEN"

# Expected: 200 or 403 depending on token scope
curl -sS -i "$BASE/api/v2/courses/$CID" \
  -H "Authorization: Token $TOKEN"
```

### 3. Working read endpoints

```bash
# Course details
curl -sS "$BASE/api/v2/courses/$CID" \
  -H "Authorization: Token $TOKEN"

# Assignment list
curl -sS "$BASE/api/v2/courses/$CID/assignments" \
  -H "Authorization: Token $TOKEN"

# Parts list
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts" \
  -H "Authorization: Token $TOKEN"
```

### 4. Files endpoint parameter behavior

```bash
# Expected: 400 "Parameter dir or filename must be specified"
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files" \
  -H "Authorization: Token $TOKEN"

# List files in a directory
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files?dir=startercode" \
  -H "Authorization: Token $TOKEN"

# Download specific file
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files?dir=startercode&filename=main.py" \
  -H "Authorization: Token $TOKEN"
```

### 5. Content upload (confirmed working contract)

```bash
# Step 1: Create a ZIP archive and base64-encode it
echo "print('hello from probe')" > /tmp/probe_main.py
cd /tmp && zip probe_upload.zip probe_main.py && cd -
ZIP_B64=$(base64 -w 0 /tmp/probe_upload.zip)

# Step 2: Upload via part PUT
curl -sS -X PUT "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"update\": 1,
    \"content\": [
      {
        \"target\": \"startercode\",
        \"zipcontent\": \"$ZIP_B64\",
        \"reset\": 1
      }
    ]
  }"

# Step 3: If response contains transactionid, poll until complete
# TXN_ID="<transactionid from step 2>"
# curl -sS "$BASE/api/v2/transaction/$TXN_ID" \
#   -H "Authorization: Token $TOKEN"
```

### 6. Assignment copy (confirmed working)

```bash
# Initiate copy
curl -sS -X POST "$BASE/api/v2/courses/$CID/assignments" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method":"copy","source":"'"$AID"'","name":"Probe Copy"}'

# Poll transaction (replace TXN_ID with transactionid from response)
# curl -sS "$BASE/api/v2/transaction/$TXN_ID" \
#   -H "Authorization: Token $TOKEN"
```

### 7. File deletion (experimental)

```bash
# Delete a specific file from a directory
curl -sS -X DELETE "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files?dir=startercode&filename=probe_main.py" \
  -H "Authorization: Token $TOKEN"

# Note: may return 404 or 405 if endpoint is not available
```
