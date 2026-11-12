/**
 * Course root classification: the evidence behind the push guard that refuses
 * `asnlib` on Container courses. Pure; fetching is injected so this module
 * needs no logger, config or client.
 */
import { sanitizeLogString } from '../api/client';

/** What the root listing of a course proves. */
export type RootEvidence =
  | { kind: 'elite' }
  | { kind: 'container' }
  | { kind: 'unknown'; detail: string };

/** Bounded-listing result, as produced by `listDirectoryBounded`. */
export interface RootListing {
  rawPages: unknown[][];
  complete: boolean;
}

/** More names than this is not evidence (mirrors the bounded collector's cap). */
const MAX_ROOT_NAMES = 1000;

const unknown = (detail: string): RootEvidence => ({ kind: 'unknown', detail });

/**
 * The one name a raw element yields, or a reason it does not.
 * The selection mirrors `parseFileListResponse` (`path ?? filename ?? name`)
 * so the guard sees exactly what the parser would select; it is stricter in
 * that anything the parser would skip, or any disagreeing string field, refuses.
 */
function elementName(el: unknown): { name: string } | { reason: string } {
  if (typeof el === 'string') {
    return el.length > 0 ? { name: el } : { reason: 'an empty name' };
  }
  if (el === null || typeof el !== 'object' || Array.isArray(el)) {
    return { reason: 'an entry that is not a name' };
  }
  const e = el as { path?: unknown; filename?: unknown; name?: unknown };
  const selected = e.path ?? e.filename ?? e.name;
  if (typeof selected !== 'string' || selected.length === 0) {
    return { reason: 'an entry without a usable name' };
  }
  for (const other of [e.path, e.filename, e.name]) {
    if (typeof other === 'string' && other !== selected) {
      return { reason: 'an entry whose name fields disagree' };
    }
  }
  return { name: selected };
}

const ELITE = ['resource', 'work'];
const CONTAINER = ['resource', 'voc', 'work'];

/**
 * Classifies a course root listing on positive evidence only.
 *
 * Elite is exactly {resource, work}; Container exactly {resource, voc, work}.
 * The names are compared as a set, so duplicates collapse
 * (`['resource','work','work']` is still Elite). Anything else, an incomplete
 * listing, or over 1,000 names is `unknown`.
 *
 * @param rawPages - Raw response elements of each non-empty page.
 * @param complete - Whether the collector read to the end.
 */
export function classifyCourseRoot(rawPages: unknown[][], complete: boolean): RootEvidence {
  if (!complete) { return unknown('the root listing was not read to the end'); }
  const names = new Set<string>();
  let count = 0;
  for (const page of rawPages) {
    for (const el of page) {
      count += 1;
      if (count > MAX_ROOT_NAMES) {
        return unknown(`the root listing has more than ${MAX_ROOT_NAMES} names`);
      }
      const r = elementName(el);
      if ('reason' in r) { return unknown(`the root listing contains ${r.reason}`); }
      // One trailing slash only; a leading slash is evidence of a different shape.
      names.add(r.name.endsWith('/') ? r.name.slice(0, -1) : r.name);
    }
  }
  const sameSet = (want: string[]): boolean => names.size === want.length && want.every((n) => names.has(n));
  if (sameSet(ELITE)) { return { kind: 'elite' }; }
  if (sameSet(CONTAINER)) { return { kind: 'container' }; }
  const shown = [...names].slice(0, 10).map((n) => JSON.stringify(n)).join(', ');
  return unknown(`the course root lists [${shown}${names.size > 10 ? ', ...' : ''}], which matches neither a known Elite nor Container root`);
}

/**
 * Resolves the root evidence for a course, one lookup per course per run
 * (failures are cached too).
 *
 * @param list - Injected root lister for a part ID.
 * @param evidencePartId - A part of the destination course, if any exists.
 * @param cache - Per-run cache keyed by course ID.
 * @param courseId - The destination course ID (string).
 */
export async function resolveCourseRootEvidence(
  list: (partId: string) => Promise<RootListing>,
  evidencePartId: string | undefined,
  cache: Map<string, RootEvidence>,
  courseId: string,
): Promise<RootEvidence> {
  const cached = cache.get(courseId);
  if (cached) { return cached; }
  // Not cached: a later caller in the same run may have a part to offer.
  if (evidencePartId === undefined) {
    return unknown('no part of this course existed to check');
  }
  let result: RootEvidence;
  try {
    const { rawPages, complete } = await list(evidencePartId);
    result = classifyCourseRoot(rawPages, complete);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = unknown(`the course root listing failed: ${sanitizeLogString(message)}`);
  }
  cache.set(courseId, result);
  return result;
}
