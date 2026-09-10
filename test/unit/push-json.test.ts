import { describe, it, expect } from 'vitest';
import { pushResultToOutcome, serializePublishResult, serializePushPlan } from '../../src/commands/publish';
import type { PublishResult } from '../../src/types/state';

const emptyResult = (over: Partial<PublishResult> = {}): PublishResult => ({
  success: true,
  created: [],
  updated: [],
  skipped: [],
  failed: [],
  contentState: {},
  summary: '',
  ...over,
});

describe('pushResultToOutcome', () => {
  it('all items succeed', () => {
    expect(pushResultToOutcome({ succeeded: 10, failed: 0, dryRun: false, planned: 10 }))
      .toEqual({ result: 'applied', category: undefined });
  });

  it('7 of 10 succeed is partial, not applied', () => {
    // Serializing this as "applied" with error:null would be indistinguishable
    // from clean success.
    expect(pushResultToOutcome({ succeeded: 7, failed: 3, dryRun: false, planned: 10 }))
      .toEqual({ result: 'partial', category: 'partial' });
  });

  it('every item failing is still partial, not internal', () => {
    expect(pushResultToOutcome({ succeeded: 0, failed: 10, dryRun: false, planned: 10 }).category)
      .toBe('partial');
  });

  it('a dry run with changes reports findings', () => {
    expect(pushResultToOutcome({ succeeded: 0, failed: 0, dryRun: true, planned: 4 }))
      .toEqual({ result: 'reported', category: 'findings' });
  });

  it('a dry run with no changes is a clean no-op', () => {
    expect(pushResultToOutcome({ succeeded: 0, failed: 0, dryRun: true, planned: 0 }))
      .toEqual({ result: 'no-op', category: undefined });
  });

  it('nothing planned and nothing done is a no-op', () => {
    expect(pushResultToOutcome({ succeeded: 0, failed: 0, dryRun: false, planned: 0 }))
      .toEqual({ result: 'no-op', category: undefined });
  });

  it('a user-cancelled push is a no-op, not a failure', () => {
    // Declining the confirmation prompt is a choice, not an error.
    expect(pushResultToOutcome({ succeeded: 0, failed: 0, dryRun: false, planned: 5, cancelled: true }))
      .toEqual({ result: 'no-op', category: undefined });
  });
});

describe('serializePublishResult', () => {
  it('reports counts for the exit decision and arrays for the detail', () => {
    const out = serializePublishResult(emptyResult({
      created: [{ type: 'assignment', id: 'a1', name: 'Lab 1' }] as PublishResult['created'],
      failed: [{ type: 'part', id: 'p1', error: new Error('boom') }] as PublishResult['failed'],
      success: false,
    }));
    expect(out.counts).toEqual({ created: 1, updated: 0, skipped: 0, failed: 1 });
    expect(out.failed).toHaveLength(1);
    expect(out.success).toBe(false);
  });

  it('is JSON-serializable — a failed entry carries an Error object', () => {
    // PublishResult.failed[].error is an Error; JSON.stringify turns one into
    // {} and silently loses the message, so the reason a push failed would
    // vanish from the report that exists to explain it.
    const out = serializePublishResult(emptyResult({
      failed: [{ type: 'part', id: 'p1', error: new Error('upload rejected') }] as PublishResult['failed'],
    }));
    expect(JSON.stringify(out)).toContain('upload rejected');
  });
});

describe('serializePushPlan', () => {
  it('drops plan.execution, which is internal machinery', () => {
    const out = serializePushPlan({
      hasChanges: true,
      summary: 's',
      semanticFingerprint: 'fp',
      intent: { assignments: [] },
      preconditions: { ok: true },
      // @ts-expect-error deliberately passing the internal field to prove it is dropped
      execution: { workingConfig: { huge: 'x'.repeat(1000) }, reconciliation: {}, lastHistory: {} },
    });
    expect(JSON.stringify(out)).not.toContain('workingConfig');
    expect(JSON.stringify(out)).not.toContain('reconciliation');
    expect(out.has_changes).toBe(true);
    expect(out.semantic_fingerprint).toBe('fp');
  });

  it('never omits a declared field, even when the plan lacks it', () => {
    const out = serializePushPlan({ hasChanges: false });
    expect(Object.keys(out).sort()).toEqual(
      ['has_changes', 'intent', 'orphaned_in_vocareum', 'preconditions',
       'semantic_fingerprint', 'stale_in_config', 'summary']);
    expect(out.intent).toBeNull();
  });
});

describe('outcome does not rely on failed[] tracking success', () => {
  it('treats success:false as partial even with an empty failed array', () => {
    expect(pushResultToOutcome({ succeeded: 3, failed: 0, dryRun: false, planned: 3, success: false }))
      .toEqual({ result: 'partial', category: 'partial' });
  });

  it('still reports applied when success is true', () => {
    expect(pushResultToOutcome({ succeeded: 3, failed: 0, dryRun: false, planned: 3, success: true }))
      .toEqual({ result: 'applied', category: undefined });
  });
});

describe('serializePushPlan keeps what the human path reports', () => {
  it('lifts orphans and stale entries out of the dropped execution block', () => {
    // The human path prints "X has no local counterpart and will be left in
    // place"; a --json caller must not get less than a human sees.
    const out = serializePushPlan({
      hasChanges: true,
      execution: {
        reconciliation: {
          orphanedInVocareum: [{ id: '123', name: 'Ghost Lab' }],
          staleInConfig: [{ id: '456', name: 'Removed Lab' }],
        },
      },
    });
    expect(out.orphaned_in_vocareum).toEqual([{ id: '123', name: 'Ghost Lab' }]);
    expect(out.stale_in_config).toEqual([{ id: '456', name: 'Removed Lab' }]);
  });

  it('still drops the bulky internals around them', () => {
    const out = serializePushPlan({
      hasChanges: true,
      execution: {
        reconciliation: { orphanedInVocareum: [] },
        // @ts-expect-error proving workingConfig is not carried through
        workingConfig: { secretish: 'x'.repeat(500) },
      },
    });
    expect(JSON.stringify(out)).not.toContain('workingConfig');
    expect(out.orphaned_in_vocareum).toEqual([]);
  });

  it('emits empty arrays, never undefined, when there is no reconciliation', () => {
    const out = serializePushPlan({ hasChanges: false });
    expect(out.orphaned_in_vocareum).toEqual([]);
    expect(out.stale_in_config).toEqual([]);
  });
});
