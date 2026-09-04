/**
 * Settings mapping tests — API response shape coercion.
 */

import { describe, it, expect, vi } from 'vitest';
import { mapAssignmentSettings, mapPartSettings } from '../../src/utils/settings';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../../src/types/api';
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';
import {
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  OBSERVED_ASSIGNMENT_SETTING_KEYS,
  OBSERVED_PART_SETTING_KEYS,
} from '../../src/utils/known-settings';

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

const noopLogger = { warn: () => {}, plain: () => {} };

describe('mapAssignmentSettings — unknown settings preservation', () => {
  it('attaches unknown fields under _unknown_settings', () => {
    const result = mapAssignmentSettings(
      baseResponse({ nosubmit: true, vendor_field: 'abc' } as never)
    );
    expect(result._unknown_settings).toEqual({ vendor_field: 'abc' });
    expect(result.nosubmit).toBe(true);
  });

  it('does not add _unknown_settings when all response keys are known or non-settings', () => {
    const result = mapAssignmentSettings(baseResponse({ nosubmit: true }));
    expect(result._unknown_settings).toBeUndefined();
  });

  it('does not route non-settings fields (id, courseid, name, due_date, deleted, published) into _unknown_settings', () => {
    const result = mapAssignmentSettings(
      baseResponse({
        nosubmit: true,
        due_date: '2026-01-01',
        points: '100',
        published: '1',
      } as never)
    );
    expect(result._unknown_settings).toBeUndefined();
  });

  it('drops lti_url (server-derived LTI launch URL) without routing it into _unknown_settings', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    const spy = vi.spyOn(reporter, 'record');
    const result = mapAssignmentSettings(
      baseResponse({
        nosubmit: true,
        lti_url: 'https://labs.vocareum.com/lti/vclab.php?course=vc_x&assignment=1',
      } as never),
      reporter,
      'a-1'
    );
    expect(result._unknown_settings).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports each unknown field once to the reporter', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    const spy = vi.spyOn(reporter, 'record');
    mapAssignmentSettings(
      baseResponse({ vendor_field: 'abc', other_new: 1 } as never),
      reporter,
      'a-1'
    );
    expect(spy).toHaveBeenCalledWith('assignment', 'vendor_field', 'abc', 'a-1');
    expect(spy).toHaveBeenCalledWith('assignment', 'other_new', 1, 'a-1');
  });
});

describe('mapAssignmentSettings — observed settings preservation', () => {
  it('attaches known-but-not-writable fields under _observed_settings', () => {
    const result = mapAssignmentSettings(
      baseResponse({
        description: 'Remote description',
        exam_duration: 45,
        nosubmit: true,
      } as never)
    );
    expect(result.nosubmit).toBe(true);
    expect(result.description).toBeUndefined();
    expect(result._observed_settings).toEqual({
      description: 'Remote description',
    });
    expect(result.exam_duration).toBe(45);
    expect(result._unknown_settings).toBeUndefined();
  });
});

function basePart(extra: Partial<VocareumPartResponse>): VocareumPartResponse {
  return {
    id: 'p1',
    courseid: 'c1',
    assignmentid: 'a1',
    name: 'Part',
    seqnum: '0',
    deleted: '0',
    ...extra,
  } as VocareumPartResponse;
}

describe('mapPartSettings — unknown settings preservation', () => {
  it('attaches unknown fields under _unknown_settings', () => {
    const result = mapPartSettings(
      basePart({ session_length: '60', mystery: true } as never)
    );
    expect(result._unknown_settings).toEqual({ mystery: true });
    expect(result.session_length).toBe('60');
  });

  it('does not route non-settings fields (id, courseid, assignmentid, name, description, seqnum, deleted, part_url) into _unknown_settings', () => {
    const result = mapPartSettings(
      basePart({ session_length: '60', description: 'D', part_url: 'x' } as never)
    );
    expect(result._unknown_settings).toBeUndefined();
  });

  it('reports each unknown field once to the reporter', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    const spy = vi.spyOn(reporter, 'record');
    mapPartSettings(
      basePart({ mystery: true, extra: 'x' } as never),
      reporter,
      'p-1'
    );
    expect(spy).toHaveBeenCalledWith('part', 'mystery', true, 'p-1');
    expect(spy).toHaveBeenCalledWith('part', 'extra', 'x', 'p-1');
  });
});

describe('mapPartSettings — observed settings preservation', () => {
  it('attaches non-writable description under _observed_settings and keeps accepted-unverified fields writable', () => {
    const result = mapPartSettings(
      basePart({
        description: 'Remote part description',
        late_penalty_percent: 10,
        session_length: '60',
      } as never)
    );
    expect(result.session_length).toBe('60');
    expect(result.late_penalty_percent).toBe(10);
    expect(result._observed_settings).toEqual({
      description: 'Remote part description',
    });
    expect(result._unknown_settings).toBeUndefined();
  });
});

