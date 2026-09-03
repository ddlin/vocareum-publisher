import { describe, it, expect, vi } from 'vitest';
import { writePartSettingsWithFallback } from '../../src/core/services/part-settings-writer';
import { buildPartSettingsPayload } from '../../src/core/payload-helpers';

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
  _unknown_settings: { max_points: '40' },
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
    expect(secondPayload.max_points).toBe('40');
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
    expect(r.dropped).toContain('max_points');
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
    expect(warned.some((w) => w.message.includes('max_points'))).toBe(true);
  });
});
