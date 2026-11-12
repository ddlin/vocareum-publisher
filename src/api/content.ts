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
const PART_UPDATE_POLL_MAX_ATTEMPTS_CAP = 300;
const PART_UPDATE_POLL_ATTEMPTS_PER_MB = 2;

// These four numbers are DELIBERATE BEST GUESSES, not measurements. No
// baseline for throughput to Vocareum or for server-side unzip time exists,
// and none was available when this was written; rather than block on
// instrumenting one, they are set for margin and revised when evidence
// arrives. 4s/MB tolerates ~0.25 MB/s (2 Mbps) sustained -- well below any
// plausible link, and far above the 0 s/MB the old fixed timeout effectively
// allowed. The cap bounds a hung run. A1 is what turns these into informed
// values; until it runs, treat them as arbitrary but safe.
const UPLOAD_TIMEOUT_BASE_MS = 60_000;
const UPLOAD_TIMEOUT_MS_PER_MB = 4_000;
const UPLOAD_TIMEOUT_MAX_MS = 600_000;

/**
 * Request timeout for a part-content PUT.
 *
 * axios's timeout covers connect + body upload + server processing until the
 * first response byte. A fixed 60s meant a ~144 MB body needed 2.4 MB/s
 * sustained before the server did any work; in practice the client aborted
 * while the server was still holding the request, and the next call for that
 * part collided with it ("previous corresponding API request is not yet
 * complete"). Budget ~4s per MB on top of the old floor, capped.
 */
export function uploadTimeoutForBytes(bodyBytes: number): number {
  // Whole megabytes only: a sub-MB body must resolve to exactly the historical
  // 60s floor, or existing callers and tests that pin 60000 start seeing 60001.
  const mb = Math.floor(bodyBytes / (1024 * 1024));
  return Math.min(
    UPLOAD_TIMEOUT_MAX_MS,
    UPLOAD_TIMEOUT_BASE_MS + mb * UPLOAD_TIMEOUT_MS_PER_MB,
  );
}

/**
 * Poll attempts to allow for the server-side unzip of a part update. Scales
 * with payload size for the same reason as the timeout above; the old fixed
 * 30s ceiling surfaced a large upload as a confusing "Timed out waiting for
 * part update" rather than as slowness.
 */
export function pollAttemptsForBytes(bodyBytes: number): number {
  // Whole megabytes, same reason as uploadTimeoutForBytes: a sub-MB body must
  // yield exactly the historical 30 attempts.
  const mb = Math.floor(bodyBytes / (1024 * 1024));
  return Math.min(
    PART_UPDATE_POLL_MAX_ATTEMPTS_CAP,
    PART_UPDATE_POLL_MAX_ATTEMPTS + mb * PART_UPDATE_POLL_ATTEMPTS_PER_MB,
  );
}

export interface DownloadContentLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_DOWNLOAD_CONTENT_LIMITS: DownloadContentLimits = {
  maxFiles: 5000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
};

/**
 * A download safety limit was hit.
 * - `file`: one file is too large. Only that file is lost; the walk continues.
 * - `walk`: the file-count or total-byte cap for the whole download was
 *   reached. The walk stops; what already arrived is kept (non-strict).
 */
export class DownloadLimitError extends APIError {
  constructor(message: string, public readonly scope: 'file' | 'walk' = 'walk') {
    super(message);
    this.name = 'DownloadLimitError';
  }
}

const MAX_DOWNLOAD_FILES_CEILING = 1_000_000;

/**
 * File-count cap for one download, from VOCAREUM_MAX_DOWNLOAD_FILES when set.
 * Courses that ship Python environments under data/ list tens of thousands of
 * entries, far past the 5,000 default.
 */
export function resolveMaxDownloadFiles(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VOCAREUM_MAX_DOWNLOAD_FILES;
  if (raw === undefined || raw.trim() === '') { return DEFAULT_DOWNLOAD_CONTENT_LIMITS.maxFiles; }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`VOCAREUM_MAX_DOWNLOAD_FILES must be a positive integer (got "${raw}").`);
  }
  const n = Number(raw.trim());
  if (n < 1 || n > MAX_DOWNLOAD_FILES_CEILING) {
    throw new Error(
      `VOCAREUM_MAX_DOWNLOAD_FILES must be between 1 and ${MAX_DOWNLOAD_FILES_CEILING} (got "${raw}").`
    );
  }
  return n;
}

interface DownloadBudget {
  /** Per-walk collector for entries a non-strict walk skipped. */
  failures?: DownloadFailure[];
  /** Vocareum-managed link entries the walk left out (see isVocareumManagedLink). */
  managedLinks?: string[];
  limits: DownloadContentLimits;
  files: number;
  bytes: number;
}

function resolveDownloadLimits(limits?: Partial<DownloadContentLimits>): DownloadContentLimits {
  return {
    maxFiles: limits?.maxFiles ?? resolveMaxDownloadFiles(),
    maxFileBytes: limits?.maxFileBytes ?? DEFAULT_DOWNLOAD_CONTENT_LIMITS.maxFileBytes,
    maxTotalBytes: limits?.maxTotalBytes ?? DEFAULT_DOWNLOAD_CONTENT_LIMITS.maxTotalBytes,
  };
}

