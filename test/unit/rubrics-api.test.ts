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

  it('stops instead of duplicating when the API ignores page and re-serves the same rows', async () => {
    const samePage = {
      status: 'success',
      rubrics: [{ id: '1', name: 'a', seqnum: '1', maxscore: '5' }],
      total_records: 50,
    };
    requestMock.mockResolvedValue(samePage);

    const result = await listRubrics(mockClient, 'c', 'a', 'p');

    expect(result).toHaveLength(1);
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
});
