/**
 * The zip path for one declared directory of a part (spec "Per directory
 * (inside `downloadContent`)", steps 1–9). `downloadContent` calls
 * `tryZipDirectory` before the walk: `'used'` means the directory is done
 * (committed, with any missing names handed to the walk; or found empty at
 * step 1, which ends exactly as the walk of an empty listing ends); `'walk'`
 * means the caller walks it exactly as today.
 *
 * I5: nothing here touches the FileMap, the budget, failures or managed links
 * before step 9 (commit). The only run state written on a fallback is the
 * part's seen-ETag set and its quarantine flag, and both only make later zip
 * attempts more conservative.
 */
import type { AxiosInstance } from 'axios';
import { sanitizeLogString, type VocareumClient } from './client';
import { listDirectoryBounded, type DownloadBudget } from './content';
import { createDeadline, type Deadline } from './deadline';
import { runZipJob } from './zip-job';
import { downloadPinned, pinObject, settleCheck, type ZipObjectContext } from './zip-object';
import { readZip } from './zip-reader';
import { filterStaging, planReconcile } from './zip-reconcile';
import { warnEvent, zipNotUsedDiagnostic, type ZipNotUsedReason } from '../core/diagnostics';
import type { DirectoryType } from '../types/config';
import type { FileInfo, FileMap } from '../types/api';

/**
 * Zip state of one part for one `downloadContent` call. Directories of a part
 * run strictly one after another, so a start is never sent while another
 * directory of the part is in steps 2–9.
 */
export interface ZipPartState {
  /** Set once any outcome after a start request was not "used"; no further zip for this part. */
  quarantined: boolean;
  /** ETags pinned for this part (exact header strings), whether or not the zip was used. */
  seen: Set<string>;
}

/** A fresh, unquarantined part state. */
export function newZipPartState(): ZipPartState {
  return { quarantined: false, seen: new Set() };
}

/** What `downloadContent` provides so the commit and handoff are exactly the walk's. */
export interface ZipDirectoryArgs {
  client: VocareumClient;
  courseId: string;
  assignmentId: string;
  partId: string;
  directory: DirectoryType;
  /** The prefixed directory, e.g. `/voc/startercode`. */
  baseApiPath: string;
  downloaded: FileMap;
  budget: DownloadBudget;
  /** The step 2–6 deadline length, from `VOCAREUM_ZIP_TIMEOUT_MS`. */
  timeoutMs: number;
  /** The monotonic clock. */
  now: () => number;
  /** A bare axios instance for S3; never the client's. */
  http: AxiosInstance;
  state: ZipPartState;
  /** True when the error is the API's "doesn't exist" answer for `apiDirPath`. */
  isMissingDirectory: (error: unknown, apiDirPath: string) => boolean;
  /** The walk's per-entry logic for one directory, restricted to the `only` names. */
  walk: (relativePath: string, depth: number, preListed: FileInfo[], only: ReadonlySet<string>) => Promise<void>;
}

