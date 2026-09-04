import { describe, expect, it } from 'vitest';
import {
  shouldSyncAssignmentSettings,
  shouldSyncCourseSettings,
  shouldSyncPartSettings,
  shouldSyncRubrics,
} from '../../src/utils/settings-sync';

describe('settings sync precedence', () => {
  it.each([
    { global: undefined, assignment: undefined, expected: true, label: 'defaults to true' },
    { global: false, assignment: undefined, expected: false, label: 'global false applies' },
    { global: true, assignment: false, expected: false, label: 'assignment false beats global true' },
    { global: false, assignment: true, expected: true, label: 'assignment true beats global false' },
  ])('assignment settings: $label', ({ global, assignment, expected }) => {
    expect(
      shouldSyncAssignmentSettings(
        { publish_options: global === undefined ? undefined : { sync_settings: global } },
        { sync_settings: assignment }
      )
    ).toBe(expected);
  });

  it.each([
    { global: undefined, assignment: undefined, part: undefined, expected: true, label: 'defaults to true' },
    { global: false, assignment: undefined, part: undefined, expected: false, label: 'global false applies' },
    { global: true, assignment: false, part: undefined, expected: false, label: 'assignment false beats global true' },
    { global: false, assignment: true, part: undefined, expected: true, label: 'assignment true beats global false' },
    { global: true, assignment: false, part: true, expected: true, label: 'part true beats assignment false' },
    { global: false, assignment: true, part: false, expected: false, label: 'part false beats assignment true' },
    { global: true, assignment: undefined, part: false, expected: false, label: 'part false beats global true' },
    { global: false, assignment: undefined, part: true, expected: true, label: 'part true beats global false' },
  ])('part settings: $label', ({ global, assignment, part, expected }) => {
    expect(
      shouldSyncPartSettings(
        { publish_options: global === undefined ? undefined : { sync_settings: global } },
        { sync_settings: assignment },
        { sync_settings: part }
      )
    ).toBe(expected);
  });

  it.each([
    { global: undefined, expected: true, label: 'defaults to true' },
    { global: true, expected: true, label: 'global true applies' },
    { global: false, expected: false, label: 'global false applies' },
  ])('course settings: $label', ({ global, expected }) => {
    expect(
      shouldSyncCourseSettings(
        { publish_options: global === undefined ? undefined : { sync_settings: global } }
      )
    ).toBe(expected);
  });
});

describe('shouldSyncRubrics', () => {
  it('defaults to true when unset', () => {
    expect(shouldSyncRubrics({})).toBe(true);
    expect(shouldSyncRubrics({ publish_options: {} })).toBe(true);
  });

  it('honours an explicit false', () => {
    expect(shouldSyncRubrics({ publish_options: { sync_rubrics: false } })).toBe(false);
  });

  it('returns true on its own when only sync_settings is disabled', () => {
    // shouldSyncRubrics answers "is the rubric option on", not "will rubrics be
    // fetched". sync_settings is the outer gate — see the traversal test below.
    expect(shouldSyncRubrics({ publish_options: { sync_settings: false } })).toBe(true);
  });
});
