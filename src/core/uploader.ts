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
import { assertConfinedToWorkspace } from './local-scan';
import { LoggerEventSink } from '../utils/logger-event-sink';
import type { EventSink } from './services/event-sink';

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
  options: UploadOptions,
  events: EventSink = new LoggerEventSink(),
): Promise<UploadResult> {
  // localPath originates in vocareum.yaml — never read/upload outside the
  // workspace (covers --force-all, which bypasses the change detector's check).
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  await assertConfinedToWorkspace(workspaceRoot, localPath);

  events.emit({ level: 'debug', message: `Reading local directory: ${localPath}` });

  const files = await readLocalDirectory(localPath, options.excludePatterns);
  const fileKeys = Object.keys(files);

  if (fileKeys.length === 0) {
    events.emit({ level: 'debug', message: `Directory ${localPath} is empty, skipping upload` });
    return {
      succeeded: [],
      failed: [],
      directoryHash: await calculateDirectoryHash(localPath, options.excludePatterns),
    };
  }

  events.emit({ level: 'info', message: `Uploading ${fileKeys.length} files to ${directoryType}...` });

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
    events.emit({ level: 'error', message: `Failed to upload ${result.failed.length} files` });
  } else {
    events.emit({ level: 'success', message: `Uploaded ${result.succeeded.length} files` });
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
  options: UploadOptions,
  events: EventSink = new LoggerEventSink(),
): Promise<UploadResult> {
  // 1. Upload current content
  const uploadResult = await uploadDirectory(
    client,
    courseId,
    assignmentId,
    partId,
    localPath,
    directoryType,
    options,
    events,
  );

  // 2. Handle deletions if enabled
  if (options.syncDeletes === true) {
    try {
      events.emit({ level: 'info', message: 'Syncing deletions...' });

      const filesToDelete = options.plannedDeletePaths !== undefined
        ? options.plannedDeletePaths.map((path) => ({ path }))
        : await (async (): Promise<Array<{ path: string }>> => {
            // Creation-time reconciliation: no remote part existed when the
            // intent was built, so resolve the deletion set now.
            const remoteFiles = await listFiles(
              client,
              courseId,
              assignmentId,
              partId,
              directoryType,
              options.architecture,
            );
            const localFiles = await readLocalDirectory(localPath, options.excludePatterns);
            const localFileSet = new Set(Object.keys(localFiles));
            return remoteFiles.filter((remoteFile) => !localFileSet.has(remoteFile.path));
          })();

      if (filesToDelete.length > 0) {
        events.emit({ level: 'info', message: `Deleting ${filesToDelete.length} files...` });

        uploadResult.deleted = [];

        for (const file of filesToDelete) {
          try {
            await deleteFile(client, courseId, assignmentId, partId, directoryType, file.path, options.architecture);
            uploadResult.deleted.push(file.path);
            events.emit({ level: 'debug', message: `Deleted: ${file.path}` });
          } catch (error) {
            events.emit({ level: 'warn', message: `Failed to delete ${file.path}: ${error instanceof Error ? error.message : 'Unknown'}` });
          }
        }

        events.emit({ level: 'success', message: `Deleted ${uploadResult.deleted.length} files` });
      }
    } catch (error) {
      events.emit({ level: 'warn', message: `Sync deletions failed: ${error instanceof Error ? error.message : 'Unknown'}` });
    }
  }

  return uploadResult;
}

export { readLocalDirectory as readDirectory };
