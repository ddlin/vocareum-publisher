/**
 * Uploader Module Tests
 *
 * Tests for uploadDirectory() and syncDirectory() which orchestrate
 * local file reading, ZIP packaging, API upload, and optional deletions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadDirectory, syncDirectory } from '../../src/core/uploader';
import { VocareumClient } from '../../src/api/client';

// Mock the content API module
vi.mock('../../src/api/content', () => ({
  uploadContent: vi.fn(),
  deleteFile: vi.fn(),
  listFiles: vi.fn(),
}));

// Mock the files utility module
vi.mock('../../src/utils/files', () => ({
  readDirectory: vi.fn(),
  calculateDirectoryHash: vi.fn(),
}));

// Mock logger to suppress output during tests
vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { uploadContent, deleteFile, listFiles } from '../../src/api/content';
import { readDirectory, calculateDirectoryHash } from '../../src/utils/files';

const mockUploadContent = vi.mocked(uploadContent);
const mockDeleteFile = vi.mocked(deleteFile);
const mockListFiles = vi.mocked(listFiles);
const mockReadDirectory = vi.mocked(readDirectory);
const mockCalculateDirectoryHash = vi.mocked(calculateDirectoryHash);

describe('uploadDirectory', () => {
  let mockClient: VocareumClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {} as VocareumClient;
    mockCalculateDirectoryHash.mockResolvedValue('abc123hash');
  });

  it('should read local files, upload, and return result with hash', async () => {
    mockReadDirectory.mockResolvedValueOnce({
      'main.py': Buffer.from('print("hello")'),
      'utils.py': Buffer.from('def util(): pass'),
    });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['main.py', 'utils.py'],
      failed: [],
      directoryHash: '',
    });

    const result = await uploadDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/startercode',
      'startercode',
      {}
    );

    expect(mockReadDirectory).toHaveBeenCalledWith('lab1/part1/startercode', undefined);
    expect(mockUploadContent).toHaveBeenCalledWith(
      mockClient, 'c1', 'a1', 'p1', 'startercode',
      { 'main.py': Buffer.from('print("hello")'), 'utils.py': Buffer.from('def util(): pass') }
    );
    expect(result.succeeded).toEqual(['main.py', 'utils.py']);
    expect(result.failed).toEqual([]);
    expect(result.directoryHash).toBe('abc123hash');
  });

  it('should pass exclude patterns to readDirectory', async () => {
    mockReadDirectory.mockResolvedValueOnce({ 'file.txt': Buffer.from('ok') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['file.txt'],
      failed: [],
      directoryHash: '',
    });

    await uploadDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/scripts',
      'scripts',
      { excludePatterns: ['*.pyc', '__pycache__/**'] }
    );

    expect(mockReadDirectory).toHaveBeenCalledWith('lab1/part1/scripts', ['*.pyc', '__pycache__/**']);
    expect(mockCalculateDirectoryHash).toHaveBeenCalledWith('lab1/part1/scripts', ['*.pyc', '__pycache__/**']);
  });

  it('should skip upload when directory is empty', async () => {
    mockReadDirectory.mockResolvedValueOnce({});

    const result = await uploadDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/empty',
      'data',
      {}
    );

    expect(mockUploadContent).not.toHaveBeenCalled();
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.directoryHash).toBe('abc123hash');
  });

  it('should calculate directory hash after upload', async () => {
    mockReadDirectory.mockResolvedValueOnce({ 'a.txt': Buffer.from('a') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['a.txt'],
      failed: [],
      directoryHash: '',
    });
    mockCalculateDirectoryHash.mockResolvedValueOnce('hash-after-upload');

    const result = await uploadDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/docs',
      'docs',
      {}
    );

    expect(result.directoryHash).toBe('hash-after-upload');
  });

  it('should propagate failed files from uploadContent', async () => {
    mockReadDirectory.mockResolvedValueOnce({
      'ok.py': Buffer.from('ok'),
      'bad.py': Buffer.from('bad'),
    });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['ok.py'],
      failed: [{ path: 'bad.py', error: 'upload rejected' }],
      directoryHash: '',
    });

    const result = await uploadDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/startercode',
      'startercode',
      {}
    );

    expect(result.succeeded).toEqual(['ok.py']);
    expect(result.failed).toEqual([{ path: 'bad.py', error: 'upload rejected' }]);
  });
});

describe('syncDirectory', () => {
  let mockClient: VocareumClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {} as VocareumClient;
    mockCalculateDirectoryHash.mockResolvedValue('sync-hash');
  });

  it('should upload then skip deletions when syncDeletes is false', async () => {
    mockReadDirectory.mockResolvedValueOnce({ 'file.py': Buffer.from('code') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['file.py'],
      failed: [],
      directoryHash: '',
    });

    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/startercode',
      'startercode',
      { syncDeletes: false }
    );

    expect(mockUploadContent).toHaveBeenCalled();
    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(result.succeeded).toEqual(['file.py']);
    expect(result.deleted).toBeUndefined();
  });

  it('should delete remote-only files when syncDeletes is true', async () => {
    // First call: uploadDirectory reads files
    mockReadDirectory.mockResolvedValueOnce({ 'keep.py': Buffer.from('keep') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['keep.py'],
      failed: [],
      directoryHash: '',
    });

    // Second call: syncDirectory reads files again for comparison
    mockReadDirectory.mockResolvedValueOnce({ 'keep.py': Buffer.from('keep') });

    // Remote has an extra file
    mockListFiles.mockResolvedValueOnce([
      { path: 'keep.py', size: 4 },
      { path: 'stale.py', size: 10 },
    ]);

    mockDeleteFile.mockResolvedValueOnce(undefined);

    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/startercode',
      'startercode',
      { syncDeletes: true }
    );

    expect(mockDeleteFile).toHaveBeenCalledWith(
      mockClient, 'c1', 'a1', 'p1', 'startercode', 'stale.py', undefined
    );
    expect(result.deleted).toEqual(['stale.py']);
  });

  it('uses the approved deletion set without relisting remote files', async () => {
    mockReadDirectory.mockResolvedValueOnce({ 'keep.py': Buffer.from('keep') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['keep.py'],
      failed: [],
      directoryHash: '',
    });
    mockDeleteFile.mockResolvedValue(undefined);

    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/startercode',
      'startercode',
      { syncDeletes: true, plannedDeletePaths: ['approved.py'] },
    );

    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockReadDirectory).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(
      mockClient, 'c1', 'a1', 'p1', 'startercode', 'approved.py', undefined,
    );
    expect(result.deleted).toEqual(['approved.py']);
  });

  it('should not delete files that exist locally', async () => {
    mockReadDirectory
      .mockResolvedValueOnce({ 'a.py': Buffer.from('a'), 'b.py': Buffer.from('b') })
      .mockResolvedValueOnce({ 'a.py': Buffer.from('a'), 'b.py': Buffer.from('b') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['a.py', 'b.py'],
      failed: [],
      directoryHash: '',
    });
    mockListFiles.mockResolvedValueOnce([
      { path: 'a.py', size: 1 },
      { path: 'b.py', size: 1 },
    ]);

    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/scripts',
      'scripts',
      { syncDeletes: true }
    );

    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(result.deleted).toBeUndefined();
  });

  it('should handle delete failures gracefully', async () => {
    mockReadDirectory
      .mockResolvedValueOnce({ 'keep.py': Buffer.from('keep') })
      .mockResolvedValueOnce({ 'keep.py': Buffer.from('keep') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['keep.py'],
      failed: [],
      directoryHash: '',
    });
    mockListFiles.mockResolvedValueOnce([
      { path: 'keep.py', size: 4 },
      { path: 'orphan1.py', size: 5 },
      { path: 'orphan2.py', size: 5 },
    ]);

    // First delete succeeds, second fails
    mockDeleteFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Delete failed'));

    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/startercode',
      'startercode',
      { syncDeletes: true }
    );

    // Only the successfully deleted file is recorded
    expect(result.deleted).toEqual(['orphan1.py']);
  });

  it('should handle listFiles failure gracefully during sync', async () => {
    mockReadDirectory.mockResolvedValueOnce({ 'file.py': Buffer.from('code') });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['file.py'],
      failed: [],
      directoryHash: '',
    });
    mockListFiles.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw - sync deletions fail gracefully
    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/docs',
      'docs',
      { syncDeletes: true }
    );

    expect(result.succeeded).toEqual(['file.py']);
    // deleted should not be set because we couldn't list remote files
    expect(result.deleted).toBeUndefined();
  });

  it('should propagate upload results through sync', async () => {
    mockReadDirectory.mockResolvedValueOnce({
      'a.py': Buffer.from('a'),
      'b.py': Buffer.from('b'),
    });
    mockUploadContent.mockResolvedValueOnce({
      succeeded: ['a.py', 'b.py'],
      failed: [],
      directoryHash: '',
    });

    const result = await syncDirectory(
      mockClient,
      'c1', 'a1', 'p1',
      'lab1/part1/data',
      'data',
      {}
    );

    expect(result.succeeded).toEqual(['a.py', 'b.py']);
    expect(result.directoryHash).toBe('sync-hash');
  });
});

describe('workspace confinement', () => {
  let mockClient: VocareumClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {} as VocareumClient;
  });

  it('uploadDirectory refuses local paths that escape the working directory', async () => {
    await expect(
      uploadDirectory(mockClient, 'c1', 'a1', 'p1', '../../outside/startercode', 'startercode', {})
    ).rejects.toThrow(/escapes/);
    expect(mockUploadContent).not.toHaveBeenCalled();
    expect(mockReadDirectory).not.toHaveBeenCalled();
  });

  it('uploadDirectory refuses absolute local paths outside the working directory', async () => {
    await expect(
      uploadDirectory(mockClient, 'c1', 'a1', 'p1', '/etc/startercode', 'startercode', {})
    ).rejects.toThrow(/escapes/);
    expect(mockUploadContent).not.toHaveBeenCalled();
  });
});