describe('source-of-truth: every key in KNOWN_*_SETTING_KEYS is actually read by its mapper', () => {
  it('mapAssignmentSettings reads every KNOWN_ASSIGNMENT_SETTING_KEYS entry', () => {
    const inputs: Record<string, unknown> = {};
    for (const k of KNOWN_ASSIGNMENT_SETTING_KEYS) {
      if (k === 'exam_mode') { inputs[k] = 'timed'; }
      else if (k === 'grading_visibility') { inputs[k] = 'all'; }
      else if (k === 'exam_duration' || k === 'num_attempts') { inputs[k] = 1; }
      else if (k === 'publish_grades') { inputs[k] = true; }
      else if (k === 'lti_on') { inputs[k] = '1'; }
      else { inputs[k] = true; }
    }
    const result = mapAssignmentSettings(baseResponse(inputs as never)) as Record<string, unknown>;
    for (const k of KNOWN_ASSIGNMENT_SETTING_KEYS) {
      expect(result, `mapAssignmentSettings did not copy "${k}" — KNOWN_ASSIGNMENT_SETTING_KEYS has drifted ahead of the mapper`).toHaveProperty(k);
    }
  });

  it('mapAssignmentSettings reads every OBSERVED_ASSIGNMENT_SETTING_KEYS entry into _observed_settings', () => {
    const inputs: Record<string, unknown> = {};
    for (const k of OBSERVED_ASSIGNMENT_SETTING_KEYS) {
      inputs[k] = k === 'description' ? 'x' : true;
    }
    const result = mapAssignmentSettings(baseResponse(inputs as never));
    for (const k of OBSERVED_ASSIGNMENT_SETTING_KEYS) {
      expect(result._observed_settings as Record<string, unknown>, `mapAssignmentSettings did not copy observed "${k}"`).toHaveProperty(k);
    }
  });

  it('no known assignment field leaks into _unknown_settings (drift detection inverse)', () => {
    // Build the same all-known-fields input the forward test uses. If a future
    // contributor adds a field to mapAssignmentSettings without adding it to
    // KNOWN_ASSIGNMENT_SETTING_KEYS or OBSERVED_ASSIGNMENT_SETTING_KEYS,
    // partition() will classify it as unknown and _unknown_settings will be
    // defined — failing this test.
    const inputs: Record<string, unknown> = {};
    for (const k of [...KNOWN_ASSIGNMENT_SETTING_KEYS, ...OBSERVED_ASSIGNMENT_SETTING_KEYS]) {
      if (k === 'exam_mode') { inputs[k] = 'timed'; }
      else if (k === 'grading_visibility') { inputs[k] = 'all'; }
      else if (k === 'exam_duration' || k === 'num_attempts') { inputs[k] = 1; }
      else if (k === 'publish_grades') { inputs[k] = true; }
      else if (k === 'description') { inputs[k] = 'x'; }
      else if (k === 'lti_on') { inputs[k] = '1'; }
      else { inputs[k] = true; }
    }
    const result = mapAssignmentSettings(baseResponse(inputs as never));
    expect(result._unknown_settings).toBeUndefined();
  });

  it('mapPartSettings reads every KNOWN_PART_SETTING_KEYS entry', () => {
    const inputs: Record<string, unknown> = {};
    for (const k of KNOWN_PART_SETTING_KEYS) {
      if (k === 'submission_filters') { inputs[k] = { include: ['*.py'] }; }
      else if (k === 'lab_interface') { inputs[k] = { panels: ['Html'] }; }
      else if (k === 'tags') { inputs[k] = { average_lab_time: 300 }; }
      else if (k === 'late_penalty_percent_rule') { inputs[k] = 'max score'; }
      else if (k === 'endlab') { inputs[k] = true; }
      else if (k === 'labtype' || k === 'container_image') { inputs[k] = 'x'; }
      else if (k === 'session_length' || k === 'monthly_dollar' || k === 'monthly_time' || k === 'total_time' || k === 'total_dollar' || k === 'deadlinedate') { inputs[k] = '60'; }
      else if (k === 'late_penalty_percent' || k === 'number_of_submissions' || k === 'databricks_maxusers') { inputs[k] = 1; }
      else { inputs[k] = true; }
    }
    const result = mapPartSettings(basePart(inputs as never)) as Record<string, unknown>;
    for (const k of KNOWN_PART_SETTING_KEYS) {
      expect(result, `mapPartSettings did not copy "${k}" — KNOWN_PART_SETTING_KEYS has drifted ahead of the mapper`).toHaveProperty(k);
    }
  });

  it('mapPartSettings reads every OBSERVED_PART_SETTING_KEYS entry into _observed_settings', () => {
    const inputs: Record<string, unknown> = {};
    for (const k of OBSERVED_PART_SETTING_KEYS) {
      inputs[k] = 'x';
    }
    const result = mapPartSettings(basePart(inputs as never));
    for (const k of OBSERVED_PART_SETTING_KEYS) {
      expect(result._observed_settings as Record<string, unknown>, `mapPartSettings did not copy observed "${k}"`).toHaveProperty(k);
    }
  });

  it('no known part field leaks into _unknown_settings (drift detection inverse)', () => {
    // Symmetric inverse for parts — see assignment-side test for rationale.
    const inputs: Record<string, unknown> = {};
    for (const k of [...KNOWN_PART_SETTING_KEYS, ...OBSERVED_PART_SETTING_KEYS]) {
      if (k === 'submission_filters') { inputs[k] = { include: ['*.py'] }; }
      else if (k === 'lab_interface') { inputs[k] = { panels: ['Html'] }; }
      else if (k === 'tags') { inputs[k] = { average_lab_time: 300 }; }
      else if (k === 'late_penalty_percent_rule') { inputs[k] = 'max score'; }
      else if (k === 'endlab') { inputs[k] = true; }
      else if (k === 'labtype' || k === 'container_image') { inputs[k] = 'x'; }
      else if (k === 'session_length' || k === 'monthly_dollar' || k === 'monthly_time' || k === 'total_time' || k === 'total_dollar' || k === 'deadlinedate') { inputs[k] = '60'; }
      else if (k === 'late_penalty_percent' || k === 'number_of_submissions' || k === 'databricks_maxusers') { inputs[k] = 1; }
      else { inputs[k] = true; }
    }
    const result = mapPartSettings(basePart(inputs as never));
    expect(result._unknown_settings).toBeUndefined();
  });
});

