/**
 * Content Operations
 *
 * File upload/download operations for Vocareum.
 *
 * CRITICAL: Content upload uses part PUT with content[].zipcontent payload.
 */
import axios from 'axios';
import { VocareumClient, APIError, VocareumError } from './client';
import type { DirectoryType } from '../types/config';
import { DEFAULT_PART_DIRECTORIES } from '../types/config';
import type { UploadResult, FileMap, FileInfo } from '../types/api';
import { logger } from '../utils/logger';

interface PartUpdateResponse {
  status: 'success';
  state?: 'pending' | 'success' | 'error' | 'failed';
  message?: string;
  transactionid?: string;
}

interface TransactionResponse {
  status: 'success';
  state: 'pending' | 'success' | 'error' | 'failed';
  message?: string;
}

const PART_UPDATE_POLL_MAX_ATTEMPTS = 30;
const PART_UPDATE_POLL_DELAY_MS = 1000;

function isHttp400(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const maybe = error as { statusCode?: number; response?: { status?: number } };
  return maybe.statusCode === 400 || maybe.response?.status === 400;
}

interface ParsedFileEntry {
  path: string;
  size: number;
  modifiedAt?: string;
  directory?: string;
}

function parseFileListResponse(response: unknown): ParsedFileEntry[] {
  let rawFiles: unknown[] = [];
  if (Array.isArray(response)) {
    rawFiles = response;
  } else if (response !== null && typeof response === 'object') {
    const obj = response as {
      files?: unknown[];
      data?: unknown[];
      items?: unknown[];
    };
    rawFiles = obj.files ?? obj.data ?? obj.items ?? [];
  }

  const parsed: ParsedFileEntry[] = [];
  for (const entry of rawFiles) {
    if (typeof entry === 'string') {
      parsed.push({ path: entry, size: 0 });
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const e = entry as {
        path?: unknown;
        filename?: unknown;
        name?: unknown;
        size?: unknown;
        modifiedAt?: unknown;
        modified_at?: unknown;
        dir?: unknown;
        directory?: unknown;
        target?: unknown;
      };
      const pathValue = e.path ?? e.filename ?? e.name;
      if (typeof pathValue === 'string' && pathValue.length > 0) {
        parsed.push({
          path: pathValue,
          size: typeof e.size === 'number' ? e.size : 0,
          modifiedAt: typeof e.modifiedAt === 'string'
            ? e.modifiedAt
            : (typeof e.modified_at === 'string' ? e.modified_at : undefined),
          directory: typeof e.dir === 'string'
            ? e.dir
            : (typeof e.directory === 'string'
              ? e.directory
              : (typeof e.target === 'string' ? e.target : undefined)),
        });
      }
    }
  }

  return parsed;
}

interface FileDownloadResponse {
  status: string;
  files?: Array<{
    filename: string;
    download_url: string;
  }>;
}

/**
 * Thrown when a listed entry cannot be resolved as a downloadable file.
 *
 * Vocareum's file list returns a flat array of names with no type info.
 * Subdirectories and symlinks appear alongside real files. When we try to
 * fetch one of those as a file, the API responds with either
 *   { status: "error", files: [{ download_url: "specified file does not exist" }] }
 * or a signed S3 URL that 404s because the key is actually a directory prefix.
 *
 * Callers (e.g. downloadContent) use this signal to probe-list the entry as
 * a directory and recurse into it.
 */
export class NotAFileError extends Error {
  constructor(public readonly fullPath: string, message?: string) {
    super(message ?? `${fullPath} is not a downloadable file`);
    this.name = 'NotAFileError';
  }
}

function isAxios404(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const maybe = error as { response?: { status?: number } };
  return maybe.response?.status === 404;
}

function isEmptyContent(content: string | Buffer): boolean {
  return Buffer.isBuffer(content) ? content.length === 0 : content.length === 0;
}

/**
 * Fetch file content from Vocareum
 *
 * API returns a signed download_url that we fetch directly.
 * Format: GET .../files?filename={directory}/{filename}
 */
async function fetchFileContent(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType,
  filePath: string
): Promise<string | Buffer> {
  const url = `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`;
  const fullPath = `${directory}/${filePath}`;

  // Request download URL from API
  const response = await client.request<FileDownloadResponse>({
    method: 'GET',
    url,
    params: { filename: fullPath },
  });

  // Vocareum returns status:"error" with a literal "specified file does not exist"
  // in the download_url field when the path isn't a real file (usually a directory).
  if (response.status === 'error') {
    throw new NotAFileError(fullPath);
  }

  const downloadUrl = response.files?.[0]?.download_url;
  if (!downloadUrl) {
    throw new APIError(`No download URL returned for ${fullPath}`);
  }

  // Defensive: if the API somehow returned a non-URL in download_url, treat as
  // not-a-file rather than letting axios throw "Invalid URL" below.
  if (!/^https?:\/\//i.test(downloadUrl)) {
    throw new NotAFileError(fullPath);
  }

  try {
    const downloadResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    return Buffer.from(downloadResponse.data);
  } catch (error) {
    // S3 returns 404 NoSuchKey when the "file path" is actually a directory
    // prefix (the API happily gives us a signed URL, but there's no object).
    if (isAxios404(error)) {
      throw new NotAFileError(fullPath);
    }
    throw error;
  }
}

