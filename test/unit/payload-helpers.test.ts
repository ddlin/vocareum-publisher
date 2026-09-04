import { describe, it, expect } from 'vitest';
import {
  isHttp400, describeApiError, describeDroppedPartSettings, omitPlatformKeysForUpdate,
  buildPartSettingsPayload, findPlatformFieldDrift, filterUnknownSettingsForPayload,
  RESERVED_PART_KEYS,
} from '../../src/core/payload-helpers';
import { APIError } from '../../src/api/client';
import { CollectingEventSink } from '../../src/core/services/event-sink';

describe('isHttp400', () => {
  it('detects APIError statusCode 400', () => {
    expect(isHttp400(new APIError('bad', 400))).toBe(true);
  });
  it('detects axios-shaped response.status 400', () => {
    expect(isHttp400({ response: { status: 400 } })).toBe(true);
  });
  it('is false for non-400 / non-error', () => {
    expect(isHttp400(new APIError('nope', 500))).toBe(false);
    expect(isHttp400({ response: { status: 404 } })).toBe(false);
    expect(isHttp400(null)).toBe(false);
    expect(isHttp400('x')).toBe(false);
  });
});

describe('describeApiError', () => {
  it('surfaces the API message from an APIError', () => {
    const err = new APIError('No valid parameters to update the assignment', 400);
    expect(describeApiError(err)).toContain('No valid parameters to update the assignment');
  });

  it('appends the raw response body when it adds detail beyond the message', () => {
    const err = new APIError('Bad Request', 400, { error: { field: 'labtype', reason: 'not writable' } });
    const out = describeApiError(err);
    expect(out).toContain('Bad Request');
    expect(out).toContain('labtype');
    expect(out).toContain('not writable');
  });

  it('does not duplicate the body when the message already contains it', () => {
    const err = new APIError('boom', 400, 'boom');
    // message and stringified body are the same → not repeated
    expect(describeApiError(err)).toBe('boom');
  });

  it('does not echo a { error: { message } } wrapper of the same message (P2)', () => {
    // The common Vocareum shape: wrapError already extracted the nested message.
    const err = new APIError('No valid parameters to update', 400, {
      error: { message: 'No valid parameters to update' },
    });
    expect(describeApiError(err)).toBe('No valid parameters to update');
  });

  it('does not echo a { message } wrapper of the same message', () => {
    const err = new APIError('No valid parameters', 400, { message: 'No valid parameters' });
    expect(describeApiError(err)).toBe('No valid parameters');
  });

  it('still appends the body when the wrapper carries extra fields', () => {
    const err = new APIError('Bad Request', 400, {
      error: { message: 'Bad Request', field: 'labtype' },
    });
    const out = describeApiError(err);
    expect(out).toContain('Bad Request');
    expect(out).toContain('labtype'); // extra field is informative → kept
  });

  it('reads an axios-shaped error (response.data)', () => {
    const out = describeApiError({ message: 'Request failed', response: { data: { message: 'container_image invalid' } } });
    expect(out).toContain('Request failed');
    expect(out).toContain('container_image invalid');
  });

  it('flattens whitespace and truncates long detail', () => {
    const long = 'x'.repeat(500);
    const out = describeApiError(new APIError('line1\n\n   line2', 400, long));
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles empty/absent detail gracefully', () => {
    expect(describeApiError(new APIError('', 400, {}))).toBe('no error detail');
    expect(describeApiError(null)).toBe('null');
  });
});

describe('describeDroppedPartSettings', () => {
  it('lists keys the reduced payload no longer carries, sorted', () => {
    const full = {
      name: 'cloud-lab',
      session_length: '120',
      labtype: 'Vocareum Notebook',
      container_image: 'Jupyter v1.70',
      lab_interface: { panels: ['Html'] },
      max_points: '40',
    } as never;
    const reduced = { name: 'cloud-lab', session_length: '120' } as never;

    expect(describeDroppedPartSettings(full, reduced)).toEqual([
      'container_image', 'lab_interface', 'labtype', 'max_points',
    ]);
  });

  it('returns an empty list when nothing was dropped', () => {
    const p = { name: 'cloud-lab', session_length: '120' } as never;
    expect(describeDroppedPartSettings(p, p)).toEqual([]);
  });
});

