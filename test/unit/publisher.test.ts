import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, HistorySettingChange, PartSettings } from '../../src/types/config';
import type { PublishOperationOptions, ReconciliationPlan } from '../../src/types/state';
import type { RubricCreate, RubricUpdate, RemoteRubric, RubricSyncPlan } from '../../src/types/api';
import type { VocareumClient } from '../../src/api/client';
import { publish, pushSettingChange, buildPartSettingsPayload } from '../../src/core/publisher';
import { executePush } from '../../src/core/services/push-service';
import { semanticFingerprint } from '../../src/core/services/plan-fingerprint';
import type { PushPlan } from '../../src/core/services/types';
import type { LockedSession } from '../../src/core/session';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { NonInteractivePrompter } from '../../src/core/services/context';

const {
  reconcileMock,
  displayPlanMock,
  copyAssignmentMock,
  getAssignmentMock,
  updateAssignmentMock,
  updateCourseMock,
  getPartMock,
  updatePartMock,
  readDirectoryMock,
  syncDirectoryMock,
  updateConfigMock,
  commitChangesMock,
  getCommitShaMock,
  getGitUserNameMock,
  promptConfirmMock,
  createRubricsMock,
  updateRubricsMock,
} = vi.hoisted(() => ({
  reconcileMock: vi.fn(),
  displayPlanMock: vi.fn(),
  copyAssignmentMock: vi.fn(),
  getAssignmentMock: vi.fn(),
  updateAssignmentMock: vi.fn(),
  updateCourseMock: vi.fn(),
  getPartMock: vi.fn(),
  updatePartMock: vi.fn(),
  readDirectoryMock: vi.fn(),
  syncDirectoryMock: vi.fn(),
  updateConfigMock: vi.fn(),
  commitChangesMock: vi.fn(),
  getCommitShaMock: vi.fn(),
  getGitUserNameMock: vi.fn(),
  promptConfirmMock: vi.fn(),
  createRubricsMock: vi.fn(),
  updateRubricsMock: vi.fn(),
}));

vi.mock('../../src/api/rubrics', () => ({
  createRubrics: createRubricsMock,
  updateRubrics: updateRubricsMock,
}));

vi.mock('../../src/core/reconciler', () => ({
  reconcile: reconcileMock,
  displayPlan: displayPlanMock,
}));

// utils/files: mock readFile (for configDigest) and calculateDirectoryHash
// (fallback for create actions that have no reconciler-computed dirHashes).
vi.mock('../../src/utils/files', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  readFile: vi.fn().mockResolvedValue('mock-config-yaml-content'),
  ensureDirectory: vi.fn().mockResolvedValue(undefined),
  readDirectory: vi.fn().mockResolvedValue({}),
  calculateDirectoryHash: vi.fn().mockResolvedValue('mock-dir-hash'),
}));

vi.mock('../../src/api/assignments', () => ({
  copyAssignment: copyAssignmentMock,
  getAssignment: getAssignmentMock,
  updateAssignment: updateAssignmentMock,
}));

vi.mock('../../src/api/courses', () => ({
  updateCourse: updateCourseMock,
}));

vi.mock('../../src/api/parts', () => ({
  getPart: getPartMock,
  updatePart: updatePartMock,
}));

vi.mock('../../src/core/uploader', () => ({
  readDirectory: readDirectoryMock,
  syncDirectory: syncDirectoryMock,
}));