function isHttp400(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const maybe = error as { statusCode?: number; response?: { status?: number } };
  return maybe.statusCode === 400 || maybe.response?.status === 400;
}

function isAxiosBodyLimitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) { return false; }
  const maybe = error as { isAxiosError?: boolean; message?: string };
  if (maybe.isAxiosError !== true && !axios.isAxiosError(error)) { return false; }
  const message = (maybe.message ?? '').toLowerCase();
  return message.includes('maxcontentlength') ||
    message.includes('maxbodylength') ||
    message.includes('content length') ||
    message.includes('body length');
}

interface ParsedFileEntry {
  path: string;
  size: number;
  modifiedAt?: string;
  directory?: string;
}

/**
 * A body that is not a file listing. Distinct from an empty listing: reading
 * it as "no names" would make a directory look empty, or end a paged listing
 * early, and drift would plan the lost names as remote deletions.
 */
export class NotAFileListingError extends APIError {
  constructor(what: string) {
    super(`The API answer is not a file listing (${what}); refusing to read it as an empty directory`);
    this.name = 'NotAFileListingError';
  }
}

function describeBody(response: unknown): string {
  if (response === null) { return 'null'; }
  if (typeof response === 'string') { return `text: ${JSON.stringify(response.trim().slice(0, 120))}`; }
  if (typeof response === 'object') { return `object with keys ${JSON.stringify(Object.keys(response).slice(0, 10))}`; }
  return typeof response;
}

function parseFileListResponse(response: unknown): ParsedFileEntry[] {
  let rawFiles: unknown[];
  if (Array.isArray(response)) {
    rawFiles = response;
  } else if (response !== null && typeof response === 'object') {
    const obj = response as {
      files?: unknown;
      data?: unknown;
      items?: unknown;
    };
    const list = obj.files ?? obj.data ?? obj.items;
    if (!Array.isArray(list)) { throw new NotAFileListingError(describeBody(response)); }
    rawFiles = list;
  } else {
    throw new NotAFileListingError(describeBody(response));
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

/** A remote entry a non-strict download could not retrieve. Path is the
 *  FileMap key (`<directory>/<relative path>`), never an API-internal path. */
export interface DownloadFailure {
  path: string;
  reason: string;
}

/**
 * The v2 files API answers `?filename=<a directory>` with HTTP 400 and
 * `{"error":{"message":"specified file does not exist <path>"}}` — observed on
 * NA course 196169, 2026-11-09 — not the `status:"error"` body handled below.
 * `lib/` entries say "specified source does not exist" for the same case.
 * Treating it as an ordinary API error dropped every subdirectory of a pull
 * (1,386 of 1,393 files) while the pull still reported success.
 */
function isNotAFileHttp400(error: unknown): boolean {
  if (!isHttp400(error)) {
    return false;
  }
  const message = error instanceof Error ? error.message : '';
  return /specified (?:file|source) does not exist/i.test(message);
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
  filePath: string,
  limits: DownloadContentLimits
): Promise<string | Buffer> {
  const url = `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`;
  const fullPath = `${directory}/${filePath}`;

  // Request download URL from API
  let response: FileDownloadResponse;
  try {
    response = await client.request<FileDownloadResponse>({
      method: 'GET',
      url,
      params: { filename: fullPath },
    });
  } catch (error) {
    if (isNotAFileHttp400(error)) {
      throw new NotAFileError(fullPath);
    }
    throw error;
  }

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
      maxContentLength: limits.maxFileBytes,
      maxBodyLength: limits.maxFileBytes,
    });
    return Buffer.from(downloadResponse.data);
  } catch (error) {
    // S3 returns 404 NoSuchKey when the "file path" is actually a directory
    // prefix (the API happily gives us a signed URL, but there's no object).
    if (isAxios404(error)) {
      throw new NotAFileError(fullPath);
    }
    if (isAxiosBodyLimitError(error)) {
      throw new DownloadLimitError(
        `Download limit exceeded: ${fullPath} exceeds ${limits.maxFileBytes} bytes`, 'file'
      );
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
 * Target uncompressed bytes per upload chunk. 32 MB of files becomes roughly a
 * 43 MB base64 body once zipped and encoded, which clears the scaled timeout
 * with room to spare. Oversized single files are exempt (see chunkFilesBySize).
 */
// Also a best guess, not a measured optimum. 32 MB sits below both observed
// failures (74 MB and 108 MB) while keeping directories smaller than that on
// the single-PUT atomic path they use today. Nothing in the evidence shows a
// 10-20 MB directory failing, so chunking one is all risk and no demonstrated
// benefit. No measurement backs the specific value. The env override exists so
// it can be tuned against a real course without a release.
export const DEFAULT_MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** Mirrors the validate-and-throw style of resolveThrottle in src/api/throttle.ts. */
export function resolveMaxChunkBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VOCAREUM_MAX_UPLOAD_CHUNK_BYTES;
  if (raw === undefined || raw === '') { return DEFAULT_MAX_CHUNK_BYTES; }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      `VOCAREUM_MAX_UPLOAD_CHUNK_BYTES must be a positive integer (got "${raw}").`,
    );
  }
  const n = Number(raw.trim());
  if (n < 1024 || n > 64 * 1024 * 1024) {
    throw new Error(
      `VOCAREUM_MAX_UPLOAD_CHUNK_BYTES must be between 1024 and ${64 * 1024 * 1024} (got "${raw}").`,
    );
  }
  return n;
}

