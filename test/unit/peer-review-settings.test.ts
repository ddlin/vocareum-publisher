/**
 * Field report items #3 and #5 — scenario contract.
 *
 * Classification is from a live writability probe (test course 215500,
 * 2026-11-10), not field names:
 * - 12 peer-review assignment fields: writable → known, typed.
 * - part cleanup_time: writable on container labs → known.
 * - part container_image_id / container_image_label: ignored by a part PUT
 *   without labtype, validated against the labtype's image list with it, and
 *   tenant-scoped → observed only, never pushed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mapAssignmentSettings, mapPartSettings } from '../../src/utils/settings';
import { AssignmentSettingsSchema, PartSettingsSchema } from '../../src/types/config';
import type { Assignment, Part } from '../../src/types/config';
import { buildPartSettingsPayload, peerReviewPayload, RESERVED_PART_KEYS } from '../../src/core/payload-helpers';
import { detectAssignmentSettingsChanged, detectPartSettingsChanged } from '../../src/core/reconciler';
import { compareAssignmentSettings, comparePartSettings } from '../../src/core/services/pull-service';
import { loadConfig } from '../../src/core/config';
import type { VocareumAssignmentResponse, VocareumPartResponse } from '../../src/types/api';

/** What the API returned for CD15315 v2 (copy 6036045), peer review off. */
const API_PEER_DEFAULTS = {
  peer_review_toggle: false,
  peer_schedule_mode: 'MANUAL',
  peer_review_start_date: null,
  peer_review_end_date: null,
  peer_hide_code: false,
  peer_gallery: false,
  reviews_number: 1,
  peer_grading_toggle: false,
  reviewguide: '',
  reviewpenalty: 0,
  reviewpenalty_percentrule: 'STUDENT_SCORE',
  reviewcalc: 'AVERAGE',
};

function apiAssignment(extra: Record<string, unknown> = {}): VocareumAssignmentResponse {
  return { id: '6036045', name: 'CD15315 v2', courseid: '215500', ...API_PEER_DEFAULTS, ...extra } as unknown as VocareumAssignmentResponse;
}

function apiContainerPart(extra: Record<string, unknown> = {}): VocareumPartResponse {
  return {
    id: '6036046', name: 'Part 1', seqnum: '0', courseid: '215500', assignmentid: '6036045',
    labtype: 'Visual Studio Code', container_image: 'CD15315 v2',
    container_image_id: '3677', container_image_label: 'CD15315 v2: image_90_CD15315_32_v2',
    cleanup_time: '0', max_points: '0',
    ...extra,
  } as unknown as VocareumPartResponse;
}

describe('pull: peer-review fields arrive as typed, known settings', () => {
  it('maps all 12, none left in _unknown_settings', () => {
    const s = mapAssignmentSettings(apiAssignment());
    expect(s).toMatchObject(API_PEER_DEFAULTS);
    expect(s._unknown_settings).toBeUndefined();
  });

  it('normalizes enum spelling and coerces numeric strings', () => {
    const s = mapAssignmentSettings(apiAssignment({
      peer_schedule_mode: 'auto', reviewcalc: 'median', reviewpenalty_percentrule: 'max_score',
      reviews_number: '3', reviewpenalty: '5',
    }));
    expect(s).toMatchObject({
      peer_schedule_mode: 'AUTO', reviewcalc: 'MEDIAN', reviewpenalty_percentrule: 'MAX_SCORE',
      reviews_number: 3, reviewpenalty: 5,
    });
  });

  it('keeps a YYYY-MM-DD date and drops a value the server would never send back', () => {
    const s = mapAssignmentSettings(apiAssignment({
      peer_review_toggle: true, peer_review_start_date: '2026-12-01', peer_review_end_date: 'not a date',
    }));
    expect(s.peer_review_start_date).toBe('2026-12-01');
    expect(s).not.toHaveProperty('peer_review_end_date');
  });

  it('an enum value outside the known set is dropped, not written into a config that would then fail to load', () => {
    const s = mapAssignmentSettings(apiAssignment({ reviewcalc: 'GEOMETRIC_MEAN' }));
    expect(s).not.toHaveProperty('reviewcalc');
    expect(AssignmentSettingsSchema.safeParse(s).success).toBe(true);
  });

  it('the mapped settings always pass the schema (pull never writes an unloadable config)', () => {
    expect(AssignmentSettingsSchema.safeParse(mapAssignmentSettings(apiAssignment())).success).toBe(true);
    expect(AssignmentSettingsSchema.safeParse(mapAssignmentSettings(apiAssignment({
      peer_review_toggle: true, peer_hide_code: true, peer_gallery: true, peer_grading_toggle: true,
      peer_review_start_date: '2026-12-01', peer_review_end_date: '2026-12-15',
    }))).success).toBe(true);
  });
});