vi.mock('../../src/core/config', () => ({
  updateConfig: updateConfigMock,
  withConfigLock: vi.fn((_path: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/utils/git', () => ({
  commitChanges: commitChangesMock,
  getCommitSha: getCommitShaMock,
  getGitUserName: getGitUserNameMock,
}));

vi.mock('../../src/utils/prompts', () => ({
  promptConfirm: promptConfirmMock,
}));

describe('pushSettingChange _unknown_settings guard', () => {
  it('does not push a change record when field is _unknown_settings', () => {
    const changes: HistorySettingChange[] = [];
    pushSettingChange(changes, {
      scope: 'assignment',
      assignment_id: 'a1',
      assignment_name: 'A1',
      field: '_unknown_settings',
      from: { foo: 1 },
      to: { foo: 2 },
    });
    expect(changes).toEqual([]);
  });

  it('still pushes a change record for normal fields', () => {
    const changes: HistorySettingChange[] = [];
    pushSettingChange(changes, {
      scope: 'assignment',
      assignment_id: 'a1',
      assignment_name: 'A1',
      field: 'nosubmit',
      from: false,
      to: true,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('nosubmit');
  });

  it('still no-ops when from equals to (existing behavior preserved)', () => {
    const changes: HistorySettingChange[] = [];
    pushSettingChange(changes, {
      scope: 'assignment',
      assignment_id: 'a1',
      assignment_name: 'A1',
      field: 'nosubmit',
      from: true,
      to: true,
    });
    expect(changes).toEqual([]);
  });
});

describe('publish', () => {
  const client = {} as VocareumClient;

  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: '201303',
      template_assignment_id: 'tmpl-1',
      api_base_url: 'https://api.vocareum.com',
    },
    assignments: [
      {
        assignment_id: null,
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: true,
        parts: [{ part_id: null, path: 'part1' }],
      },
    ],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: false,
      abort_on_error: false,
      sync_deletes: false,
      exclude_patterns: [],
    },
  };

  const baseOptions: PublishOperationOptions = {
    dryRun: false,
    nonInteractive: true,
    autoCommit: false,
    syncDeletes: false,
    verbose: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    updateConfigMock.mockResolvedValue(undefined);
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
    readDirectoryMock.mockResolvedValue({});
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', deleted: '0', courseid: '201303' });
    getPartMock.mockResolvedValue({ id: 'part-1', name: 'Part 1', seqnum: '0', deleted: '0', courseid: '201303', assignmentid: 'asn-1' });
    promptConfirmMock.mockResolvedValue(true);
  });

  it('should stop on first error action when abortOnError=true', async () => {
    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'error',
          assignment: config.assignments[0],
          parts: [],
          reason: 'Missing assignment_id',
        },
        {
          type: 'create',
          assignment: config.assignments[0],
          parts: [],
          willCreate: true,
          templateId: 'tmpl-1',
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 1,
        assignmentsToUpdate: 0,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    };
    reconcileMock.mockResolvedValue(plan);

    const result = await publish(config, client, { ...baseOptions, abortOnError: true });

    expect(result.success).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(copyAssignmentMock).not.toHaveBeenCalled();
  });

  it('should update assignment metadata when assignmentMetadataChanged=true', async () => {
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      settings: { description: 'New description' },
    };

    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [],
          assignmentMetadataChanged: true,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    };
    reconcileMock.mockResolvedValue(plan);
    updateAssignmentMock.mockResolvedValue(undefined);

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    // API now uses course-scoped endpoint: updateAssignment(client, courseId, assignmentId, settings)
    expect(updateAssignmentMock).toHaveBeenCalledWith(client, '201303', 'asn-1', {
      name: 'Lab 1',
    });
  });

  it('should send all working assignment settings', async () => {
    // Description is observed-only; writable fields are sent.
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      settings: {
        nosubmit: false,
        auto_submit: true,
        grading_on_submit: true,
      },
    };

    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [],
          assignmentMetadataChanged: true,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    };
    reconcileMock.mockResolvedValue(plan);
    updateAssignmentMock.mockResolvedValue(undefined);

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    // API now uses course-scoped endpoint: updateAssignment(client, courseId, assignmentId, settings)
    expect(updateAssignmentMock).toHaveBeenCalledWith(client, '201303', 'asn-1', {
      name: 'Lab 1',
      nosubmit: false,
      auto_submit: true,
      grading_on_submit: true,
    });
  });

  it('should send all part settings when part metadata changed', async () => {
    // Note: name is REQUIRED for part updates
    // Working fields: name, submission_filters, session_length, cloud_labs (if org permits),
    // monthly_dollar, monthly_time, total_time, total_dollar
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      parts: [
        {
          part_id: 'part-1',
          path: 'part1',
          name: 'Updated Part',
          settings: {
            cloud_labs: true,
            session_length: '3600',
            late_penalty_percent: 10,
            late_penalty_percent_rule: 'max score',
            deadlinedate: '2026-12-31T23:59:00Z',
            number_of_submissions: 5,
            submission_filters: { include: ['*.py'], exclude: ['*.pyc'] },
          },
        },
      ],
    };

    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [
            {
              type: 'update',
              part: assignment.parts[0],
              contentChanged: false,
              metadataChanged: true,
              reason: 'Settings changed',
            },
          ],
          assignmentMetadataChanged: false,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    };
    reconcileMock.mockResolvedValue(plan);
    updatePartMock.mockResolvedValue(undefined);

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    // API now uses course-scoped endpoint: updatePart(client, courseId, assignmentId, partId, settings)
    expect(updatePartMock).toHaveBeenCalledWith(client, '201303', 'asn-1', 'part-1', {
      name: 'Updated Part',  // Required for all part updates
      cloud_labs: true,
      session_length: '3600',
      late_penalty_percent: 10,
      late_penalty_percent_rule: 'max score',
      deadlinedate: '2026-12-31T23:59:00Z',
      number_of_submissions: 5,
      submission_filters: {
        include: ['*.py'],
        exclude: ['*.pyc'],
        list: undefined,
      },
    });
  });

  it('should pass filtered assignments to reconcile when assignment option is used', async () => {
    const multiConfig: Config = {
      ...config,
      assignments: [
        { assignment_id: 'asn-1', name: 'Lab 1', path: 'lab1', parts: [{ part_id: 'p1', path: 'part1' }] },
        { assignment_id: 'asn-2', name: 'Lab 2', path: 'lab2', parts: [{ part_id: 'p2', path: 'part1' }] },
      ],
    };

    const emptyPlan: ReconciliationPlan = {
      config: multiConfig,
      course: { type: 'skip' },
      assignments: [],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 0,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 0,
      },
      orphanedInVocareum: [],
    };
    reconcileMock.mockResolvedValue(emptyPlan);

    await publish(multiConfig, client, { ...baseOptions, assignment: 'lab2' });

    const passedConfig = reconcileMock.mock.calls[0][0] as Config;
    expect(passedConfig.assignments).toHaveLength(1);
    expect(passedConfig.assignments[0].path).toBe('lab2');
  });

  it('should retry part settings update with safe payload after 400', async () => {
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      parts: [
        {
          part_id: 'part-1',
          path: 'part1',
          name: 'Part 1',
          settings: {
            cloud_labs: false,
            session_length: '3600',
            submission_filters: { include: ['*.py'], exclude: [] },
          },
        },
      ],
    };

    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [
            {
              type: 'update',
              part: assignment.parts[0],
              contentChanged: false,
              metadataChanged: true,
              reason: 'Settings changed',
            },
          ],
          assignmentMetadataChanged: false,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    };
    reconcileMock.mockResolvedValue(plan);
    // Only 2 calls: this fixture has no labtype/container_image, so the
    // without-platform rung would be byte-identical to full and is skipped
    // automatically (round 1 fix — the ladder now skips a rung whose payload
    // deep-equals the one just attempted, rather than re-sending a guaranteed
    // duplicate). The effective ladder here is full -> safe.
    updatePartMock
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce(undefined);

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    expect(updatePartMock).toHaveBeenCalledTimes(2);
    expect(updatePartMock.mock.calls[0][4]).toMatchObject({
      name: 'Part 1',
      cloud_labs: false,
      session_length: '3600',
      submission_filters: {
        include: ['*.py'],
        exclude: [],
        list: undefined,
      },
    });
    expect(updatePartMock.mock.calls[1][4]).toMatchObject({
      name: 'Part 1',
      session_length: '3600',
      submission_filters: {
        include: ['*.py'],
        exclude: [],
        list: undefined,
      },
    });
    expect(updatePartMock.mock.calls[1][4].cloud_labs).toBeUndefined();
  });

  it('should retry part settings update when error uses statusCode=400 shape', async () => {
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      parts: [
        {
          part_id: 'part-1',
          path: 'part1',
          name: 'Part 1',
          settings: {
            session_length: '3600',
          },
        },
      ],
    };

    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [
            {
              type: 'update',
              part: assignment.parts[0],
              contentChanged: false,
              metadataChanged: true,
              reason: 'Settings changed',
            },
          ],
          assignmentMetadataChanged: false,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    };
    reconcileMock.mockResolvedValue(plan);
    updatePartMock
      .mockRejectedValueOnce({ statusCode: 400, message: 'Request failed with status code 400' })
      .mockResolvedValueOnce(undefined);

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    expect(updatePartMock).toHaveBeenCalledTimes(2);
  });

  it('should skip metadata failure when all payload retries return 400', async () => {
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      parts: [
        {
          part_id: 'part-1',
          path: 'part1',
          name: 'Part 1',
          settings: {
            cloud_labs: true,
            session_length: '3600',
          },
        },
      ],
    };

    const plan: ReconciliationPlan = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [
            {
              type: 'update',
              part: assignment.parts[0],
              contentChanged: false,
              metadataChanged: true,
              reason: 'Settings changed',
            },
          ],
          assignmentMetadataChanged: false,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    };
    reconcileMock.mockResolvedValue(plan);
    // Only 3 calls: this fixture has no labtype/container_image, so the
    // without-platform rung is skipped as a guaranteed duplicate of full
    // (round 1 fix). Effective ladder here is full -> safe -> name-only.
    updatePartMock
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockRejectedValueOnce({ response: { status: 400 } });

    const result = await publish(config, client, baseOptions);

    expect(updatePartMock).toHaveBeenCalledTimes(3);
    expect(updatePartMock.mock.calls[2][4]).toEqual({ name: 'Part 1' });
    expect(result.failed).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it('should persist detailed settings and file size deltas in publish history', async () => {
    const withHistory: Config = {
      ...config,
      publish_history: [
        {
          timestamp: '2026-02-13T00:00:00.000Z',
          commit_sha: 'old',
          published_by: 'tester',
          status: 'success',
          content_state: {
            'lab1/part1/docs': 'oldhash',
          },
          file_size_state: {
            'lab1/part1/docs/readme.md': 2,
          },
        },
      ],
    };
    const assignment = {
      ...withHistory.assignments[0],
      assignment_id: 'asn-1',
      name: 'Lab 1 Updated',
      settings: { description: 'new description' },
      parts: [
        {
          part_id: 'part-1',
          path: 'part1',
          name: 'Part 1',
          settings: { session_length: '60' },
        },
      ],
    };

    const plan: ReconciliationPlan = {
      config: withHistory,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment,
          parts: [
            {
              type: 'update',
              part: assignment.parts[0],
              contentChanged: true,
              changedDirectories: ['docs'],
              metadataChanged: true,
              reason: 'Content and settings changed',
            },
          ],
          assignmentMetadataChanged: true,
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 2,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    };

    reconcileMock.mockResolvedValue(plan);
    getAssignmentMock.mockResolvedValue({
      id: 'asn-1',
      name: 'Lab 1',
      deleted: '0',
      courseid: '201303',
      description: 'old description',
    });
    getPartMock.mockResolvedValue({
      id: 'part-1',
      seqnum: '0',
      name: 'Part 1',
      deleted: '0',
      courseid: '201303',
      assignmentid: 'asn-1',
      session_length: '30',
    });
    readDirectoryMock.mockResolvedValue({
      'readme.md': Buffer.from('hello'),
    });
    syncDirectoryMock.mockResolvedValue({
      succeeded: ['readme.md'],
      failed: [],
      directoryHash: 'newhash',
      deleted: [],
    });

    const result = await publish(withHistory, client, baseOptions);

    expect(result.success).toBe(true);
    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    const historyArg = updateConfigMock.mock.calls[0][1].publish_history[0];
    expect(historyArg.changes.settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'assignment',
          field: 'name',
          from: 'Lab 1',
          to: 'Lab 1 Updated',
        }),
        expect.objectContaining({
          scope: 'part',
          field: 'session_length',
          from: '30',
          to: '60',
        }),
      ])
    );
    expect(historyArg.changes.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'lab1/part1/docs/readme.md',
          previous_size: 2,
          current_size: 5,
          delta: 3,
        }),
      ])
    );
    expect(historyArg.file_size_state['lab1/part1/docs/readme.md']).toBe(5);
    expect(historyArg.settings_state).toMatchObject({
      'assignments/lab1/parts/part1/settings/session_length': '60',
    });
    expect(historyArg.settings_state).not.toHaveProperty('assignments/lab1/settings/description');
  });
});

