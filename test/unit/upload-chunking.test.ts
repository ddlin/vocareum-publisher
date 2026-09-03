import { describe, it, expect } from 'vitest';
import {
  chunkFilesBySize,
  resolveMaxChunkBytes,
  DEFAULT_MAX_CHUNK_BYTES,
} from '../../src/api/content';

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
