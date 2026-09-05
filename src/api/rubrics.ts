/**
 * Rubric Operations
 *
 * API operations for Vocareum rubrics — the per-criterion grading breakdown.
 *
 * CRITICAL: All IDs are strings!
 * CRITICAL: seqnum is a STRING that must be parsed for sorting!
 *
 * Rubrics are PART-scoped. Assignment-level (`/assignments/{a}/rubrics`),
 * collection-level (`/courses/{c}/rubrics`) and singular (`.../rubric`)
 * variants all return `Invalid Request` — verified 2026-09-03.
 *
 * The rubrics token permission is OPTIONAL at token creation (see README
 * "Required Permissions"), so a 403 here means "this token lacks the scope"
 * far more often than "no access to this course". Callers must treat that as
 * a degradation, not a failure — see src/core/services/rubric-fetcher.ts.
 */

import { VocareumClient, APIError } from './client';
import type { VocareumRubricResponse, RubricsListResponse, RubricCreate, RubricUpdate } from '../types/api';

/**
 * Parse one page's `total_records` field for the pagination guard below.
 *
 * `total_records` is declared `number | string | undefined` — a numeric
 * string (e.g. `"5"`) is the real API shape and must parse cleanly. Absent
 * means "the server didn't report a total" and is treated as 0, the same as
 * always (a part with genuinely no rubrics is a normal response). But a
 * field that IS present and does not parse to a finite, non-negative number
 * (e.g. `"unknown"`, or a negative value) must not silently become 0 either:
 * `Number("unknown")` is `NaN`, and every comparison against `NaN` is
 * false, which would defeat both the `more` check and the post-loop
 * shortfall guard and let a malformed response return an empty/short list
 * as though it were the complete, authoritative one — deleting the user's
 * local rubrics. Throw instead.
 */
function parseTotalRecords(value: number | string | undefined, partId: string): number {
  if (value === undefined) { return 0; }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new APIError(
      `Rubrics request for part ${partId} returned a malformed total_records value: ${JSON.stringify(value)}`,
      undefined,
      { partId, total_records: value }
    );
  }
  return parsed;
}

/**
 * List all rubric criteria for a part, across all pages, ordered by seqnum.
 *
 * Pagination mirrors listAssignments: zero-based `page` plus `size`, driven by
 * `total_records`. The seen-id guard is the difference — if the endpoint turns
 * out to ignore `page` and re-serve the first page, the loop terminates on the
 * repeat instead of accumulating duplicates until it outruns total_records.
 * Duplicates matter more here than elsewhere: a future push reconciles against
 * this list, and a phantom row is a row something could try to delete.
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @param partId - Part ID (string!)
 * @returns Rubric criteria sorted by parseInt(seqnum)
 * @throws ForbiddenError if the token lacks the rubrics scope
 * @throws APIError if the response body reports a non-success status
 * @throws APIError if a present `total_records` does not parse to a finite,
 *   non-negative number (an absent field is treated as 0, not an error)
 * @throws APIError if fewer rows were received than the highest `total_records`
 *   reported across the walk (unless that maximum is 0, the genuine-empty
 *   case) — a short read must never be mistaken for a complete list, see the
 *   shortfall check below
 */
