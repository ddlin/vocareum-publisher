import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  chunkFilesBySize,
  resolveMaxChunkBytes,
  DEFAULT_MAX_CHUNK_BYTES,
  uploadContent,
  PartialUploadError,
} from '../../src/api/content';
import { VocareumClient } from '../../src/api/client';

const buf = (n: number) => Buffer.alloc(n, 0x61);

describe('chunkFilesBySize', () => {
  it('keeps everything in one chunk when it fits', () => {
    const files = { a: buf(10), b: buf(10) };
    expect(chunkFilesBySize(files, 100)).toEqual([files]);
  });

  it('splits on the cumulative byte budget', () => {
    const chunks = chunkFilesBySize({ a: buf(60), b: buf(60), c: buf(10) }, 100);
    expect(chunks).toHaveLength(2);
    expect(Object.keys(chunks[0])).toEqual(['a']);
    expect(Object.keys(chunks[1])).toEqual(['b', 'c']);
  });

  it('gives an oversized single file its own chunk rather than dropping it', () => {
    // There is no sub-file granularity: the API takes whole files inside a zip.
    const chunks = chunkFilesBySize({ small: buf(10), huge: buf(500) }, 100);
    expect(chunks.map((c) => Object.keys(c))).toEqual([['huge'], ['small']]);
  });

  it('measures string content by byte length, not character count', () => {
    const chunks = chunkFilesBySize({ a: 'é'.repeat(60), b: 'x' }, 100);
    // 60 two-byte chars = 120 bytes, already over budget on its own.
    expect(chunks).toHaveLength(2);
  });

  it('returns a single empty chunk for no files, so the existing throw is preserved', () => {
    // NOT a reset-only clearing path -- no such feature exists. createZipBuffer
    // throws 'Cannot create ZIP: no files provided' on an empty map
    // (src/api/content.ts:269), and uploadDirectory skips empty directories
    // before ever calling uploadContent (src/core/uploader.ts:49). One empty
    // chunk keeps that throw; returning [] would turn it into a silent no-op.
    expect(chunkFilesBySize({}, 100)).toEqual([{}]);
  });

  it('is deterministic across calls', () => {
    const files = { z: buf(30), a: buf(30), m: buf(30) };
    expect(chunkFilesBySize(files, 60)).toEqual(chunkFilesBySize(files, 60));
  });
});

describe('resolveMaxChunkBytes', () => {
  it('defaults when unset', () => {
    expect(resolveMaxChunkBytes({})).toBe(DEFAULT_MAX_CHUNK_BYTES);
  });

  it('honours the env override', () => {
    expect(resolveMaxChunkBytes({ VOCAREUM_MAX_UPLOAD_CHUNK_BYTES: '1048576' })).toBe(1048576);
  });

  it('throws on a non-integer rather than silently clamping', () => {
    expect(() => resolveMaxChunkBytes({ VOCAREUM_MAX_UPLOAD_CHUNK_BYTES: 'big' })).toThrow();
  });
});

describe('uploadContent chunking', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn().mockResolvedValue({ status: 'success' });
    mockClient = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;
  });

  it('sends reset:1 on the first chunk and reset:0 on every later chunk', async () => {
    // Three chunks at a 100-byte budget.
    const files = {
      a: Buffer.alloc(80, 1),
      b: Buffer.alloc(80, 2),
      c: Buffer.alloc(80, 3),
    };
    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', files, { maxChunkBytes: 100 });

    expect(requestMock).toHaveBeenCalledTimes(3);
    const resets = requestMock.mock.calls.map((c) => c[0].data.content[0].reset);
    // Anything other than [1,0,0] deletes earlier chunks: reset:1 clears the
    // target directory before applying the zip.
    expect(resets).toEqual([1, 0, 0]);
  });

  it('still sends a single reset:1 PUT when everything fits in one chunk', async () => {
    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', { a: 'hello' });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0].data.content[0].reset).toBe(1);
  });

  it('reports every file across all chunks as succeeded', async () => {
    const result = await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', {
      a: Buffer.alloc(80, 1),
      b: Buffer.alloc(80, 2),
    }, { maxChunkBytes: 100 });
    expect(result.succeeded.sort()).toEqual(['a', 'b']);
    expect(result.failed).toEqual([]);
  });

  it('waits for each chunk transaction before sending the next', async () => {
    const order: string[] = [];
    requestMock.mockImplementation(async (cfg: { method: string; url: string }) => {
      if (cfg.method === 'PUT') {
        order.push('put');
        return { status: 'success', transactionid: 't1' };
      }
      order.push('poll');
      return { state: 'success' };
    });

    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', {
      a: Buffer.alloc(80, 1),
      b: Buffer.alloc(80, 2),
    }, { maxChunkBytes: 100 });

    // Vocareum serialises part updates; overlapping them is what produced
    // "previous corresponding API request is not yet complete".
    expect(order).toEqual(['put', 'poll', 'put', 'poll']);
  });

  it('gives reset:1 to chunk 0 even when chunk 0 is an oversized file out of sort order', async () => {
    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', {
      zbig: Buffer.alloc(300, 1), // oversized -> emitted as chunk 0 despite sorting last
      a: Buffer.alloc(80, 2),
      b: Buffer.alloc(80, 3),
    }, { maxChunkBytes: 100 });
    const contents = requestMock.mock.calls.map((c) => c[0].data.content[0]);
    expect(contents.map((c) => c.reset)).toEqual([1, 0, 0]);
    // chunk 0 must BE the oversized file and must still carry the reset
    expect(Buffer.from(contents[0].zipcontent, 'base64').toString('latin1')).toContain('zbig');
  });

  it('warns exactly once when every chunk in a multi-chunk upload returns no transaction id', async () => {
    const emitMock = mockClient.events.emit as ReturnType<typeof vi.fn>;
    requestMock.mockResolvedValue({ status: 'success' }); // no transactionid, every chunk

    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', {
      a: Buffer.alloc(80, 1),
      b: Buffer.alloc(80, 2),
    }, { maxChunkBytes: 100 });

    // A server that never returns a transaction id would otherwise repeat this
    // warning once per chunk; it must fire only for the first occurrence.
    const warnings = emitMock.mock.calls
      .map((c) => c[0])
      .filter((e) => e.level === 'warn' && /transaction id/.test(e.message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('Chunk 1 of 2');
  });

  it('emits per-chunk progress for a multi-chunk upload, naming position and file count', async () => {
    const emitMock = mockClient.events.emit as ReturnType<typeof vi.fn>;

    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', {
      a: Buffer.alloc(80, 1),
      b: Buffer.alloc(80, 2),
      c: Buffer.alloc(80, 3),
    }, { maxChunkBytes: 100 });

    const progress = emitMock.mock.calls
      .map((c) => c[0])
      .filter((e) => e.level === 'info' && /^Uploading chunk/.test(e.message));
    expect(progress.map((e) => e.message)).toEqual([
      'Uploading chunk 1 of 3 to docs (1 files)',
      'Uploading chunk 2 of 3 to docs (1 files)',
      'Uploading chunk 3 of 3 to docs (1 files)',
    ]);
  });

  it('emits no per-chunk progress line for a single-chunk upload', async () => {
    const emitMock = mockClient.events.emit as ReturnType<typeof vi.fn>;

    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', { a: 'hello' });

    const progress = emitMock.mock.calls
      .map((c) => c[0])
      .filter((e) => /^Uploading chunk/.test(e.message));
    expect(progress).toHaveLength(0);
  });

  it('does not warn about a missing transaction id for a single-chunk upload', async () => {
    const emitMock = mockClient.events.emit as ReturnType<typeof vi.fn>;
    requestMock.mockResolvedValue({ status: 'success' }); // no transactionid

    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', { a: 'hello' });

    const warnings = emitMock.mock.calls
      .map((c) => c[0])
      .filter((e) => e.level === 'warn');
    expect(warnings).toHaveLength(0);
  });
});