/**
 * Calculate CRC32 checksum for ZIP file integrity
 * @internal Exported for testing
 */
export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      const lsb = crc & 1;
      crc = (crc >>> 1) ^ (lsb ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Create a ZIP buffer from a map of files
 * @internal Exported for testing
 */
export function createZipBuffer(files: FileMap): Buffer {
  const entries = Object.entries(files)
    .map(([relativePath, content]) => [relativePath.replace(/\\/g, '/'), content] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    throw new Error('Cannot create ZIP: no files provided');
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  let fileCount = 0;

  for (const [normalizedPath, content] of entries) {
    const nameBuffer = Buffer.from(normalizedPath, 'utf8');
    const dataBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
    fileCount += 1;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(fileCount, 8);
  endOfCentralDirectory.writeUInt16LE(fileCount, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

/**
 * Poll transaction endpoint until part update completes
 * @internal Exported for testing
 */
export async function waitForPartUpdateTransaction(
  client: VocareumClient,
  transactionId: string,
  options: { maxAttempts?: number; delayMs?: number } = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? PART_UPDATE_POLL_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? PART_UPDATE_POLL_DELAY_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const txn = await client.request<TransactionResponse>({
      method: 'GET',
      url: `/api/v2/transaction/${transactionId}`,
    });

    if (txn.state === 'success') {
      return;
    }
    if (txn.state === 'error' || txn.state === 'failed') {
      throw new APIError(
        txn.message ?? `Part update transaction failed (txn=${transactionId})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new APIError(
    `Timed out after ${maxAttempts * delayMs}ms waiting for part update (txn=${transactionId})`
  );
}

/**
 * Upload content to a Vocareum workspace directory
 *
 * CRITICAL: Uses part update endpoint with content[].zipcontent payload.
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @param partId - Part ID (string!)
 * @param directory - Directory type (startercode, scripts, docs, data)
 * @param files - Map of relative paths to file contents
 * @returns Upload result with succeeded/failed files
 */
export async function uploadContent(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType,
  files: FileMap
): Promise<UploadResult> {
  const filePaths = Object.keys(files);
  const zipBuffer = createZipBuffer(files);
  const zipBase64 = zipBuffer.toString('base64');

  const response = await client.request<PartUpdateResponse>({
    method: 'PUT',
    url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}`,
    data: {
      update: 1,
      content: [
        {
          target: directory,
          zipcontent: zipBase64,
          reset: 1, // Clear directory before upload to ensure exact Git state
        },
      ],
    },
    timeout: 60000,
  });

  if (response.transactionid !== undefined && response.transactionid !== '') {
    await waitForPartUpdateTransaction(client, response.transactionid);
  } else if (response.state === 'error' || response.state === 'failed') {
    throw new APIError(
      response.message ?? `Part update failed (part=${partId}, dir=${directory})`
    );
  }

  return {
    succeeded: filePaths,
    failed: [],
    directoryHash: '', // Calculated by uploader after upload
  };
}

/**
 * Maximum subdirectory depth to descend into when `downloadContent` encounters
 * listed entries that aren't directly downloadable as files. Protects against
 * symlink loops and runaway recursion.
 */
const MAX_DOWNLOAD_DEPTH = 4;

/**
 * Download all content from a part workspace
 *
 * @param client - Vocareum API client
 * @param partId - Part ID (string!)
 * @returns Map of relative paths to file contents
 */
export function downloadContent(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directories?: DirectoryType[],
  architecture?: 'elite' | 'container'
): Promise<FileMap> {
  return (async (): Promise<FileMap> => {
    // 'course' excluded — shared across all assignments, syncing causes infinite loops.
    // When no directories specified, try all non-course directories (union of both architectures).
    const dirs: DirectoryType[] = directories ?? DEFAULT_PART_DIRECTORIES;
    const downloaded: FileMap = {};

    for (const directory of dirs) {
      const baseApiPath = toApiDirPath(directory, architecture);
      await downloadDirectoryTree(
        client,
        courseId,
        assignmentId,
        partId,
        directory,
        baseApiPath,
        '',
        0,
        downloaded
      );
    }

    return downloaded;
  })();
}

/**
 * Walk a directory tree, downloading files and recursing into subdirectories.
 *
 * Vocareum's list API returns a flat array of names with no type information,
 * so we can't know in advance which entries are files vs. subdirectories. We
 * optimistically try to fetch each as a file; when the API or S3 tells us it
 * isn't one (see `NotAFileError`), we list it as a directory and recurse.
 */
async function downloadDirectoryTree(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType,
  baseApiPath: string,
  relativePath: string,
  depth: number,
  downloaded: FileMap
): Promise<void> {
  const apiDirPath = relativePath ? `${baseApiPath}/${relativePath}` : baseApiPath;
  const entries = await listFilesByApiPath(client, courseId, assignmentId, partId, apiDirPath);

  for (const entry of entries) {
    const entryRelPath = relativePath ? `${relativePath}/${entry.path}` : entry.path;
    const filemapKey = `${directory}/${entryRelPath}`;

    try {
      const content = await fetchFileContent(
        client, courseId, assignmentId, partId, directory, entryRelPath
      );

      // Some Vocareum workspaces expose directory placeholders as zero-byte
      // downloadable objects while also allowing the same path to be listed.
      // Prefer the directory contents in that case so paths like scripts/python
      // are imported recursively instead of as empty files.
      if (isEmptyContent(content) && depth < MAX_DOWNLOAD_DEPTH) {
        const childApiDirPath = `${baseApiPath}/${entryRelPath}`;
        const childEntries = await listFilesByApiPath(
          client, courseId, assignmentId, partId, childApiDirPath
        );
        if (childEntries.length > 0) {
          await downloadDirectoryTree(
            client, courseId, assignmentId, partId,
            directory, baseApiPath, entryRelPath, depth + 1, downloaded
          );
          continue;
        }
      }

      downloaded[filemapKey] = content;
    } catch (error) {
      if (error instanceof NotAFileError) {
        if (depth < MAX_DOWNLOAD_DEPTH) {
          await downloadDirectoryTree(
            client, courseId, assignmentId, partId,
            directory, baseApiPath, entryRelPath, depth + 1, downloaded
          );
        } else {
          logger.debug(`Max depth reached, skipping ${filemapKey}`);
        }
        continue;
      }
      logger.warn(
        `Failed to download ${filemapKey}: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }
}

/**
 * List files in a workspace directory
 *
 * @param client - Vocareum API client
 * @param partId - Part ID (string!)
 * @param directory - Directory type
 * @returns Array of file info
 */
/**
 * Map directory type to Vocareum API path format for file listing.
 *
 * Vocareum file listing uses /resource/ for shared library directories
 * (lib/asnlib) and /voc/ for workspace directories.
 */
function toApiDirPath(directory: DirectoryType, _architecture?: 'elite' | 'container'): string {
  const prefix = directory === 'lib' || directory === 'asnlib' ? '/resource' : '/voc';
  return `${prefix}/${directory}`;
}

function missingDirectoryMessageMatches(errorMessage: string, apiDirPath: string): boolean {
  if (!errorMessage.includes("doesn't exist")) { return false; }
  const requested = apiDirPath.replace(/^\/(?:voc|resource)\//, '');
  return errorMessage.includes(apiDirPath) || errorMessage.includes(requested);
}

export async function listFiles(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType,
  architecture?: 'elite' | 'container'
): Promise<FileInfo[]> {
  return listFilesByApiPath(
    client, courseId, assignmentId, partId, toApiDirPath(directory, architecture)
  );
}

async function listFilesByApiPath(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  apiDirPath: string
): Promise<FileInfo[]> {
  const url = `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`;

  try {
    const response = await client.request<unknown>({
      method: 'GET',
      url,
      params: { dir: apiDirPath, list: true },
    });
    return parseFileListResponse(response).map((entry) => ({
      path: entry.path,
      size: entry.size,
      modifiedAt: entry.modifiedAt,
    }));
  } catch (error) {
    // Missing optional directories are normal, but only mask the error when it
    // names the requested directory. Other 400s likely indicate bad IDs/params.
    if (isHttp400(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      if (missingDirectoryMessageMatches(msg, apiDirPath)) {
        return [];
      }
    }
    if (isHttp400(error)) {
      throw error;
    }
    // For transient/non-400 errors, log and return empty.
    logger.warn(
      `Failed to list files for part=${partId}, dir=${apiDirPath}: ${error instanceof Error ? error.message : 'Unknown'}`
    );
    return [];
  }
}

/**
 * Delete a file from a workspace directory
 *
 * WARNING: File deletion may not be fully supported by the API.
 * We recommend using `reset: 1` in upload payload to clear directories instead.
 * This function handles errors gracefully and won't throw on 400/404/405.
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string!)
 * @param assignmentId - Assignment ID (string!)
 * @param partId - Part ID (string!)
 * @param directory - Directory type
 * @param filePath - Relative path of file to delete
 */
export async function deleteFile(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType,
  filePath: string,
  architecture?: 'elite' | 'container'
): Promise<void> {
  const apiDirPath = toApiDirPath(directory, architecture);
  try {
    await client.request({
      method: 'DELETE',
      url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`,
      params: {
        dir: apiDirPath,
        filename: filePath,
      },
    });
  } catch (error: unknown) {
    // Handle errors gracefully - deletion may not be supported
    if (error instanceof VocareumError) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 405) {
        logger.debug(`File deletion not supported or file not found: ${filePath}`);
        return;
      }
    }
    // For other errors, just log and continue (don't fail the operation)
    logger.warn(`Failed to delete ${filePath}: ${error instanceof Error ? error.message : 'Unknown'}`);
  }
}
