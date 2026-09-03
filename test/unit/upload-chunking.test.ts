import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  chunkFilesBySize,
  resolveMaxChunkBytes,
  DEFAULT_MAX_CHUNK_BYTES,
  uploadContent,
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
});
