/**
 * Uploader Module
 *
 * Handle file system operations and content uploads.
 */

import type { DirectoryType } from '../types/config';
import type { UploadOptions } from '../types/state';
import type { UploadResult } from '../types/api';
import { VocareumClient } from '../api/client';
import { uploadContent, deleteFile, listFiles } from '../api/content';
import { readDirectory as readLocalDirectory, calculateDirectoryHash } from '../utils/files';
import { logger } from '../utils/logger';

/**
 * Upload directory contents to Vocareum
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID (string)
 * @param assignmentId - Assignment ID (string)
 * @param partId - Part ID (string)
 * @param localPath - Local directory path
 * @param directoryType - Type of directory (startercode, scripts, docs, data)
 * @param options - Upload options
 * @returns Upload result
 */
export async function uploadDirectory(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  localPath: string,
  directoryType: DirectoryType,
  options: UploadOptions
): Promise<UploadResult> {
  logger.debug(`Reading local directory: ${localPath}`);

  const files = await readLocalDirectory(localPath, options.excludePatterns);
  const fileKeys = Object.keys(files);

  if (fileKeys.length === 0) {
    logger.debug(`Directory ${localPath} is empty, skipping upload`);
    return {
      succeeded: [],
      failed: [],
      directoryHash: await calculateDirectoryHash(localPath, options.excludePatterns),
    };
  }

  logger.info(`Uploading ${fileKeys.length} files to ${directoryType}...`);

  const result = await uploadContent(
    client,
    courseId,
    assignmentId,
    partId,
    directoryType,
    files
  );

  // Calculate hash for the uploaded content
  result.directoryHash = await calculateDirectoryHash(localPath, options.excludePatterns);

  if (result.failed.length > 0) {
    logger.error(`Failed to upload ${result.failed.length} files`);
  } else {
    logger.success(`Uploaded ${result.succeeded.length} files`);
  }

  return result;
}

/**
 * Sync directory with Vocareum (including deletions if enabled)
 *
 * @param client - Vocareum API client
 * @param courseId - Course ID
 * @param assignmentId - Assignment ID
 * @param partId - Part ID
 * @param localPath - Local directory path
 * @param directoryType - Type of directory
 * @param options - Upload options
 * @returns Upload result with deletions
 */
export async function syncDirectory(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  localPath: string,
  directoryType: DirectoryType,
  options: UploadOptions
): Promise<UploadResult> {
  // 1. Upload current content
  const uploadResult = await uploadDirectory(
    client,
    courseId,
    assignmentId,
    partId,
    localPath,
    directoryType,
    options
  );

  // 2. Handle deletions if enabled
  if (options.syncDeletes === true) {
    try {
      logger.info('Syncing deletions...');

      // Get remote files
      const remoteFiles = await listFiles(client, courseId, assignmentId, partId, directoryType, options.architecture);
      const localFiles = await readLocalDirectory(localPath, options.excludePatterns);
      const localFileSet = new Set(Object.keys(localFiles));

      const filesToDelete = remoteFiles.filter(rf => !localFileSet.has(rf.path));

      if (filesToDelete.length > 0) {
        logger.info(`Deleting ${filesToDelete.length} files...`);

        uploadResult.deleted = [];

        for (const file of filesToDelete) {
          try {
            await deleteFile(client, courseId, assignmentId, partId, directoryType, file.path, options.architecture);
            uploadResult.deleted.push(file.path);
            logger.debug(`Deleted: ${file.path}`);
          } catch (error) {
            logger.warn(`Failed to delete ${file.path}: ${error instanceof Error ? error.message : 'Unknown'}`);
          }
        }

        logger.success(`Deleted ${uploadResult.deleted.length} files`);
      }
    } catch (error) {
      logger.warn(`Sync deletions failed: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  return uploadResult;
}

export { readLocalDirectory as readDirectory };