describe('pull: container image identity is observed, cleanup_time is known', () => {
  it('container_image_id / _label go to _observed_settings, never to _unknown_settings', () => {
    const s = mapPartSettings(apiContainerPart());
    expect(s._observed_settings).toMatchObject({
      container_image_id: '3677', container_image_label: 'CD15315 v2: image_90_CD15315_32_v2',
    });
    expect(s._unknown_settings).toBeUndefined();
    expect(s.container_image).toBe('CD15315 v2');
  });

  it('cleanup_time is read as a number', () => {
    expect(mapPartSettings(apiContainerPart({ cleanup_time: '30' })).cleanup_time).toBe(30);
  });
});

describe('push: what reaches the PUT', () => {
  it('peer-review fields are sent together; null and absent are not sent', () => {
    expect(peerReviewPayload({
      peer_review_toggle: true, peer_hide_code: true, peer_review_start_date: '2026-12-01',
      peer_review_end_date: null, reviewguide: undefined,
    })).toEqual({ peer_review_toggle: true, peer_hide_code: true, peer_review_start_date: '2026-12-01' });
    expect(peerReviewPayload(undefined)).toEqual({});
  });

  it('cleanup_time is part of the full part payload', () => {
    expect(buildPartSettingsPayload('Part 1', { cleanup_time: 30 } as never, 'full')).toMatchObject({ cleanup_time: 30 });
  });

  it('a container image id never rides a push, even when a hand-edited _unknown_settings carries it (cross-tenant)', () => {
    expect(RESERVED_PART_KEYS.has('container_image_id')).toBe(true);
    expect(RESERVED_PART_KEYS.has('container_image_label')).toBe(true);
    const payload = buildPartSettingsPayload(
      'Part 1',
      { _unknown_settings: { container_image_id: '3677', container_image_label: 'x' } } as never,
      'full',
    );
    expect(payload).not.toHaveProperty('container_image_id');
    expect(payload).not.toHaveProperty('container_image_label');
  });
});

describe('drift: push side (reconciler) and pull side (settings diff)', () => {
  const assignment = (settings: Record<string, unknown>): Assignment =>
    ({ assignment_id: '6036045', name: 'CD15315 v2', path: 'cd', create_from_template: false, settings, parts: [] }) as unknown as Assignment;

  it('a changed peer-review setting is drift, both ways', () => {
    expect(detectAssignmentSettingsChanged(assignment({ reviewcalc: 'MEDIAN' }), apiAssignment())).toBe(true);
    const diffs = compareAssignmentSettings({ reviewcalc: 'MEDIAN' } as never, mapAssignmentSettings(apiAssignment()));
    expect(diffs.map(d => d.key)).toContain('reviewcalc');
  });

  it('an unchanged config is not drift', () => {
    expect(detectAssignmentSettingsChanged(assignment({ ...API_PEER_DEFAULTS }), apiAssignment())).toBe(false);
  });

  it('a field the server does not return is not drift (tenant without peer review)', () => {
    const remote = apiAssignment();
    delete (remote as unknown as Record<string, unknown>).reviewcalc;
    expect(detectAssignmentSettingsChanged(assignment({ reviewcalc: 'MEDIAN' }), remote)).toBe(false);
  });

  it('cleanup_time drift is detected, and string "30" equals number 30', () => {
    const part = (s: Record<string, unknown>) => ({ part_id: '6036046', path: '.', name: 'Part 1', settings: s }) as unknown as Part;
    expect(detectPartSettingsChanged(part({ cleanup_time: 30 }), apiContainerPart({ cleanup_time: '0' }))).toBe(true);
    expect(detectPartSettingsChanged(part({ cleanup_time: 30 }), apiContainerPart({ cleanup_time: '30' }))).toBe(false);
    expect(comparePartSettings({ cleanup_time: 30 } as never, mapPartSettings(apiContainerPart({ cleanup_time: '0' }))).map(d => d.key)).toContain('cleanup_time');
  });

  it('container image identity is never drift (observed only)', () => {
    const part = { part_id: '6036046', path: '.', name: 'Part 1', settings: { _observed_settings: { container_image_id: '3607' } } } as unknown as Part;
    expect(detectPartSettingsChanged(part, apiContainerPart())).toBe(false);
  });
});