export async function listRubrics(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string
): Promise<VocareumRubricResponse[]> {
  const all: VocareumRubricResponse[] = [];
  const seen = new Set<string>();
  let page = 0;
  let more = true;
  let maxTotalRecords = 0;

  while (more) {
    const response = await client.request<RubricsListResponse>({
      method: 'GET',
      url: `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/rubrics`,
      params: { page, size: 100 },
    });

    // Vocareum encodes some failures in the body with a 200 status line — see
    // src/api/content.ts:257 for the same pattern. A non-success status must
    // never be treated as "this part has no rubrics": the pull apply path
    // treats an empty remote list as authoritative and DELETES the local
    // rubrics, so a body-encoded failure has to surface as an error instead
    // of silently producing an empty page. Throw instead; the fetcher turns
    // it into `undefined`, which means "unknown" and changes nothing.
    if (response.status !== 'success') {
      throw new APIError(
        `Rubrics request for part ${partId} returned a non-success status`,
        undefined,
        response
      );
    }

    const rubrics = response.rubrics ?? [];
    let added = 0;
    for (const rubric of rubrics) {
      if (seen.has(rubric.id)) { continue; }
      seen.add(rubric.id);
      all.push(rubric);
      added++;
    }

    // Track the largest total_records seen across the walk, not just this
    // page's — see the shortfall check below for why the last page's value
    // is not safe to compare against. parseTotalRecords also rejects a
    // present-but-unparseable value (e.g. "unknown", a negative number)
    // rather than letting it silently become 0 via NaN comparisons.
    const pageTotal = parseTotalRecords(response.total_records, partId);
    if (pageTotal > maxTotalRecords) { maxTotalRecords = pageTotal; }
    more = all.length < maxTotalRecords && added > 0;
    page += 1;
  }

  // A short list is never safe to treat as authoritative here: the pull apply
  // path deletes a part's local rubrics when the remote list is empty, and
  // replaces it wholesale otherwise. This pagination has never been exercised
  // against the live API — the zero-based `page` param is an inference from
  // listAssignments, not a verified fact — so a short read (an empty
  // `status: 'success'` page against a nonzero total_records, a one-based
  // endpoint returning nothing for page=0, or the seen-id guard tripping
  // before total_records was reached) must throw rather than return fewer
  // rows than the server reported. The check is against `maxTotalRecords` —
  // the HIGHEST total_records reported by any page during the walk, not the
  // last one — because a later page reporting a smaller (or zero) total must
  // not be allowed to retroactively relax the guard a larger earlier page
  // already established; a server that does that would otherwise have its
  // short read accepted as complete. `maxTotalRecords === 0` (every page
  // either omitted the field or genuinely reported 0) is the one case where
  // a short (empty) list is the genuine, complete answer.
  if (all.length < maxTotalRecords) {
    throw new APIError(
      `Rubrics request for part ${partId} returned ${all.length} of ${maxTotalRecords} ` +
      'reported rows; refusing to treat a short read as the complete list',
      undefined,
      { partId, received: all.length, totalRecords: maxTotalRecords }
    );
  }

  return all.sort((a, b) => parseInt(a.seqnum, 10) - parseInt(b.seqnum, 10));
}

/**
 * Normalize one API rubric row to the string-typed shape the rest of vocgit assumes.
 *
 * POST responses have been observed returning `id` and `seqnum` as NUMBERS while GET
 * returns both as strings. This function coerces numbers and numeric strings to strings,
 * but throws APIError if either field is missing, null, or undefined — those are genuine
 * API anomalies, not shape variations. AGENTS.md constraint 1 requires ids to be strings
 * everywhere downstream; a fabricated "undefined" id would silently flow into the config.
 *
 * @throws APIError if `id` or `seqnum` is missing, null, or undefined
 */
function normalizeRubricRow(row: VocareumRubricResponse): VocareumRubricResponse {
  if (row.id === null || row.id === undefined) {
    throw new APIError(
      'Rubrics response row missing or null id',
      undefined,
      row
    );
  }
  if (row.seqnum === null || row.seqnum === undefined) {
    throw new APIError(
      'Rubrics response row missing or null seqnum',
      undefined,
      row
    );
  }
  return { ...row, id: String(row.id), seqnum: String(row.seqnum) };
}

async function writeRubrics(
  client: VocareumClient,
  method: 'POST' | 'PUT',
  courseId: string,
  assignmentId: string,
  partId: string,
  rows: RubricCreate[] | RubricUpdate[],
  verb: string
): Promise<VocareumRubricResponse[]> {
  if (rows.length === 0) { return []; }

  const response = await client.request<RubricsListResponse>({
    method,
    url: `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/rubrics`,
    data: { rubrics: rows },
  });

  // Same body-encoded-failure guard as listRubrics. A write reported as success that did
  // nothing is worse here than a thrown error: the caller would record a migration that
  // never happened, and max_points would silently stay wrong.
  if (response.status !== 'success') {
    throw new APIError(
      `Rubrics ${verb} for part ${partId} returned a non-success status`,
      undefined,
      response
    );
  }

  return (response.rubrics ?? []).map(normalizeRubricRow);
}

/**
 * Create rubric criteria on a part. One batched request.
 *
 * @throws APIError if the response body reports a non-success status
 */
export async function createRubrics(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  rubrics: RubricCreate[]
): Promise<VocareumRubricResponse[]> {
  return writeRubrics(client, 'POST', courseId, assignmentId, partId, rubrics, 'create');
}

/**
 * Update rubric criteria on a part, keyed by server id. Partial — omitted fields are
 * preserved. One batched request.
 *
 * @throws APIError if the response body reports a non-success status
 */
export async function updateRubrics(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  updates: RubricUpdate[]
): Promise<VocareumRubricResponse[]> {
  return writeRubrics(client, 'PUT', courseId, assignmentId, partId, updates, 'update');
}
