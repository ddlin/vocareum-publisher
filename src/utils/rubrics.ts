/**
 * Rubric projection and comparison — pure helpers, no I/O.
 *
 * Comparison is POSITIONAL, not name-based. Both sides are seqnum-ordered, so
 * position is the server's own ordering. Name matching is what breaks on
 * duplicate criterion names and on renames (a rename reads as remove+add), and
 * on the read side nothing needs it: remote wins, so exact equality is the whole
 * question. describeRubricChanges does best-effort name matching for the
 * human-readable diff only — nothing acts on its output.
 */

import type { VocareumRubricResponse } from '../types/api';
import type { Rubric } from '../types/config';

export interface RubricChangeSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Project API rubric rows onto the config shape.
 *
 * Drops the server-assigned `id` — it is course-scoped and must not be carried
 * into a migrated course. Preserves input order (listRubrics already sorted).
 */
export function mapRubrics(apiRubrics: VocareumRubricResponse[]): Rubric[] {
  return apiRubrics.map((apiRubric) => {
    const rubric: Rubric = {
      name: apiRubric.name,
      seqnum: apiRubric.seqnum,
      maxscore: apiRubric.maxscore,
    };
    if (apiRubric.auto !== undefined) { rubric.auto = apiRubric.auto; }
    if (apiRubric.exclude !== undefined) { rubric.exclude = apiRubric.exclude; }
    return rubric;
  });
}

/** An omitted boolean flag means false — a hand-written config that leaves
 *  `auto` out must not read as drift against a remote that reports false. */
function flag(value: boolean | undefined): boolean {
  return value === true;
}

function rubricEqual(a: Rubric, b: Rubric): boolean {
  return a.name === b.name &&
    a.seqnum === b.seqnum &&
    a.maxscore === b.maxscore &&
    flag(a.auto) === flag(b.auto) &&
    flag(a.exclude) === flag(b.exclude);
}

/** True when the two seqnum-ordered lists are the same rubric, in the same order. */
export function rubricsEqual(a: Rubric[], b: Rubric[]): boolean {
  if (a.length !== b.length) { return false; }
  return a.every((rubric, i) => rubricEqual(rubric, b[i]));
}

/**
 * Best-effort added/removed/changed breakdown by criterion name, for display.
 * Duplicate names are handled by count: three "Correctness" rows locally and
 * four remotely yields one "added" entry.
 * A name can legitimately appear in more than one bucket when it is duplicated:
 * if one copy's values changed and another copy was added, the name lands in both
 * `changed` and `added`, because both are true of that name.
 */
export function describeRubricChanges(local: Rubric[], remote: Rubric[]): RubricChangeSummary {
  const byName = (list: Rubric[]): Map<string, Rubric[]> => {
    const map = new Map<string, Rubric[]>();
    for (const rubric of list) {
      const existing = map.get(rubric.name);
      if (existing) { existing.push(rubric); } else { map.set(rubric.name, [rubric]); }
    }
    return map;
  };

  const localByName = byName(local);
  const remoteByName = byName(remote);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, remoteList] of remoteByName) {
    const localList = localByName.get(name) ?? [];
    if (localList.length === 0) { added.push(name); continue; }
    const paired = Math.min(localList.length, remoteList.length);
    for (let i = 0; i < paired; i++) {
      if (!rubricEqual(localList[i], remoteList[i])) { changed.push(name); break; }
    }
    if (remoteList.length > localList.length) { added.push(name); }
  }

  for (const [name, localList] of localByName) {
    const remoteList = remoteByName.get(name) ?? [];
    if (remoteList.length < localList.length) { removed.push(name); }
  }

  return { added, removed, changed };
}