function contentByteLength(content: Buffer | string): number {
  return Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf8');
}

/**
 * Partition a FileMap into chunks whose uncompressed contents stay under
 * `maxChunkBytes`.
 *
 * Paths are sorted so chunking is deterministic: a retry must reproduce the
 * same boundaries, because chunk 1 is the one that carries `reset: 1`.
 *
 * A single file larger than the budget gets its own chunk. There is no
 * sub-file granularity available -- the API accepts whole files inside a zip --
 * so the alternative would be dropping it.
 *
 * An empty map yields one empty chunk so that createZipBuffer still throws
 * 'Cannot create ZIP: no files provided' exactly as it does today. Returning an
 * empty array instead would skip the loop entirely and turn that throw into a
 * silent success. (No caller passes an empty map: uploadDirectory returns early
 * for empty directories.)
 */
export function chunkFilesBySize(files: FileMap, maxChunkBytes: number): FileMap[] {
  const paths = Object.keys(files).sort();
  if (paths.length === 0) { return [{}]; }

  const oversized = paths.filter((p) => contentByteLength(files[p]) > maxChunkBytes);
  const regular = paths.filter((p) => contentByteLength(files[p]) <= maxChunkBytes);

  const chunks: FileMap[] = oversized.map((p) => ({ [p]: files[p] }));

  let current: FileMap = {};
  let currentBytes = 0;
  for (const p of regular) {
    const size = contentByteLength(files[p]);
    if (currentBytes > 0 && currentBytes + size > maxChunkBytes) {
      chunks.push(current);
      current = {};
      currentBytes = 0;
    }
    current[p] = files[p];
    currentBytes += size;
  }
  if (Object.keys(current).length > 0) { chunks.push(current); }

  return chunks;
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
      url: `/transaction/${transactionId}`,
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
 * A multi-chunk upload failed partway through, so the remote directory holds
 * some chunks but not all of it.
 *
 * Recovery is to re-run the same upload from the beginning: chunk 1 carries
 * reset:1, so replaying the whole sequence clears whatever landed and rebuilds
 * the directory. The FINAL STATE converges regardless of where the previous
 * attempt died.
 *
 * That is a statement about state, not about timing. An immediate replay can
 * still be refused with "The previous corresponding API request is not yet
 * complete" if the aborted request is still executing server-side -- which is
 * exactly the failure this work exists to address. Retry after a pause, and do
 * not treat a collision on the retry as a new fault.
 */
export class PartialUploadError extends APIError {
  constructor(
    public chunkIndex: number,
    public totalChunks: number,
    public directory: string,
    public partId: string,
    cause: unknown,
  ) {
    super(
      `Part ${partId} directory "${directory}" is PARTIALLY uploaded: chunk ` +
      `${chunkIndex + 1} of ${totalChunks} failed (${cause instanceof Error ? cause.message : String(cause)}). ` +
      (chunkIndex === 0
        ? `Chunk 1's own outcome is unknown -- its reset:1 may or may not have executed, ` +
          `so the directory may now be empty, untouched, or still holding its old content. `
        : `The remote directory now holds only the chunks before it. `) +
      `Re-run the push to rebuild it from scratch -- the first chunk resets the directory, ` +
      `so a full replay is safe.`,
      undefined,
      cause,
    );
    this.name = 'PartialUploadError';
  }
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
 * @param options.maxChunkBytes - Overrides the resolved chunk-size budget
 *   (env var, then default). Large directories are split into sequential
 *   chunks; chunk 1 sends reset:1 to clear the target, later chunks send
 *   reset:0 to append.
 * @returns Upload result with succeeded/failed files
 */
export async function uploadContent(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  directory: DirectoryType,
  files: FileMap,
  options?: { maxChunkBytes?: number }
): Promise<UploadResult> {
  const filePaths = Object.keys(files);
  // Explicit override wins over the env var, which wins over the default. Tests
  // pass a tiny override directly; resolveMaxChunkBytes enforces a 1 KB floor
  // that a test-sized value would otherwise trip.
  const chunks = chunkFilesBySize(files, options?.maxChunkBytes ?? resolveMaxChunkBytes());

  const isChunkedUpload = chunks.length > 1;

  if (isChunkedUpload) {
    // Say this out loud. A single PUT was effectively atomic from a viewer's
    // side; a chunk sequence is not. Between chunk 1's reset and the last
    // chunk landing, the remote directory is genuinely incomplete and students
    // looking at the course see it that way. That window is new behavior and
    // is not something the chunking can avoid -- there is no staged-swap
    // primitive in the API -- so the operator has to know it exists.
    //
    // It also is not undoable partway through. Chunk 1's reset:1 has already
    // erased the previous contents before chunk 2 is ever sent, and there is
    // no rollback: an abort at chunk 5 of 14 leaves the directory holding
    // only chunks 1-4 permanently, until a re-run completes the rest.
    client.events.emit({
      level: 'warn',
      message:
        `Uploading ${filePaths.length} files to ${directory} in ${chunks.length} chunks. ` +
        `This directory will be incomplete in Vocareum until all chunks land. ` +
        `If this upload fails partway, the directory is left holding only the ` +
        `chunks that landed; re-run to restore it.`,
    });
  }

  // Fires at most once per uploadContent call, on whichever chunk hits it
  // first. Without this a 14-chunk upload against a server that never returns
  // a transaction id would emit the same warning 14 times.
  let missingTransactionWarned = false;

  for (let i = 0; i < chunks.length; i++) {
    try {
      if (isChunkedUpload) {
        client.events.emit({
          level: 'info',
          message:
            `Uploading chunk ${i + 1} of ${chunks.length} to ${directory} ` +
            `(${Object.keys(chunks[i]).length} files)`,
        });
      }

      const zipBase64 = createZipBuffer(chunks[i]).toString('base64');
      const bodyBytes = Buffer.byteLength(zipBase64, 'utf8');

      // Only the first chunk resets. reset:1 clears the target directory before
      // applying the zip, so sending it on a later chunk would delete everything
      // uploaded so far and leave only the final chunk. Keyed off the loop
      // index, never off chunk contents: chunkFilesBySize emits an oversized
      // file's chunk first, so chunk 0 need not be the alphabetically-first
      // file, but it is always this loop's first iteration.
      const reset = i === 0 ? 1 : 0;

      const response = await client.request<PartUpdateResponse>({
        method: 'PUT',
        url: `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}`,
        data: {
          update: 1,
          content: [{ target: directory, zipcontent: zipBase64, reset }],
        },
        timeout: uploadTimeoutForBytes(bodyBytes),
      });

      if (response.transactionid !== undefined && response.transactionid !== '') {
        // Must complete before the next chunk: the server serialises part
        // updates and rejects an overlapping one outright.
        await waitForPartUpdateTransaction(client, response.transactionid, {
          maxAttempts: pollAttemptsForBytes(bodyBytes),
        });
      } else if (response.state === 'error' || response.state === 'failed') {
        throw new APIError(
          response.message ?? `Part update failed (part=${partId}, dir=${directory})`
        );
      } else if (isChunkedUpload && !missingTransactionWarned) {
        // No transactionid means we cannot confirm this chunk actually landed
        // before the next PUT goes out -- the exact overlap this plan exists to
        // prevent. Established single-response contract (tests mock
        // {status:'success'} with no transactionid) is left alone; this only
        // makes the gap visible rather than changing control flow.
        //
        // Emitted only once per upload: if the server never returns a
        // transaction id, every remaining chunk would hit this same branch, and
        // a warning repeated once per chunk is noise, not information.
        missingTransactionWarned = true;
        client.events.emit({
          level: 'warn',
          message:
            `Chunk ${i + 1} of ${chunks.length} for ${directory} returned no transaction id; ` +
            `its completion could not be confirmed before the next chunk was sent. This server ` +
            `does not appear to return transaction ids for this upload, so no further chunks ` +
            `will be confirmed either -- this warning will not repeat for the rest of it.`,
        });
      }
    } catch (error) {
      // Vocareum refuses the target before applying anything, so this is not
      // a partial upload even mid-sequence (it can only happen on chunk 0).
      const invalidTarget = invalidTargetMessage(error, directory);
      if (invalidTarget !== undefined) {
        throw new APIError(invalidTarget, 400, error);
      }
      // Any failure in a multi-chunk sequence is indeterminate, chunk 0
      // included. A client-side abort does not tell us whether the server
      // applied the request -- that indeterminacy is the whole premise of this
      // work -- so a failed chunk 0 may well have executed its reset:1 and
      // cleared the directory, or landed chunk 0 and nothing else. Both are
      // partial states for a multi-chunk upload.
      //
      // A single-chunk upload is genuinely all-or-nothing: the directory ends
      // up either as it was or as the new content, never a mix. Leave that
      // unwrapped so today's error surface is unchanged.
      if (chunks.length > 1) {
        throw new PartialUploadError(i, chunks.length, directory, partId, error);
      }
      throw error;
    }
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
 *
 * Must clear the deepest layout we import. AWS Academy courses nest per-locale
 * assets at `asnlib/public/docs/lang/<locale>/images/<file>` — the part root is
 * depth 0, so `images/` needs a descent to depth 5. A previous value of 4 cut
 * exactly there and dropped every locale's images while still fetching the
 * READMEs beside them, so pulls looked complete. The real guard against
 * runaway recursion is the download budget (maxFiles / maxTotalBytes), which
 * is charged for every listed entry; this is secondary defense, so it carries
 * headroom rather than hugging the known-deepest layout.
 */
const MAX_DOWNLOAD_DEPTH = 10;

/**
 * Consecutive identical path segments that make a path a CYCLE CANDIDATE.
 *
 * Vocareum workspaces carry escaping symlinks such as
 * `publicdata -> /mnt/worktest/<course>/data`. The files API lists the same
 * child under every level of one, so the walk sees
 * `lib/publicdata/publicdata/publicdata/...` without end.
 *
 * A repeated name alone is NOT treated as a cycle — `data/a/a/a` can be real.
 * The walk (see `descend`) skips a candidate only when its listing names exactly
 * the entries its parent lists; anything else is walked, and the depth limit
 * (a recorded failure) still bounds it. The listing API returns names only, so
 * a same-names-different-bytes tree is not distinguished — accepted as out of
 * proportion (review triage, 2026-11-09).
 */
const CYCLE_REPEAT_THRESHOLD = 3;

/**
 * True when a relative path ends in CYCLE_REPEAT_THRESHOLD identical segments,
 * i.e. the walk is going in circles rather than descending real content.
 */
/** True when two listings name exactly the same entries (order-insensitive). */
function sameEntryNames(a: FileInfo[], b: FileInfo[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const names = new Set(a.map(e => e.path));
  return b.every(e => names.has(e.path));
}

function isCyclicPath(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.length < CYCLE_REPEAT_THRESHOLD) {
    return false;
  }
  const tail = segments.slice(-CYCLE_REPEAT_THRESHOLD);
  return tail.every((segment) => segment === tail[0]);
}

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
  architecture?: 'elite' | 'container',
  options?: {
    /** Throw on any per-file download failure instead of skipping the file.
     *  Required by drift detection: a silently incomplete map makes files
     *  look remotely deleted. */
    strict?: boolean;
    /** Defensive resource limits for remote content downloads. */
    limits?: Partial<DownloadContentLimits>;
    /** Non-strict only: receives every entry that was skipped, so the caller
     *  can report the pull as incomplete instead of successful. */
    failures?: DownloadFailure[];
    /** Receives the FileMap key of every Vocareum-managed link the walk left
     *  out (e.g. `lib/publicdata`), so a caller comparing against local files
     *  does not read their absence as a remote deletion. */
    managedLinks?: string[];
  }
): Promise<FileMap> {
  return (async (): Promise<FileMap> => {
    // 'course' excluded — shared across all assignments, syncing causes infinite loops.
    // When no directories specified, try all non-course directories (union of both architectures).
    const dirs: DirectoryType[] = directories ?? DEFAULT_PART_DIRECTORIES;
    const downloaded: FileMap = {};
    const budget: DownloadBudget = {
      limits: resolveDownloadLimits(options?.limits),
      files: 0,
      bytes: 0,
      failures: options?.failures,
      managedLinks: options?.managedLinks,
    };

    const strict = options?.strict === true;
    for (let i = 0; i < dirs.length; i++) {
      const directory = dirs[i];
      const baseApiPath = toApiDirPath(directory, architecture);
      try {
        await downloadDirectoryTree(
          client, courseId, assignmentId, partId, directory, baseApiPath, '', 0, downloaded, strict, budget
        );
      } catch (error) {
        if (!(error instanceof DownloadLimitError) || strict) {
          throw error;
        }
        // The cap stops the walk; it must not also throw away what arrived.
        // Record this directory and every one not reached, so callers know
        // exactly which directories are incomplete (push refuses to upload
        // them — see INCOMPLETE_PULL_MARKER).
        recordDownloadFailure(
          client, budget, strict, directory,
          `${error.message}; the rest of this directory was NOT downloaded`
        );
        for (const notReached of dirs.slice(i + 1)) {
          recordDownloadFailure(
            client, budget, strict, notReached,
            'NOT downloaded: the download limit was reached earlier in this part'
          );
        }
        break;
      }
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
  downloaded: FileMap,
  strict: boolean,
  budget: DownloadBudget,
  /** Entries the caller already listed for this directory (saves a request). */
  preListed?: FileInfo[]
): Promise<void> {
  const apiDirPath = relativePath ? `${baseApiPath}/${relativePath}` : baseApiPath;
  // Only the part's own declared directory is worth warning about; deeper
  // levels are paths we discovered, so their absence is not a config problem.
  const entries = preListed ?? await listFilesByApiPath(
    client, courseId, assignmentId, partId, apiDirPath, relativePath === ''
  );

  for (const entry of entries) {
    const entryRelPath = relativePath ? `${relativePath}/${entry.path}` : entry.path;
    const filemapKey = `${directory}/${entryRelPath}`;

    /**
     * Walk into a confirmed directory. Every way a walk can stop short is
     * either a recorded failure (strict: a throw) or a proven link cycle —
     * never a silent drop, and never a placeholder stored as an empty file.
     */
    const descend = async (childEntries: FileInfo[]): Promise<void> => {
      if (isCyclicPath(entryRelPath) && sameEntryNames(childEntries, entries)) {
        // A repeated name alone does not prove a cycle — data/a/a/a can be
        // real. A link back to an ancestor lists exactly what its parent
        // lists; only then is there nothing below it to lose.
        client.events.emit({
          level: 'debug',
          message: `Skipping cyclic path ${filemapKey} (lists the same entries as its parent)`,
        });
        return;
      }
      if (depth >= MAX_DOWNLOAD_DEPTH) {
        // Truncating the walk drops files — the caller must not see a clean
        // pull. Warn without --verbose (a debug line here once hid an entire
        // course's nested assets) and record it as a failure.
        recordDownloadFailure(
          client, budget, strict, filemapKey,
          `directory nesting exceeds the ${MAX_DOWNLOAD_DEPTH}-level download limit; ` +
          `it and anything below it were NOT downloaded`
        );
        return;
      }
      await downloadDirectoryTree(
        client, courseId, assignmentId, partId,
        directory, baseApiPath, entryRelPath, depth + 1, downloaded, strict, budget,
        childEntries
      );
    };

    try {
      assertListedFileWithinBudget(filemapKey, entry, budget);
      const content = await fetchFileContent(
        client, courseId, assignmentId, partId, directory, entryRelPath, budget.limits
      );

      // Some Vocareum workspaces expose directory placeholders as zero-byte
      // downloadable objects while also allowing the same path to be listed.
      // Probe every zero-byte entry: one that lists children is a directory,
      // and must be walked (or recorded as cut off), never kept as an empty file.
      if (isEmptyContent(content)) {
        const childEntries = await listFilesByApiPath(
          client, courseId, assignmentId, partId, `${baseApiPath}/${entryRelPath}`
        );
        if (childEntries.length > 0) {
          await descend(childEntries);
          continue;
        }
      }

      accountDownloadedFile(filemapKey, content, budget);
      downloaded[filemapKey] = content;
    } catch (error) {
      if (error instanceof DownloadLimitError) {
        if (error.scope === 'file' && !strict) {
          recordDownloadFailure(client, budget, strict, filemapKey, error.message);
          continue;
        }
        throw error;
      }
      if (error instanceof NotAFileError) {
        // Not a file: list it as a directory. "Absent" here means the entry is
        // neither — e.g. a dangling link, or a file deleted mid-walk. That must
        // be reported, not silently treated as an empty directory.
        let childListing: { entries: FileInfo[]; absent: boolean };
        try {
          childListing = await listDirectory(
            client, courseId, assignmentId, partId, `${baseApiPath}/${entryRelPath}`, false
          );
        } catch (listError) {
          // One unlistable subdirectory must not abort the rest of the part.
          recordDownloadFailure(
            client, budget, strict, filemapKey,
            `could not be listed as a directory: ${listError instanceof Error ? listError.message : 'Unknown'}`
          );
          continue;
        }
        if (childListing.absent) {
          if (isVocareumManagedLink(directory, relativePath, entry.path)) {
            budget.managedLinks?.push(filemapKey);
            client.events.emit({
              level: 'debug',
              message: `Skipping ${filemapKey}: Vocareum's course-wide data link, not assignment content`,
            });
            continue;
          }
          recordDownloadFailure(
            client, budget, strict, filemapKey,
            'not downloadable as a file and not listable as a directory'
          );
          continue;
        }
        await descend(childListing.entries);
        continue;
      }
      if (strict) {
        throw error;
      }
      recordDownloadFailure(
        client, budget, strict, filemapKey, error instanceof Error ? error.message : 'Unknown'
      );
    }
  }
}

/**
 * Vocareum rejects an upload target the course's workspace does not have, e.g.
 * `lib` in a Container course ("Invalid target (lib) for content update.
 * Valid targets: [course, data, docs, ...]", seen 2026-11-10 on a Vocareum
 * Standard part inside Container course 215500). vocgit picks the directory set
 * from the part's labtype, which can disagree with the course; say how to fix
 * the config instead of passing the raw API text through. The fix is the part's
 * own `directories` list: pull writes one for every imported part, so changing
 * `vocareum.architecture` would not stop the upload (and would move every
 * other directory to the other path prefix).
 *
 * @internal Exported for testing
 */
export function invalidTargetMessage(error: unknown, directory: DirectoryType): string | undefined {
  const message = error instanceof Error ? error.message : '';
  const m = /Invalid target \(([^)]+)\) for content update\.?\s*(Valid targets: \[[^\]]*\])?/i.exec(message);
  if (!m) { return undefined; }
  return (
    `Vocareum does not accept "${directory}/" as an upload target for this part` +
    `${m[2] !== undefined ? ` (${m[2]})` : ''}. The course's workspace layout differs ` +
    `from the one vocgit inferred from the part's labtype. Remove "${directory}" (and any other ` +
    `directory not in that list, such as asnlib) from this part's \`directories\` in vocareum.yaml.`
  );
}

/**
 * `publicdata` at the top of the course-wide tree (`lib/` on Elite, `course/`
 * on Container) is a root-owned link Vocareum creates to the course data mount
 * (`/voc/course/publicdata -> /mnt/.../course<id>/data`, seen 2026-11-10). The
 * API lists it but can neither fetch nor list it, and a `reset: 1` upload does
 * not remove it: on Elite course 240788 a reset upload of `lib/` deleted a
 * marker file added just before and left `publicdata` in place (2026-11-10).
 * (On Container course 215500 `lib` is not an upload target at all.) It is not
 * assignment content, so it is skipped rather than marking the pull incomplete
 * and blocking every push of `lib/`.
 */
function isVocareumManagedLink(directory: DirectoryType, relativePath: string, name: string): boolean {
  return relativePath === '' && (directory === 'lib' || directory === 'course') && name === 'publicdata';
}

/**
 * A non-strict walk records the miss and carries on, so one bad entry does not
 * cost the rest of the tree; callers read `failures` to report the pull as
 * incomplete. A strict walk (drift detection) throws instead: a silently
 * incomplete remote map would make the missing files look deleted remotely.
 */
function recordDownloadFailure(
  client: VocareumClient,
  budget: DownloadBudget,
  strict: boolean,
  filemapKey: string,
  reason: string
): void {
  if (strict) {
    throw new APIError(`Could not download ${filemapKey}: ${reason}`);
  }
  client.events.emit({ level: 'warn', message: `Failed to download ${filemapKey}: ${reason}` });
  budget.failures?.push({ path: filemapKey, reason });
}

function assertListedFileWithinBudget(
  filemapKey: string,
  entry: FileInfo,
  budget: DownloadBudget
): void {
  budget.files += 1;
  if (budget.files > budget.limits.maxFiles) {
    throw new DownloadLimitError(
      `Download limit exceeded: more than ${budget.limits.maxFiles} files while downloading ${filemapKey} ` +
      `(raise it with VOCAREUM_MAX_DOWNLOAD_FILES)`
    );
  }
  // Many Vocareum listings are string-only and report size=0; this check is
  // an early rejection when size metadata exists. Actual bytes are enforced by
  // axios and accountDownloadedFile below.
  if (entry.size > budget.limits.maxFileBytes) {
    throw new DownloadLimitError(
      `Download limit exceeded: ${filemapKey} is listed as ${entry.size} bytes ` +
      `(max ${budget.limits.maxFileBytes})`, 'file'
    );
  }
}

function accountDownloadedFile(
  filemapKey: string,
  content: string | Buffer,
  budget: DownloadBudget
): void {
  const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  if (bytes > budget.limits.maxFileBytes) {
    throw new DownloadLimitError(
      `Download limit exceeded: ${filemapKey} is ${bytes} bytes (max ${budget.limits.maxFileBytes})`, 'file'
    );
  }
  if (budget.bytes + bytes > budget.limits.maxTotalBytes) {
    throw new DownloadLimitError(
      `Download limit exceeded: ${budget.bytes + bytes} total bytes ` +
      `(max ${budget.limits.maxTotalBytes})`
    );
  }
  budget.bytes += bytes;
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
/**
 * Map a directory to its path in the Vocareum workspace.
 *
 * The two architectures are laid out differently, and this is not cosmetic:
 *
 *   Elite      `/` -> ['resource', 'work']            — there is NO /voc
 *              `/resource` -> asnlib, lib, scripts, startercode
 *   Container  `/` -> ['resource', 'voc', 'work']
 *              `/voc` -> course, data, docs, private, scripts, startercode
 *
 * This function previously ignored `architecture` and always sent `scripts` and
 * `startercode` to /voc. On Elite that path cannot exist, the API answered
 * "doesn't exist", and listFilesByApiPath's missing-optional-directory branch
 * turned it into an empty listing — so pulls reported success while every
 * build/grade/run/submit script stayed on the server. Verified against live
 * Elite courses 102668 and 227714.
 *
 * Note Elite has no `docs` at all (neither /voc/docs nor /resource/docs); its
 * documentation lives under `/resource/asnlib/public/docs` and arrives via
 * asnlib. A part that declares `docs` on an Elite course now gets a warning
 * from listFilesByApiPath rather than a silently empty directory.
 */
export function toApiDirPath(directory: DirectoryType, architecture?: 'elite' | 'container'): string {
  if (architecture === 'elite') {
    return `/resource/${directory}`;
  }
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
    client, courseId, assignmentId, partId, toApiDirPath(directory, architecture), true
  );
}

async function listFilesByApiPath(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  apiDirPath: string,
  warnIfAbsent = false,
): Promise<FileInfo[]> {
  return (await listDirectory(client, courseId, assignmentId, partId, apiDirPath, warnIfAbsent)).entries;
}

/**
 * Pages read before a listing is refused as unbounded: 10,000 pages of the
 * observed 100 names is 1,000,000 entries, the VOCAREUM_MAX_DOWNLOAD_FILES
 * ceiling; page 10,000 itself is the empty page that confirms the end.
 */
const MAX_LIST_PAGES = 10_000;

/**
 * List a directory, distinguishing "absent" from "empty" — the walk needs the
 * difference to tell a real (empty) subdirectory from an entry that is not
 * there at all.
 */
async function listDirectory(
  client: VocareumClient,
  courseId: string,
  assignmentId: string,
  partId: string,
  apiDirPath: string,
  /**
   * Warn when the API reports this path absent. Only true for a directory the
   * part actually DECLARES. The walk also calls this speculatively — to decide
   * whether a zero-byte entry is really a directory — and those probes are
   * expected to miss constantly. Warning on them would bury the real signal.
   */
  warnIfAbsent: boolean,
): Promise<{ entries: FileInfo[]; absent: boolean }> {
  const url = `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`;

  // Which page failed decides what an error means: only page 0 can say the
  // directory is absent. Declared outside the try so the catch can see it.
  let page = 0;
  try {
    const entries: FileInfo[] = [];
    const seen = new Set<string>();
    // The listing is paged and says nothing about it: no total, no "more"
    // flag. It takes a 0-based `page` (no `page` = page 0; `per_page`/`limit`
    // are ignored). Probed on course 215500, 2026-11-11: a 115-entry
    // directory answered 100 names, then 15 on page=1, then none. Reading only
    // the first page silently dropped every name after the 100th, so pull lost
    // the files and drift read them as remote deletions.
    //
    // Read until a page comes back EMPTY, not merely short. The page size is
    // observed, not documented: a deployment with a smaller page, or a server
    // that filters entries (hidden files) after paging, would end a page early
    // with more to come. One extra request per directory buys never mistaking
    // a short page for the end.
    for (; ; page++) {
      if (page > MAX_LIST_PAGES) {
        throw new APIError(
          `Listing ${apiDirPath} was still returning names after ${MAX_LIST_PAGES} pages; ` +
          `stopping rather than reading it as complete`
        );
      }
      const response = await client.request<unknown>({
        method: 'GET',
        url,
        params: page === 0 ? { dir: apiDirPath, list: true } : { dir: apiDirPath, list: true, page },
      });
      const batch = parseFileListResponse(response);
      if (batch.length === 0) { break; }
      let added = 0;
      for (const entry of batch) {
        if (seen.has(entry.path)) { continue; }
        seen.add(entry.path);
        entries.push({ path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt });
        added += 1;
      }
      if (page > 0 && added === 0) {
        // A page with nothing new: the server ignored `page` and repeated an
        // earlier one. We cannot read past it, and a short listing reads as
        // deletions downstream, so fail rather than guess.
        throw new APIError(
          `Listing ${apiDirPath}: page ${page} repeated names already read; ` +
          `cannot page through it, so the directory cannot be listed completely`
        );
      }
    }
    return { entries, absent: false };
  } catch (error) {
    // Missing optional directories are normal, but only mask the error when it
    // names the requested directory. Other 400s likely indicate bad IDs/params.
    // "Doesn't exist" means absent only on page 0. On a later page the names
    // already read prove the directory existed; treating it as absent would
    // throw them away and report an empty directory.
    if (page === 0 && isHttp400(error)) {
      const msg = error instanceof Error ? error.message : String(error);
      if (missingDirectoryMessageMatches(msg, apiDirPath)) {
        // An absent directory is not an error — returning [] is correct, and
        // throwing would make pull read it as remote deletions. But a DECLARED
        // directory coming back absent must not be SILENT: this swallow is why
        // a whole architecture's worth of scripts/ went missing with exit
        // code 0. Name the path we asked for, so a wrong prefix is visible as
        // a wrong prefix.
        if (warnIfAbsent) {
          client.events.emit({
          level: 'warn',
          message:
            `Directory "${apiDirPath}" does not exist on part ${partId} — treated as empty. ` +
            `If you expected content here, the directory may live at a different path for ` +
            `this lab type (Elite workspaces keep everything under /resource; Container ` +
            `workspaces keep scripts, startercode, docs, data and private under /voc).`,
          });
        }
        return { entries: [], absent: true };
      }
    }
    // Transient/non-400 errors must propagate: returning [] here would make an
    // unreachable directory look empty, which pull interprets as remote
    // deletions (and in --batch mode, deletes local files).
    client.events.emit({
      level: 'warn',
      message: `Failed to list files for part=${partId}, dir=${apiDirPath}: ${error instanceof Error ? error.message : 'Unknown'}`,
    });
    throw error;
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
      url: `/courses/${courseId}/assignments/${assignmentId}/parts/${partId}/files`,
      params: {
        dir: apiDirPath,
        filename: filePath,
      },
    });
  } catch (error: unknown) {
    // Handle errors gracefully - deletion may not be supported
    if (error instanceof VocareumError) {
      if (error.statusCode === 400 || error.statusCode === 404 || error.statusCode === 405) {
        client.events.emit({ level: 'debug', message: `File deletion not supported or file not found: ${filePath}` });
        return;
      }
    }
    // For other errors, just log and continue (don't fail the operation)
    client.events.emit({ level: 'warn', message: `Failed to delete ${filePath}: ${error instanceof Error ? error.message : 'Unknown'}` });
  }
}
