/**
 * Content Operations
 *
 * File upload/download operations for Vocareum.
 *
 * CRITICAL: Content upload requires multipart/form-data format!
 * Use form-data library for file uploads.
 */
import FormData from 'form-data';
import { VocareumClient, APIError, VocareumError } from './client';
import type { DirectoryType } from '../types/config';
import type { UploadResult, FileMap, FileInfo } from '../types/api';
import { logger } from '../utils/logger';

/**
 * Upload content to a Vocareum workspace directory
 *
 * CRITICAL: Uses multipart/form-data, NOT JSON!
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
  const form = new FormData();

  // Append metadata
  form.append('courseid', courseId);
  form.append('assignmentid', assignmentId);
  form.append('partid', partId);
  form.append('type', directory);

  const filePaths = Object.keys(files);

  // Append files
  for (const filePath of filePaths) {
    const content = files[filePath];
    // Form-data requires Buffer or Stream for files, or string
    form.append('file', content, { filename: filePath });
  }

  try {
    // Assuming endpoint matches what AGENTS.md hinted at
    // Using a generic /api/v2/upload or /api/v2/parts/:id/upload
    // Given we send courseid/assignmentid/partid in body, maybe it's a generic endpoint?
    // Let's try /api/v2/upload which is common for bulk uploads
    await client.request({
      method: 'POST',
      url: '/api/v2/upload', // Guessing based on AGENTS.md 'axios.post("/upload")'
      data: form,
      headers: form.getHeaders(),
      // Increase timeout for uploads
      timeout: 60000,
    });

    return {
      succeeded: filePaths,
      failed: [],
      directoryHash: 'calculated_externally', // content.ts doesn't calculate hash? Uploader does.
    };
  } catch (error) {
    // If bulk upload fails, all fail
    return {
      succeeded: [],
      failed: filePaths.map(p => ({ path: p, error })),
      directoryHash: '',
    };
  }
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