describe('buildPartSettingsPayload — _unknown_settings handling', () => {
  it('full mode spreads _unknown_settings keys at the top level (without the wrapper)', () => {
    const settings: PartSettings = {
      session_length: '60',
      _unknown_settings: { vendor_flag: true, extra: 'x' },
    };
    const payload = buildPartSettingsPayload('PartName', settings, 'full') as Record<string, unknown>;
    expect(payload.session_length).toBe('60');
    expect(payload.vendor_flag).toBe(true);
    expect(payload.extra).toBe('x');
    expect(payload._unknown_settings).toBeUndefined();
  });

  it('safe mode does NOT include _unknown_settings keys', () => {
    const settings: PartSettings = {
      session_length: '60',
      _unknown_settings: { vendor_flag: true },
    };
    const payload = buildPartSettingsPayload('PartName', settings, 'safe') as Record<string, unknown>;
    expect(payload.vendor_flag).toBeUndefined();
    expect(payload._unknown_settings).toBeUndefined();
    expect(payload.session_length).toBe('60');
  });

  it('full mode with no _unknown_settings behaves identically to today', () => {
    const settings: PartSettings = { session_length: '60', labtype: 'Document' };
    const payload = buildPartSettingsPayload('PartName', settings, 'full') as Record<string, unknown>;
    expect(payload.session_length).toBe('60');
    expect(payload.labtype).toBe('Document');
    expect(Object.keys(payload).every((k) => !k.startsWith('vendor_'))).toBe(true);
  });

  it('full mode filters reserved keys from _unknown_settings — "name" in _unknown_settings does NOT override the real part name', () => {
    const settings: PartSettings = {
      session_length: '60',
      _unknown_settings: { name: 'Wrong Name', vendor_flag: 'keep' },
    };
    const payload = buildPartSettingsPayload('RealPartName', settings, 'full') as Record<string, unknown>;
    expect(payload.name).toBe('RealPartName');
    expect(payload.vendor_flag).toBe('keep');
    // 'name' must not appear from _unknown_settings since it is reserved
  });

  it('full mode filters all part reserved keys from _unknown_settings', () => {
    const settings: PartSettings = {
      _unknown_settings: {
        name: 'x',
        id: 'x',
        courseid: 'x',
        assignmentid: 'x',
        session_length: '999',  // known setting key — also reserved
        vendor_ok: 'yes',
      },
    };
    const payload = buildPartSettingsPayload('Part', settings, 'full') as Record<string, unknown>;
    // All reserved keys must use their normal values, not the _unknown_settings overrides
    expect(payload.name).toBe('Part');
    expect(payload.id).toBeUndefined();          // non-setting field never in payload
    expect(payload.courseid).toBeUndefined();     // non-setting field never in payload
    expect(payload.assignmentid).toBeUndefined(); // non-setting field never in payload
    expect(payload.session_length).toBeUndefined(); // undefined because partSettings?.session_length is undefined
    expect(payload.vendor_ok).toBe('yes');
  });
});

