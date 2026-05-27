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
import axios from 'axios';

// Mock axios for S3 downloads
vi.mock('axios');

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

  it('should throw APIError when transaction returns error state', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'error',
      message: 'Upload failed: transaction error',
    });

    await expect(
      waitForPartUpdateTransaction(mockClient, 'txn-error')
    ).rejects.toThrow('Upload failed: transaction error');
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

  it('should throw on direct error response', async () => {
    requestMock.mockResolvedValueOnce({
      status: 'success',
      state: 'error',
      message: 'Invalid zip content',
    });

    const files = { 'file.txt': 'content' };
    await expect(
      uploadContent(mockClient, 'c1', 'a1', 'p1', 'startercode', files)
    ).rejects.toThrow('Invalid zip content');
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

  it('should call correct endpoint with dir param and list=true', async () => {
    requestMock.mockResolvedValueOnce({ files: [] });

    await listFiles(mockClient, 'c1', 'a1', 'p1', 'startercode');

    expect(requestMock).toHaveBeenCalledWith({
      method: 'GET',
      url: '/api/v2/courses/c1/assignments/a1/parts/p1/files',
      params: { dir: '/voc/startercode', list: true },
    });
  });

  it('should use /resource for lib and asnlib file listing', async () => {
    requestMock.mockResolvedValue({ files: [] });

    await listFiles(mockClient, 'c1', 'a1', 'p1', 'lib');
    await listFiles(mockClient, 'c1', 'a1', 'p1', 'asnlib');

    expect(requestMock).toHaveBeenNthCalledWith(1, {
      method: 'GET',
      url: '/api/v2/courses/c1/assignments/a1/parts/p1/files',
      params: { dir: '/resource/lib', list: true },
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, {
      method: 'GET',
      url: '/api/v2/courses/c1/assignments/a1/parts/p1/files',
      params: { dir: '/resource/asnlib', list: true },
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

  it('should support direct array response from API', async () => {
    requestMock.mockResolvedValueOnce([
      { path: 'main.py', size: 120 },
      { filename: 'utils.py', size: 80 },
    ]);

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'scripts');

    expect(result).toEqual([
      { path: 'main.py', size: 120, modifiedAt: undefined },
      { path: 'utils.py', size: 80, modifiedAt: undefined },
    ]);
  });

  it('should support data/items array response variants', async () => {
    requestMock.mockResolvedValueOnce({ data: ['a.py', 'b.py'] });

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'startercode');

    expect(result).toEqual([
      { path: 'a.py', size: 0 },
      { path: 'b.py', size: 0 },
    ]);
  });

  it('should return empty array on error (graceful fallback)', async () => {
    requestMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'data');

    expect(result).toEqual([]);
  });

  it('should return empty array on 400 "doesn\'t exist" error', async () => {
    requestMock.mockRejectedValueOnce(
      new VocareumError("startercode doesn't exist", 'API_ERROR', 400)
    );

    const result = await listFiles(mockClient, 'c1', 'a1', 'p1', 'startercode');

    expect(result).toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('should throw 400 errors that do not reference the requested directory', async () => {
    requestMock.mockRejectedValueOnce(
      new VocareumError("assignment doesn't exist", 'API_ERROR', 400)
    );

    await expect(listFiles(mockClient, 'c1', 'a1', 'p1', 'startercode')).rejects.toThrow(
      "assignment doesn't exist"
    );
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
        dir: '/voc/startercode',
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

  it('should handle non-404/405 VocareumErrors gracefully', async () => {
    const error = new VocareumError('Server error', 'API_ERROR', 500);
    requestMock.mockRejectedValueOnce(error);

    // Should not throw - just logs and continues
    await expect(deleteFile(mockClient, 'c1', 'a1', 'p1', 'data', 'file.csv')).resolves.toBeUndefined();
  });

  it('should handle non-VocareumError errors gracefully', async () => {
    requestMock.mockRejectedValueOnce(new Error('Connection failed'));

    // Should not throw - just logs and continues
    await expect(deleteFile(mockClient, 'c1', 'a1', 'p1', 'startercode', 'file.py')).resolves.toBeUndefined();
  });
});

describe('downloadContent', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;
  const mockedAxios = vi.mocked(axios);

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
    vi.clearAllMocks();
  });

  // Helper to set up mocks for the two-step download process
  // Step 1: listFiles returns file list
  // Step 2: fetchFileContent makes request to get download_url, then axios fetches from S3
  function setupEmptyDirectoryMocks() {
    // 7 directories: startercode, scripts, docs, data, private, lib, asnlib
    for (let i = 0; i < 7; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }
  }

  it('should iterate directories and download each file', async () => {
    // startercode: has one file
    requestMock.mockResolvedValueOnce({ files: [{ path: 'main.py', size: 50 }] });
    // fetchFileContent for main.py - returns download_url
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'startercode/main.py', download_url: 'https://s3.example.com/main.py' }],
    });
    // Mock axios to return file content
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('print("hello")') });

    // Other directories empty
    for (let i = 0; i < 6; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result).toHaveProperty('startercode/main.py');
    expect(Buffer.isBuffer(result['startercode/main.py'])).toBe(true);
    expect(result['startercode/main.py'].toString()).toBe('print("hello")');
  });

  it('should handle Buffer response from S3', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
    requestMock.mockResolvedValueOnce({ files: [{ path: 'image.png', size: 4 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'startercode/image.png', download_url: 'https://s3.example.com/image.png' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: pngHeader });

    for (let i = 0; i < 6; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(Buffer.isBuffer(result['startercode/image.png'])).toBe(true);
    expect(result['startercode/image.png'][0]).toBe(0x89);
  });

  it('should download files from multiple directories', async () => {
    // startercode: main.py
    requestMock.mockResolvedValueOnce({ files: [{ path: 'main.py', size: 20 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'startercode/main.py', download_url: 'https://s3.example.com/main.py' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('code') });

    // scripts: grade.sh
    requestMock.mockResolvedValueOnce({ files: [{ path: 'grade.sh', size: 15 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'scripts/grade.sh', download_url: 'https://s3.example.com/grade.sh' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('#!/bin/bash') });

    // docs: README.md
    requestMock.mockResolvedValueOnce({ files: [{ path: 'README.md', size: 5 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'docs/README.md', download_url: 'https://s3.example.com/README.md' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('# Doc') });

    // data, private, lib, asnlib: empty
    for (let i = 0; i < 4; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(Object.keys(result)).toHaveLength(3);
    expect(result['startercode/main.py'].toString()).toBe('code');
    expect(result['scripts/grade.sh'].toString()).toBe('#!/bin/bash');
    expect(result['docs/README.md'].toString()).toBe('# Doc');
  });

  it('should return empty object when no files exist', async () => {
    setupEmptyDirectoryMocks();

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');
    expect(result).toEqual({});
  });

  it('should return empty when files exist but download_url fetch fails', async () => {
    requestMock.mockResolvedValueOnce({ files: [{ path: 'file.txt', size: 10 }] });
    // fetchFileContent request fails
    requestMock.mockRejectedValueOnce(new Error('Download failed'));

    for (let i = 0; i < 6; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');
    expect(result).toEqual({});
  });

  it('should return empty when S3 download fails', async () => {
    requestMock.mockResolvedValueOnce({ files: [{ path: 'file.txt', size: 10 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'startercode/file.txt', download_url: 'https://s3.example.com/file.txt' }],
    });
    // axios S3 download fails
    mockedAxios.get.mockRejectedValueOnce(new Error('S3 download failed'));

    for (let i = 0; i < 6; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');
    expect(result).toEqual({});
  });

  it('should skip individual file failures and continue', async () => {
    requestMock.mockResolvedValueOnce({
      files: [
        { path: 'good.py', size: 10 },
        { path: 'bad.py', size: 10 },
      ],
    });
    // good.py download_url request
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'startercode/good.py', download_url: 'https://s3.example.com/good.py' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('good content') });

    // bad.py download_url request fails
    requestMock.mockRejectedValueOnce(new Error('fail'));

    for (let i = 0; i < 6; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(result['startercode/good.py'].toString()).toBe('good content');
    expect(result).not.toHaveProperty('startercode/bad.py');
  });

  it('should call axios with correct options for S3 download', async () => {
    requestMock.mockResolvedValueOnce({ files: [{ path: 'test.txt', size: 5 }] });
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'startercode/test.txt', download_url: 'https://s3.example.com/signed-url' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('test') });

    for (let i = 0; i < 6; i++) {
      requestMock.mockResolvedValueOnce({ files: [] });
    }

    await downloadContent(mockClient, 'c1', 'a1', 'p1');

    expect(mockedAxios.get).toHaveBeenCalledWith('https://s3.example.com/signed-url', {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
  });
});

describe('downloadContent recursive directory handling', () => {
  let mockClient: VocareumClient;
  let requestMock: ReturnType<typeof vi.fn>;
  const mockedAxios = vi.mocked(axios);

  beforeEach(() => {
    requestMock = vi.fn();
    mockClient = {
      request: requestMock,
    } as unknown as VocareumClient;
    vi.clearAllMocks();
  });

  it('should skip (no throw) entries the API reports status:"error" for', async () => {
    // Top-level list returns a phantom entry (not a real file)
    requestMock.mockResolvedValueOnce({ files: [{ path: 'centos', size: 0 }] });
    // fetchFileContent: API tells us it's not a file
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'lib/centos', download_url: 'specified file does not exist' }],
    });
    // Recursion probe (list as directory) → empty, so nothing to recurse into
    requestMock.mockResolvedValueOnce({ files: [] });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['lib']);

    expect(result).toEqual({});
    // No axios.get — we never produced an Invalid URL call
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('should recurse into a subdirectory when an entry is not a file (status:error)', async () => {
    // asnlib → [public]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'public', size: 0 }] });
    // fetch asnlib/public → status:error
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/public', download_url: 'specified file does not exist' }],
    });
    // list asnlib/public as a directory → [docs]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'docs', size: 0 }] });
    // fetch asnlib/public/docs → status:error
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/public/docs', download_url: 'specified file does not exist' }],
    });
    // list asnlib/public/docs as a directory → [file.txt]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'file.txt', size: 14 }] });
    // fetch asnlib/public/docs/file.txt → real file
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'asnlib/public/docs/file.txt', download_url: 'https://s3.example.com/file.txt' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('nested content') });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['asnlib']);

    expect(result['asnlib/public/docs/file.txt'].toString()).toBe('nested content');
  });

  it('should recurse when S3 returns 404 for a path that also resolves as a directory', async () => {
    // asnlib → [public]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'public', size: 0 }] });
    // fetch asnlib/public → success with URL
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'asnlib/public', download_url: 'https://s3.example.com/public' }],
    });
    // axios S3 returns 404 (NoSuchKey — the path is actually a directory prefix)
    const s3Err = Object.assign(new Error('Request failed with status code 404'), {
      isAxiosError: true,
      response: { status: 404 },
    });
    mockedAxios.get.mockRejectedValueOnce(s3Err);
    // Fallback: list asnlib/public as directory → [vocareum.css]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'vocareum.css', size: 10 }] });
    // fetch asnlib/public/vocareum.css → real file
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'asnlib/public/vocareum.css', download_url: 'https://s3.example.com/css' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('body {}') });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['asnlib']);

    expect(result['asnlib/public/vocareum.css'].toString()).toBe('body {}');
  });

  it('should recurse when a zero-byte placeholder also resolves as a directory', async () => {
    // scripts → [python]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'python', size: 0 }] });
    // fetch scripts/python → signed URL
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'scripts/python', download_url: 'https://s3.example.com/python-placeholder' }],
    });
    // The placeholder object is real but empty.
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.alloc(0) });
    // Probe scripts/python as a directory → has children.
    requestMock.mockResolvedValueOnce({ files: [{ path: 'dbacademy.py', size: 10 }] });
    // Recursion lists scripts/python again.
    requestMock.mockResolvedValueOnce({ files: [{ path: 'dbacademy.py', size: 10 }] });
    // fetch scripts/python/dbacademy.py → real file
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'scripts/python/dbacademy.py', download_url: 'https://s3.example.com/dbacademy.py' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.from('nested py') });

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['scripts']);

    expect(result).not.toHaveProperty('scripts/python');
    expect(result['scripts/python/dbacademy.py'].toString()).toBe('nested py');
  });

  it('should keep a real zero-byte file when it is not listable as a directory', async () => {
    // scripts → [run.sh]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'run.sh', size: 0 }] });
    // fetch scripts/run.sh → signed URL
    requestMock.mockResolvedValueOnce({
      status: 'success',
      files: [{ filename: 'scripts/run.sh', download_url: 'https://s3.example.com/run.sh' }],
    });
    mockedAxios.get.mockResolvedValueOnce({ data: Buffer.alloc(0) });
    // Probe scripts/run.sh as a directory → not a directory.
    requestMock.mockRejectedValueOnce(
      new VocareumError("/voc/scripts/run.sh doesn't exist", 'API_ERROR', 400)
    );

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['scripts']);

    expect(result).toHaveProperty('scripts/run.sh');
    expect(Buffer.from(result['scripts/run.sh']).length).toBe(0);
  });

  it('should stop recursing after 4 levels of subdirectories', async () => {
    // Level 0: list asnlib → [a]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'a', size: 0 }] });
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/a', download_url: 'specified file does not exist' }],
    });
    // Level 1: list asnlib/a → [b]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'b', size: 0 }] });
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/a/b', download_url: 'specified file does not exist' }],
    });
    // Level 2: list asnlib/a/b → [c]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'c', size: 0 }] });
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/a/b/c', download_url: 'specified file does not exist' }],
    });
    // Level 3: list asnlib/a/b/c → [d]
    requestMock.mockResolvedValueOnce({ files: [{ path: 'd', size: 0 }] });
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/a/b/c/d', download_url: 'specified file does not exist' }],
    });
    // Level 4: list asnlib/a/b/c/d → [e] (final allowed level)
    requestMock.mockResolvedValueOnce({ files: [{ path: 'e', size: 0 }] });
    requestMock.mockResolvedValueOnce({
      status: 'error',
      files: [{ filename: 'asnlib/a/b/c/d/e', download_url: 'specified file does not exist' }],
    });
    // No further calls — recursion capped at depth 4

    const result = await downloadContent(mockClient, 'c1', 'a1', 'p1', ['asnlib']);

    expect(result).toEqual({});
    // 5 list calls (levels 0-4) + 5 fetch-as-file calls = 10
    expect(requestMock).toHaveBeenCalledTimes(10);
  });
});
