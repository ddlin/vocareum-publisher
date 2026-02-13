import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import type { PublishOperationOptions, ReconciliationPlan } from '../../src/types/state';
import type { VocareumClient } from '../../src/api/client';
import { publish } from '../../src/core/publisher';

const {
  reconcileMock,
  displayPlanMock,
  copyAssignmentMock,
  updateAssignmentMock,
  updateCourseMock,
  updatePartMock,
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
  updateAssignmentMock: vi.fn(),
  updateCourseMock: vi.fn(),
  updatePartMock: vi.fn(),
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
  updateAssignment: updateAssignmentMock,
}));

vi.mock('../../src/api/courses', () => ({
  updateCourse: updateCourseMock,
}));

vi.mock('../../src/api/parts', () => ({
  updatePart: updatePartMock,
}));

vi.mock('../../src/core/uploader', () => ({
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
      settings: { description: 'New description', due_date: '2026-12-31T23:59:00Z' },
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
    updateAssignmentMock.mockResolvedValue({ id: 'asn-1' });

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    expect(updateAssignmentMock).toHaveBeenCalledWith(client, 'asn-1', {
      name: 'Lab 1',
      description: 'New description',
      due_date: '2026-12-31T23:59:00Z',
      points: undefined,
      published: undefined,
    });
  });

  it('should send all assignment settings including points and published', async () => {
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      settings: {
        description: 'Updated description',
        due_date: '2026-12-31T23:59:00Z',
        points: '100',
        published: true,
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
    updateAssignmentMock.mockResolvedValue({ id: 'asn-1' });

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    expect(updateAssignmentMock).toHaveBeenCalledWith(client, 'asn-1', {
      name: 'Lab 1',
      description: 'Updated description',
      due_date: '2026-12-31T23:59:00Z',
      points: '100',
      published: true,
    });
  });

  it('should send all part settings when part metadata changed', async () => {
    const assignment = {
      ...config.assignments[0],
      assignment_id: 'asn-1',
      parts: [
        {
          part_id: 'part-1',
          path: 'part1',
          name: 'Updated Part',
          settings: {
            description: 'Part description',
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
    updatePartMock.mockResolvedValue({ id: 'part-1' });

    const result = await publish(config, client, baseOptions);

    expect(result.success).toBe(true);
    expect(updatePartMock).toHaveBeenCalledWith(client, 'part-1', {
      name: 'Updated Part',
      description: 'Part description',
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
});