describe('part update full→safe ladder with _unknown_settings (integration-style via publish)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries with safe payload when full is rejected 400, and updateConfig is not asked to remove _unknown_settings', async () => {
    const localConfig: Config = {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_id: 'tmpl-1',
        api_base_url: 'https://api.vocareum.com',
      },
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Lab 1',
          path: 'lab1',
          create_from_template: false,
          parts: [{
            part_id: 'p1',
            path: 'part1',
            settings: {
              session_length: '60',
              _unknown_settings: { vendor_flag: true },
            },
          }],
        },
      ],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip',
        auto_commit: false,
        abort_on_error: false,
        sync_deletes: false,
        exclude_patterns: [],
      },
    };

    const plan: ReconciliationPlan = {
      config: localConfig,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [{ type: 'update', part: localConfig.assignments[0].parts[0], metadataChanged: true, contentChanged: false }],
        assignmentMetadataChanged: false,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    };

    reconcileMock.mockResolvedValue(plan);
    displayPlanMock.mockReturnValue(undefined);
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: localConfig.vocareum.course_id, name: 'Lab 1', deleted: '0',
    });
    getPartMock.mockResolvedValue({
      id: 'p1', courseid: localConfig.vocareum.course_id, assignmentid: 'a1',
      name: 'part1', seqnum: '0', deleted: '0', session_length: '60',
    });
    readDirectoryMock.mockResolvedValue({});
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'h' });
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    updateConfigMock.mockResolvedValue(undefined);

    const http400 = Object.assign(new Error('rejected'), { response: { status: 400 } });
    // Only 2 calls: this fixture has no labtype/container_image, so the
    // without-platform rung is skipped as a guaranteed duplicate of full
    // (round 1 fix). Effective ladder here is full -> safe.
    updatePartMock
      .mockRejectedValueOnce(http400)   // full attempt
      .mockResolvedValueOnce(undefined); // safe retry

    const baseOptions: PublishOperationOptions = {
      dryRun: false,
      nonInteractive: true,
      autoCommit: false,
      syncDeletes: false,
      verbose: false,
    };

    await publish(localConfig, {} as VocareumClient, baseOptions);

    expect(updatePartMock).toHaveBeenCalledTimes(2);
    const firstSettings = updatePartMock.mock.calls[0][4] as Record<string, unknown>;
    const secondSettings = updatePartMock.mock.calls[1][4] as Record<string, unknown>;
    // First call = full payload: includes both known + spread unknown fields
    expect(firstSettings.session_length).toBe('60');
    expect(firstSettings.vendor_flag).toBe(true);
    // Second call = safe payload: includes known fields but NOT unknown spread,
    // AND NOT full-only fields like labtype / endlab / cloud_labs
    expect(secondSettings.session_length).toBe('60');
    expect(secondSettings.vendor_flag).toBeUndefined();
    expect(secondSettings.labtype).toBeUndefined();
    expect(secondSettings.endlab).toBeUndefined();
    expect(secondSettings.cloud_labs).toBeUndefined();

    // updateConfig should not have been called with a payload that strips
    // _unknown_settings. If updateConfigMock was called for any reason, check
    // that none of its calls request removing or clearing _unknown_settings.
    for (const call of updateConfigMock.mock.calls) {
      const updates = call[1];
      if (updates?.assignments) {
        for (const a of updates.assignments) {
          if (a.parts) {
            for (const p of a.parts) {
              if (p.settings) {
                expect(p.settings._unknown_settings).toBeDefined();
              }
            }
          }
        }
      }
    }
  });
});

