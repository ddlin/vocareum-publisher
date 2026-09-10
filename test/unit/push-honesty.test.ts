/**
 * push must not report a write that did not happen, and must not advance the
 * state that suppresses a retry of one.
 *
 * Both defects below survived the first fix attempt: stopping the false REPORT
 * left the false STATE, and pruning nothing left a phantom `updated` entry.
 */
import { describe, it, expect, vi } from 'vitest';
import { syncDirectory } from '../../src/core/uploader';
import { deleteFile, uploadContent, listFiles } from '../../src/api/content';
import { CollectingEventSink } from '../../src/core/services/event-sink';

vi.mock('../../src/api/content', () => ({
  deleteFile: vi.fn(),
  uploadContent: vi.fn(),
  listFiles: vi.fn(),
}));

describe('a rejected deletion keeps the directory eligible for retry', () => {
  it('records the failure so content_state cannot advance', async () => {
    // push advances contentState[dir] only when uploadResult.failed is empty.
    // A rejected delete that left `failed` empty let the hash advance, so the
    // next push saw local == stored, never re-planned the directory, and the
    // file that was never removed became permanently invisible.
    vi.mocked(uploadContent).mockResolvedValue({
      succeeded: [], failed: [], directoryHash: 'hash-after-local-change',
    } as unknown as Awaited<ReturnType<typeof uploadContent>>);
    vi.mocked(deleteFile).mockResolvedValue(false);   // API refused
    vi.mocked(listFiles).mockResolvedValue([]);

    const events = new CollectingEventSink();
    const result = await syncDirectory(
      {} as never, 'c1', 'a1', 'p1', 'startercode', {},
      { syncDeletes: true, plannedDeletePaths: ['old.py'] } as never,
      events,
    );

    expect(result.deleted).toEqual([]);            // not claimed
    expect(result.failed.length).toBeGreaterThan(0); // and state cannot advance
    expect(JSON.stringify(result.failed)).toContain('old.py');
  });

  it('a successful deletion is recorded and leaves failed empty', async () => {
    vi.mocked(uploadContent).mockResolvedValue({
      succeeded: [], failed: [], directoryHash: 'h',
    } as unknown as Awaited<ReturnType<typeof uploadContent>>);
    vi.mocked(deleteFile).mockResolvedValue(true);
    vi.mocked(listFiles).mockResolvedValue([]);

    const events = new CollectingEventSink();
    const result = await syncDirectory(
      {} as never, 'c1', 'a1', 'p1', 'startercode', {},
      { syncDeletes: true, plannedDeletePaths: ['old.py'] } as never,
      events,
    );

    expect(result.deleted).toEqual(['old.py']);
    expect(result.failed).toEqual([]);
  });
});