describe('omitPlatformKeysForUpdate', () => {
  it('removes both platform fields', () => {
    const out = omitPlatformKeysForUpdate({
      name: 'p', session_length: '120',
      labtype: 'Vocareum Notebook', container_image: 'Jupyter v1.70',
    } as never);
    expect(out).toEqual({ name: 'p', session_length: '120' });
  });

  it('leaves a payload without them untouched', () => {
    const payload = { name: 'p', session_length: '120' } as never;
    expect(omitPlatformKeysForUpdate(payload)).toEqual(payload);
  });

  it('does not mutate its input', () => {
    const payload = { name: 'p', labtype: 'Vocareum Notebook' } as never;
    omitPlatformKeysForUpdate(payload);
    expect((payload as Record<string, unknown>).labtype).toBe('Vocareum Notebook');
  });

  it('preserves the grading and interface settings that the safe fallback would have lost', () => {
    const out = omitPlatformKeysForUpdate({
      name: 'p', labtype: 'Vocareum Notebook', container_image: 'Jupyter v1.70',
      lab_interface: { panels: ['Html'] }, tags: [], max_points: '40',
    } as never) as Record<string, unknown>;
    expect(out.max_points).toBe('40');
    expect(out.lab_interface).toBeDefined();
    expect(out.tags).toBeDefined();
  });
});

describe('rubrics are reserved against _unknown_settings pass-through (FIX D)', () => {
  // Rubrics are part-scoped config, but they're stored at part.rubrics and
  // written through the dedicated rubrics endpoint — never through the
  // part-settings PUT this payload feeds. `rubrics` must therefore be in
  // RESERVED_PART_KEYS (via NON_SETTING_FIELDS_PART) so neither a
  // hand-written `_unknown_settings.rubrics` nor a future server-sent
  // `rubrics` key (captured into _unknown_settings by mapPartSettings) can
  // sneak into the outgoing part payload and risk 400ing the request.

  it('RESERVED_PART_KEYS includes rubrics', () => {
    expect(RESERVED_PART_KEYS.has('rubrics')).toBe(true);
  });

  it('filterUnknownSettingsForPayload drops a rubrics key and warns', () => {
    const events = new CollectingEventSink();
    const filtered = filterUnknownSettingsForPayload(
      { rubrics: [{ name: 'A', seqnum: '1', maxscore: '10' }], some_future_flag: '5' },
      RESERVED_PART_KEYS,
      'part',
      'cloud-lab',
      events,
    );

    expect(filtered).not.toHaveProperty('rubrics');
    expect(filtered).toEqual({ some_future_flag: '5' });

    const warnings: string[] = [];
    events.flushTo({ emit: (e) => { if (e.message) { warnings.push(e.message); } } });
    expect(warnings.some((m) => m.includes('rubrics') && m.includes('cloud-lab'))).toBe(true);
  });

  it('buildPartSettingsPayload drops _unknown_settings.rubrics from the built payload and warns', () => {
    const events = new CollectingEventSink();
    const settings = {
      session_length: '120',
      _unknown_settings: { rubrics: [{ name: 'A', seqnum: '1', maxscore: '10' }] },
    } as never;

    const payload = buildPartSettingsPayload('cloud-lab', settings, 'full', events);

    expect(payload).not.toHaveProperty('rubrics');

    const warnings: string[] = [];
    events.flushTo({ emit: (e) => { if (e.message) { warnings.push(e.message); } } });
    expect(warnings.some((m) => m.includes('_unknown_settings.rubrics'))).toBe(true);
  });
});

