import { compileExcludedPathMatcher, compileExcludedSubtreeMatcher } from '../utils/files';

/** Whether a remote entry is a directory (listing succeeded) or does not exist as one (a file). */
export type RemoteEntryKind = 'directory' | 'absent';

/** Outcome of screening delete candidates against the user's exclude_patterns. */
export interface ScreenedDeletes {
  /** Paths that are safe to delete. */
  deletable: string[];
  /** Directory entries kept because they may hold excluded content. */
  keptDirectories: string[];
  /** Entries whose probe failed: not deleted, and the caller must record a failure. */
  probeFailed: Array<{ path: string; reason: string }>;
}

/**
 * Screen remote-only paths before `--sync-deletes` acts on them.
 *
 * A path an exclude pattern matches (itself or an ancestor) is never deleted.
 * A path that only *could* hold excluded descendants (`venv` under `venv/*`) is
 * ambiguous: the listing has no type field, and a leading `**` would otherwise
 * shield every stale file. So the entry is probed as a directory: a directory is
 * kept, a file (the listing says it does not exist) is deleted, and any other
 * probe failure keeps the entry and is reported rather than guessed at.
 * Without user patterns nothing is probed and every candidate is deletable.
 *
 * @param candidates - Directory-relative remote paths missing locally
 * @param userPatterns - The user's exclude_patterns
 * @param probe - Lists the entry as a directory; throws on any failure other than "absent"
 * @returns The screened sets
 */
export async function screenExcludedDeletes(
  candidates: string[],
  userPatterns: string[],
  probe: (relativePath: string) => Promise<RemoteEntryKind>,
): Promise<ScreenedDeletes> {
  const result: ScreenedDeletes = { deletable: [], keptDirectories: [], probeFailed: [] };
  if (userPatterns.length === 0) {
    result.deletable = [...candidates];
    return result;
  }
  const isExcluded = compileExcludedPathMatcher(userPatterns);
  const mayHoldExcluded = compileExcludedSubtreeMatcher(userPatterns);
  for (const candidate of candidates) {
    if (isExcluded(candidate)) { continue; }
    if (!mayHoldExcluded(candidate)) {
      result.deletable.push(candidate);
      continue;
    }
    try {
      if ((await probe(candidate)) === 'directory') {
        result.keptDirectories.push(candidate);
      } else {
        result.deletable.push(candidate);
      }
    } catch (error) {
      result.probeFailed.push({ path: candidate, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
