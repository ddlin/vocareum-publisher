/**
 * File System Utilities
 *
 * File operations with proper error handling and security.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { FileMap } from '../types/api';

/**
 * Error for file operation failures
 */
export class FileError extends Error {
  constructor(
    message: string,
    public code: string,
    public filePath?: string
  ) {
    super(message);
    this.name = 'FileError';
  }
}

/**
 * Check if a path exists
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a directory
 */
export async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read all files from a directory recursively
 *
 * @param dirPath - Directory to read
 * @param excludePatterns - Glob patterns to exclude
 * @returns Map of relative paths to file contents
 */
export async function readDirectory(
  dirPath: string,
  excludePatterns: string[] = []
): Promise<FileMap> {
  const result: FileMap = {};

  async function readRecursive(currentPath: string, basePath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      // Check if should exclude
      if (shouldExclude(relativePath, excludePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        await readRecursive(fullPath, basePath);
      } else if (entry.isFile()) {
        const content = await fs.readFile(fullPath);
        result[relativePath] = content;
      }
    }
  }

  if (await pathExists(dirPath)) {
    await readRecursive(dirPath, dirPath);
  }

  return result;
}

/**
 * Check if a path matches any exclude pattern
 */
function shouldExclude(relativePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob matching (supports * and **)
    const regex = globToRegex(pattern);
    if (regex.test(relativePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<<DOUBLE>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<<DOUBLE>>>/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Calculate SHA256 hash of a directory's contents
 *
 * @param dirPath - Directory to hash
 * @param excludePatterns - Patterns to exclude
 * @returns SHA256 hash string
 */
export async function calculateDirectoryHash(
  dirPath: string,
  excludePatterns: string[] = []
): Promise<string> {
  const files = await readDirectory(dirPath, excludePatterns);

  // Sort files by path for consistent hashing
  const sortedPaths = Object.keys(files).sort();

  if (sortedPaths.length === 0) {
    // Empty directory
    return crypto.createHash('sha256').update('empty').digest('hex');
  }

  // Calculate hash for each file
  const fileHashes: string[] = [];
  for (const filePath of sortedPaths) {
    const content = files[filePath];
    const fileHash = crypto
      .createHash('sha256')
      .update(Buffer.isBuffer(content) ? content : Buffer.from(content))
      .digest('hex');
    fileHashes.push(`${filePath}:${fileHash}`);
  }

  // Hash the concatenated file hashes
  return crypto.createHash('sha256').update(fileHashes.join(':')).digest('hex');
}

/**
 * Get immediate subdirectories of a path
 *
 * @param dirPath - Directory to list
 * @returns Array of directory names
 */
export async function getDirectories(dirPath: string): Promise<string[]> {
  const directories: string[] = [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        directories.push(entry.name);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  return directories;
}

/**
 * Validate that a path doesn't escape the base directory
 * Prevents path traversal attacks
 *
 * @param basePath - Base directory path
 * @param targetPath - Target path to validate
 * @throws FileError if path escapes base directory
 */
export function validatePath(basePath: string, targetPath: string): void {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(basePath, targetPath);

  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new FileError(
      `Invalid path: "${targetPath}" escapes base directory`,
      'PATH_TRAVERSAL',
      targetPath
    );
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 *
 * @param dirPath - Directory path
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Write content to a file, creating parent directories if needed
 *
 * @param filePath - File path
 * @param content - Content to write
 */
export async function writeFile(filePath: string, content: string | Buffer): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, content);
}

/**
 * Read a file's contents
 *
 * @param filePath - Path to the file
 * @param encoding - Optional encoding (defaults to utf-8)
 * @returns File contents
 * @throws FileError if file doesn't exist
 */
export async function readFile(filePath: string, encoding?: BufferEncoding): Promise<string> {
  try {
    return await fs.readFile(filePath, { encoding: encoding ?? 'utf-8' });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      throw new FileError(`File not found: ${filePath}`, 'FILE_NOT_FOUND', filePath);
    }
    if (nodeError.code === 'EACCES') {
      throw new FileError(`Permission denied: ${filePath}`, 'PERMISSION_DENIED', filePath);
    }
    throw new FileError(
      `Failed to read file: ${nodeError.message}`,
      'READ_ERROR',
      filePath
    );
  }
}

/**
 * Read a file as a Buffer
 *
 * @param filePath - Path to the file
 * @returns File contents as Buffer
 * @throws FileError if file doesn't exist
 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      throw new FileError(`File not found: ${filePath}`, 'FILE_NOT_FOUND', filePath);
    }
    if (nodeError.code === 'EACCES') {
      throw new FileError(`Permission denied: ${filePath}`, 'PERMISSION_DENIED', filePath);
    }
    throw new FileError(
      `Failed to read file: ${nodeError.message}`,
      'READ_ERROR',
      filePath
    );
  }
}

/**
 * Copy a file from source to destination
 *
 * @param source - Source file path
 * @param destination - Destination file path
 */
export async function copyFile(source: string, destination: string): Promise<void> {
  await ensureDirectory(path.dirname(destination));
  await fs.copyFile(source, destination);
}

/**
 * Delete a file if it exists
 *
 * @param filePath - Path to the file
 * @returns true if file was deleted, false if it didn't exist
 */
export async function deleteFile(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return false;
    }
    throw new FileError(
      `Failed to delete file: ${nodeError.message}`,
      'DELETE_ERROR',
      filePath
    );
  }
}

/**
 * Get file stats
 *
 * @param filePath - Path to the file
 * @returns File stats or null if file doesn't exist
 */
export async function getFileStats(filePath: string): Promise<{
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  modifiedAt: Date;
} | null> {
  try {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      modifiedAt: stats.mtime,
    };
  } catch {
    return null;
  }
}
