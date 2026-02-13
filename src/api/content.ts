/**
 * Content Operations
 *
 * File upload/download operations for Vocareum.
 *
 * CRITICAL: Content upload uses part PUT with content[].zipcontent payload.
 */
import { VocareumClient, APIError, VocareumError } from './client';
import type { DirectoryType } from '../types/config';
import type { UploadResult, FileMap, FileInfo } from '../types/api';
import { logger } from '../utils/logger';

interface PartUpdateResponse {
  status: 'success';
  state?: 'pending' | 'success' | 'failed';
  message?: string;
  transactionid?: string;
}

interface TransactionResponse {
  status: 'success';
  state: 'pending' | 'success' | 'failed';
  message?: string;
}

const PART_UPDATE_POLL_MAX_ATTEMPTS = 30;
const PART_UPDATE_POLL_DELAY_MS = 1000;

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
    if (txn.state === 'failed') {
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
          reset: 0,
        },
      ],
    },
    timeout: 60000,
  });

  if (response.transactionid !== undefined && response.transactionid !== '') {
    await waitForPartUpdateTransaction(client, response.transactionid);
  } else if (response.state === 'failed') {
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
 * Download all content from a part workspace
 *
 * @param client - Vocareum API client
 * @param partId - Part ID (string!)
 * @returns Map of relative paths to file contents
 */
export function downloadContent(
  _client: VocareumClient,
  _partId: string
): Promise<FileMap> {
  // TODO: Implement download logic
  // This likely returns a zip stream?
  // For Phase 3 foundation, we might just stub or guess
  return Promise.reject(new APIError('Download not implemented', 501));
}

/**
 * List files in a workspace directory
 *
 * @param client - Vocareum API client
 * @param partId - Part ID (string!)
 * @param directory - Directory type
 * @returns Array of file info
 */
export async function listFiles(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType
): Promise<FileInfo[]> {
  try {
    const response = await client.request<{ files?: FileInfo[] }>({
      method: 'GET',
      url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`,
      params: { dir: directory },
    });
    return response.files ?? [];
  } catch (error) {
    logger.warn(`Failed to list files or not supported: ${error instanceof Error ? error.message : 'Unknown'}`);
    return [];
  }
}

/**
 * Delete a file from a workspace directory
 *
 * Note: This is experimental and may not be supported.
 * Handle 404/405 gracefully.
 *
 * @param client - Vocareum API client
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
  filePath: string
): Promise<void> {
  try {
    await client.request({
      method: 'DELETE',
      url: `/api/v2/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`,
      params: {
        dir: directory,
        filename: filePath,
      },
    });
  } catch (error: unknown) {
    // Handle 404/405 gracefully as per requirements
    if (error instanceof VocareumError) {
      if (error.statusCode === 404 || error.statusCode === 405) {
        logger.warn(`File deletion not supported or file not found: ${filePath}`);
        return;
      }
    }
    throw error;
  }
}
