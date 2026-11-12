/**
 * Zip pull, spec steps 6-7: make the staging set look the way the walk sees the
 * tree, then plan how it reconciles with listings read after the zip arrived.
 * Both functions are pure; the caller does the listing, charging and handoff.
 */
import { isCyclicPath, MAX_DOWNLOAD_DEPTH } from './content';
import type { StagingSet } from './zip-reader';

/** The staging set after the dotfile drop, depth cut and ancestor closure. */
export interface FilteredStaging {
  /** Files the walk would fetch (at most MAX_DOWNLOAD_DEPTH + 1 segments). */
  files: Map<string, Buffer>;
  /** Directories the walk would list: explicit and implied. Never `''`. */
  keptDirs: Set<string>;
  /** Directories with exactly MAX_DOWNLOAD_DEPTH + 1 segments, which the walk
   *  records as cut off and never lists. Not in `keptDirs`. */
  depthCut: Set<string>;
  /** A walked directory path matches the walk's cycle pattern. */
  cyclePattern: boolean;
}

/** Outcome of reconciling the filtered staging set with fresh listings. */
export interface ReconcilePlan {
  /** A zip name is not in its directory's listing: not this directory's content. */
  mismatch: boolean;
  /** A listed entry's size exceeds `maxFileBytes` (only when sizes were given). */
  listedOverLimit: boolean;
  /** Directory path -> listed names the zip lacks as a file, kept directory or
   *  depth-cut directory. Only directories with at least one such name appear. */
  missing: Map<string, Set<string>>;
  /** Parent path -> names of kept directories that had no zip children and an
   *  empty listing; the walk handles them at the parent (spec G-F7). */
  handoffEmpty: Map<string, Set<string>>;
  /** Kept directories the commit charges: `keptDirs` minus the handed-off ones. */
  keptDirsToCharge: Set<string>;
}

/** Optional listed sizes, so the `listed_size_over_limit` rule is checked here. */
export interface ReconcileOptions {
  /** Directory path -> name -> listed size in bytes. */
  sizes?: Map<string, Map<string, number>>;
  maxFileBytes?: number;
}

/** Split a relative path into its parent path (`''` for the root) and name. */
function splitParent(path: string): { parent: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { parent: '', name: path } : { parent: path.slice(0, i), name: path.slice(i + 1) };
}

