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
import type { VocareumRubricResponse, RubricsListResponse } from '../types/api';

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
 * @throws APIError if fewer rows were received than `total_records` reported
 *   (unless `total_records` is 0, the genuine-empty case) — a short read must
 *   never be mistaken for a complete list, see the shortfall check below
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
  let totalRecords = 0;

  while (more) {
    const response = await client.request<RubricsListResponse>({
      method: 'GET',
      url: `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/rubrics`,
      params: { page, size: 100 },
    });

    // Vocareum encodes some failures in the body with a 200 status line — see
    // src/api/content.ts:257 for the same pattern. Defaulting a missing `rubrics`
    // key to [] would turn such a response into "this part has no rubrics", and
    // the pull apply path treats an empty remote list as authoritative and DELETES
    // the local rubrics. Throw instead; the fetcher turns it into `undefined`,
    // which means "unknown" and changes nothing.
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

    totalRecords = Number(response.total_records ?? 0);
    more = all.length < totalRecords && added > 0;
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
  // rows than the server reported. `totalRecords === 0` is the one case where
  // a short (empty) list is the genuine, complete answer.
  if (all.length < totalRecords) {
    throw new APIError(
      `Rubrics request for part ${partId} returned ${all.length} of ${totalRecords} ` +
      'reported rows; refusing to treat a short read as the complete list',
      undefined,
      { partId, received: all.length, totalRecords }
    );
  }

  return all.sort((a, b) => parseInt(a.seqnum, 10) - parseInt(b.seqnum, 10));
}
