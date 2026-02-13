import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import type { PublishOperationOptions, ReconciliationPlan } from '../../src/types/state';
import type { VocareumClient } from '../../src/api/client';
import { publish } from '../../src/core/publisher';

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
}));

vi.mock('../../src/core/reconciler', () => ({
  reconcile: reconcileMock,
  displayPlan: displayPlanMock,
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
}));

vi.mock('../../src/utils/git', () => ({
  commitChanges: commitChangesMock,
  getCommitSha: getCommitShaMock,
  getGitUserName: getGitUserNameMock,
}));

vi.mock('../../src/utils/prompts', () => ({
  promptConfirm: promptConfirmMock,
}));

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
      description: 'New description',
      nosubmit: undefined,
      auto_submit: undefined,
      grading_on_submit: undefined,
    });
  });

  it('should send all working assignment settings', async () => {
    // Note: due_date, points, published do NOT work via API (return "No valid parameters")
    // Working fields: name, description, nosubmit, auto_submit, grading_on_submit
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      settings: {
        description: 'Updated description',
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
      description: 'Updated description',
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
      submission_filters: { include: ['*.py'], exclude: ['*.pyc'] },
      instant_aws_access: undefined,
      monthly_dollar: undefined,
      monthly_time: undefined,
      total_time: undefined,
      total_dollar: undefined,
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
      submission_filters: { include: ['*.py'], exclude: [], list: undefined },
    });
    expect(updatePartMock.mock.calls[1][4]).toMatchObject({
      name: 'Part 1',
      session_length: '3600',
      submission_filters: { include: ['*.py'], exclude: [], list: undefined },
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
          scope: 'assignment',
          field: 'description',
          from: 'old description',
          to: 'new description',
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
  });
});