function hasDotSegment(path: string): boolean {
  return path.split('/').some(seg => seg.startsWith('.'));
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

/**
 * Filter a staging set the way the walk sees the tree (spec step 6).
 *
 * Order matters (G-F8): dotfiles are dropped and the depth cut applied first,
 * and the ancestor closure runs last over what remains. Otherwise a 12-segment
 * file would keep an 11-segment ancestor the walk never lists, and
 * `foo/.hidden/file` would keep a `foo` that has nothing visible in it.
 *
 * Depth mirrors `downloadDirectoryTree`: it descends only into directories of
 * at most MAX_DOWNLOAD_DEPTH segments, so files of up to MAX_DOWNLOAD_DEPTH + 1
 * segments are kept, and the directory at MAX_DOWNLOAD_DEPTH + 1 segments on
 * the path of any deeper entry is a depth-cut directory (the walk sees it in
 * its parent's listing and records it as cut off).
 *
 * @param s - Staging set from `readZip`; names already normalised.
 * @returns Kept files, kept directories, depth-cut directories and whether the
 *          cycle pattern was seen.
 */
export function filterStaging(s: StagingSet): FilteredStaging {
  const files = new Map<string, Buffer>();
  const explicitDirs = new Set<string>();
  const depthCut = new Set<string>();
  const cutAt = MAX_DOWNLOAD_DEPTH + 1;

  const cutPrefix = (path: string): string => path.split('/').slice(0, cutAt).join('/');

  for (const [path, buf] of s.files) {
    if (hasDotSegment(path)) {continue;}
    if (path.split('/').length <= cutAt) {
      files.set(path, buf);
    } else {
      depthCut.add(cutPrefix(path));
    }
  }
  for (const dir of s.dirs) {
    if (hasDotSegment(dir)) {continue;}
    if (dir.split('/').length < cutAt) {
      explicitDirs.add(dir);
    } else {
      depthCut.add(cutPrefix(dir));
    }
  }

  // Ancestor closure over what survived: a zip may omit `public/` while
  // holding `public/x`, or hold only `a/b/` with no `a/`. Depth-cut
  // directories need their ancestors listed too, so their names are checked
  // against the parent's listing like every other zip name.
  const keptDirs = new Set<string>(explicitDirs);
  const closeOver = (path: string): void => {
    let { parent } = splitParent(path);
    while (parent !== '' && !keptDirs.has(parent)) {
      keptDirs.add(parent);
      parent = splitParent(parent).parent;
    }
  };
  for (const path of files.keys()) {closeOver(path);}
  for (const dir of explicitDirs) {closeOver(dir);}
  for (const dir of depthCut) {closeOver(dir);}

  // The walk checks the cycle pattern on every directory it descends into,
  // depth-cut ones included (the cycle test runs before the depth test). It
  // can skip a match by comparing listings; the zip cannot, so any match
  // means the zip is not used.
  let cyclePattern = false;
  for (const dir of [...keptDirs, ...depthCut]) {
    if (isCyclicPath(dir)) {
      cyclePattern = true;
      break;
    }
  }

  return { files, keptDirs, depthCut, cyclePattern };
}

/**
 * Plan the reconcile of a filtered staging set with listings (spec step 7).
 *
 * - `mismatch`: a zip file, kept directory or depth-cut directory is not in its
 *   parent's listing, so the zip is not this directory's current content.
 * - `missing`: listed names the zip lacks; the handoff fetches them.
 * - A kept directory with no zip children and an empty listing leaves the
 *   charged set and joins its parent's `handoffEmpty` set: an empty listing is
 *   also what a file path gives, so the walk decides (G-F7).
 *
 * A kept directory (or the root) with no entry in `listings` is treated as an
 * empty listing; any zip child of it is then a mismatch, which is the safe
 * outcome.
 *
 * @param filtered - Output of `filterStaging`.
 * @param listings - Directory path (`''` = root) -> normalised listed names.
 * @param options - Optional listed sizes and the per-file byte limit.
 * @returns The reconcile plan.
 */
export function planReconcile(
  filtered: FilteredStaging,
  listings: Map<string, string[]>,
  options: ReconcileOptions = {}
): ReconcilePlan {
  // Directory path -> names the zip has directly under it.
  const children = new Map<string, Set<string>>();
  for (const path of [...filtered.files.keys(), ...filtered.keptDirs, ...filtered.depthCut]) {
    const { parent, name } = splitParent(path);
    addTo(children, parent, name);
  }

  const listed = new Map<string, Set<string>>();
  for (const dir of ['', ...filtered.keptDirs]) {
    listed.set(dir, new Set(listings.get(dir) ?? []));
  }

  let mismatch = false;
  for (const [dir, names] of children) {
    const have = listed.get(dir) ?? new Set<string>();
    for (const name of names) {
      if (!have.has(name)) {
        mismatch = true;
      }
    }
  }

  const missing = new Map<string, Set<string>>();
  for (const [dir, names] of listed) {
    const zipNames = children.get(dir);
    for (const name of names) {
      if (zipNames?.has(name) !== true) {
        addTo(missing, dir, name);
      }
    }
  }

  const handoffEmpty = new Map<string, Set<string>>();
  const keptDirsToCharge = new Set<string>();
  for (const dir of filtered.keptDirs) {
    const noZipChildren = (children.get(dir)?.size ?? 0) === 0;
    const emptyListing = (listed.get(dir)?.size ?? 0) === 0;
    if (noZipChildren && emptyListing) {
      const { parent, name } = splitParent(dir);
      addTo(handoffEmpty, parent, name);
    } else {
      keptDirsToCharge.add(dir);
    }
  }

  let listedOverLimit = false;
  const { sizes, maxFileBytes } = options;
  if (sizes !== undefined && maxFileBytes !== undefined) {
    for (const [dir, bySize] of sizes) {
      if (!listed.has(dir)) {continue;}
      for (const size of bySize.values()) {
        if (size > maxFileBytes) {
          listedOverLimit = true;
        }
      }
    }
  }

  return { mismatch, listedOverLimit, missing, handoffEmpty, keptDirsToCharge };
}
