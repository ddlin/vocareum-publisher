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
import { buildPartSettingsPayload, coercedPeerDependents, peerReviewPayload, RESERVED_PART_KEYS } from '../../src/core/payload-helpers';
import { cleanupTimeIgnoredByServer, detectAssignmentSettingsChanged, detectPartSettingsChanged } from '../../src/core/reconciler';
import { compareAssignmentSettings, comparePartSettings, dropTypedCopiesOfUnreadableRemote } from '../../src/core/services/pull-service';
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

  it('keeps a YYYY-MM-DD date; an unreadable one is preserved in _unknown_settings, not dropped', () => {
    const s = mapAssignmentSettings(apiAssignment({
      peer_review_toggle: true, peer_review_start_date: '2026-12-01', peer_review_end_date: 'not a date',
    }));
    expect(s.peer_review_start_date).toBe('2026-12-01');
    expect(s).not.toHaveProperty('peer_review_end_date');
    expect(s._unknown_settings).toEqual({ peer_review_end_date: 'not a date' });
  });

  it('an enum value newer than this release is preserved (and reported) in _unknown_settings, and the config still loads', () => {
    const s = mapAssignmentSettings(apiAssignment({ reviewcalc: 'GEOMETRIC_MEAN' }));
    expect(s).not.toHaveProperty('reviewcalc');
    expect(s._unknown_settings).toEqual({ reviewcalc: 'GEOMETRIC_MEAN' });
    expect(AssignmentSettingsSchema.safeParse(s).success).toBe(true);
  });

  it('a null review guide is kept as null, so pull can clear a stale local guide', () => {
    expect(mapAssignmentSettings(apiAssignment({ reviewguide: null })).reviewguide).toBeNull();
    const diffs = compareAssignmentSettings({ reviewguide: 'old text' } as never, mapAssignmentSettings(apiAssignment({ reviewguide: null })));
    expect(diffs.map(d => d.key)).toContain('reviewguide');
  });

  it('a remote value outside the API ranges is preserved in _unknown_settings, never written typed (round 2)', () => {
    const s = mapAssignmentSettings(apiAssignment({ reviews_number: 0, reviewpenalty: 1.5, peer_review_start_date: '2026-02-30', reviewcalc: ' median ' }));
    expect(s._unknown_settings).toEqual({ reviews_number: 0, reviewpenalty: 1.5, peer_review_start_date: '2026-02-30' });
    expect(s.reviewcalc).toBe('MEDIAN');
    expect(AssignmentSettingsSchema.safeParse(s).success).toBe(true);
    const p = mapPartSettings(apiContainerPart({ cleanup_time: '1.5' }));
    expect(p).not.toHaveProperty('cleanup_time');
    expect(p._unknown_settings).toEqual({ cleanup_time: '1.5' });
    expect(PartSettingsSchema.safeParse(p).success).toBe(true);
  });

  it('pull merge: an unreadable remote value replaces the stale typed copy, so the next load keeps it (round 2)', () => {
    const remote = mapAssignmentSettings(apiAssignment({ reviewcalc: 'GEOMETRIC_MEAN' }));
    const merged: Record<string, unknown> = { ...{ reviewcalc: 'MEDIAN' }, ...remote };
    dropTypedCopiesOfUnreadableRemote(merged, remote._unknown_settings);
    expect(merged).not.toHaveProperty('reviewcalc');
    expect(merged._unknown_settings).toEqual({ reviewcalc: 'GEOMETRIC_MEAN' });
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
  it('peer-review fields are sent together; absent and null are not sent, except a null date, which clears it', () => {
    expect(peerReviewPayload({
      peer_review_toggle: true, peer_hide_code: true, peer_review_start_date: '2026-12-01',
      peer_review_end_date: null, reviewguide: null, reviewcalc: undefined,
    })).toEqual({ peer_review_toggle: true, peer_hide_code: true, peer_review_start_date: '2026-12-01', peer_review_end_date: null });
    expect(peerReviewPayload(undefined)).toEqual({});
  });

  it('with the toggle off, the three dependent options go out as false (the API rejects true and resets them)', () => {
    expect(peerReviewPayload({ peer_review_toggle: false, peer_gallery: true, peer_hide_code: true, peer_grading_toggle: false }))
      .toEqual({ peer_review_toggle: false, peer_gallery: false, peer_hide_code: false, peer_grading_toggle: false });
  });

  it('a dependent option without the toggle in the config follows the stored toggle (probe Q1 / Q10)', () => {
    expect(peerReviewPayload({ peer_gallery: true }, { remoteToggle: true })).toEqual({ peer_gallery: true });
    expect(peerReviewPayload({ peer_gallery: true }, { remoteToggle: false })).toEqual({ peer_gallery: false });
    // Unknown stored state (create): sent as written.
    expect(peerReviewPayload({ peer_gallery: true })).toEqual({ peer_gallery: true });
  });

  it('the options sent as false are reported, so push can warn instead of silently editing intent', () => {
    expect(coercedPeerDependents({ peer_review_toggle: false, peer_gallery: true, peer_hide_code: false })).toEqual(['peer_gallery']);
    expect(coercedPeerDependents({ peer_gallery: true }, { remoteToggle: false })).toEqual(['peer_gallery']);
    expect(coercedPeerDependents({ peer_gallery: true }, { remoteToggle: true })).toEqual([]);
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

  it('a remote value in another spelling (lower case, numeric string, "1" flag) is not drift', () => {
    const remote = apiAssignment({ reviewcalc: 'average', reviews_number: '1', reviewpenalty: '0', peer_review_toggle: '0' });
    expect(detectAssignmentSettingsChanged(assignment({ ...API_PEER_DEFAULTS }), remote)).toBe(false);
  });

  it('a null local date against a set remote date is drift (push clears it); null against null is not', () => {
    expect(detectAssignmentSettingsChanged(assignment({ peer_review_start_date: null }), apiAssignment({ peer_review_start_date: '2026-12-01' }))).toBe(true);
    expect(detectAssignmentSettingsChanged(assignment({ peer_review_start_date: null }), apiAssignment())).toBe(false);
  });

  it('toggle off with a dependent still true locally is not drift once the server has reset it', () => {
    expect(detectAssignmentSettingsChanged(assignment({ peer_review_toggle: false, peer_gallery: true }), apiAssignment())).toBe(false);
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

  it('cleanup_time on a Standard (Elite) part that reads back 0 is not drift; on a container lab it always is', () => {
    const part = { part_id: '6036046', path: 'p1', name: 'Part 1', settings: { cleanup_time: 30 } } as unknown as Part;
    const standard = apiContainerPart({ labtype: 'Vocareum Standard', cleanup_time: '0' });
    expect(cleanupTimeIgnoredByServer(part, standard)).toBe(true);
    expect(detectPartSettingsChanged(part, standard, { ignoreCleanupTime: true })).toBe(false);
    // Round-2 review: a container lab changed in the UI (or never sent) must still be corrected.
    expect(cleanupTimeIgnoredByServer(part, apiContainerPart({ labtype: 'Vocareum Notebook', cleanup_time: '120' }))).toBe(false);
    expect(cleanupTimeIgnoredByServer(part, apiContainerPart({ labtype: 'Visual Studio Code', cleanup_time: '0' }))).toBe(false);
    // A Standard part reading back a non-zero value is real drift.
    expect(cleanupTimeIgnoredByServer(part, apiContainerPart({ labtype: 'Vocareum Standard', cleanup_time: '10' }))).toBe(false);
  });

  it('a dependent option with no toggle in the config is drift-checked against the STORED toggle', () => {
    // Stored off: Vocareum rejects true (probe Q10), so push sends false; server already false = no drift.
    expect(detectAssignmentSettingsChanged(assignment({ peer_gallery: true }), apiAssignment())).toBe(false);
    // Stored on: true is sent and accepted (probe Q1), so false on the server is drift.
    expect(detectAssignmentSettingsChanged(assignment({ peer_gallery: true }), apiAssignment({ peer_review_toggle: true }))).toBe(true);
  });

  it('container image identity is never drift (observed only)', () => {
    const part = { part_id: '6036046', path: '.', name: 'Part 1', settings: { _observed_settings: { container_image_id: '3607' } } } as unknown as Part;
    expect(detectPartSettingsChanged(part, apiContainerPart())).toBe(false);
  });
});

describe('schema: the server rules, enforced at config load (adversarial input)', () => {
  it('no combination of the toggle and its options can make the config fail to load', () => {
    // The off-toggle case is resolved at push (sent as false); a partial config
    // is valid while Vocareum already has peer review on. Probed 2026-11-10.
    for (const s of [
      { peer_review_toggle: false, peer_gallery: true },
      { peer_gallery: true },
      { peer_review_toggle: true, peer_hide_code: true },
      { peer_hide_code: false },
    ]) {
      expect(AssignmentSettingsSchema.safeParse(s).success).toBe(true);
    }
  });


  it('an impossible calendar date is rejected (the API rejects it too)', () => {
    expect(AssignmentSettingsSchema.safeParse({ peer_review_start_date: '2026-13-40' }).success).toBe(false);
    expect(AssignmentSettingsSchema.safeParse({ peer_review_start_date: '2026-02-30' }).success).toBe(false);
  });

  it('counts use the API ranges: reviews_number 1-10, reviewpenalty 0-100, cleanup_time >= 0, whole numbers', () => {
    expect(AssignmentSettingsSchema.safeParse({ reviews_number: 0 }).success).toBe(false);
    expect(AssignmentSettingsSchema.safeParse({ reviews_number: 11 }).success).toBe(false);
    expect(AssignmentSettingsSchema.safeParse({ reviewpenalty: 1.5 }).success).toBe(false);
    expect(AssignmentSettingsSchema.safeParse({ reviewpenalty: 101 }).success).toBe(false);
    expect(AssignmentSettingsSchema.parse({ reviewpenalty: '100' })?.reviewpenalty).toBe(100);
    expect(PartSettingsSchema.safeParse({ cleanup_time: 1.5 }).success).toBe(false);
  });

  it('an empty string, a boolean or an array is rejected, never coerced into a real 0 or 1', () => {
    for (const v of ['', ' ', true, false, [], 'abc']) {
      expect(AssignmentSettingsSchema.safeParse({ reviews_number: v }).success).toBe(false);
      expect(AssignmentSettingsSchema.safeParse({ reviewpenalty: v }).success).toBe(false);
      expect(PartSettingsSchema.safeParse({ cleanup_time: v }).success).toBe(false);
    }
  });

  it('enum values with stray whitespace are trimmed', () => {
    expect(AssignmentSettingsSchema.parse({ reviewcalc: ' median ' })?.reviewcalc).toBe('MEDIAN');
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

  it('counts must be in range; numeric strings are coerced', () => {
    expect(AssignmentSettingsSchema.parse({ reviews_number: '2' })?.reviews_number).toBe(2);
    expect(AssignmentSettingsSchema.safeParse({ reviews_number: -1 }).success).toBe(false);
    expect(AssignmentSettingsSchema.safeParse({ reviews_number: '-1' }).success).toBe(false);
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

  it('a legacy toggle-off config with a dependent still true loads (both reviewers\' brick case)', async () => {
    const { asn } = await load(
      `      peer_review_toggle: false
      _unknown_settings:
        peer_review_toggle: true
        peer_gallery: true`,
      `        {}`,
    );
    expect(asn.peer_review_toggle).toBe(false);
    expect(asn.peer_gallery).toBe(true);
    expect(peerReviewPayload(asn)).toMatchObject({ peer_review_toggle: false, peer_gallery: false });
  });

  it('a legacy dependent option with no toggle anywhere loads', async () => {
    const { asn } = await load(
      `      _unknown_settings:
        peer_gallery: true`,
      `        {}`,
    );
    expect(asn.peer_gallery).toBe(true);
    expect(asn._unknown_settings).toBeUndefined();
  });

  it('legacy raw API spellings ("1" flags, lower-case enums, numeric strings) are promoted, not stranded', async () => {
    const { asn } = await load(
      `      _unknown_settings:
        peer_review_toggle: "1"
        reviewcalc: median
        reviews_number: "3"`,
      `        {}`,
    );
    expect(asn).toMatchObject({ peer_review_toggle: true, reviewcalc: 'MEDIAN', reviews_number: 3 });
    expect(asn._unknown_settings).toBeUndefined();
  });

  it('unquoted YAML dates load as written: a real date passes, an impossible one or a datetime is rejected (not shifted)', async () => {
    const { asn } = await load(`      peer_review_start_date: 2026-12-01`, `        {}`);
    expect(asn.peer_review_start_date).toBe('2026-12-01');
    for (const v of ['2026-02-30', '2026-13-40', '2026-12-01T23:30:00-08:00', '2026-12-01T10:00:00Z']) {
      await expect(load(`      peer_review_start_date: ${v}`, `        {}`)).rejects.toThrow(/peer_review_start_date/);
    }
  });

  it('YAML merge keys still work with timestamps off', async () => {
    const yaml = `version: "1.0"
defaults: &d
  nosubmit: true
vocareum:
  org_id: "292"
  course_id: "215500"
assignments:
  - assignment_id: "1"
    name: a
    path: a
    settings:
      <<: *d
    parts: []
`;
    const file = path.join(dir, 'vocareum.yaml');
    await fs.writeFile(file, yaml, 'utf8');
    expect((await loadConfig(file)).assignments[0].settings?.nosubmit).toBe(true);
  });

  it('a legacy exponent or hex number string is not promoted (same rule as a top-level value)', async () => {
    const { asn } = await load(
      `      _unknown_settings:
        reviews_number: "1e1"
        reviewpenalty: "0x10"`,
      `        {}`,
    );
    expect(asn).not.toHaveProperty('reviews_number');
    expect(asn).not.toHaveProperty('reviewpenalty');
    expect(asn._unknown_settings).toEqual({ reviews_number: '1e1', reviewpenalty: '0x10' });
  });

  it('a legacy empty string is not promoted into a real 0', async () => {
    const { asn } = await load(
      `      _unknown_settings:
        reviews_number: ""`,
      `        {}`,
    );
    expect(asn).not.toHaveProperty('reviews_number');
    expect(asn._unknown_settings).toEqual({ reviews_number: '' });
  });

  it('a malformed (non-object) _observed_settings is not silently replaced by migration', async () => {
    await expect(load(
      `      nosubmit: false`,
      `        _observed_settings: not-an-object
        _unknown_settings:
          container_image_id: "3677"`,
    )).rejects.toThrow();
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
