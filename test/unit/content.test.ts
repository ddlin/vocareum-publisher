/**
 * Content API Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  crc32,
  createZipBuffer,
  waitForPartUpdateTransaction,
  uploadContent,
  listFiles,
  deleteFile,
  downloadContent,
} from '../../src/api/content';
import { VocareumClient, VocareumError } from '../../src/api/client';

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

  it('should sort entries by path for deterministic output', () => {
    const files1 = { 'b.txt': 'B', 'a.txt': 'A', 'c.txt': 'C' };
    const files2 = { 'c.txt': 'C', 'a.txt': 'A', 'b.txt': 'B' };
    const buffer1 = createZipBuffer(files1);
    const buffer2 = createZipBuffer(files2);

    expect(buffer1.equals(buffer2)).toBe(true);
  });

  it('should encode correct file count in end of central directory', () => {
    const files = {
      'a.txt': 'a',
      'b.txt': 'b',
      'c.txt': 'c',
    };
    const buffer = createZipBuffer(files);

    // EOCD record: last 22 bytes, file count at offset 8 (little-endian uint16)
    const eocd = buffer.slice(-22);
    const fileCount = eocd.readUInt16LE(8);
    expect(fileCount).toBe(3);
  });

  it('should embed correct CRC32 in local file headers', () => {
    const content = 'hello world';
    const files = { 'test.txt': content };
    const buffer = createZipBuffer(files);

    // CRC32 is at offset 14 in the local file header
    const embeddedCrc = buffer.readUInt32LE(14);
    const expectedCrc = crc32(Buffer.from(content, 'utf8'));
    expect(embeddedCrc).toBe(expectedCrc);
  });

  it('should set compressed and uncompressed sizes equal (no compression)', () => {
    const content = 'test content for size check';
    const files = { 'size.txt': content };
    const buffer = createZipBuffer(files);

    // Compressed size at offset 18, uncompressed at offset 22
    const compressedSize = buffer.readUInt32LE(18);
    const uncompressedSize = buffer.readUInt32LE(22);
    expect(compressedSize).toBe(uncompressedSize);
    expect(compressedSize).toBe(Buffer.from(content, 'utf8').length);
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

  it('should call correct transaction endpoint', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success', state: 'success' });

    await waitForPartUpdateTransaction(mockClient, 'txn-abc-123');

    expect(requestMock).toHaveBeenCalledWith({
      method: 'GET',
      url: '/api/v2/transaction/txn-abc-123',
    });
  });
});

describe('uploadContent', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
  });

  it('should send PUT request with correct URL and payload shape', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success' });

    const files = { 'main.py': 'print("hello")' };
    await uploadContent(mockClient, '201303', '5137423', '5137424', 'startercode', files);

    expect(requestMock).toHaveBeenCalledTimes(1);
    const callArgs = requestMock.mock.calls[0][0];
    expect(callArgs.method).toBe('PUT');
    expect(callArgs.url).toBe('/api/v2/courses/201303/assignments/5137423/parts/5137424');
    expect(callArgs.timeout).toBe(60000);
    expect(callArgs.data.update).toBe(1);
    expect(callArgs.data.content).toHaveLength(1);
    expect(callArgs.data.content[0].target).toBe('startercode');
    expect(callArgs.data.content[0].reset).toBe(1);
    expect(typeof callArgs.data.content[0].zipcontent).toBe('string');
  });

  it('should send valid base64-encoded ZIP in zipcontent', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success' });

    const files = { 'test.txt': 'hello' };
    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', files);

    const zipcontent = requestMock.mock.calls[0][0].data.content[0].zipcontent;

    // Should be valid base64
    const decoded = Buffer.from(zipcontent, 'base64');
    expect(decoded.length).toBeGreaterThan(0);

    // Should start with ZIP magic number
    expect(decoded[0]).toBe(0x50);
    expect(decoded[1]).toBe(0x4b);
    expect(decoded[2]).toBe(0x03);
    expect(decoded[3]).toBe(0x04);
  });

  it('should return succeeded file list on sync success', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success' });

    const files = { 'a.py': 'a', 'b.py': 'b' };
    const result = await uploadContent(mockClient, 'c1', 'a1', 'p1', 'startercode', files);

    expect(result.succeeded).toEqual(['a.py', 'b.py']);
    expect(result.failed).toEqual([]);
  });

  it('should poll transaction when transactionid is returned', async () => {
    requestMock
      .mockResolvedValueOnce({ status: 'success', transactionid: 'txn-upload-1' })
      .mockResolvedValueOnce({ status: 'success', state: 'pending' })
      .mockResolvedValueOnce({ status: 'success', state: 'success' });

    const files = { 'file.txt': 'content' };
    const result = await uploadContent(mockClient, 'c1', 'a1', 'p1', 'scripts', files);

    expect(requestMock).toHaveBeenCalledTimes(3);
    // Second call should be the transaction poll
    expect(requestMock.mock.calls[1][0].url).toBe('/api/v2/transaction/txn-upload-1');
    expect(result.succeeded).toEqual(['file.txt']);
  });

  it('should not poll when transactionid is empty string', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success', transactionid: '' });

    const files = { 'file.txt': 'content' };
    await uploadContent(mockClient, 'c1', 'a1', 'p1', 'data', files);

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('should throw on direct failure response', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'failed',
      message: 'Invalid target directory',
    });

    const files = { 'file.txt': 'content' };
    await expect(
      uploadContent(mockClient, 'c1', 'a1', 'p1', 'startercode', files)
    ).rejects.toThrow('Invalid target directory');
  });

  it('should throw default message on failure without message', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'failed',
    });

    const files = { 'file.txt': 'content' };
    await expect(
      uploadContent(mockClient, 'c1', 'a1', 'p1', 'docs', files)
    ).rejects.toThrow('Part update failed (part=p1, dir=docs)');
  });

  it('should handle multiple files in a single upload', async () => {
    requestMock.mockResolvedValueOnce({ status: 'success' });

    const files = {
      'src/main.py': 'import os',
      'src/utils.py': 'def helper(): pass',
      'README.md': '# Project',
      'data/sample.csv': 'a,b,c\n1,2,3',
    };

    const result = await uploadContent(mockClient, 'c1', 'a1', 'p1', 'startercode', files);

    expect(result.succeeded).toHaveLength(4);
    // All files in a single ZIP, single request
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('should use correct target for different directory types', async () => {
    requestMock.mockResolvedValue({ status: 'success' });

    const files = { 'file.txt': 'content' };
    const targets = ['startercode', 'scripts', 'docs', 'data'] as const;

    for (const target of targets) {
      requestMock.mockClear();
      await uploadContent(mockClient, 'c1', 'a1', 'p1', target, files);
      expect(requestMock.mock.calls[0][0].data.content[0].target).toBe(target);
    }
  });
});

describe('listFiles', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
  });

  it('should call correct endpoint with dir param', async () => {
    requestMock.mockResolvedValueOnce({ files: [] });

    await listFiles(mockClient, 'c1', 'a1', 'p1', 'startercode');

    expect(requestMock).toHaveBeenCalledWith({
      method: 'GET',
      url: '/api/v2/courses/c1/assignments/a1/parts/p1/files',
      params: { dir: 'startercode' },
    });
  });

  it('should return files array from response', async () => {
    const mockFiles = [
      { path: 'main.py', size: 120 },
      { path: 'utils.py', size: 80, modifiedAt: '2026-01-01' },
    ];
    requestMock.mockResolvedValueOnce({ files: mockFiles });

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'scripts');

    expect(result).toEqual(mockFiles);
  });

  it('should return empty array when files field is missing', async () => {
    requestMock.mockResolvedValueOnce({});

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'docs');

    expect(result).toEqual([]);
  });

  it('should return empty array on error (graceful fallback)', async () => {
    requestMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'data');

    expect(result).toEqual([]);
  });
});

describe('deleteFile', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
  });

  it('should call DELETE with correct params', async () => {
    requestMock.mockResolvedValueOnce({});

    await deleteFile(mockClient, 'c1', 'a1', 'p1', 'startercode', 'old-file.py');

    expect(requestMock).toHaveBeenCalledWith({
      method: 'DELETE',
      url: '/api/v2/courses/c1/assignments/a1/parts/p1/files',
      params: {
        dir: 'startercode',
        filename: 'old-file.py',
      },
    });
  });

  it('should handle 404 gracefully (file not found)', async () => {
    const error = new VocareumError('Not found', 'NOT_FOUND', 404);
    requestMock.mockRejectedValueOnce(error);

    // Should not throw
    await expect(deleteFile(mockClient, 'c1', 'a1', 'p1', 'docs', 'missing.txt')).resolves.toBeUndefined();
  });

  it('should handle 405 gracefully (method not allowed)', async () => {
    const error = new VocareumError('Method Not Allowed', 'API_ERROR', 405);
    requestMock.mockRejectedValueOnce(error);

    // Should not throw
    await expect(deleteFile(mockClient, 'c1', 'a1', 'p1', 'scripts', 'file.sh')).resolves.toBeUndefined();
  });

  it('should rethrow non-404/405 VocareumErrors', async () => {
    const error = new VocareumError('Server error', 'API_ERROR', 500);
    requestMock.mockRejectedValueOnce(error);

    await expect(
      deleteFile(mockClient, 'c1', 'a1', 'p1', 'data', 'file.csv')
    ).rejects.toThrow('Server error');
  });

  it('should rethrow non-VocareumError errors', async () => {
    requestMock.mockRejectedValueOnce(new Error('Connection failed'));

    await expect(
      deleteFile(mockClient, 'c1', 'a1', 'p1', 'startercode', 'file.py')
    ).rejects.toThrow('Connection failed');
  });
});

describe('downloadContent', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
  });

  it('should iterate directories and download each file', async () => {
    // listFiles calls for each directory
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'main.py', size: 50 }] }) // startercode
      .mockResolvedValueOnce('print("hello")') // download main.py
      .mockResolvedValueOnce({ files: [] }) // scripts
      .mockResolvedValueOnce({ files: [] }) // docs
      .mockResolvedValueOnce({ files: [] }) // data
      .mockResolvedValueOnce({ files: [] }) // private
      .mockResolvedValueOnce({ files: [] }) // lib
      .mockResolvedValueOnce({ files: [] }); // asnlib

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result).toHaveProperty('startercode/main.py');
    expect(result['startercode/main.py']).toBe('print("hello")');
  });

  it('should handle string response format', async () => {
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'readme.md', size: 10 }] })
      .mockResolvedValueOnce('# Hello')
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result['startercode/readme.md']).toBe('# Hello');
  });

  it('should handle Buffer response format', async () => {
    const bufferContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'image.png', size: 4 }] })
      .mockResolvedValueOnce(bufferContent)
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(Buffer.isBuffer(result['startercode/image.png'])).toBe(true);
  });

  it('should handle object response with content field', async () => {
    const base64Content = Buffer.from('hello world').toString('base64');
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'file.txt', size: 11 }] })
      .mockResolvedValueOnce({ content: base64Content })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result).toHaveProperty('startercode/file.txt');
  });

  it('should handle object response with data field', async () => {
    const base64Content = Buffer.from('data field').toString('base64');
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'file.txt', size: 10 }] })
      .mockResolvedValueOnce({ data: base64Content })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result).toHaveProperty('startercode/file.txt');
  });

  it('should download files from multiple directories', async () => {
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'main.py', size: 20 }] }) // startercode list
      .mockResolvedValueOnce('code') // startercode/main.py
      .mockResolvedValueOnce({ files: [{ path: 'grade.sh', size: 15 }] }) // scripts list
      .mockResolvedValueOnce('#!/bin/bash') // scripts/grade.sh
      .mockResolvedValueOnce({ files: [{ path: 'README.md', size: 5 }] }) // docs list
      .mockResolvedValueOnce('# Doc') // docs/README.md
      .mockResolvedValueOnce({ files: [] }) // data list
      .mockResolvedValueOnce({ files: [] }) // private list
      .mockResolvedValueOnce({ files: [] }) // lib list
      .mockResolvedValueOnce({ files: [] }); // asnlib list

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(Object.keys(result)).toHaveLength(3);
    expect(result).toHaveProperty('startercode/main.py', 'code');
    expect(result).toHaveProperty('scripts/grade.sh', '#!/bin/bash');
    expect(result).toHaveProperty('docs/README.md', '# Doc');
  });

  it('should return empty object when no files exist', async () => {
    // All directories empty
    requestMock
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');
    expect(result).toEqual({});
  });

  it('should return empty when files exist but content fails', async () => {
    requestMock
      .mockResolvedValueOnce({ files: [{ path: 'file.txt', size: 10 }] })
      .mockRejectedValueOnce(new Error('Download failed')) // file download fails
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');
    expect(result).toEqual({});
  });

  it('should skip individual file failures and continue', async () => {
    requestMock
      .mockResolvedValueOnce({
        files: [
          { path: 'good.py', size: 10 },
          { path: 'bad.py', size: 10 },
        ],
      })
      .mockResolvedValueOnce('good content') // good.py succeeds
      .mockRejectedValueOnce(new Error('fail')) // bad.py fails
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result).toHaveProperty('startercode/good.py', 'good content');
    expect(result).not.toHaveProperty('startercode/bad.py');
  });
});