describe('plan/execute payload agreement', () => {
  it('produces an identical payload from the same settings at both sites', () => {
    // planPush and executePush build this payload separately. If they drift,
    // semanticFingerprint describes something executePush never sends, which is
    // the facade fingerprint AGENTS.md #15 forbids.
    const settings = {
      session_length: '120', total_dollar: '10.00',
      labtype: 'Vocareum Notebook', container_image: 'Jupyter v1.70',
      _unknown_settings: { max_points: '40' },
    } as never;

    const asPlanned = omitPlatformKeysForUpdate(buildPartSettingsPayload('cloud-lab', settings, 'full'));
    const asExecuted = omitPlatformKeysForUpdate(buildPartSettingsPayload('cloud-lab', settings, 'full'));
    expect(asPlanned).toEqual(asExecuted);
    expect(asPlanned).not.toHaveProperty('labtype');
    expect(asPlanned).not.toHaveProperty('container_image');
  });
});

describe('findPlatformFieldDrift', () => {
  // labtype/container_image are stripped from every update payload
  // (omitPlatformKeysForUpdate) because the write API rejects them. A real
  // difference here can never be resolved by push, so it must be surfaced
  // rather than silently planning and "succeeding" at a no-op update forever.

  it('flags labtype when the desired value differs from what Vocareum reports', () => {
    const drift = findPlatformFieldDrift(
      { labtype: 'Vocareum Notebook' } as never,
      { labtype: 'JupyterLab' },
    );
    expect(drift).toEqual([
      { key: 'labtype', desired: 'Vocareum Notebook', remote: 'JupyterLab' },
    ]);
  });

  it('flags container_image independently of labtype', () => {
    const drift = findPlatformFieldDrift(
      { container_image: 'Jupyter v1.70' } as never,
      { container_image: 'Jupyter v1.60' },
    );
    expect(drift).toEqual([
      { key: 'container_image', desired: 'Jupyter v1.70', remote: 'Jupyter v1.60' },
    ]);
  });

  it('flags both keys when both differ', () => {
    const drift = findPlatformFieldDrift(
      { labtype: 'Vocareum Notebook', container_image: 'Jupyter v1.70' } as never,
      { labtype: 'JupyterLab', container_image: 'Jupyter v1.60' },
    );
    expect(drift.map((d) => d.key).sort()).toEqual(['container_image', 'labtype']);
  });

  it('does not fire when the desired value matches remote', () => {
    const drift = findPlatformFieldDrift(
      { labtype: 'Vocareum Notebook', container_image: 'Jupyter v1.70' } as never,
      { labtype: 'Vocareum Notebook', container_image: 'Jupyter v1.70' },
    );
    expect(drift).toEqual([]);
  });

  it('does not fire when no local value is desired (undefined/null)', () => {
    expect(findPlatformFieldDrift(undefined, { labtype: 'JupyterLab' })).toEqual([]);
    expect(findPlatformFieldDrift(
      { labtype: null } as never,
      { labtype: 'JupyterLab' },
    )).toEqual([]);
  });

  it('treats a missing remote value as empty string rather than throwing', () => {
    const drift = findPlatformFieldDrift(
      { labtype: 'Vocareum Notebook' } as never,
      {},
    );
    expect(drift).toEqual([
      { key: 'labtype', desired: 'Vocareum Notebook', remote: '' },
    ]);
  });
});

describe('derived point fields never reach an outgoing payload', () => {
  it('drops _unknown_settings.max_points and warns, rather than sending it', () => {
    // max_points is derived from rubric maxscore and is accepted-then-discarded by the
    // part PUT (VOC-4003). It is a reserved part key, so a hand-written or legacy
    // _unknown_settings entry must not smuggle it into the payload.
    const events = { emit: vi.fn() };
    const payload = buildPartSettingsPayload(
      'Part 1',
      { session_length: '120', _unknown_settings: { max_points: '40' } } as never,
      'full',
      events as never,
    );

    expect(payload).not.toHaveProperty('max_points');
    expect(payload.session_length).toBe('120');
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('max_points') }),
    );
  });

  it('still passes through a genuinely unknown part field', () => {
    const payload = buildPartSettingsPayload(
      'Part 1',
      { session_length: '120', _unknown_settings: { cleanup_time: '0' } } as never,
      'full',
    );

    expect(payload).toMatchObject({ cleanup_time: '0' });
  });
});