describe('assignment update — 2-step ladder with _unknown_settings', () => {
  function makeConfigWithUnknownAsnSetting(includeUnknown = true): Config {
    return {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_id: 'tmpl-1',
        api_base_url: 'https://api.vocareum.com',
      },
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Lab 1',
          path: 'lab1',
          create_from_template: false,
          parts: [{ part_id: 'p1', path: 'part1' }],
          settings: {
            nosubmit: true,
            ...(includeUnknown ? { _unknown_settings: { vendor_flag: true } } : {}),
          },
        },
      ],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip',
        auto_commit: false,
        abort_on_error: false,
        sync_deletes: false,
        exclude_patterns: [],
      },
    };
  }

  function makePlanForUpdate(local: Config): ReconciliationPlan {
    return {
      config: local,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: local.assignments[0],
        parts: [],
        assignmentMetadataChanged: true,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    } as ReconciliationPlan;
  }

  function stubRemoteFetches(local: Config): void {
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: local.vocareum.course_id,
      name: 'Lab 1', deleted: '0', nosubmit: false,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    updateConfigMock.mockResolvedValue(undefined);
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
    readDirectoryMock.mockResolvedValue({});
    getPartMock.mockResolvedValue({ id: 'p1', name: 'Part 1', seqnum: '0', deleted: '0', courseid: '201303', assignmentid: 'a1' });
    promptConfirmMock.mockResolvedValue(true);
    displayPlanMock.mockReturnValue(undefined);
  });

  const client = {} as VocareumClient;
  const baseOptions: PublishOperationOptions = {
    dryRun: false,
    nonInteractive: true,
    autoCommit: false,
    syncDeletes: false,
    verbose: false,
  };

  it('first attempt sends a payload that includes both known fields and the unknown_settings keys', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting();
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalled();
    const firstCallSettings = updateAssignmentMock.mock.calls[0][3] as Record<string, unknown>;
    expect(firstCallSettings.nosubmit).toBe(true);
    expect(firstCallSettings.vendor_flag).toBe(true);
  });

  it('retries with known-only payload when first attempt fails 400', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting();
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);

    const http400 = Object.assign(new Error('rejected'), { response: { status: 400 } });
    updateAssignmentMock
      .mockRejectedValueOnce(http400)
      .mockResolvedValueOnce(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalledTimes(2);
    const second = updateAssignmentMock.mock.calls[1][3] as Record<string, unknown>;
    expect(second.vendor_flag).toBeUndefined();
    expect(second.nosubmit).toBe(true);
  });

  it('non-400 errors are not retried and result in failure (existing behavior preserved)', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting();
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);

    const http500 = Object.assign(new Error('server'), { response: { status: 500 } });
    updateAssignmentMock.mockRejectedValueOnce(http500);

    const result = await publish(localConfig, client, baseOptions);
    expect(result.success).toBe(false);
    expect(updateAssignmentMock).toHaveBeenCalledTimes(1);
  });

  it('without _unknown_settings, makes only one attempt (existing behavior)', async () => {
    const localConfig = makeConfigWithUnknownAsnSetting(false);
    reconcileMock.mockResolvedValue(makePlanForUpdate(localConfig));
    stubRemoteFetches(localConfig);
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalledTimes(1);
  });

  it('_unknown_settings.name does NOT override the real assignment name in the payload', async () => {
    const localConfig: Config = {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_id: 'tmpl-1',
        api_base_url: 'https://api.vocareum.com',
      },
      assignments: [{
        assignment_id: 'a1',
        name: 'Real Assignment Name',
        path: 'lab1',
        create_from_template: false,
        parts: [],
        settings: {
          nosubmit: true,
          _unknown_settings: { name: 'Wrong Name', vendor_ok: 'yes' },
        },
      }],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip',
        auto_commit: false,
        abort_on_error: false,
        sync_deletes: false,
        exclude_patterns: [],
      },
    };

    const plan: ReconciliationPlan = {
      config: localConfig,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [],
        assignmentMetadataChanged: true,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    } as ReconciliationPlan;

    reconcileMock.mockResolvedValue(plan);
    getAssignmentMock.mockResolvedValue({
      id: 'a1',
      courseid: '201303',
      name: 'Real Assignment Name',
      deleted: '0',
      nosubmit: false,
    });
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).toHaveBeenCalled();
    const payload = updateAssignmentMock.mock.calls[0][3] as Record<string, unknown>;
    // Real name preserved — NOT overridden by _unknown_settings.name
    expect(payload.name).toBe('Real Assignment Name');
    // Non-reserved unknown key passes through
    expect(payload.vendor_ok).toBe('yes');
    // nosubmit from known settings
    expect(payload.nosubmit).toBe(true);
  });

  it('filters all assignment reserved keys (id, courseid, name, known settings) from _unknown_settings', async () => {
    const localConfig: Config = {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_id: 'tmpl-1',
        api_base_url: 'https://api.vocareum.com',
      },
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Real Assignment Name',
          path: 'lab1',
          create_from_template: false,
          parts: [{ part_id: 'p1', path: 'part1' }],
          settings: {
            nosubmit: true,
            _unknown_settings: {
              // Reserved (NON_SETTING_FIELDS_ASSIGNMENT) — must be filtered
              id: 'WRONG_ID',
              courseid: 'WRONG_COURSE',
              name: 'Wrong Name',
              // Reserved (KNOWN_ASSIGNMENT_SETTING_KEYS) — must be filtered
              nosubmit: false,
              // Non-reserved — must pass through
              vendor_ok: 'passes',
            },
          },
        },
      ],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip',
        auto_commit: false,
        abort_on_error: false,
        sync_deletes: false,
        exclude_patterns: [],
      },
    };

    const plan: ReconciliationPlan = {
      config: localConfig,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [],
        assignmentMetadataChanged: true,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    } as ReconciliationPlan;

    reconcileMock.mockResolvedValue(plan);
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: '201303', name: 'Real Assignment Name', deleted: '0', nosubmit: false,
    });
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    const payload = updateAssignmentMock.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.name).toBe('Real Assignment Name');
    expect(payload.id).toBeUndefined();
    expect(payload.courseid).toBeUndefined();
    expect(payload.nosubmit).toBe(true);     // from known field, NOT overridden
    expect(payload.vendor_ok).toBe('passes'); // non-reserved passes through
  });

  it('filters nested _unknown_settings._unknown_settings from outgoing payload', async () => {
    // A YAML where the wrapper key is itself listed inside the bucket must
    // not leak _unknown_settings as a top-level API payload field.
    const localConfig: Config = {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_id: 'tmpl-1',
        api_base_url: 'https://api.vocareum.com',
      },
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Real Assignment Name',
          path: 'lab1',
          create_from_template: false,
          parts: [{ part_id: 'p1', path: 'part1' }],
          settings: {
            nosubmit: true,
            _unknown_settings: {
              _unknown_settings: { nested_garbage: true },
              vendor_ok: 'passes',
            },
          },
        },
      ],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip',
        auto_commit: false,
        abort_on_error: false,
        sync_deletes: false,
        exclude_patterns: [],
      },
    };

    reconcileMock.mockResolvedValue({
      config: localConfig,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [],
        assignmentMetadataChanged: true,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    } as ReconciliationPlan);
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: '201303', name: 'Real Assignment Name', deleted: '0', nosubmit: false,
    });
    updateAssignmentMock.mockResolvedValue(undefined);

    await publish(localConfig, client, baseOptions);

    const payload = updateAssignmentMock.mock.calls[0][3] as Record<string, unknown>;
    expect(payload._unknown_settings).toBeUndefined();
    expect(payload.vendor_ok).toBe('passes');
  });
});

