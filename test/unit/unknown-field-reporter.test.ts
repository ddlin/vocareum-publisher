import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';

const makeLogger = () => ({
  warn: vi.fn(),
  plain: vi.fn(),
});

describe('UnknownFieldReporter', () => {
  let logger: ReturnType<typeof makeLogger>;
  beforeEach(() => {
    logger = makeLogger();
  });

  it('dedupes repeated (scope, field) pairs and counts occurrences', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('part', 'new_flag', true, '1');
    r.record('part', 'new_flag', false, '2');
    r.record('part', 'new_flag', true, '3');
    const summary = r.summary();
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      scope: 'part',
      field: 'new_flag',
      exampleValue: true,
      count: 3,
      firstResourceId: '1',
    });
  });

  it('emits a warn line only on the first occurrence of a (scope, field) pair', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('assignment', 'foo', 1, 'a1');
    r.record('assignment', 'foo', 2, 'a2');
    r.record('assignment', 'bar', 3, 'a1');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toContain('foo');
    expect(logger.warn.mock.calls[1][0]).toContain('bar');
  });

  it('hasAny returns false when no records and true otherwise', () => {
    const r = new UnknownFieldReporter(logger);
    expect(r.hasAny()).toBe(false);
    r.record('part', 'x', 1, 'p1');
    expect(r.hasAny()).toBe(true);
  });

  it('summary sorts by scope then field', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('part', 'zeta', 1, 'p1');
    r.record('assignment', 'beta', 2, 'a1');
    r.record('part', 'alpha', 3, 'p2');
    r.record('assignment', 'alpha', 4, 'a2');
    const summary = r.summary();
    expect(summary.map((s) => `${s.scope}.${s.field}`)).toEqual([
      'assignment.alpha',
      'assignment.beta',
      'part.alpha',
      'part.zeta',
    ]);
  });

  it('printSummary prints nothing when no unknowns were recorded', () => {
    const r = new UnknownFieldReporter(logger);
    r.printSummary();
    expect(logger.plain).not.toHaveBeenCalled();
  });

  it('printSummary prints a block including field names and example values when unknowns exist', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('part', 'new_flag', true, 'p1');
    r.record('part', 'extra', 'abc', 'p2');
    r.printSummary();
    expect(logger.plain).toHaveBeenCalled();
    const lines = logger.plain.mock.calls.map((c) => c[0] as string);
    const printed = lines.join('\n');
    expect(printed).toContain('new_flag');
    expect(printed).toContain('extra');
    expect(printed).toContain('_unknown_settings');
    expect(printed).toContain('https://github.com/ddlin/vocareum-publisher/issues/new');
    // Output stability: must open and close with a divider line
    expect(lines[0]).toMatch(/─{20,}/);
    expect(lines[lines.length - 1]).toMatch(/─{20,}/);
  });

  it('printSummary separates scope groups with a blank line', () => {
    const r = new UnknownFieldReporter(logger);
    r.record('assignment', 'asn_field', 'x', 'a1');
    r.record('part', 'part_field', 1, 'p1');
    r.printSummary();
    const lines = logger.plain.mock.calls.map((c) => c[0] as string);
    // Find the indices of the two "resource scope:" lines and confirm there's
    // a blank line between them.
    const scopeLineIdxs = lines
      .map((l, i) => (l.includes('- resource scope:') ? i : -1))
      .filter((i) => i >= 0);
    expect(scopeLineIdxs).toHaveLength(2);
    // Between the two groups there should be at least one empty line.
    const between = lines.slice(scopeLineIdxs[0], scopeLineIdxs[1]);
    expect(between.some((l) => l === '')).toBe(true);
  });
});
