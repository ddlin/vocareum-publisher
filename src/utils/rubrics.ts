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

import type { VocareumRubricResponse, RubricCreate, RubricUpdate, RubricSyncPlan, RemoteRubric } from '../types/api';
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

function duplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) { dupes.add(n); } else { seen.add(n); }
  }
  return [...dupes].sort();
}

/**
 * Diff local rubric config against a part's remote rows.
 *
 * Names match EXACTLY — byte-for-byte, case-sensitive, no trimming. Vocareum criterion
 * names carry meaningful leading tags ("[Task 2] …"), and a fuzzy match that paired
 * "[Task 2] Foo" with "[Task 3] Foo" would update the wrong row's points. A near-miss is
 * better surfaced as a create plus an orphan, which the confirmation shows, than resolved
 * by a guess.
 *
 * Never produces deletions. A remote row with no local match is an orphan — most often a
 * rename, since name matching cannot see one — and because max_points is derived from
 * rubric maxscore, creating its replacement while the original remains inflates the part's
 * points. That is why orphans are surfaced rather than acted on.
 *
 * Duplicate names on either side make matching undefined, so the part is refused wholesale
 * rather than guessed at.
 */
export function planRubricSync(local: Rubric[], remote: RemoteRubric[]): RubricSyncPlan {
  // Duplicates are checked WITHIN each side, never across them. Concatenating first would
  // flag every ordinary local↔remote name match as a duplicate and refuse the part — which
  // is the normal case this function exists to handle.
  const duplicateNames = [...new Set([
    ...duplicates(local.map(r => r.name)),
    ...duplicates(remote.map(r => r.name)),
  ])].sort();
  if (duplicateNames.length > 0) {
    return { creates: [], updates: [], orphans: [], duplicateNames };
  }

  const remoteByName = new Map(remote.map(r => [r.name, r]));
  const localNames = new Set(local.map(r => r.name));

  // Create order is the only ordering control available: POST rejects seqnum and the
  // server assigns it by append order.
  const ordered = [...local].sort((a, b) => parseInt(a.seqnum, 10) - parseInt(b.seqnum, 10));

  const creates: RubricCreate[] = [];
  const updates: RubricUpdate[] = [];

  for (const rubric of ordered) {
    const match = remoteByName.get(rubric.name);
    if (!match) {
      const create: RubricCreate = { name: rubric.name, maxscore: rubric.maxscore };
      if (rubric.auto !== undefined) { create.auto = rubric.auto; }
      if (rubric.exclude !== undefined) { create.exclude = rubric.exclude; }
      creates.push(create);
      continue;
    }

    const update: RubricUpdate = { id: match.id };
    let changed = false;
    if (rubric.maxscore !== match.maxscore) { update.maxscore = rubric.maxscore; changed = true; }
    if (flag(rubric.auto) !== flag(match.auto)) { update.auto = flag(rubric.auto); changed = true; }
    if (flag(rubric.exclude) !== flag(match.exclude)) { update.exclude = flag(rubric.exclude); changed = true; }
    if (changed) { updates.push(update); }
  }

  const orphans = remote.filter(r => !localNames.has(r.name));

  return { creates, updates, orphans, duplicateNames: [] };
}

/**
 * The part's point total before and after the plan, using Vocareum's own rule:
 * Σ maxscore over criteria where exclude !== true.
 *
 * Shown in the push confirmation because "your points will go from 25 to 30" is the
 * sentence that makes the rename hazard legible; "1 orphan" is not. It is a projection
 * from plan-time remote state, not a promise — see the design spec §7b.
 *
 * Non-finite maxscores (from hand-edited vocareum.yaml like "N/A" or "") contribute 0
 * to the totals and are listed in `unparseable`. A non-empty unparseable list means the
 * totals are incomplete and should not be shown as a point projection.
 */
export function projectedPoints(
  remote: RemoteRubric[],
  plan: RubricSyncPlan
): { before: number; after: number; unparseable: string[] } {
  const unparseable = new Set<string>();

  const isValidMaxscore = (maxscore: string): boolean => {
    if (maxscore === '' || maxscore.trim() === '') { return false; }
    const num = Number(maxscore);
    return Number.isFinite(num);
  };

  const score = (maxscore: string, exclude: boolean | undefined): number => {
    if (flag(exclude)) { return 0; }
    if (!isValidMaxscore(maxscore)) { return 0; }
    return Number(maxscore);
  };

  // Check remote for unparseable maxscores
  for (const r of remote) {
    if (!isValidMaxscore(r.maxscore)) { unparseable.add(r.name); }
  }

  // Check plan creates for unparseable maxscores
  for (const c of plan.creates) {
    if (!isValidMaxscore(c.maxscore)) { unparseable.add(c.name); }
  }

  const before = remote.reduce((sum, r) => sum + score(r.maxscore, r.exclude), 0);

  const updateById = new Map(plan.updates.map(u => [u.id, u]));
  const afterExisting = remote.reduce((sum, r) => {
    const u = updateById.get(r.id);
    return sum + score(u?.maxscore ?? r.maxscore, u?.exclude ?? r.exclude);
  }, 0);
  const afterCreates = plan.creates.reduce((sum, c) => sum + score(c.maxscore, c.exclude), 0);

  return { before, after: afterExisting + afterCreates, unparseable: [...unparseable].sort() };
}