describe('publish — Fix #3: reporter threading through update-path reads', () => {
  const client = {} as VocareumClient;
  const baseOptions: PublishOperationOptions = {
    dryRun: false,
    nonInteractive: true,
    autoCommit: false,
    syncDeletes: false,
    verbose: false,
  };

  function makeUpdatePlan(localConfig: Config): ReconciliationPlan {
    return {
      config: localConfig,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [],
        assignmentMetadataChanged: true,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 0,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    } as ReconciliationPlan;
  }

  function makePartUpdatePlan(localConfig: Config): ReconciliationPlan {
    return {
      config: localConfig,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: localConfig.assignments[0],
        parts: [{
          type: 'update',
          part: localConfig.assignments[0].parts[0],
          metadataChanged: true,
          contentChanged: false,
        }],
        assignmentMetadataChanged: false,
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
    } as ReconciliationPlan;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    updateConfigMock.mockResolvedValue(undefined);
    syncDirectoryMock.mockResolvedValue({ succeeded: [], failed: [], directoryHash: 'hash' });
    readDirectoryMock.mockResolvedValue({});
    promptConfirmMock.mockResolvedValue(true);
    displayPlanMock.mockReturnValue(undefined);
    updateAssignmentMock.mockResolvedValue(undefined);
    updatePartMock.mockResolvedValue(undefined);
  });

  it('records unknown assignment fields in reporter when getAssignment returns them during update', async () => {
    const { UnknownFieldReporter } = await import('../../src/utils/unknown-field-reporter');

    const localConfig: Config = {
      version: '1.0',
      vocareum: { org_id: '1', course_id: '201303', api_base_url: 'https://api.vocareum.com' },
      assignments: [{
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        parts: [],
        settings: { nosubmit: false },
      }],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    };

    reconcileMock.mockResolvedValue(makeUpdatePlan(localConfig));
    // Remote returns an unknown field 'vendor_setting'
    getAssignmentMock.mockResolvedValue({
      id: 'a1',
      courseid: '201303',
      name: 'Lab 1',
      deleted: '0',
      nosubmit: false,
      vendor_setting: 'active',
    });

    const reporter = new UnknownFieldReporter({ warn: vi.fn(), plain: vi.fn() });
    await publish(localConfig, client, baseOptions, reporter);

    const summary = reporter.summary();
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'assignment', field: 'vendor_setting' }),
      ])
    );
  });

  it('records unknown part fields in reporter when getPart returns them during update', async () => {
    const { UnknownFieldReporter } = await import('../../src/utils/unknown-field-reporter');

    const localConfig: Config = {
      version: '1.0',
      vocareum: { org_id: '1', course_id: '201303', api_base_url: 'https://api.vocareum.com' },
      assignments: [{
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        parts: [{
          part_id: 'p1',
          path: 'part1',
          name: 'Part 1',
          settings: { session_length: '60' },
        }],
        settings: {},
      }],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    };

    reconcileMock.mockResolvedValue(makePartUpdatePlan(localConfig));
    // Remote part returns an unknown field 'mystery_field'
    getPartMock.mockResolvedValue({
      id: 'p1',
      courseid: '201303',
      assignmentid: 'a1',
      name: 'Part 1',
      seqnum: '0',
      deleted: '0',
      session_length: '60',
      mystery_field: 42,
    });

    const reporter = new UnknownFieldReporter({ warn: vi.fn(), plain: vi.fn() });
    await publish(localConfig, client, baseOptions, reporter);

    const summary = reporter.summary();
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'part', field: 'mystery_field' }),
      ])
    );
  });

  it('does not send or trust assignment settings when assignment sync_settings is false', async () => {
    const localConfig: Config = {
      version: '1.0',
      vocareum: { org_id: '1', course_id: '201303', api_base_url: 'https://api.vocareum.com' },
      assignments: [{
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        sync_settings: false,
        parts: [],
        settings: { nosubmit: true },
      }],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    };

    reconcileMock.mockResolvedValue(makeUpdatePlan(localConfig));

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).not.toHaveBeenCalled();
    const history = updateConfigMock.mock.calls[0][1].publish_history[0];
    expect(history.settings_state ?? {}).not.toHaveProperty('assignments/lab1/settings/nosubmit');
  });

  it('allows part sync_settings to override a disabled assignment for publish', async () => {
    const localConfig: Config = {
      version: '1.0',
      vocareum: { org_id: '1', course_id: '201303', api_base_url: 'https://api.vocareum.com' },
      assignments: [{
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        sync_settings: false,
        parts: [{
          part_id: 'p1',
          path: 'part1',
          name: 'Part 1',
          sync_settings: true,
          settings: { session_length: '60' },
        }],
        settings: { nosubmit: true },
      }],
      publish_history: [],
      publish_options: {
        on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
        sync_deletes: false, exclude_patterns: [],
      },
    };

    reconcileMock.mockResolvedValue(makePartUpdatePlan(localConfig));
    getPartMock.mockResolvedValue({
      id: 'p1',
      courseid: '201303',
      assignmentid: 'a1',
      name: 'Part 1',
      seqnum: '0',
      deleted: '0',
      session_length: '30',
    });

    await publish(localConfig, client, baseOptions);

    expect(updateAssignmentMock).not.toHaveBeenCalled();
    expect(updatePartMock).toHaveBeenCalled();
    const history = updateConfigMock.mock.calls[0][1].publish_history[0];
    expect(history.settings_state).toMatchObject({
      'assignments/lab1/parts/part1/settings/session_length': '60',
    });
    expect(history.settings_state).not.toHaveProperty('assignments/lab1/settings/nosubmit');
  });
});

