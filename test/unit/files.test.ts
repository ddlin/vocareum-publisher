/**
 * File System Utilities Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  pathExists,
  isDirectory,
  readDirectory,
  calculateDirectoryHash,
  getDirectories,
  validatePath,
  ensureDirectory,
  writeFile,
  readFile,
  readFileBuffer,
  copyFile,
  deleteFile,
  getFileStats,
  FileError,
} from '../../src/utils/files';

describe('File System Utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a unique temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-test-'));
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('pathExists', () => {
    it('should return true for existing file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'content');
      expect(await pathExists(filePath)).toBe(true);
    });

    it('should return true for existing directory', async () => {
      const dirPath = path.join(tempDir, 'subdir');
      await fs.mkdir(dirPath);
      expect(await pathExists(dirPath)).toBe(true);
    });

    it('should return false for non-existent path', async () => {
      expect(await pathExists(path.join(tempDir, 'nonexistent'))).toBe(false);
    });
  });

  describe('isDirectory', () => {
    it('should return true for directory', async () => {
      const dirPath = path.join(tempDir, 'subdir');
      await fs.mkdir(dirPath);
      expect(await isDirectory(dirPath)).toBe(true);
    });

    it('should return false for file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'content');
      expect(await isDirectory(filePath)).toBe(false);
    });

    it('should return false for non-existent path', async () => {
      expect(await isDirectory(path.join(tempDir, 'nonexistent'))).toBe(false);
    });
  });

  describe('readDirectory', () => {
    it('should read all files recursively', async () => {
      // Create nested structure
      await fs.mkdir(path.join(tempDir, 'sub1'));
      await fs.mkdir(path.join(tempDir, 'sub1', 'nested'));
      await fs.writeFile(path.join(tempDir, 'root.txt'), 'root');
      await fs.writeFile(path.join(tempDir, 'sub1', 'file.txt'), 'sub1');
      await fs.writeFile(path.join(tempDir, 'sub1', 'nested', 'deep.txt'), 'deep');

      const files = await readDirectory(tempDir);

      expect(Object.keys(files)).toHaveLength(3);
      expect(files['root.txt']).toBeDefined();
      expect(files[path.join('sub1', 'file.txt')]).toBeDefined();
      expect(files[path.join('sub1', 'nested', 'deep.txt')]).toBeDefined();
    });

    it('should exclude files matching patterns', async () => {
      await fs.writeFile(path.join(tempDir, 'keep.txt'), 'keep');
      await fs.writeFile(path.join(tempDir, 'skip.tmp'), 'skip');
      await fs.writeFile(path.join(tempDir, '.hidden'), 'hidden');

      const files = await readDirectory(tempDir, ['*.tmp', '.*']);

      expect(Object.keys(files)).toHaveLength(1);
      expect(files['keep.txt']).toBeDefined();
      expect(files['skip.tmp']).toBeUndefined();
      expect(files['.hidden']).toBeUndefined();
    });

    it('should return empty object for non-existent directory', async () => {
      const files = await readDirectory(path.join(tempDir, 'nonexistent'));
      expect(Object.keys(files)).toHaveLength(0);
    });

    it('should handle ** glob pattern', async () => {
      await fs.mkdir(path.join(tempDir, '__pycache__'));
      await fs.mkdir(path.join(tempDir, 'src'));
      await fs.mkdir(path.join(tempDir, 'src', '__pycache__'));
      await fs.writeFile(path.join(tempDir, 'main.py'), 'code');
      await fs.writeFile(path.join(tempDir, '__pycache__', 'cached.pyc'), 'cache');
      await fs.writeFile(path.join(tempDir, 'src', '__pycache__', 'nested.pyc'), 'nested');

      // Use pattern that matches __pycache__ at root and nested
      const files = await readDirectory(tempDir, ['__pycache__/**', '**/__pycache__/**']);

      expect(Object.keys(files)).toHaveLength(1);
      expect(files['main.py']).toBeDefined();
    });
  });

  describe('calculateDirectoryHash', () => {
    it('should produce consistent hash for same content', async () => {
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'content1');
      await fs.writeFile(path.join(tempDir, 'file2.txt'), 'content2');

      const hash1 = await calculateDirectoryHash(tempDir);
      const hash2 = await calculateDirectoryHash(tempDir);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex
    });

    it('should produce different hash for different content', async () => {
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content1');
      const hash1 = await calculateDirectoryHash(tempDir);

      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content2');
      const hash2 = await calculateDirectoryHash(tempDir);

      expect(hash1).not.toBe(hash2);
    });

    it('should return consistent hash for empty directory', async () => {
      const hash = await calculateDirectoryHash(tempDir);
      expect(hash).toBeDefined();
      expect(hash).toHaveLength(64);
    });

    it('should exclude patterns when hashing', async () => {
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');
      await fs.writeFile(path.join(tempDir, 'file.tmp'), 'temp');

      const hash1 = await calculateDirectoryHash(tempDir, ['*.tmp']);

      // Remove .tmp file and hash again
      await fs.unlink(path.join(tempDir, 'file.tmp'));
      const hash2 = await calculateDirectoryHash(tempDir);

      expect(hash1).toBe(hash2);
    });
  });

  describe('getDirectories', () => {
    it('should return only directories', async () => {
      await fs.mkdir(path.join(tempDir, 'dir1'));
      await fs.mkdir(path.join(tempDir, 'dir2'));
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');

      const dirs = await getDirectories(tempDir);

      expect(dirs).toContain('dir1');
      expect(dirs).toContain('dir2');
      expect(dirs).not.toContain('file.txt');
    });

    it('should exclude hidden directories', async () => {
      await fs.mkdir(path.join(tempDir, '.hidden'));
      await fs.mkdir(path.join(tempDir, 'visible'));

      const dirs = await getDirectories(tempDir);

      expect(dirs).toContain('visible');
      expect(dirs).not.toContain('.hidden');
    });

    it('should return empty array for non-existent directory', async () => {
      const dirs = await getDirectories(path.join(tempDir, 'nonexistent'));
      expect(dirs).toEqual([]);
    });
  });

  describe('validatePath', () => {
    it('should allow valid paths', () => {
      expect(() => validatePath(tempDir, 'subdir')).not.toThrow();
      expect(() => validatePath(tempDir, 'subdir/file.txt')).not.toThrow();
      expect(() => validatePath(tempDir, './subdir')).not.toThrow();
    });

    it('should reject path traversal attempts', () => {
      expect(() => validatePath(tempDir, '../escape')).toThrow(FileError);
      expect(() => validatePath(tempDir, 'subdir/../../escape')).toThrow(FileError);
      expect(() => validatePath(tempDir, '/absolute/path')).toThrow(FileError);
    });

    it('should throw FileError with correct code', () => {
      try {
        validatePath(tempDir, '../escape');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(FileError);
        expect((error as FileError).code).toBe('PATH_TRAVERSAL');
      }
    });

    it('should allow exact base path', () => {
      expect(() => validatePath(tempDir, '.')).not.toThrow();
    });
  });

  describe('ensureDirectory', () => {
    it('should create directory if not exists', async () => {
      const dirPath = path.join(tempDir, 'new', 'nested', 'dir');
      await ensureDirectory(dirPath);
      expect(await isDirectory(dirPath)).toBe(true);
    });

    it('should not throw if directory exists', async () => {
      await fs.mkdir(path.join(tempDir, 'existing'));
      await expect(ensureDirectory(path.join(tempDir, 'existing'))).resolves.not.toThrow();
    });
  });

  describe('writeFile', () => {
    it('should create file with string content', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await writeFile(filePath, 'hello world');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('hello world');
    });

    it('should create file with Buffer content', async () => {
      const filePath = path.join(tempDir, 'binary.bin');
      const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await writeFile(filePath, buffer);
      const content = await fs.readFile(filePath);
      expect(content.equals(buffer)).toBe(true);
    });

    it('should create parent directories', async () => {
      const filePath = path.join(tempDir, 'new', 'nested', 'file.txt');
      await writeFile(filePath, 'content');
      expect(await pathExists(filePath)).toBe(true);
    });
  });

  describe('readFile', () => {
    it('should read file content as string', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'hello world');
      const content = await readFile(filePath);
      expect(content).toBe('hello world');
    });

    it('should throw FileError for non-existent file', async () => {
      await expect(readFile(path.join(tempDir, 'nonexistent.txt'))).rejects.toThrow(FileError);

      try {
        await readFile(path.join(tempDir, 'nonexistent.txt'));
      } catch (error) {
        expect((error as FileError).code).toBe('FILE_NOT_FOUND');
      }
    });
  });

  describe('readFileBuffer', () => {
    it('should read file content as Buffer', async () => {
      const filePath = path.join(tempDir, 'binary.bin');
      const originalBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await fs.writeFile(filePath, originalBuffer);

      const content = await readFileBuffer(filePath);
      expect(Buffer.isBuffer(content)).toBe(true);
      expect(content.equals(originalBuffer)).toBe(true);
    });

    it('should throw FileError for non-existent file', async () => {
      await expect(readFileBuffer(path.join(tempDir, 'nonexistent.bin'))).rejects.toThrow(FileError);
    });
  });

  describe('copyFile', () => {
    it('should copy file to new location', async () => {
      const srcPath = path.join(tempDir, 'source.txt');
      const destPath = path.join(tempDir, 'dest.txt');
      await fs.writeFile(srcPath, 'content');

      await copyFile(srcPath, destPath);

      expect(await pathExists(destPath)).toBe(true);
      const content = await fs.readFile(destPath, 'utf-8');
      expect(content).toBe('content');
    });

    it('should create parent directories for destination', async () => {
      const srcPath = path.join(tempDir, 'source.txt');
      const destPath = path.join(tempDir, 'new', 'nested', 'dest.txt');
      await fs.writeFile(srcPath, 'content');

      await copyFile(srcPath, destPath);

      expect(await pathExists(destPath)).toBe(true);
    });
  });

  describe('deleteFile', () => {
    it('should delete existing file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'content');

      const result = await deleteFile(filePath);

      expect(result).toBe(true);
      expect(await pathExists(filePath)).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      const result = await deleteFile(path.join(tempDir, 'nonexistent.txt'));
      expect(result).toBe(false);
    });
  });

  describe('getFileStats', () => {
    it('should return stats for existing file', async () => {
      const filePath = path.join(tempDir, 'test.txt');
      await fs.writeFile(filePath, 'hello');

      const stats = await getFileStats(filePath);

      expect(stats).not.toBeNull();
      expect(stats?.isFile).toBe(true);
      expect(stats?.isDirectory).toBe(false);
      expect(stats?.size).toBe(5);
      expect(stats?.modifiedAt).toBeInstanceOf(Date);
    });

    it('should return stats for existing directory', async () => {
      const dirPath = path.join(tempDir, 'subdir');
      await fs.mkdir(dirPath);

      const stats = await getFileStats(dirPath);

      expect(stats).not.toBeNull();
      expect(stats?.isFile).toBe(false);
      expect(stats?.isDirectory).toBe(true);
    });

    it('should return null for non-existent path', async () => {
      const stats = await getFileStats(path.join(tempDir, 'nonexistent'));
      expect(stats).toBeNull();
    });
  });
});

describe('FileError', () => {
  it('should have correct properties', () => {
    const error = new FileError('test message', 'TEST_CODE', '/path/to/file');

    expect(error.message).toBe('test message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.filePath).toBe('/path/to/file');
    expect(error.name).toBe('FileError');
  });
});
