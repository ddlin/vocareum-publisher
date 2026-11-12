/**
 * A push must not claim a deletion that did not happen.
 *
 * deleteFile returned void and swallowed 400/404/405, so syncDirectory pushed
 * every attempt into `deleted` and reported "Deleted N files" -- and the JSON
 * payload agreed -- even when the API had refused every one. Deletion stays
 * non-fatal (AGENTS.md #6); what changed is that it stops lying.
 */
import { describe, it, expect, vi } from 'vitest';
import { deleteFile } from '../../src/api/content';
import { APIError, NotFoundError } from '../../src/api/client';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { collectDiagnostics } from '../../src/core/diagnostics';

function clientThatFailsWith(error: unknown): { client: never; events: CollectingEventSink } {
  const events = new CollectingEventSink();
  const client = { request: vi.fn().mockRejectedValue(error), events } as unknown as never;
  return { client, events };
}

const call = (client: never) =>
  deleteFile(client, 'c1', 'a1', 'p1', 'startercode', 'old.py', 'container');

describe('deleteFile reports whether the file is actually gone', () => {
  it('returns true on a successful delete', async () => {
    const events = new CollectingEventSink();
    const client = { request: vi.fn().mockResolvedValue({}), events } as unknown as never;
    await expect(call(client)).resolves.toBe(true);
  });

  it('returns true on 404 — already absent IS the desired end state', async () => {
    const { client } = clientThatFailsWith(new NotFoundError('file', 'old.py'));
    await expect(call(client)).resolves.toBe(true);
  });

  it('returns FALSE on 405 — the API refused and the file is still there', async () => {
    const { client, events } = clientThatFailsWith(new APIError('not allowed', 405));
    await expect(call(client)).resolves.toBe(false);
    const diagnostics = collectDiagnostics(events.drain());
    const found = diagnostics.find((d) => d.code === 'delete_sync_failed');
    expect(found, 'no delete_sync_failed diagnostic').toBeDefined();
    expect(found?.data?.status_code).toBe(405);
    expect(found?.data?.path).toBe('old.py');
  });

  it('returns FALSE on 400 and says the file is still present', async () => {
    const { client, events } = clientThatFailsWith(new APIError('bad request', 400));
    await expect(call(client)).resolves.toBe(false);
    expect(events.drain().some((e) => (e.message ?? '').includes('still present'))).toBe(true);
  });

  it('does not throw on an unexpected error — deletion stays non-fatal', async () => {
    const { client, events } = clientThatFailsWith(new Error('socket hang up'));
    await expect(call(client)).resolves.toBe(false);
    expect(collectDiagnostics(events.drain()).some((d) => d.code === 'delete_sync_failed')).toBe(true);
  });
});
