import { describe, it, expect } from 'vitest';
import { mapRubrics, rubricsEqual, describeRubricChanges, planRubricSync, projectedPoints } from '../../src/utils/rubrics';
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

describe('planRubricSync', () => {
  const remote = (id: string, name: string, maxscore: string, extra = {}) =>
    ({ id, name, seqnum: id, maxscore, auto: false, exclude: false, ...extra });

  it('creates local criteria that have no remote name match', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '10' }, { name: 'B', seqnum: '2', maxscore: '5' }],
      [remote('r1', 'A', '10')],
    );

    expect(plan.creates).toEqual([{ name: 'B', maxscore: '5' }]);
    expect(plan.updates).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it('updates a name match whose maxscore differs, carrying the remote id', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '12' }],
      [remote('r1', 'A', '10')],
    );

    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([{ id: 'r1', maxscore: '12' }]);
  });

  it('updates auto and exclude when they differ', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '10', auto: true, exclude: true }],
      [remote('r1', 'A', '10')],
    );

    expect(plan.updates).toEqual([{ id: 'r1', auto: true, exclude: true }]);
  });

  it('emits NOTHING when local and remote agree — no false write', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '10', auto: false, exclude: false }],
      [remote('r1', 'A', '10')],
    );

    expect(plan).toEqual({ creates: [], updates: [], orphans: [], duplicateNames: [] });
  });

  it('treats an omitted local flag as false, matching the read side', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '10' }],
      [remote('r1', 'A', '10', { auto: false, exclude: false })],
    );

    expect(plan.updates).toEqual([]);
  });

  it('reports a remote criterion with no local match as an orphan and never deletes it', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '10' }],
      [remote('r1', 'A', '10'), remote('r2', 'GONE', '5')],
    );

    expect(plan.orphans.map(o => o.name)).toEqual(['GONE']);
    expect(plan.creates).toEqual([]);
  });

  it('a rename surfaces as a create PLUS an orphan — it cannot be seen as a rename', () => {
    const plan = planRubricSync(
      [{ name: 'NEW NAME', seqnum: '1', maxscore: '10' }],
      [remote('r1', 'OLD NAME', '10')],
    );

    expect(plan.creates).toEqual([{ name: 'NEW NAME', maxscore: '10' }]);
    expect(plan.orphans.map(o => o.name)).toEqual(['OLD NAME']);
  });

  it('matches names exactly — no trimming, no case folding', () => {
    const plan = planRubricSync(
      [{ name: 'a ', seqnum: '1', maxscore: '10' }],
      [remote('r1', 'A', '10')],
    );

    expect(plan.creates).toHaveLength(1);
    expect(plan.orphans).toHaveLength(1);
  });

  it('creates in local seqnum order, since the server assigns seqnum by append order', () => {
    const plan = planRubricSync(
      [{ name: 'Third', seqnum: '10', maxscore: '1' },
       { name: 'First', seqnum: '2', maxscore: '1' }],
      [],
    );

    expect(plan.creates.map(c => c.name)).toEqual(['First', 'Third']);
  });

  it('refuses a part with duplicate LOCAL names', () => {
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '1' }, { name: 'A', seqnum: '2', maxscore: '2' }],
      [],
    );

    expect(plan.duplicateNames).toEqual(['A']);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it('refuses a part with duplicate REMOTE names', () => {
    // Remote is not trustworthy just because Vocareum returned it: copied templates,
    // UI edits and prior failed runs all produce duplicates, and with two rows sharing
    // a name "the name matches" no longer identifies a row.
    const plan = planRubricSync(
      [{ name: 'A', seqnum: '1', maxscore: '1' }],
      [remote('r1', 'A', '1'), remote('r2', 'A', '2')],
    );

    expect(plan.duplicateNames).toEqual(['A']);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
  });
});

describe('projectedPoints', () => {
  it('sums maxscore over non-excluded rows, before and after the plan', () => {
    const remote = [
      { id: 'r1', name: 'A', seqnum: '1', maxscore: '10', auto: false, exclude: false },
      { id: 'r2', name: 'X', seqnum: '2', maxscore: '4', auto: false, exclude: true },
    ];
    const plan = { creates: [{ name: 'B', maxscore: '5' }], updates: [], orphans: [], duplicateNames: [] };

    // before: 10 (X excluded).  after: 10 + 5.
    expect(projectedPoints(remote, plan)).toEqual({ before: 10, after: 15 });
  });

  it('counts an update as replacing the matched row value', () => {
    const remote = [{ id: 'r1', name: 'A', seqnum: '1', maxscore: '10', auto: false, exclude: false }];
    const plan = { creates: [], updates: [{ id: 'r1', maxscore: '12' }], orphans: [], duplicateNames: [] };

    expect(projectedPoints(remote, plan)).toEqual({ before: 10, after: 12 });
  });

  it('excludes a create marked exclude:true from the projection', () => {
    const plan = { creates: [{ name: 'B', maxscore: '5', exclude: true }], updates: [], orphans: [], duplicateNames: [] };
    expect(projectedPoints([], plan)).toEqual({ before: 0, after: 0 });
  });
});
