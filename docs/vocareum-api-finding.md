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

Testing covered endpoint discovery, auth behavior, response shape, and request contract probing for read/write operations.

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

## Unresolved / Not Yet Confirmed

### 1. Upload contract

We tested multiple candidate upload patterns, including:

- `POST /api/v2/upload` (multipart + JSON variants)
- `POST/PUT/PATCH /api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files` with combinations of:
  - `type`, `dir`, `filename`
  - raw body vs multipart
  - assignment/course/part IDs in body or query

All tested variants returned:

- `400` with `Invalid Request`

Result: upload endpoint *path likely exists*, but exact payload contract remains undocumented/unclear from black-box probing.

### 1.1 Postman-documented upload/update contract (provided by team)

Per Vocareum Postman example, file/content updates are done via:

- `PUT /api/v2/courses/{courseId}/assignments/{assignmentId}/parts/{partId}`
- Header:
  - `Authorization: Token <token>`
  - `Content-Type: application/json`
- Body includes:
  - `name` (part name)
  - `content` (array)
  - `update` flag

`content[]` item fields:

- `target` (required directory target)
- `url` (optional source URL for zip content)
- `zipcontent` (optional base64 zip archive)
- `reset` (`0` = append/write, `1` = clear target then write)

Observed target sets in provided Postman notes:

- `lib | asnlib | docs | scripts | startercode`
- `course | data | docs | scripts | private | startercode`

Project decision: use `zipcontent` (base64 zip) for deterministic Git -> Vocareum uploads.

### 2. Historical invalid copy variants (for reference)

Before reading Postman collection details, we tested several copy endpoint guesses:

- `POST /api/v2/assignments/{template_id}/copy`
- `POST /api/v2/courses/{cid}/assignments/{template_id}/copy`

These returned `400 Invalid Request` and are not the correct contract.

### 2.1 Confirmed assignment copy contract (Postman + live test)

Confirmed request:

- `POST /api/v2/courses/{courseId}/assignments`
- Body:
  - `method: "copy"`
  - `source: "<source-assignment-id>"`
  - `name: "<new assignment name>"`

Live-tested on `courseId=201303` with `source=5137423`:

- Initial response: `202`, `status=success`, `message=Started`, with `transactionid`.
- Transaction endpoint:
  - `GET /api/v2/transaction/{transactionid}`
  - progresses `pending -> success`
  - on success returns final copied assignment id in `objid`.

Important nuance:

- Initial copy response may include an `objid` placeholder (observed as course id), not final assignment id.
- Client should always poll transaction when `transactionid` is present and trust `objid` from transaction success.

## Data Contract Observations

### 1. ID typing inconsistency risk

- Most API docs/assumptions indicate IDs are strings.
- In assignment list responses, `part_ids` were observed as numeric values.
- We should normalize IDs to strings in our tool to avoid comparison bugs.

### 2. Content-Type inconsistency

- Some successful responses containing JSON were served with `text/html; charset=UTF-8`.
- This can break strict client parsers and content-type guards.

### 3. Error semantics

- Many different invalid states collapse to the same:
  - `400` + `Invalid Request`
- This makes integration significantly harder and increases trial-and-error.

## Implementation Decisions We Applied

Based on confirmed behavior, this project now uses:

- `Authorization: Token <token>`
- `api/v2` route family
- parts route with course scope:
  - `/api/v2/courses/{cid}/assignments/{aid}/parts`
- files list/delete route with course+assignment+part scope and `dir`/`filename` params:
  - `/api/v2/courses/{cid}/assignments/{aid}/parts/{pid}/files`

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

### 5. Clarify upload and copy API contracts

- Upload:
  - canonical endpoint (appears to be part `PUT`, not separate file endpoint)
  - explicit schema for `content[]` objects and `target` enum by lab type
  - max file size and limits
  - per-directory semantics (`startercode/scripts/docs/data`)
  - exact semantics for `reset` and `update`
- Copy:
  - canonical route
  - required payload fields
  - expected response structure (new assignment ID + part IDs)

### 6. Improve status code usage

- Distinguish:
  - `401` invalid token
  - `403` token scope mismatch
  - `404` missing resource
  - `422` validation failure

### 7. Add minimal endpoint introspection

- A version/capabilities endpoint would allow safer client auto-detection:
  - supported features (copy/upload/delete/list)
  - API version
  - auth mode

## Next Recommended Steps for Our Project

1. Validate upload and copy contracts using official Vocareum API examples or direct support guidance.
2. Add integration tests that run against a dedicated sandbox course.
3. Keep API adapter isolated so endpoint contract changes are localized.

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

# Expected: 400 "<dir> doesn't exist" (if dir is missing server-side)
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files?dir=startercode" \
  -H "Authorization: Token $TOKEN"

# Expected: 400 "specified source does not exist <filename>" (if file not present)
curl -sS "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID/files?filename=main.py" \
  -H "Authorization: Token $TOKEN"
```

### 5. Unresolved write contracts (documented failures)

```bash
# Upload candidate (all tested variants currently return 400 Invalid Request)
curl -sS -X POST "$BASE/api/v2/upload" \
  -H "Authorization: Token $TOKEN" \
  -F "courseid=$CID" \
  -F "assignmentid=$AID" \
  -F "partid=$PID" \
  -F "type=startercode" \
  -F "file=@./probe.txt;filename=probe.txt"

# Copy candidate (currently returns 400 Invalid Request in tested variants)
curl -sS -X POST "$BASE/api/v2/courses/$CID/assignments" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method":"copy","source":"'"$AID"'","name":"Probe Copy"}'

# Postman-documented update/content pattern (to validate with real payload)
curl -sS -X PUT "$BASE/api/v2/courses/$CID/assignments/$AID/parts/$PID" \
  -H "Authorization: Token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Part-1",
    "content": [
      {
        "target": "docs",
        "zipcontent": "<base64-zip-bytes>",
        "reset": 1
      }
    ],
    "update": 1
  }'
```