/** One trailing `/` removed: the normalisation every zip-path rule uses (spec step 5). */
export function normaliseListedName(name: string): string {
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

function segments(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

/** A directory's listing read for the zip path: raw entries for the walk, normalised names for reconcile. */
interface ReadListing {
  entries: FileInfo[];
  names: string[];
  sizes: Map<string, number>;
}

/**
 * Read one listing with the bounded collector. Names are deduplicated (the
 * collector keeps repeats) and normalised; the raw entries keep the listing's
 * own spelling, so a handoff walks exactly what the walk would have listed.
 */
async function readBounded(
  args: ZipDirectoryArgs, apiDirPath: string, counter: { remaining: number },
): Promise<ReadListing | 'over_budget'> {
  const listed = await listDirectoryBounded(
    args.client, args.courseId, args.assignmentId, args.partId, apiDirPath, counter,
  );
  if (!listed.complete) { return 'over_budget'; }
  const entries: FileInfo[] = [];
  const names = new Set<string>();
  const sizes = new Map<string, number>();
  const raw = new Set<string>();
  for (const name of listed.names) {
    if (raw.has(name)) { continue; }
    raw.add(name);
    const size = listed.sizes.get(name) ?? 0;
    entries.push({ path: name, size });
    const normalised = normaliseListedName(name);
    names.add(normalised);
    sizes.set(normalised, Math.max(size, sizes.get(normalised) ?? 0));
  }
  return { entries, names: [...names], sizes };
}

/**
 * Try to download one directory as one verified zip (spec steps 1–9).
 *
 * Emits exactly one `zip_not_used` for a directory that falls back, except an
 * empty directory (done) or a missing one (walked, which warns as today). A part
 * already quarantined gets one with reason `quarantined` per later directory.
 *
 * Errors thrown by the commit or the handoff (a strict-mode failure, a walk
 * limit) propagate exactly as the walk's do.
 *
 * @returns `'used'` when the directory is done (committed, or empty at step 1);
 *   `'walk'` when the caller must walk it
 */
export async function tryZipDirectory(args: ZipDirectoryArgs): Promise<'used' | 'walk'> {
  const { client, partId, directory, baseApiPath, budget, state } = args;
  const limits = budget.limits;

  const notUsed = (reason: ZipNotUsedReason, quarantines: boolean): 'walk' => {
    if (quarantines) { state.quarantined = true; }
    client.events.emit(warnEvent(
      `Not using the zip download for ${directory}/ of part ${partId} (${reason}); downloading it file by file`,
      zipNotUsedDiagnostic(partId, directory, reason, quarantines),
    ));
    return 'walk';
  };

  if (state.quarantined) { return notUsed('quarantined', false); }

  // Step 1: list the top level. Nothing is started yet, so nothing here quarantines.
  let top: ReadListing | 'over_budget';
  try {
    top = await readBounded(args, baseApiPath, { remaining: limits.maxFiles - budget.files });
  } catch (error) {
    // A missing directory keeps today's handling, silently here: the walk
    // lists it again and decides. The bounded collector cannot say which page
    // answered "doesn't exist", and only page 0 means absent; a later page
    // means names were already read, which the walk reports as an error.
    if (args.isMissingDirectory(error, baseApiPath)) { return 'walk'; }
    return notUsed('listing_failed', false);
  }
  if (top === 'over_budget') { return notUsed('listing_over_budget', false); }
  // Empty: stop. A zip request for it would never finish (Elite), and the walk
  // of an empty listing does nothing, so the directory is done.
  if (top.names.length === 0) { return 'used'; }
  for (const size of top.sizes.values()) {
    if (size > limits.maxFileBytes) { return notUsed('listed_size_over_limit', false); }
  }

  // From the start request on, any outcome but "used" quarantines the part:
  // a job of ours may still be writing the shared object.
  const deadline = createDeadline(args.timeoutMs, args.now);
  try {
    let prepared: Prepared | ZipNotUsedReason;
    try {
      prepared = await prepareZip(args, deadline);
    } catch (error) {
      // Every step reports its own reason; a throw is a defect or an
      // unforeseen answer. Nothing was committed (I5), and a job of ours may
      // still be writing, so it is a rejection like any other. Only the
      // sanitised message is kept: an S3 axios error carries the signed URL
      // in config.url, and a message may quote it.
      const message = error instanceof Error ? error.message : String(error);
      client.events.emit({
        level: 'debug',
        message: `Zip download of ${directory}/ of part ${partId} failed unexpectedly: ${sanitizeLogString(message)}`,
      });
      prepared = 'zip_invalid';
    }
    if (typeof prepared === 'string') { return notUsed(prepared, true); }
    const { filtered, plan, listings, count, bytes } = prepared;

    // Step 9: commit, then hand the missing names to the walk.
    budget.files += count;
    budget.bytes += bytes;
    for (const [path, buf] of filtered.files) { args.downloaded[`${directory}/${path}`] = buf; }
    // Depth-cut directories go to the walk with the missing names: the zip saw
    // them only as a prefix of deeper entries, so a name that is now a file
    // must still be fetched; the walk records a real cut itself.
    const handoff = new Map<string, Set<string>>();
    for (const source of [plan.missing, plan.handoffEmpty, plan.handoffDepthCut]) {
      for (const [dir, names] of source) {
        const set = handoff.get(dir) ?? new Set<string>();
        for (const name of names) { set.add(name); }
        handoff.set(dir, set);
      }
    }
    for (const dir of [...handoff.keys()].sort()) {
      // preListed is the full step-7 listing: the cycle comparison needs it whole.
      const entries = listings.get(dir)?.entries ?? [];
      await args.walk(dir, segments(dir), entries, handoff.get(dir)!);
    }
    return 'used';
  } finally {
    // The deadline bounds steps 2–6 only; its timer must not outlive the directory.
    deadline.dispose();
  }
}

/** Steps 2–8 passed: everything step 9 commits and hands off. Nothing is committed yet. */
interface Prepared {
  filtered: ReturnType<typeof filterStaging>;
  plan: ReturnType<typeof planReconcile>;
  listings: Map<string, ReadListing>;
  count: number;
  bytes: number;
}

/**
 * Steps 2–8 for one directory. Writes nothing but the part's seen-ETag set
 * (inside `pinObject`); returns the plan to commit, or why the zip is not used.
 */
async function prepareZip(
  args: ZipDirectoryArgs, deadline: Deadline,
): Promise<Prepared | ZipNotUsedReason> {
  const { client, partId, baseApiPath, budget, state } = args;
  const limits = budget.limits;

  // Steps 2–3: start, poll, check the URL.
  const job = await runZipJob(
    client, { courseId: args.courseId, assignmentId: args.assignmentId, partId }, baseApiPath, deadline, args.now,
  );
  if ('reason' in job) { return job.reason; }

  // Step 4: pin, then download. Step 4a: settle, before inflation.
  const ctx: ZipObjectContext = {
    now: args.now,
    http: args.http,
    deadline,
    maxBytes: limits.maxTotalBytes - budget.bytes,
    seen: state.seen,
    jobStart: job.jobStart,
    success: job.success,
  };
  const pinned = await pinObject(job.url, ctx);
  if ('reason' in pinned) { return pinned.reason; }
  const body = await downloadPinned(job.url, pinned.sample, ctx);
  if (!Buffer.isBuffer(body)) { return body.reason; }
  const settled = await settleCheck(job.url, pinned.sample, ctx);
  if (settled !== true) { return settled.reason; }

  // Step 5: read into a staging area, under the remaining budget.
  const staging = await readZip(body, {
    maxEntries: limits.maxFiles - budget.files,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes - budget.bytes,
    signal: deadline.signal,
  });
  if ('reason' in staging) { return staging.reason; }

  // Step 6: filter the way the walk sees the tree.
  const filtered = filterStaging(staging);
  if (filtered.cyclePattern) { return 'cycle_pattern'; }

  // Step 7: re-list every kept directory and the root, one running total across all.
  const counter = { remaining: limits.maxFiles - budget.files };
  const listings = new Map<string, ReadListing>();
  const keptInOrder = [...filtered.keptDirs].sort();
  for (const dir of ['', ...keptInOrder]) {
    let listing: ReadListing | 'over_budget';
    try {
      listing = await readBounded(args, dir === '' ? baseApiPath : `${baseApiPath}/${dir}`, counter);
    } catch {
      return 'listing_failed';
    }
    if (listing === 'over_budget') { return 'listing_over_budget'; }
    listings.set(dir, listing);
  }
  const plan = planReconcile(
    filtered,
    new Map([...listings].map(([dir, l]) => [dir, l.names])),
    { sizes: new Map([...listings].map(([dir, l]) => [dir, l.sizes])), maxFileBytes: limits.maxFileBytes },
  );
  if (plan.mismatch) { return 'name_mismatch'; }
  if (plan.listedOverLimit) { return 'listed_size_over_limit'; }

  // Step 8: the commit must fit. Missing names and depth-cut directories are
  // not pre-charged: the handoff charges them once, and trips a limit exactly
  // as the walk does.
  let bytes = 0;
  for (const buf of filtered.files.values()) { bytes += buf.length; }
  const count = filtered.files.size + plan.keptDirsToCharge.size;
  if (budget.files + count > limits.maxFiles || budget.bytes + bytes > limits.maxTotalBytes) {
    return 'budget';
  }
  return { filtered, plan, listings, count, bytes };
}