describe('executePush intent authority', () => {
  it('executes the confirmed content directory and exact delete set, not reconciliation fields', async () => {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    readDirectoryMock.mockResolvedValue({ 'keep.py': Buffer.from('keep') });
    syncDirectoryMock.mockResolvedValue({
      succeeded: ['keep.py'],
      failed: [],
      directoryHash: 'intent-hash',
      deleted: ['approved.py'],
    });

    const config: Config = {
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        api_base_url: 'https://api.vocareum.com',
      },
      assignments: [{
        assignment_id: 'a1',
        name: 'Lab 1',
        path: 'lab1',
        parts: [{
          part_id: 'p1',
          path: 'part1',
          directories: ['startercode'],
        }],
      }],
      publish_history: [],
      publish_options: { sync_deletes: true, exclude_patterns: [] },
    };

    // Deliberately disagree with the intent. Execution must use the intent's
    // startercode directory and approved delete path, not this scripts value.
    const reconciliation = {
      config,
      course: { type: 'skip' },
      assignments: [{
        type: 'update',
        assignment: config.assignments[0],
        parts: [{
          type: 'update',
          part: config.assignments[0].parts[0],
          contentChanged: true,
          changedDirectories: ['scripts'],
        }],
      }],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    } as ReconciliationPlan;

    const intent = {
      assignments: [{
        path: 'lab1',
        name: 'Lab 1',
        assignmentId: 'a1',
        action: 'update' as const,
        parts: [{
          partId: 'p1',
          path: 'part1',
          contentHashes: { startercode: 'intent-hash' },
          deletePaths: ['startercode/approved.py'],
        }],
      }],
    };
    const plan: PushPlan = {
      intent,
      preconditions: {
        configDigest: 'config-hash',
        contentHashes: { 'lab1/part1/startercode': 'intent-hash' },
        assignmentIds: ['a1'],
        partIds: ['p1'],
        remoteAssumptions: [{
          assignmentPath: 'lab1',
          assignmentId: 'a1',
          exists: true,
          partIds: ['p1'],
        }],
      },
      semanticFingerprint: semanticFingerprint(intent),
      summary: '1 to update',
      hasChanges: true,
      execution: { reconciliation, workingConfig: config },
    };

    const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
    await executePush(
      { applyConfigUpdate } as unknown as LockedSession,
      {
        persistedConfig: config,
        effectiveConfig: config,
        configPath: 'vocareum.yaml',
        workspaceRoot: process.cwd(),
        events: new CollectingEventSink(),
        prompter: new NonInteractivePrompter(),
        client: {} as VocareumClient,
      },
      { syncDeletes: true },
      plan,
    );

    expect(syncDirectoryMock).toHaveBeenCalledTimes(1);
    expect(syncDirectoryMock.mock.calls[0][5]).toBe('startercode');
    expect(syncDirectoryMock.mock.calls[0][6]).toMatchObject({
      syncDeletes: true,
      plannedDeletePaths: ['approved.py'],
    });
  });

  it('rejects an intent modified after fingerprinting', async () => {
    const intent = { assignments: [] };
    const plan = {
      intent,
      preconditions: {
        configDigest: 'config-hash',
        contentHashes: {},
        assignmentIds: [],
        partIds: [],
        remoteAssumptions: [],
      },
      semanticFingerprint: semanticFingerprint(intent),
      summary: 'No changes',
      hasChanges: false,
      execution: {
        reconciliation: {} as ReconciliationPlan,
        workingConfig: {} as Config,
      },
    } satisfies PushPlan;
    plan.intent.assignments.push({
      path: 'changed',
      name: 'Changed',
      assignmentId: null,
      action: 'create',
      parts: [],
    });

    await expect(executePush(
      {} as LockedSession,
      {} as Parameters<typeof executePush>[1],
      {},
      plan,
    )).rejects.toThrow(/intent changed after confirmation/);
  });
});

