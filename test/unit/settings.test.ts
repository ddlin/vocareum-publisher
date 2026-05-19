/**
 * Settings mapping tests — API response shape coercion.
 */

import { describe, it, expect } from 'vitest';
import { mapAssignmentSettings, mapPartSettings } from '../../src/utils/settings';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../../src/types/api';

function baseResponse(extra: Partial<VocareumAssignmentResponse>): VocareumAssignmentResponse {
  return {
    id: '1',
    courseid: '1',
    name: 'Test',
    deleted: '0',
    ...extra,
  } as VocareumAssignmentResponse;
}

describe('mapAssignmentSettings lti_on coercion', () => {
  it('coerces lti_on "1" to true (Vocareum returns it as a string)', () => {
    const result = mapAssignmentSettings(
      baseResponse({ lti_on: '1' })
    );
    expect(result.lti_on).toBe(true);
  });

  it('coerces lti_on "0" to false', () => {
    const result = mapAssignmentSettings(
      baseResponse({ lti_on: '0' })
    );
    expect(result.lti_on).toBe(false);
  });

  it('passes through real boolean true', () => {
    const result = mapAssignmentSettings(baseResponse({ lti_on: true }));
    expect(result.lti_on).toBe(true);
  });

  it('passes through real boolean false', () => {
    const result = mapAssignmentSettings(baseResponse({ lti_on: false }));
    expect(result.lti_on).toBe(false);
  });

  it('leaves lti_on unset when API omits it', () => {
    const result = mapAssignmentSettings(baseResponse({}));
    expect(result.lti_on).toBeUndefined();
  });
});

describe('mapPartSettings tag handling', () => {
  it('preserves numeric tag values returned by Vocareum', () => {
    const result = mapPartSettings({
      id: 'p1',
      courseid: 'c1',
      assignmentid: 'a1',
      name: 'Part 1',
      seqnum: '0',
      deleted: '0',
      tags: {
        average_lab_time: 240,
      },
    } as VocareumPartResponse);

    expect(result.tags).toEqual({ average_lab_time: 240 });
  });
});
