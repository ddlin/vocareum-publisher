import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRubricFetcher } from '../../src/core/services/rubric-fetcher';
import { VocareumClient, ForbiddenError, APIError } from '../../src/api/client';

describe('createRubricFetcher', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;
  let warnings: string[];
  const warnFn = (msg: string): void => { warnings.push(msg); };

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = { request: requestMock } as unknown as VocareumClient;
    warnings = [];
  });

  it('returns mapped rubrics on success', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      rubrics: [{ id: '1', name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false }],
      total_records: 1,
    });

    const fetcher = createRubricFetcher(mockClient, 'c', true, warnFn);

    expect(await fetcher.fetch('a', 'p')).toEqual([
      { name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false },
    ]);
    expect(warnings).toEqual([]);
  });

  it('returns undefined without calling the API when disabled', async () => {
    const fetcher = createRubricFetcher(mockClient, 'c', false, warnFn);

    expect(await fetcher.fetch('a', 'p')).toBeUndefined();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('warns once on 403 and stops calling the API for the rest of the run', async () => {
    requestMock.mockRejectedValue(new ForbiddenError('Access Forbidden', 'part'));

    const fetcher = createRubricFetcher(mockClient, 'c', true, warnFn);

    expect(await fetcher.fetch('a', 'p1')).toBeUndefined();
    expect(await fetcher.fetch('a', 'p2')).toBeUndefined();
    expect(await fetcher.fetch('a', 'p3')).toBeUndefined();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('rubrics');
  });

  it('never throws on a non-403 error, and keeps trying other parts', async () => {
    requestMock
      .mockRejectedValueOnce(new APIError('Internal Server Error', 500))
      .mockResolvedValueOnce({
        status: 'success',
        rubrics: [{ id: '1', name: 'A', seqnum: '1', maxscore: '10' }],
        total_records: 1,
      });

    const fetcher = createRubricFetcher(mockClient, 'c', true, warnFn);

    expect(await fetcher.fetch('a', 'p1')).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('p1');

    expect(await fetcher.fetch('a', 'p2')).toHaveLength(1);
  });
});

describe('rubric read failures are machine-readable', () => {
  it('a failed read emits rubric_read_failed with part_id and reason', async () => {
    const { createRubricFetcher: create } = await import('../../src/core/services/rubric-fetcher');
    const { APIError: ApiErr, ForbiddenError: Forbidden } = await import('../../src/api/client');
    const seen: Array<{ code: string; data: Record<string, unknown> } | undefined> = [];
    const client = { request: vi.fn()
      .mockRejectedValueOnce(new ApiErr('Internal Server Error', 500))
      .mockRejectedValueOnce(new Forbidden('Access Forbidden', 'part')) } as never;
    const fetcher = create(client, 'c', true, (_m, d) => { seen.push(d); });
    await fetcher.fetch('a', 'p1');
    await fetcher.fetch('a', 'p2');
    expect(seen[0]).toMatchObject({ code: 'rubric_read_failed', data: { part_id: 'p1' } });
    expect(seen[1]).toMatchObject({ code: 'rubric_read_failed', data: { part_id: 'p2', reason: 'forbidden' } });
  });
});
