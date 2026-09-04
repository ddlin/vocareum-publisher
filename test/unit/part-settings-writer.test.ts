import { describe, it, expect, vi } from 'vitest';
import { writePartSettingsWithFallback } from '../../src/core/services/part-settings-writer';
import { buildPartSettingsPayload, omitPlatformKeysForUpdate } from '../../src/core/payload-helpers';

const http400 = () => Object.assign(new Error('Bad Request'), {
  isAxiosError: true,
  response: { status: 400, data: { message: 'Image Jupyter v1.70 not found' } },
});

const settings = {
  session_length: '120',
  total_dollar: '10.00',
  labtype: 'Vocareum Notebook',
  container_image: 'Jupyter v1.70',
  lab_interface: { panels: ['Html'], controls: [], information: [] },
  tags: [],
  _unknown_settings: { cleanup_time: '40' },
} as never;

const sink = () => ({ emit: vi.fn() });

describe('writePartSettingsWithFallback', () => {
  it('sends the full payload and stops when it is accepted', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    const r = await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never);

    expect(update).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe('full');
    expect(r.dropped).toEqual([]);
  });

  it('retries without the platform pair before falling back to the safe subset', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(http400())   // full rejected
      .mockResolvedValueOnce(undefined);  // platform-stripped accepted
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    const r = await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never);

    expect(update).toHaveBeenCalledTimes(2);
    expect(r.outcome).toBe('without-platform');
    expect(r.dropped).toEqual(['container_image', 'labtype']);

    // The whole point: grading and interface settings survive this rung.
    const secondPayload = update.mock.calls[1][0] as Record<string, unknown>;
    expect(secondPayload.cleanup_time).toBe('40');
    expect(secondPayload.lab_interface).toBeDefined();
  });

  it('falls through to the safe subset only when the stripped payload is also rejected', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(http400())
      .mockRejectedValueOnce(http400())
      .mockResolvedValueOnce(undefined);
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    const r = await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never);

    expect(update).toHaveBeenCalledTimes(3);
    expect(r.outcome).toBe('safe');
    expect(r.dropped).toContain('cleanup_time');
  });

  it('reports name-only, then none, as the last rungs', async () => {
    const update = vi.fn().mockRejectedValue(http400());
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    const r = await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never);

    expect(update).toHaveBeenCalledTimes(4);
    expect(r.outcome).toBe('none');
  });

  it('rethrows a non-400 instead of degrading', async () => {
    const boom = Object.assign(new Error('gateway'), { isAxiosError: true, response: { status: 502 } });
    const update = vi.fn().mockRejectedValue(boom);
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    await expect(
      writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never),
    ).rejects.toThrow('gateway');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('warns naming every dropped setting when it degrades', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(http400())
      .mockRejectedValueOnce(http400())
      .mockResolvedValueOnce(undefined);
    const events = sink();
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, events as never);

    const warned = events.emit.mock.calls.map((c) => c[0]).filter((e) => e.level === 'warn');
    expect(warned.some((w) => w.message.includes('cleanup_time'))).toBe(true);
  });

  it('skips the without-platform rung when the full payload was already stripped upstream', async () => {
    // Simulates planPush, which already strips labtype/container_image before
    // the ladder ever sees the payload (push-service.ts:321 and :895). The
    // without-platform rung would then be byte-identical to full, so it must
    // be skipped rather than sent as a guaranteed-duplicate request.
    const update = vi.fn()
      .mockRejectedValueOnce(http400())   // full rejected
      .mockResolvedValueOnce(undefined);  // safe accepted
    const full = omitPlatformKeysForUpdate(buildPartSettingsPayload('cloud-lab', settings, 'full'));

    const r = await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never);

    // Exactly two calls: full, then safe. without-platform was skipped, not sent.
    expect(update).toHaveBeenCalledTimes(2);
    // The outcome names the rung that actually succeeded (safe), never the
    // skipped one (without-platform).
    expect(r.outcome).toBe('safe');

    const firstPayload = update.mock.calls[0][0] as Record<string, unknown>;
    const secondPayload = update.mock.calls[1][0] as Record<string, unknown>;
    expect(firstPayload).not.toEqual(secondPayload);
    expect(secondPayload.cleanup_time).toBeUndefined();
    expect(secondPayload.lab_interface).toBeUndefined();
  });

  it('still exercises the without-platform rung, unskipped, when the payload was not pre-stripped', async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(http400())   // full rejected
      .mockRejectedValueOnce(http400())   // without-platform: distinct payload, also rejected
      .mockResolvedValueOnce(undefined);  // safe accepted
    const full = buildPartSettingsPayload('cloud-lab', settings, 'full');

    const r = await writePartSettingsWithFallback(update, 'cloud-lab', settings, full, sink() as never);

    expect(update).toHaveBeenCalledTimes(3);
    const secondPayload = update.mock.calls[1][0] as Record<string, unknown>;
    expect(secondPayload.labtype).toBeUndefined();
    expect(secondPayload.container_image).toBeUndefined();
    // Grading settings still present on the without-platform rung, even
    // though this attempt is ultimately also rejected.
    expect(secondPayload.cleanup_time).toBe('40');
    expect(r.outcome).toBe('safe');
  });
});