describe('schema: the server rules, enforced at config load (adversarial input)', () => {
  it('a dependent option without peer review enabled is rejected with the fix in the message', () => {
    const r = AssignmentSettingsSchema.safeParse({ peer_review_toggle: false, peer_gallery: true });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/peer_gallery: true requires peer_review_toggle: true/);
  });

  it('dependents are allowed with the toggle on, and false is always allowed', () => {
    expect(AssignmentSettingsSchema.safeParse({ peer_review_toggle: true, peer_hide_code: true }).success).toBe(true);
    expect(AssignmentSettingsSchema.safeParse({ peer_hide_code: false }).success).toBe(true);
  });

  it('a datetime where the API wants a bare date is rejected', () => {
    expect(AssignmentSettingsSchema.safeParse({ peer_review_start_date: '2026-12-01T10:00:00Z' }).success).toBe(false);
    expect(AssignmentSettingsSchema.safeParse({ peer_review_start_date: '2026-12-01' }).success).toBe(true);
    expect(AssignmentSettingsSchema.safeParse({ peer_review_start_date: null }).success).toBe(true);
  });

  it('enums accept any case, normalize to upper case, and reject unknown values', () => {
    expect(AssignmentSettingsSchema.parse({ reviewcalc: 'median' })?.reviewcalc).toBe('MEDIAN');
    const bad = AssignmentSettingsSchema.safeParse({ reviewcalc: 'mean' });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/must be one of AVERAGE, MEDIAN, MAXIMUM/);
  });

  it('counts must be non-negative numbers; numeric strings are coerced', () => {
    expect(AssignmentSettingsSchema.parse({ reviews_number: '2' })?.reviews_number).toBe(2);
    expect(AssignmentSettingsSchema.safeParse({ reviews_number: -1 }).success).toBe(false);
    expect(PartSettingsSchema.parse({ cleanup_time: '30' })?.cleanup_time).toBe(30);
  });
});

describe('legacy configs: _unknown_settings from an older pull are migrated at load', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-settings-migration-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function load(assignmentSettings: string, partSettings: string) {
    const yaml = `version: "1.0"
vocareum:
  org_id: "292"
  course_id: "215500"
assignments:
  - assignment_id: "6036045"
    name: CD15315 v2
    path: cd15315-v2
    settings:
${assignmentSettings}
    parts:
      - part_id: "6036046"
        path: "."
        settings:
${partSettings.split('\n').map(line => `  ${line}`).join('\n')}
`;
    const file = path.join(dir, 'vocareum.yaml');
    await fs.writeFile(file, yaml, 'utf8');
    const config = await loadConfig(file);
    return { asn: config.assignments[0].settings!, part: config.assignments[0].parts[0].settings! };
  }

  it('a 1.5.0-era pull layout loads with peer review known, image identity observed, cleanup_time known', async () => {
    const { asn, part } = await load(
      `      nosubmit: false
      _unknown_settings:
        peer_review_toggle: false
        peer_schedule_mode: MANUAL
        peer_review_start_date: null
        reviews_number: 1
        reviewcalc: AVERAGE
        some_future_field: 7`,
      `        container_image: CD15315 v2
        _unknown_settings:
          cleanup_time: "0"
          container_image_id: "3677"
          container_image_label: "CD15315 v2: image_90_CD15315_32_v2"`,
    );
    expect(asn).toMatchObject({ peer_review_toggle: false, peer_schedule_mode: 'MANUAL', reviews_number: 1, reviewcalc: 'AVERAGE' });
    expect(asn.peer_review_start_date).toBeNull();
    // A genuinely unknown field stays where it was.
    expect(asn._unknown_settings).toEqual({ some_future_field: 7 });
    expect(part.cleanup_time).toBe(0);
    expect(part._observed_settings).toMatchObject({ container_image_id: '3677' });
    expect(part._unknown_settings).toBeUndefined();
  });

  it('an explicit top-level value wins over a legacy unknown copy', async () => {
    const { asn } = await load(
      `      reviewcalc: MEDIAN
      _unknown_settings:
        reviewcalc: AVERAGE`,
      `        {}`,
    );
    expect(asn.reviewcalc).toBe('MEDIAN');
    expect(asn._unknown_settings).toBeUndefined();
  });

  it('a legacy value that fails its schema stays in _unknown_settings instead of breaking the load', async () => {
    const { asn } = await load(
      `      _unknown_settings:
        reviewcalc: GEOMETRIC_MEAN
        reviews_number: 2`,
      `        {}`,
    );
    expect(asn).not.toHaveProperty('reviewcalc');
    expect(asn.reviews_number).toBe(2);
    expect(asn._unknown_settings).toEqual({ reviewcalc: 'GEOMETRIC_MEAN' });
  });

  it('wrapper keys inside _unknown_settings are left alone (never promoted to a real bucket)', async () => {
    const { asn } = await load(
      `      _unknown_settings:
        _unknown_settings: { nested: 1 }
        _observed_settings: { x: 1 }`,
      `        {}`,
    );
    expect(asn._unknown_settings).toEqual({ _unknown_settings: { nested: 1 }, _observed_settings: { x: 1 } });
    expect(asn._observed_settings).toBeUndefined();
  });
});
