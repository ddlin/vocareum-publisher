import { describe, it, expect } from 'vitest';
import { mapRubrics, rubricsEqual, describeRubricChanges } from '../../src/utils/rubrics';
import { RubricSchema } from '../../src/types/config';
import type { VocareumRubricResponse } from '../../src/types/api';

const api = (over: Partial<VocareumRubricResponse> = {}): VocareumRubricResponse => ({
  id: '11504090', name: 'Prompts were run', seqnum: '1', maxscore: '10',
  exclude: false, auto: true, ...over,
});

describe('mapRubrics', () => {
  it('projects the migratable fields', () => {
    expect(mapRubrics([api()])).toEqual([
      { name: 'Prompts were run', seqnum: '1', maxscore: '10', auto: true, exclude: false },
    ]);
  });

  it('never carries the server id into config', () => {
    const [mapped] = mapRubrics([api()]);
    expect(mapped).not.toHaveProperty('id');
  });

  it('keeps maxscore and seqnum as strings', () => {
    const [mapped] = mapRubrics([api({ seqnum: '10', maxscore: '5' })]);
    expect(mapped.seqnum).toBe('10');
    expect(mapped.maxscore).toBe('5');
  });

  it('omits auto/exclude when the API does not return them', () => {
    const { auto, exclude, ...withoutFlags } = api();
    const [mapped] = mapRubrics([withoutFlags as VocareumRubricResponse]);
    expect(mapped).toEqual({ name: 'Prompts were run', seqnum: '1', maxscore: '10' });
  });

  it('preserves the order it is given', () => {
    const mapped = mapRubrics([api({ name: 'first', seqnum: '1' }), api({ name: 'second', seqnum: '2' })]);
    expect(mapped.map(r => r.name)).toEqual(['first', 'second']);
  });
});

describe('RubricSchema — adversarial input', () => {
  it('strips a hand-added server id instead of preserving it', () => {
    const parsed = RubricSchema.parse({ id: '11504090', name: 'A', seqnum: '1', maxscore: '10' });
    expect(parsed).not.toHaveProperty('id');
  });

  it('strips any other unknown key', () => {
    const parsed = RubricSchema.parse({ name: 'A', seqnum: '1', maxscore: '10', weight: 3 });
    expect(parsed).not.toHaveProperty('weight');
  });

  it('rejects a numeric maxscore rather than coercing it', () => {
    expect(() => RubricSchema.parse({ name: 'A', seqnum: '1', maxscore: 10 })).toThrow();
  });

  it('rejects a criterion with no maxscore', () => {
    expect(() => RubricSchema.parse({ name: 'A', seqnum: '1' })).toThrow();
  });
});

describe('rubricsEqual', () => {
  const a = { name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: false };
  const b = { name: 'B', seqnum: '2', maxscore: '5', auto: true, exclude: false };

  it('is true for identical lists', () => {
    expect(rubricsEqual([a, b], [a, b])).toBe(true);
  });

  it('is true for two empty lists', () => {
    expect(rubricsEqual([], [])).toBe(true);
  });

  it('is false when a maxscore changes', () => {
    expect(rubricsEqual([a], [{ ...a, maxscore: '12' }])).toBe(false);
  });

  it('is false when a criterion is added remotely', () => {
    expect(rubricsEqual([a], [a, b])).toBe(false);
  });

  it('is false when a criterion is removed remotely', () => {
    expect(rubricsEqual([a, b], [a])).toBe(false);
  });

  it('is false when order differs', () => {
    expect(rubricsEqual([a, b], [b, a])).toBe(false);
  });

  it('treats an omitted flag as false rather than drift', () => {
    expect(rubricsEqual([{ name: 'A', seqnum: '1', maxscore: '10' }],
                        [{ name: 'A', seqnum: '1', maxscore: '10', auto: false, exclude: false }])).toBe(true);
  });

  it('still reports drift when an omitted flag becomes true remotely', () => {
    expect(rubricsEqual([{ name: 'A', seqnum: '1', maxscore: '10' }],
                        [{ name: 'A', seqnum: '1', maxscore: '10', auto: true }])).toBe(false);
  });
});

describe('describeRubricChanges', () => {
  const a = { name: 'A', seqnum: '1', maxscore: '10' };
  const b = { name: 'B', seqnum: '2', maxscore: '5' };

  it('names criteria added on the remote', () => {
    expect(describeRubricChanges([a], [a, b])).toEqual({ added: ['B'], removed: [], changed: [] });
  });

  it('names criteria missing from the remote', () => {
    expect(describeRubricChanges([a, b], [a])).toEqual({ added: [], removed: ['B'], changed: [] });
  });

  it('names criteria whose values changed', () => {
    expect(describeRubricChanges([a], [{ ...a, maxscore: '12' }]))
      .toEqual({ added: [], removed: [], changed: ['A'] });
  });

  it('handles duplicate names by count', () => {
    expect(describeRubricChanges([a], [a, { ...a, seqnum: '2' }]))
      .toEqual({ added: ['A'], removed: [], changed: [] });
  });

  it('puts a name in both changed and added when duplicated with one copy altered', () => {
    const local = [{ name: 'A', seqnum: '1', maxscore: '10' }, { name: 'A', seqnum: '2', maxscore: '20' }];
    const remote = [{ name: 'A', seqnum: '1', maxscore: '99' }, { name: 'A', seqnum: '2', maxscore: '20' }, { name: 'A', seqnum: '3', maxscore: '30' }];
    expect(describeRubricChanges(local, remote)).toEqual({ added: ['A'], removed: [], changed: ['A'] });
  });

  it('puts a name in both changed and removed when duplicated with one copy altered', () => {
    const local = [{ name: 'A', seqnum: '1', maxscore: '99' }, { name: 'A', seqnum: '2', maxscore: '20' }, { name: 'A', seqnum: '3', maxscore: '30' }];
    const remote = [{ name: 'A', seqnum: '1', maxscore: '10' }, { name: 'A', seqnum: '2', maxscore: '20' }];
    expect(describeRubricChanges(local, remote)).toEqual({ added: [], removed: ['A'], changed: ['A'] });
  });
});
