import { describe, it, expect } from 'vitest';
import { RecordingClient } from './recording-client';

describe('RecordingClient', () => {
  it('records method+path, KEEPS query params, returns enqueued responses in order', async () => {
    const c = new RecordingClient();
    c.enqueue({ a: 1 }); c.enqueue({ b: 2 });
    await c.request({ method: 'GET', url: '/courses/1/assignments?page=2&size=10' });
    await c.request({ method: 'PUT', url: '/courses/1' });
    expect(c.sequence()).toEqual(['GET /courses/1/assignments?page=2&size=10', 'PUT /courses/1']);
  });
  it('redacts volatile token params but keeps the key present', async () => {
    const c = new RecordingClient(); c.enqueue({});
    await c.request({ method: 'POST', url: '/oauth/token?client_secret=abc123' });
    expect(c.sequence()).toEqual(['POST /oauth/token?client_secret=<redacted>']);
  });
  it('throws when no response is enqueued', async () => {
    await expect(new RecordingClient().request({ method: 'GET', url: '/x' })).rejects.toThrow(/no enqueued response/i);
  });
});
