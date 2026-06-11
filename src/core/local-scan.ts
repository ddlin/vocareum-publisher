/**
 * Local Content Scan
 *
 * Offline (no API) CONTENT change detection: compares local directory hashes
 * against the last recorded publish state in vocareum.yaml. This is the single
 * source of truth for "what would `vocgit push` upload" — the reconciler and
 * `vocgit status --json` (consumed by the VS Code extension) both use it.
 *
 * Scope: content only. Push additionally compares assignment/part SETTINGS
 * against the remote (reconciler, requires API) — a content-synced assignment
 * can still receive settings updates on push. Do not extend this module with a
 * partial local settings diff; settings equality lives with the reconciler
 * until consolidated into a single settings-diff module.
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { calculateDirectoryHash } from '../utils/files';
import {
  ELITE_DIRECTORIES,
  CONTAINER_DIRECTORIES,
  DEFAULT_PART_DIRECTORIES,
  type Config,
  type Assignment,
  type Part,
  type DirectoryType,
  type PublishHistory,
} from '../types/config';

/**
 * Local content-sync status.
 * - `pending_create`: no assignment_id and create_from_template is true — push will act
 * - `unlinked`: no assignment_id and no template — push may link by name,
 *   skip, or abort depending on on_missing_id; not locally decidable
 * - `error`: the directory could not be read (e.g. permissions) — isolated
 *   to the affected subtree, the rest of the scan continues
 */
export type LocalSyncStatus = 'synced' | 'needs_publish' | 'unknown' | 'pending_create' | 'unlinked' | 'error';

type PartLevelStatus = Exclude<LocalSyncStatus, 'pending_create' | 'unlinked'>;

export interface DirectoryScan {
  directory: DirectoryType;
  status: PartLevelStatus;
}

export interface PartScan {
  path: string;
  part_id: string | null;
  status: PartLevelStatus;
  directories: DirectoryScan[];
}

export interface AssignmentScan {
  path: string;
  name: string;
  assignment_id: string | null;
  status: LocalSyncStatus;
  parts: PartScan[];
}

export interface LocalScanResult {
  assignments: AssignmentScan[];
  summary: {
    synced: number;
    needs_publish: number;
    unknown: number;
    pending_create: number;
    unlinked: number;
    error: number;
  };
}

/**
 * The history entry push compares against: publish_history[0]. updateConfig
 * keeps the array sorted newest-first; trusting [0] (rather than re-deriving
 * a max timestamp) keeps status, scanner, and publisher on one baseline.
 */
export function latestHistoryEntry(config: Pick<Config, 'publish_history'>): PublishHistory | undefined {
  return config.publish_history?.[0];
}

/**
 * The exclude patterns the publisher applies when hashing/uploading.
 * Reconciler, publisher, and scanner must agree or hashes won't round-trip.
 */
export function publishExcludePatterns(config: Pick<Config, 'publish_options'>): string[] {
  return ['.gitkeep', '**/.gitkeep', ...(config.publish_options?.exclude_patterns ?? [])];
}

/**
 * Directories the push pipeline syncs for a part: an explicit part-level
 * override wins, then the course architecture set, then the default union.
 */
export function directoriesForPart(config: Config, part: Part): DirectoryType[] {
  const archDirs = config.vocareum.architecture === 'elite' ? ELITE_DIRECTORIES
    : config.vocareum.architecture === 'container' ? CONTAINER_DIRECTORIES
    : DEFAULT_PART_DIRECTORIES;
  return part.directories ?? archDirs;
}

/**
 * Detect which directories changed since the last publish.
 *
 * The state key is `path.join(assignmentPath, partPath, dir)` — the exact key
 * the publisher records in content_state. The newest history entry is used
 * even when failed: its content_state is what a retrying push compares to.
 *
 * @param baseDir - Directory assignment paths are relative to (defaults to cwd)
 */