describe('mapper guard: reporter without resourceId', () => {
  it('mapAssignmentSettings throws if reporter is provided without resourceId', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    expect(() => mapAssignmentSettings(baseResponse({ nosubmit: true }), reporter)).toThrow(
      /resourceId is required/
    );
  });

  it('mapPartSettings throws if reporter is provided without resourceId', () => {
    const reporter = new UnknownFieldReporter(noopLogger);
    expect(() => mapPartSettings(basePart({ session_length: '60' }), reporter)).toThrow(
      /resourceId is required/
    );
  });
});

describe('mapPartSettings — submission_filters normalization', () => {
  it('normalizes array form of submission_filters to {include: [...]}', () => {
    const result = mapPartSettings(
      basePart({ submission_filters: ['*.py', '*.txt'] } as never)
    );
    expect(result.submission_filters).toEqual({ include: ['*.py', '*.txt'] });
  });

  it('preserves object form of submission_filters as-is', () => {
    const result = mapPartSettings(
      basePart({ submission_filters: { include: ['*.py'], exclude: ['*.pyc'] } } as never)
    );
    expect(result.submission_filters).toEqual({ include: ['*.py'], exclude: ['*.pyc'] });
  });

  it('returns undefined for empty array', () => {
    const result = mapPartSettings(basePart({ submission_filters: [] } as never));
    expect(result.submission_filters).toBeUndefined();
  });
});

// ── Derived point fields ─────────────────────────────────────────────────────
// max_points (part) and total_points (assignment) are computed by Vocareum from
// rubric maxscore and are not storable: a part PUT setting max_points returns a
// successful "Part updated" transaction and changes nothing, and an assignment PUT
// is rejected outright with "No valid parameters to update the assignment"
// (docs/vocareum-api-rubrics-findings.md §3). They belong in _observed_settings —
// recorded for the reader, never sent back.
describe('derived point fields are observed, not written', () => {
  it('mapPartSettings puts max_points under _observed_settings, not _unknown_settings', () => {
    const result = mapPartSettings({
      id: 'p1', courseid: 'c', assignmentid: 'a', name: 'Part 1', seqnum: '0', deleted: '0',
      max_points: '25',
    } as never);

    expect(result._observed_settings).toMatchObject({ max_points: '25' });
    expect(result._unknown_settings ?? {}).not.toHaveProperty('max_points');
  });

  it('mapAssignmentSettings puts total_points under _observed_settings, not _unknown_settings', () => {
    const result = mapAssignmentSettings({
      id: 'a1', courseid: 'c', name: 'Lab 1', total_points: '25',
    } as never);

    expect(result._observed_settings).toMatchObject({ total_points: '25' });
    expect(result._unknown_settings ?? {}).not.toHaveProperty('total_points');
  });

  it('omits max_points entirely when the API does not return it', () => {
    const result = mapPartSettings({
      id: 'p1', courseid: 'c', assignmentid: 'a', name: 'Part 1', seqnum: '0', deleted: '0',
    } as never);

    expect(result._observed_settings ?? {}).not.toHaveProperty('max_points');
  });
});