describe('multi-chunk failure reporting', () => {
  it('reports which chunk failed and that the remote directory is now partial', async () => {
    const requestMock = vi.fn()
      .mockResolvedValueOnce({ status: 'success' })            // chunk 1 ok
      .mockRejectedValueOnce(new Error('connection reset'));   // chunk 2 dies
    const client = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;

    await expect(
      uploadContent(client, 'c1', 'a1', 'p1', 'docs', {
        a: Buffer.alloc(80, 1),
        b: Buffer.alloc(80, 2),
      }, { maxChunkBytes: 100 }),
    ).rejects.toThrow(PartialUploadError);
  });

  it('does not wrap a single-chunk failure, which leaves no partial state', async () => {
    const requestMock = vi.fn().mockRejectedValueOnce(new Error('connection reset'));
    const client = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;

    // One chunk that fails is the old all-or-nothing behavior: reset:1 either
    // landed with its content or the directory is untouched.
    await expect(
      uploadContent(client, 'c1', 'a1', 'p1', 'docs', { a: 'hello' }),
    ).rejects.not.toThrow(PartialUploadError);
  });

  it('preserves the original cause as `details` rather than discarding it', async () => {
    const cause = new Error('connection reset');
    const requestMock = vi.fn()
      .mockResolvedValueOnce({ status: 'success' })
      .mockRejectedValueOnce(cause);
    const client = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;

    try {
      await uploadContent(client, 'c1', 'a1', 'p1', 'docs', {
        a: Buffer.alloc(80, 1),
        b: Buffer.alloc(80, 2),
      }, { maxChunkBytes: 100 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PartialUploadError).details).toBe(cause);
    }
  });

  it('describes a chunk-0 failure without claiming a chunk landed before it', async () => {
    const requestMock = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const client = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;

    try {
      await uploadContent(client, 'c1', 'a1', 'p1', 'docs', {
        a: Buffer.alloc(80, 1),
        b: Buffer.alloc(80, 2),
      }, { maxChunkBytes: 100 });
      expect.unreachable('should have thrown');
    } catch (e) {
      const message = (e as Error).message;
      // Chunk 0 has no chunks before it -- the old wording was wrong here.
      expect(message).not.toContain('holds only the chunks before it');
      expect(message).toContain('Re-run');
    }
  });

  it('carries the chunk position in the message', async () => {
    const requestMock = vi.fn()
      .mockResolvedValueOnce({ status: 'success' })
      .mockRejectedValueOnce(new Error('boom'));
    const client = {
      request: requestMock,
      events: { emit: vi.fn() },
    } as unknown as VocareumClient;

    try {
      await uploadContent(client, 'c1', 'a1', 'p1', 'docs', {
        a: Buffer.alloc(80, 1),
        b: Buffer.alloc(80, 2),
      }, { maxChunkBytes: 100 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PartialUploadError);
      expect((e as PartialUploadError).chunkIndex).toBe(1);
      expect((e as PartialUploadError).totalChunks).toBe(2);
      expect((e as Error).message).toContain('PARTIALLY uploaded');
      expect((e as Error).message).toContain('Re-run');
    }
  });
});
