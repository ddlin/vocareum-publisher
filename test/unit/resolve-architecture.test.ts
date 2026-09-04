/**
 * Regression: the push path must resolve workspace architecture the same way
 * the pull path does.
 *
 * `getDownloadPlan` (pull) falls back to `detectArchitecture(labtype)` when the
 * config carries no explicit `vocareum.architecture`. The push path read that
 * config field directly with no fallback — and no real config sets it (checked
 * across courses 102668, 229259 and 229473, all `undefined`). So every Elite
 * course got the Container path mapping on push: `listFiles` and `deleteFile`
 * during sync-deletes asked for `/voc/scripts`, which does not exist on Elite,
 * got an empty listing, and silently found nothing to delete.
 *
 * Not destructive — an empty remote listing means no deletions are planned, not
 * wrong ones — but inert on exactly the courses the Elite path fix was for.
 * Extracting one resolver keeps the two paths from drifting again.
 */

import { describe, it, expect } from 'vitest';
import { resolveArchitecture } from '../../src/types/config';

describe('resolveArchitecture', () => {
  it('derives elite from the labtype when config does not say', () => {
    expect(resolveArchitecture(undefined, 'Vocareum Elite')).toBe('elite');
    expect(resolveArchitecture(undefined, 'Vocareum Standard')).toBe('elite');
  });

  it('derives container from the labtype when config does not say', () => {
    expect(resolveArchitecture(undefined, 'Vocareum Notebook')).toBe('container');
    expect(resolveArchitecture(undefined, 'Databricks')).toBe('container');
  });

  it('lets an explicit config value win over the labtype', () => {
    // An operator who set the field meant it; labtype detection is the fallback,
    // not an override.
    expect(resolveArchitecture('container', 'Vocareum Elite')).toBe('container');
    expect(resolveArchitecture('elite', 'Vocareum Notebook')).toBe('elite');
  });

  it('returns undefined when neither source says anything', () => {
    // Callers then fall back to the union directory set / container paths, which
    // is the pre-existing behaviour for configs with no labtype recorded.
    expect(resolveArchitecture(undefined, undefined)).toBeUndefined();
    expect(resolveArchitecture(undefined, null)).toBeUndefined();
    expect(resolveArchitecture(undefined, '')).toBeUndefined();
  });
});
