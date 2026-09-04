import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listRubrics } from '../../src/api/rubrics';
import { VocareumClient } from '../../src/api/client';

describe('listRubrics', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = { request: requestMock } as unknown as VocareumClient;
  });

  it('requests the part-scoped rubrics endpoint', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success', rubrics: [], total_records: 0 });

    await listRubrics(mockClient, '227714', '5745796', '5745862');

    expect(requestMock).toHaveBeenCalledWith({
      method: 'GET',
      url: '/courses/227714/assignments/5745796/parts/5745862/rubrics',
      params: { page: 0, size: 100 },
    });
  });

  it('sorts by seqnum numerically, not lexically', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      rubrics: [
        { id: '3', name: 'ten', seqnum: '10', maxscore: '1' },
        { id: '1', name: 'two', seqnum: '2', maxscore: '1' },
      ],
      total_records: 2,
    });

    const result = await listRubrics(mockClient, 'c', 'a', 'p');

    expect(result.map(r => r.name)).toEqual(['two', 'ten']);
  });

  it('follows pagination until total_records is reached', async () => {
    requestMock
      .mockResolvedValueOnce({
        status: 'success',
        rubrics: [{ id: '1', name: 'a', seqnum: '1', maxscore: '5' }],
        total_records: 2,
      })
      .mockResolvedValueOnce({
        status: 'success',
        rubrics: [{ id: '2', name: 'b', seqnum: '2', maxscore: '5' }],
        total_records: 2,
      });

    const result = await listRubrics(mockClient, 'c', 'a', 'p');

    expect(result).toHaveLength(2);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1][0].params).toEqual({ page: 1, size: 100 });
  });

  it('stops accumulating duplicates when the API ignores page and re-serves the same rows, then throws on the resulting shortfall', async () => {
    // The seen-id guard still prevents an infinite/duplicated accumulation, but
    // the result (1 row against a reported 50) is exactly the short-read shape
    // that must not be handed to callers as a complete list — see the
    // shortfall check in listRubrics.
    const samePage = {
      status: 'success',
      rubrics: [{ id: '1', name: 'a', seqnum: '1', maxscore: '5' }],
      total_records: 50,
    };
    requestMock.mockResolvedValue(samePage);

    await expect(listRubrics(mockClient, 'c', 'a', 'p')).rejects.toThrow(/1 of 50/);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('returns an empty array when the part genuinely has no rubrics', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success', total_records: 0 });

    expect(await listRubrics(mockClient, 'c', 'a', 'p')).toEqual([]);
  });

  it('throws rather than reporting "no rubrics" when the body reports an error', async () => {
    // A body-encoded error must not read as an authoritative empty remote list —
    // the pull apply path would delete the part's local rubrics.
    requestMock.mockResolvedValueOnce({ status: 'error', message: 'Invalid Request' });

    await expect(listRubrics(mockClient, 'c', 'a', 'p')).rejects.toThrow();
  });

  it('throws instead of returning an authoritative empty list when a success page reports rows but returns none', async () => {
    // A `status: 'success'` page with total_records > 0 but zero rubrics on the
    // page must not be treated as "this part has no rubrics" — that would flow
    // into the config write and delete the user's parts[].rubrics.
    requestMock.mockResolvedValueOnce({ status: 'success', rubrics: [], total_records: 5 });

    await expect(listRubrics(mockClient, 'c', 'a', 'p')).rejects.toThrow(/0 of 5/);
  });

  // A full page (added > 0) with no `total_records` field is indistinguishable
  // from a genuine one-page, complete response: `more` becomes
  // `all.length < 0 && added > 0` = false, so the loop stops after page 0 with
  // exactly the rows the (only) page returned, and totalRecords defaults to 0,
  // which satisfies `all.length < totalRecords` as false. There is no signal
  // available to tell "the server just omitted the field on a complete
  // response" apart from "the server omitted it on a truncated response" — a
  // one-based endpoint returning a full page-0-equivalent under a zero-based
  // request would look identical. We accept the response as complete rather
  // than throwing on every request against a server that never populates
  // total_records, since that would make rubrics unusable for such servers;
  // the risk this leaves open is bounded by the fact that the shortfall guard
  // above still catches any case where total_records IS reported honestly.
  it('accepts a full page with no total_records as complete (cannot be distinguished from a genuine one-page response)', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      rubrics: [{ id: '1', name: 'a', seqnum: '1', maxscore: '5' }],
    });

    const result = await listRubrics(mockClient, 'c', 'a', 'p');

    expect(result).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