export async function detectChangedDirectories(
  assignmentPath: string,
  partPath: string,
  directories: DirectoryType[],
  lastPublishHistory?: PublishHistory,
  forceAll: boolean = false,
  excludePatterns: string[] = [],
  baseDir: string = '.'
): Promise<DirectoryType[]> {
  // Confinement comes first — including under forceAll, whose returned list
  // the publisher will read and upload.
  await assertConfinedToWorkspace(baseDir, path.join(assignmentPath, partPath));

  if (forceAll) {
    return directories;
  }

  if (!lastPublishHistory?.content_state) {
    return directories; // All changed if no history
  }

  const changed: DirectoryType[] = [];

  for (const dir of directories) {
    const key = path.join(assignmentPath, partPath, dir);
    await assertConfinedToWorkspace(baseDir, key);

    // Calculate hash with same exclude patterns as publisher to ensure consistency
    const currentHash = await calculateDirectoryHash(path.resolve(baseDir, key), excludePatterns);
    const previousHash = lastPublishHistory.content_state[key];

    if (currentHash !== previousHash) {
      changed.push(dir);
    }
  }

  return changed;
}

/**
 * Scan all configured assignments for local content changes.
 *
 * Pure local computation — no network. Status semantics:
 * - `unknown`: no publish history exists, so there is nothing to compare to
 * - `pending_create`: assignment has no assignment_id (push would create it)
 * - `needs_publish` / `synced`: hash comparison against the latest history entry
 */
export async function scanLocalContent(config: Config, baseDir: string = '.'): Promise<LocalScanResult> {
  const lastHistory = latestHistoryEntry(config);
  const excludePatterns = publishExcludePatterns(config);

  const assignments: AssignmentScan[] = [];

  for (const assignment of config.assignments) {
    assignments.push(await scanAssignment(config, assignment, lastHistory, excludePatterns, baseDir));
  }

  const summary = { synced: 0, needs_publish: 0, unknown: 0, pending_create: 0, unlinked: 0, error: 0 };
  for (const a of assignments) {
    summary[a.status] += 1;
  }

  return { assignments, summary };
}

/**
 * Workspace confinement for config-supplied paths.
 *
 * Assignment/part paths come from vocareum.yaml, which is attacker-controlled
 * in a cloned repository — and the VS Code extension runs this scan
 * automatically. Both checks are required:
 * - lexical: the resolved path must stay under baseDir (catches `../`, absolute)
 * - realpath: the deepest existing ancestor must also resolve under baseDir
 *   (catches symlinks pointing out of the workspace)
 */
export async function isConfinedToWorkspace(baseDir: string, relPath: string): Promise<boolean> {
  const baseAbs = path.resolve(baseDir);
  const targetAbs = path.resolve(baseDir, relPath);

  if (targetAbs !== baseAbs && !targetAbs.startsWith(baseAbs + path.sep)) {
    return false;
  }

  let baseReal: string;
  try {
    baseReal = await fs.realpath(baseAbs);
  } catch {
    return false; // workspace itself unreadable — treat as not confined
  }

  const targetReal = await deepestExistingRealpath(targetAbs);
  return targetReal === baseReal || targetReal.startsWith(baseReal + path.sep);
}

/**
 * Throwing variant for the push pipeline (reconciler hashing, uploader reads):
 * config-supplied paths must never read or upload content from outside the
 * working tree.
 */
export async function assertConfinedToWorkspace(baseDir: string, relPath: string): Promise<void> {
  if (!await isConfinedToWorkspace(baseDir, relPath)) {
    throw new Error(
      `Refusing to access "${relPath}": path escapes the workspace (check vocareum.yaml assignment/part paths and symlinks)`
    );
  }
}

/** Realpath of the target, or of its deepest existing ancestor when the leaf
 *  does not exist yet (intermediate symlinks must still be resolved). */
async function deepestExistingRealpath(targetAbs: string): Promise<string> {
  let current = targetAbs;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current; // filesystem root
      }
      current = parent;
    }
  }
}

function errorPart(part: Part, directories: DirectoryType[]): PartScan {
  return {
    path: part.path,
    part_id: part.part_id,
    status: 'error',
    directories: directories.map((directory) => ({ directory, status: 'error' as const })),
  };
}