describe('executePush rubric history', () => {
  /**
   * Build a minimal update-action plan for one part carrying the given rubricPlan
   * (against a fixed single-criterion remote, "A" @ 25 points), run the real
   * executePush, and return the publish_history entry handed to
   * session.applyConfigUpdate — the only place history assembly can be observed,
   * since publish-command.test.ts mocks both planPush and executePush.
   */
  async function pushAndReadHistory(
    rubricPlanInput: {
      creates?: RubricCreate[];
      updates?: RubricUpdate[];
      orphans?: RemoteRubric[];
    },
    options: { nonInteractive?: boolean } = {},
  ) {
    vi.clearAllMocks();
    getCommitShaMock.mockResolvedValue('abc123');
    getGitUserNameMock.mockResolvedValue('tester');
    createRubricsMock.mockResolvedValue([]);
    updateRubricsMock.mockResolvedValue([]);

    const rubricPlan: RubricSyncPlan = {
      creates: rubricPlanInput.creates ?? [],
      updates: rubricPlanInput.updates ?? [],
      orphans: rubricPlanInput.orphans ?? [],
      duplicateNames: [],
    };
    const remoteRubrics: RemoteRubric[] = [
      { id: 'r1', name: 'A', seqnum: '1', maxscore: '25', auto: false, exclude: false },
    ];

    const config: Config = {
      version: '1.0',
      vocareum: { org_id: '1', course_id: 'c1', api_base_url: 'https://api.vocareum.com' },
      assignments: [
        {
          assignment_id: 'a1',
          name: 'Lab 1',
          path: 'lab1',
          parts: [{ part_id: 'p1', path: 'part1', rubrics: [] }],
        },
      ],
      publish_history: [],
    } as unknown as Config;

    const reconciliation = {
      config,
      course: { type: 'skip' },
      assignments: [
        {
          type: 'update',
          assignment: config.assignments[0],
          parts: [
            {
              type: 'update',
              part: config.assignments[0].parts[0],
              contentChanged: false,
              rubricPlan,
              remoteRubrics,
            },
          ],
        },
      ],
      summary: {
        coursesToUpdate: 0,
        assignmentsToCreate: 0,
        assignmentsToUpdate: 1,
        assignmentsWithDiscoveredIds: 0,
        assignmentsToSkip: 0,
        partsToCreate: 0,
        partsToUpdate: 1,
        estimatedApiCalls: 1,
      },
      orphanedInVocareum: [],
      staleInConfig: [],
    } as unknown as ReconciliationPlan;

    const intent = {
      assignments: [
        {
          path: 'lab1',
          name: 'Lab 1',
          assignmentId: 'a1',
          action: 'update' as const,
          parts: [{ partId: 'p1', path: 'part1', contentHashes: {}, rubricPlan }],
        },
      ],
    };

    const plan: PushPlan = {
      intent,
      preconditions: {
        configDigest: 'digest',
        contentHashes: {},
        assignmentIds: ['a1'],
        partIds: ['p1'],
        remoteAssumptions: [
          { assignmentPath: 'lab1', assignmentId: 'a1', exists: true, partIds: ['p1'] },
        ],
      },
      semanticFingerprint: semanticFingerprint(intent),
      summary: '1 to update',
      hasChanges: true,
      execution: { reconciliation, workingConfig: config },
    };

    const applyConfigUpdate = vi.fn().mockResolvedValue(undefined);
    await executePush(
      { applyConfigUpdate } as unknown as LockedSession,
      {
        persistedConfig: config,
        effectiveConfig: config,
        configPath: 'vocareum.yaml',
        workspaceRoot: process.cwd(),
        events: new CollectingEventSink(),
        prompter: new NonInteractivePrompter(),
        client: {} as VocareumClient,
      },
      { nonInteractive: options.nonInteractive ?? false },
      plan,
    );

    return applyConfigUpdate.mock.calls[0][0].publish_history[0];
  }

  it('records created and updated criteria in publish_history with the point delta', async () => {
    const history = await pushAndReadHistory({ creates: [{ name: 'B', maxscore: '5' }] });

    expect(history.changes?.rubrics?.[0]).toMatchObject({
      part_id: expect.any(String),
      created: ['B'],
      points_before: 25,
      points_after: 30,
    });
  });

  it('records the updated criterion by name using the remote row when the update omits it', async () => {
    const history = await pushAndReadHistory({ updates: [{ id: 'r1', maxscore: '30' }] });

    expect(history.changes?.rubrics?.[0]).toMatchObject({
      updated: ['A'],
      points_before: 25,
      points_after: 30,
    });
    expect(history.changes?.rubrics?.[0].created).toBeUndefined();
  });

  it('records a held part with its reason and no created/updated names', async () => {
    const history = await pushAndReadHistory(
      {
        creates: [{ name: 'NEW', maxscore: '5' }],
        orphans: [{ id: 'r9', name: 'OLD', seqnum: '9', maxscore: '5' }],
      },
      { nonInteractive: true },
    );

    expect(createRubricsMock).not.toHaveBeenCalled();
    expect(history.changes?.rubrics?.[0]).toMatchObject({ held: 'orphans-held' });
    expect(history.changes?.rubrics?.[0].created).toBeUndefined();
  });
});
