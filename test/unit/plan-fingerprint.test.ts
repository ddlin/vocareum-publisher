import { describe, it, expect } from 'vitest';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';
import type { PushIntent } from '../../src/core/services/types';

const base: PushIntent = { assignments: [{ path: 'lab1', name: 'Lab 1', assignmentId: '900', action: 'update', parts: [
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
  it('changes when deletePaths set is different (P0 #1)', () => {
    const baseWithDelete: PushIntent = JSON.parse(JSON.stringify(base));
    baseWithDelete.assignments[0].parts[0].deletePaths = ['file1.txt', 'file2.txt'];
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].parts[0].deletePaths = ['file1.txt', 'file3.txt'];
    expect(semanticFingerprint(baseWithDelete)).not.toBe(semanticFingerprint(changed));
  });
  it('does not change when deletePaths order is different (proves sort)', () => {
    const baseWithDelete: PushIntent = JSON.parse(JSON.stringify(base));
    baseWithDelete.assignments[0].parts[0].deletePaths = ['b.txt', 'a.txt'];
    const reordered: PushIntent = JSON.parse(JSON.stringify(base));
    reordered.assignments[0].parts[0].deletePaths = ['a.txt', 'b.txt'];
    expect(semanticFingerprint(baseWithDelete)).toBe(semanticFingerprint(reordered));
  });
  it('changes when templateAssignmentId changes (P0 #1)', () => {
    const baseWithTemplate: PushIntent = JSON.parse(JSON.stringify(base));
    baseWithTemplate.assignments[0].templateAssignmentId = 'tpl1';
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].templateAssignmentId = 'tpl2';
    expect(semanticFingerprint(baseWithTemplate)).not.toBe(semanticFingerprint(changed));
  });
  it('changes when a create assignment name changes', () => {
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].name = 'Renamed Lab';
    expect(semanticFingerprint(base)).not.toBe(semanticFingerprint(changed));
  });
  it('changes when templateCourseId changes (P0 #1 — cross-course template source)', () => {
    const baseWithCourse: PushIntent = JSON.parse(JSON.stringify(base));
    baseWithCourse.assignments[0].templateCourseId = 'course-A';
    const changed: PushIntent = JSON.parse(JSON.stringify(base));
    changed.assignments[0].templateCourseId = 'course-B';
    expect(semanticFingerprint(baseWithCourse)).not.toBe(semanticFingerprint(changed));
  });
  it('shifts when templateCourseId is added to an intent that previously had none', () => {
    const withoutCourse: PushIntent = JSON.parse(JSON.stringify(base));
    const withCourse: PushIntent = JSON.parse(JSON.stringify(base));
    withCourse.assignments[0].templateCourseId = 'course-X';
    expect(semanticFingerprint(withoutCourse)).not.toBe(semanticFingerprint(withCourse));
  });
});
