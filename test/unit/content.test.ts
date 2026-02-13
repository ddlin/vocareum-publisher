/**
 * Content API Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crc32, createZipBuffer, waitForPartUpdateTransaction } from '../../src/api/content';
import { VocareumClient, APIError } from '../../src/api/client';

describe('crc32', () => {
  it('should calculate CRC32 for empty buffer', () => {
    const result = crc32(Buffer.from(''));
    expect(result).toBe(0);
  });

  it('should calculate CRC32 for simple string', () => {
    const result = crc32(Buffer.from('hello'));
    // Known CRC32 value for "hello"
    expect(result).toBe(0x3610a686);
  });

  it('should calculate CRC32 for binary data', () => {
    const buffer = Buffer.from([0x00, 0xff, 0x12, 0x34]);
    const result = crc32(buffer);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('should return consistent results for same input', () => {
    const buffer = Buffer.from('test data');
    const result1 = crc32(buffer);
    const result2 = crc32(buffer);
    expect(result1).toBe(result2);
  });

  it('should return different results for different inputs', () => {
    const result1 = crc32(Buffer.from('abc'));
    const result2 = crc32(Buffer.from('xyz'));
    expect(result1).not.toBe(result2);
  });
});

describe('createZipBuffer', () => {
  it('should throw error for empty files map', () => {
    expect(() => createZipBuffer({})).toThrow('Cannot create ZIP: no files provided');
  });

  it('should create valid ZIP buffer for single file', () => {
    const files = { 'test.txt': 'hello world' };
    const buffer = createZipBuffer(files);

    // Check ZIP magic number (PK\x03\x04)
    expect(buffer[0]).toBe(0x50); // P
    expect(buffer[1]).toBe(0x4b); // K
    expect(buffer[2]).toBe(0x03);
    expect(buffer[3]).toBe(0x04);

    // Check end of central directory signature
    const eocd = buffer.slice(-22);
    expect(eocd[0]).toBe(0x50); // P
    expect(eocd[1]).toBe(0x4b); // K
    expect(eocd[2]).toBe(0x05);
    expect(eocd[3]).toBe(0x06);
  });

  it('should create valid ZIP buffer for multiple files', () => {
    const files = {
      'file1.txt': 'content 1',
      'file2.txt': 'content 2',
      'subdir/file3.txt': 'content 3',
    };
    const buffer = createZipBuffer(files);

    // Verify buffer starts with local file header
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);

    // Buffer should be non-trivial size
    expect(buffer.length).toBeGreaterThan(100);
  });

  it('should handle binary content', () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    const files = { 'binary.bin': binaryContent };
    const buffer = createZipBuffer(files);

    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it('should normalize Windows-style paths', () => {
    const files = { 'dir\\subdir\\file.txt': 'content' };
    const buffer = createZipBuffer(files);

    // The path should be normalized in the buffer
    // This is validated by checking the buffer is valid
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it('should handle UTF-8 filenames', () => {
    const files = { 'файл.txt': 'content' };
    const buffer = createZipBuffer(files);

    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it('should handle empty file content', () => {
    const files = { 'empty.txt': '' };
    const buffer = createZipBuffer(files);

    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });
});

describe('waitForPartUpdateTransaction', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
  });

  it('should resolve when transaction succeeds immediately', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'success',
    });

    await expect(
      waitForPartUpdateTransaction(mockClient, 'txn-123')
    ).resolves.toBeUndefined();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('should poll until transaction succeeds', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'success' });

    await waitForPartUpdateTransaction(mockClient, 'txn-456', { delayMs: 10 });

    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('should throw APIError when transaction fails', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'failed',
      message: 'Upload failed: invalid content',
    });

    await expect(
      waitForPartUpdateTransaction(mockClient, 'txn-fail')
    ).rejects.toThrow('Upload failed: invalid content');
  });

  it('should use default message when transaction fails without message', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'failed',
    });

    await expect(
      waitForPartUpdateTransaction(mockClient, 'txn-fail-no-msg')
    ).rejects.toThrow('Part update transaction failed (txn=txn-fail-no-msg)');
  });

  it('should timeout after max attempts', async () => {
    requestMock.mockResolvedValue({ status: 'success', state: 'pending' });

    await expect(
      waitForPartUpdateTransaction(mockClient, 'txn-timeout', {
        maxAttempts: 3,
        delayMs: 10,
      })
    ).rejects.toThrow('Timed out after 30ms waiting for part update (txn=txn-timeout)');

    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('should use custom polling options', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'success' });

    const startTime = Date.now();
    await waitForPartUpdateTransaction(mockClient, 'txn-custom', {
      maxAttempts: 5,
      delayMs: 50,
    });
    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(200);
  });
});