async function scanAssignment(
  config: Config,
  assignment: Assignment,
  lastHistory: PublishHistory | undefined,
  excludePatterns: string[],
  baseDir: string
): Promise<AssignmentScan> {
  const parts: PartScan[] = [];
  const hasHistory = lastHistory?.content_state !== undefined;

  // Confinement is checked even when there is no history (and even with zero
  // parts): the extension walks assignment paths for display, so escaping
  // paths must surface as errors regardless of scan depth.
  const assignmentConfined = await isConfinedToWorkspace(baseDir, assignment.path);
  if (!assignmentConfined) {
    return {
      path: assignment.path,
      name: assignment.name,
      assignment_id: assignment.assignment_id,
      status: 'error',
      parts: assignment.parts.map((part) => errorPart(part, directoriesForPart(config, part))),
    };
  }

  for (const part of assignment.parts) {
    const directories = directoriesForPart(config, part);

    if (!await isConfinedToWorkspace(baseDir, path.join(assignment.path, part.path))) {
      parts.push(errorPart(part, directories));
      continue;
    }

    if (!hasHistory) {
      parts.push({
        path: part.path,
        part_id: part.part_id,
        status: 'unknown',
        directories: directories.map((directory) => ({ directory, status: 'unknown' as const })),
      });
      continue;
    }

    const directoryScans: DirectoryScan[] = [];
    for (const directory of directories) {
      directoryScans.push(
        await scanDirectory(assignment.path, part.path, directory, lastHistory, excludePatterns, baseDir)
      );
    }

    const partStatus: PartLevelStatus = directoryScans.some((d) => d.status === 'error') ? 'error'
      : directoryScans.some((d) => d.status === 'needs_publish') ? 'needs_publish'
      : 'synced';

    parts.push({
      path: part.path,
      part_id: part.part_id,
      status: partStatus,
      directories: directoryScans,
    });
  }

  const missingId = assignment.assignment_id === null || assignment.assignment_id === '';
  let status: LocalSyncStatus;
  if (parts.some((p) => p.status === 'error')) {
    // Errors are never masked: an unreadable/escaping path matters regardless
    // of whether push would create, link, or update this assignment.
    status = 'error';
  } else if (missingId) {
    // Mirrors the reconciler: push creates only when create_from_template is
    // true; otherwise it tries name-lookup, then skips/aborts (on_missing_id).
    status = assignment.create_from_template === true ? 'pending_create' : 'unlinked';
  } else if (!hasHistory) {
    status = 'unknown';
  } else {
    status = parts.some((p) => p.status === 'needs_publish') ? 'needs_publish' : 'synced';
  }

  return {
    path: assignment.path,
    name: assignment.name,
    assignment_id: assignment.assignment_id,
    status,
    parts,
  };
}

/**
 * Classify one directory, isolating read failures: an unreadable directory is
 * reported as `error` for that subtree only (a missing one is legitimately
 * empty — that matches what push would see). Note `calculateDirectoryHash`
 * cannot distinguish unreadable from missing (its existence probe swallows
 * EACCES), hence the explicit stat here.
 */
async function scanDirectory(
  assignmentPath: string,
  partPath: string,
  directory: DirectoryType,
  lastHistory: PublishHistory | undefined,
  excludePatterns: string[],
  baseDir: string
): Promise<DirectoryScan> {
  const relPath = path.join(assignmentPath, partPath, directory);
  const absPath = path.resolve(baseDir, relPath);

  // The directory name is enum-constrained, but the directory itself can be a
  // symlink pointing out of the workspace — re-check confinement at this level.
  if (!await isConfinedToWorkspace(baseDir, relPath)) {
    return { directory, status: 'error' };
  }

  try {
    await fs.stat(absPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { directory, status: 'error' };
    }
    // ENOENT: fall through — hashes as 'empty', same as the push pipeline.
  }

  try {
    const changed = await detectChangedDirectories(
      assignmentPath, partPath, [directory], lastHistory, false, excludePatterns, baseDir
    );
    return { directory, status: changed.length > 0 ? 'needs_publish' : 'synced' };
  } catch {
    return { directory, status: 'error' };
  }
}
