import { describe, it, expect } from 'vitest';
import {
  KNOWN_COURSE_SETTING_KEYS,
  KNOWN_ASSIGNMENT_SETTING_KEYS,
  KNOWN_PART_SETTING_KEYS,
  NON_SETTING_FIELDS_COURSE,
  NON_SETTING_FIELDS_ASSIGNMENT,
  NON_SETTING_FIELDS_PART,
  partitionApiResponse,
} from '../../src/utils/known-settings';

describe('partitionApiResponse', () => {
  it('routes known keys to knownFields', () => {
    const result = partitionApiResponse(
      { session_length: '60', labtype: 'Document' },
      KNOWN_PART_SETTING_KEYS,
      NON_SETTING_FIELDS_PART
    );
    expect(result.knownFields).toEqual({ session_length: '60', labtype: 'Document' });
    expect(result.unknownFields).toEqual({});
  });

  it('routes unknown keys to unknownFields', () => {
    const result = partitionApiResponse(
      { session_length: '60', new_vocareum_flag: true },
      KNOWN_PART_SETTING_KEYS,
      NON_SETTING_FIELDS_PART
    );
    expect(result.knownFields).toEqual({ session_length: '60' });
    expect(result.unknownFields).toEqual({ new_vocareum_flag: true });
  });

  it('drops non-settings keys entirely', () => {
    const result = partitionApiResponse(
      { id: '1', courseid: '2', assignmentid: '3', seqnum: '0', deleted: '0', part_url: 'x', name: 'P', description: 'D', session_length: '60' },
      KNOWN_PART_SETTING_KEYS,
      NON_SETTING_FIELDS_PART
    );
    expect(result.knownFields).toEqual({ session_length: '60' });
    expect(result.unknownFields).toEqual({});
  });

  it('routes a key to unknown when it is neither known nor non-setting', () => {
    const result = partitionApiResponse(
      { totally_new: 'x' },
      KNOWN_ASSIGNMENT_SETTING_KEYS,
      NON_SETTING_FIELDS_ASSIGNMENT
    );
    expect(result.unknownFields).toEqual({ totally_new: 'x' });
  });
});

describe('per-scope set invariants', () => {
  const scopes: Array<[string, ReadonlySet<string>, ReadonlySet<string>]> = [
    ['course', KNOWN_COURSE_SETTING_KEYS, NON_SETTING_FIELDS_COURSE],
    ['assignment', KNOWN_ASSIGNMENT_SETTING_KEYS, NON_SETTING_FIELDS_ASSIGNMENT],
    ['part', KNOWN_PART_SETTING_KEYS, NON_SETTING_FIELDS_PART],
  ];

  it.each(scopes)('%s: known and non-settings sets are disjoint', (_name, known, nonSettings) => {
    const intersection = [...known].filter((k) => nonSettings.has(k));
    expect(intersection).toEqual([]);
  });

  it.each(scopes)('%s: _unknown_settings is not in either set', (_name, known, nonSettings) => {
    expect(known.has('_unknown_settings')).toBe(false);
    expect(nonSettings.has('_unknown_settings')).toBe(false);
  });
});

describe('initial set contents', () => {
  it('course KNOWN set is {name, description} (defined for deferred phase)', () => {
    expect([...KNOWN_COURSE_SETTING_KEYS].sort()).toEqual(['description', 'name']);
  });

  it('assignment KNOWN set matches mapAssignmentSettings keys', () => {
    expect([...KNOWN_ASSIGNMENT_SETTING_KEYS].sort()).toEqual([
      'anonymous_grading', 'auto_submit', 'copy_startercode', 'description',
      'exam_duration', 'exam_mode', 'grading_on_submit', 'grading_visibility',
      'live_code_comments', 'noworkarea', 'nosubmit', 'num_attempts',
      'publish', 'publish_grades', 'send_webhook', 'show_end_exam_button',
      'uncompressupload', 'lti_on',
    ].sort());
  });

  it('part KNOWN set matches mapPartSettings keys', () => {
    expect([...KNOWN_PART_SETTING_KEYS].sort()).toEqual([
      'cloud_labs', 'container_image', 'databricks_maxusers', 'deadlinedate',
      'endlab', 'instant_aws_access', 'lab_interface', 'labtype',
      'late_penalty_percent', 'late_penalty_percent_rule', 'monthly_dollar',
      'monthly_time', 'number_of_submissions', 'session_length',
      'submission_filters', 'tags', 'total_dollar', 'total_time',
    ].sort());
  });
});

describe('publisher hand-written settings arrays exclude _unknown_settings', () => {
  it('publisher.ts does not include _unknown_settings in its keyof-typed arrays', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../src/core/publisher.ts', import.meta.url),
      'utf8'
    );
    const assignmentKeysMatch = src.match(/assignmentKeys:\s*\(keyof[\s\S]*?\)\[\]\s*=\s*\[([\s\S]*?)\];/);
    const partKeysMatch = src.match(/partKeys:\s*\(keyof[\s\S]*?\)\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(assignmentKeysMatch).not.toBeNull();
    expect(partKeysMatch).not.toBeNull();
    expect(assignmentKeysMatch![1]).not.toContain('_unknown_settings');
    expect(partKeysMatch![1]).not.toContain('_unknown_settings');
  });
});
