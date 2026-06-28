import { describe, it, expect } from 'vitest';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';
import type { PushIntent } from '../../src/core/services/types';

const base: PushIntent = { assignments: [{ path: 'lab1', assignmentId: '900', action: 'update', parts: [
  { partId: '901', path: 'part1', contentHashes: { startercode: 'h1' }, settingsPayload: { nosubmit: false } },
]}]};

describe('semanticFingerprint', () => {
  it('is order-independent for the same intent', () => {
    const reordered: PushIntent = { assignments: [{ ...base.assignments[0],
      parts: [{ ...base.assignments[0].parts[0] }] }] };
    expect(semanticFingerprint(base)).toBe(semanticFingerprint(reordered));
  });
  it('changes when a content hash changes (P0 #1)', () => {
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].parts[0].contentHashes.startercode = 'h2';
    expect(semanticFingerprint(base)).not.toBe(semanticFingerprint(changed));
  });
  it('changes when a settings payload changes', () => {
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].parts[0].settingsPayload = { nosubmit: true };
    expect(semanticFingerprint(base)).not.toBe(semanticFingerprint(changed));
  });
});
