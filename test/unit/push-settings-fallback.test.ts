import { describe, it, expect } from 'vitest';
import { buildPartSettingsPayload, describeDroppedPartSettings } from '../../src/core/payload-helpers';

describe('safe-mode fallback loss', () => {
  it('drops grading and platform settings that the caller must be told about', () => {
    const settings = {
      cloud_labs: true,
      instant_aws_access: false,
      session_length: '120',
      total_dollar: '10.00',
      labtype: 'Vocareum Notebook',
      container_image: 'Jupyter v1.70',
      lab_interface: { panels: ['Html'], controls: [], information: [] },
      tags: [],
      _unknown_settings: { cleanup_time: '0' },
    } as never;

    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');
    const safe = buildPartSettingsPayload('cloud-lab', settings, 'safe');
    const dropped = describeDroppedPartSettings(full, safe);

    // An unrecognized pass-through field is dropped by the safe rung and must be
    // named, so the caller can tell the user what was given up. (This fixture used
    // max_points until it became a reserved observed key — it is now filtered before
    // payload construction, so it can no longer reach or be dropped by this ladder.)
    expect(dropped).toContain('cleanup_time');
    expect(dropped).toContain('lab_interface');
    expect(dropped).toContain('container_image');
    expect(dropped).toContain('labtype');
  });
});
