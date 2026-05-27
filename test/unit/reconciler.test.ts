import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import type { VocareumClient } from '../../src/api/client';
import { reconcile } from '../../src/core/reconciler';

const {
  getCourseMock,
  listAssignmentsMock,
  getAssignmentMock,
  listPartsMock,
  getPartMock,
  calculateDirectoryHashMock,
} = vi.hoisted(() => ({
  getCourseMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  getAssignmentMock: vi.fn(),
  listPartsMock: vi.fn(),
  getPartMock: vi.fn(),
  calculateDirectoryHashMock: vi.fn(),
}));

vi.mock('../../src/api/courses', () => ({
  getCourse: getCourseMock,
}));

vi.mock('../../src/api/assignments', () => ({
  listAssignments: listAssignmentsMock,
  getAssignment: getAssignmentMock,
}));

vi.mock('../../src/api/parts', () => ({
  listParts: listPartsMock,
  getPart: getPartMock,
}));

vi.mock('../../src/utils/files', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/files')>('../../src/utils/files');
  return {
    ...actual,
    calculateDirectoryHash: calculateDirectoryHashMock,
  };
});

describe('reconcile options behavior', () => {
  const client = {} as VocareumClient;

  const baseConfig: Config = {
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
        create_from_template: false,
        parts: [
          {
            part_id: 'part-1',
            path: 'part1',
            directories: ['startercode', 'scripts', 'docs', 'data'],
          },
        ],
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

  beforeEach(() => {
    vi.clearAllMocks();
    getCourseMock.mockResolvedValue({ id: '201303', name: 'Course 1', org_id: '1' });
    listAssignmentsMock.mockResolvedValue([]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', courseid: '201303', deleted: '0' });
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0' },
    ]);
    getPartMock.mockResolvedValue({ id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', assignmentid: 'asn-1', courseid: '201303' });
    calculateDirectoryHashMock.mockResolvedValue('same-hash');
  });

  it('should skip assignment when ID is missing and onMissingId=skip', async () => {
    const plan = await reconcile(baseConfig, client, undefined, { onMissingId: 'skip' });

    expect(plan.assignments[0].type).toBe('skip');
    expect(plan.assignments[0].reason).toContain('on_missing_id=skip');
  });

  it('should mark assignment as error when ID is missing and onMissingId=abort', async () => {
    const plan = await reconcile(baseConfig, client, undefined, { onMissingId: 'abort' });

    expect(plan.assignments[0].type).toBe('error');
    expect(plan.assignments[0].reason).toContain('on_missing_id=abort');
  });

  it('should use assignment-level template ID for create actions', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          create_from_template: true,
          template_assignment_id: 'tmpl-assignment',
        },
      ],
    };

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].type).toBe('create');
    expect(plan.assignments[0].templateId).toBe('tmpl-assignment');
  });

  it('should fall back to first global template ID from template_assignment_ids', async () => {
    const config: Config = {
      ...baseConfig,
      vocareum: {
        ...baseConfig.vocareum,
        template_assignment_ids: ['tmpl-list-1', 'tmpl-list-2'],
      },
      assignments: [
        {
          ...baseConfig.assignments[0],
          create_from_template: true,
        },
      ],
    };

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].type).toBe('create');
    expect(plan.assignments[0].templateId).toBe('tmpl-list-1');
  });

  it('should use first named template from templates array', async () => {
    const config: Config = {
      ...baseConfig,
      vocareum: {
        ...baseConfig.vocareum,
        templates: [
          { id: 'tmpl-named-1', name: 'Standard Lab', course_id: '201303' },
          { id: 'tmpl-named-2', name: 'Cloud Lab', course_id: '999' },
        ],
      },
      assignments: [
        {
          ...baseConfig.assignments[0],
          create_from_template: true,
        },
      ],
    };

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].type).toBe('create');
    expect(plan.assignments[0].templateId).toBe('tmpl-named-1');
  });

  it('should prefer named templates over legacy template_assignment_ids', async () => {
    const config: Config = {
      ...baseConfig,
      vocareum: {
        ...baseConfig.vocareum,
        templates: [{ id: 'tmpl-named', name: 'Named Template', course_id: '201303' }],
        template_assignment_ids: ['tmpl-legacy'],
      },
      assignments: [
        {
          ...baseConfig.assignments[0],
          create_from_template: true,
        },
      ],
    };

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].type).toBe('create');
    expect(plan.assignments[0].templateId).toBe('tmpl-named');
  });

  it('should skip stale assignment when its ID is in excluded_assignments', async () => {
    const config: Config = {
      ...baseConfig,
      vocareum: {
        ...baseConfig.vocareum,
        excluded_assignments: ['asn-missing'],
      },
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-missing',
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].type).toBe('skip');
    expect(plan.assignments[0].reason).toBe('Assignment ID is excluded from sync');
    expect(plan.staleInConfig).toEqual([]);
  });

  it('does not mark assignment metadata changed when only observed description differs', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: { description: 'New description' },
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0', description: 'Old description' },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
  });

  it('should detect assignment metadata change when name differs', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          name: 'Lab 1 Updated',
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(true);
  });

  it('should not flag assignment metadata changed when description matches', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: { description: 'Same description' },
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0', description: 'Same description' },
    ]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', deleted: '0', description: 'Same description', courseid: '201303' });

    const plan = await reconcile(config, client, undefined);

    // No name change, no description change
    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
  });

  it('should detect part metadata change when session_length differs', async () => {
    // Working part fields: name, session_length, submission_filters, cloud_labs (if org permits)
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              directories: ['startercode', 'scripts', 'docs', 'data'],
              settings: { session_length: '3600' },
            },
          ],
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', session_length: '240' },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].parts[0].metadataChanged).toBe(true);
    expect(plan.assignments[0].parts[0].reason).toContain('Settings changed');
  });

  it('should detect part metadata change when cloud_labs differs', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              directories: ['startercode', 'scripts', 'docs', 'data'],
              settings: { cloud_labs: true },
            },
          ],
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', cloud_labs: false },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].parts[0].metadataChanged).toBe(true);
  });

  it('should detect part metadata change when submission_filters differ', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              directories: ['startercode', 'scripts', 'docs', 'data'],
              settings: { submission_filters: { include: ['*.py'], exclude: ['*.pyc'] } },
            },
          ],
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0' },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].parts[0].metadataChanged).toBe(true);
  });

  it('should not flag part metadata changed when all settings match', async () => {
    const publishHistory = {
      timestamp: '2026-02-12T00:00:00Z',
      commit_sha: 'abc',
      published_by: 'tester',
      status: 'success' as const,
      content_state: {
        'lab1/part1/startercode': 'same-hash',
        'lab1/part1/scripts': 'same-hash',
        'lab1/part1/docs': 'same-hash',
        'lab1/part1/data': 'same-hash',
      },
      settings_state: {
        'assignments/lab1/settings/exam_mode': 'TIMED',
        'assignments/lab1/settings/exam_duration': 45,
        'assignments/lab1/settings/num_attempts': 3,
        'assignments/lab1/settings/anonymous_grading': false,
        'assignments/lab1/settings/grading_visibility': 'ALL',
        'assignments/lab1/settings/live_code_comments': false,
        'assignments/lab1/parts/part1/settings/late_penalty_percent': 10,
        'assignments/lab1/parts/part1/settings/late_penalty_percent_rule': 'max score',
        'assignments/lab1/parts/part1/settings/deadlinedate': '2026-12-31T23:59:00Z',
        'assignments/lab1/parts/part1/settings/endlab': true,
        'assignments/lab1/parts/part1/settings/number_of_submissions': 5,
        'assignments/lab1/parts/part1/settings/lab_interface': { panels: ['Console'] },
      },
    };

    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              name: 'Part 1',
              directories: ['startercode', 'scripts', 'docs', 'data'],
              settings: { description: 'Same', cloud_labs: true },
            },
          ],
        },
      ],
      publish_history: [publishHistory],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', deleted: '0', courseid: '201303' });
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', description: 'Same', cloud_labs: true },
    ]);
    getPartMock.mockResolvedValue({ id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', description: 'Same', cloud_labs: true, assignmentid: 'asn-1', courseid: '201303' });

    const plan = await reconcile(config, client, publishHistory);

    expect(plan.assignments[0].parts[0].type).toBe('skip');
    expect(plan.assignments[0].parts[0].metadataChanged).toBeUndefined();
  });

  it('should not mark accepted-unverified settings changed when API omits readback', async () => {
    const publishHistory = {
      timestamp: '2026-02-12T00:00:00Z',
      commit_sha: 'abc',
      published_by: 'tester',
      status: 'success' as const,
      content_state: {
        'lab1/part1/startercode': 'same-hash',
        'lab1/part1/scripts': 'same-hash',
        'lab1/part1/docs': 'same-hash',
        'lab1/part1/data': 'same-hash',
      },
      settings_state: {
        'assignments/lab1/settings/exam_mode': 'TIMED',
        'assignments/lab1/settings/exam_duration': 45,
        'assignments/lab1/settings/num_attempts': 3,
        'assignments/lab1/settings/anonymous_grading': false,
        'assignments/lab1/settings/grading_visibility': 'ALL',
        'assignments/lab1/settings/live_code_comments': false,
        'assignments/lab1/parts/part1/settings/late_penalty_percent': 10,
        'assignments/lab1/parts/part1/settings/late_penalty_percent_rule': 'max score',
        'assignments/lab1/parts/part1/settings/deadlinedate': '2026-12-31T23:59:00Z',
        'assignments/lab1/parts/part1/settings/endlab': true,
        'assignments/lab1/parts/part1/settings/number_of_submissions': 5,
        'assignments/lab1/parts/part1/settings/lab_interface': { panels: ['Console'] },
      },
    };
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: {
            exam_mode: 'TIMED',
            exam_duration: 45,
            num_attempts: 3,
            anonymous_grading: false,
            grading_visibility: 'ALL',
            live_code_comments: false,
          },
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              name: 'Part 1',
              directories: ['startercode', 'scripts', 'docs', 'data'],
              settings: {
                late_penalty_percent: 10,
                late_penalty_percent_rule: 'max score',
                deadlinedate: '2026-12-31T23:59:00Z',
                endlab: true,
                number_of_submissions: 5,
                lab_interface: { panels: ['Console'] },
              },
            },
          ],
        },
      ],
      publish_history: [publishHistory],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', deleted: '0', courseid: '201303' });
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0' },
    ]);
    getPartMock.mockResolvedValue({ id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', assignmentid: 'asn-1', courseid: '201303' });

    const plan = await reconcile(config, client, publishHistory);

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
    expect(plan.assignments[0].parts[0].type).toBe('skip');
    expect(plan.assignments[0].parts[0].metadataChanged).toBeUndefined();
  });

  it('marks accepted-unverified settings changed when local value differs from last pushed state', async () => {
    const publishHistory = {
      timestamp: '2026-02-12T00:00:00Z',
      commit_sha: 'abc',
      published_by: 'tester',
      status: 'success' as const,
      content_state: {
        'lab1/part1/startercode': 'same-hash',
        'lab1/part1/scripts': 'same-hash',
        'lab1/part1/docs': 'same-hash',
        'lab1/part1/data': 'same-hash',
      },
      settings_state: {
        'assignments/lab1/settings/exam_duration': 30,
        'assignments/lab1/parts/part1/settings/late_penalty_percent': 5,
      },
    };
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: { exam_duration: 45 },
          parts: [
            {
              part_id: 'part-1',
              path: 'part1',
              name: 'Part 1',
              directories: ['startercode', 'scripts', 'docs', 'data'],
              settings: { late_penalty_percent: 10 },
            },
          ],
        },
      ],
      publish_history: [publishHistory],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', deleted: '0', courseid: '201303' });
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0' },
    ]);
    getPartMock.mockResolvedValue({ id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', assignmentid: 'asn-1', courseid: '201303' });

    const plan = await reconcile(config, client, publishHistory);

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(true);
    expect(plan.assignments[0].parts[0].metadataChanged).toBe(true);
  });

  it('should mark all directories as changed when forceAll=true', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
        },
      ],
      publish_history: [
        {
          timestamp: '2026-02-12T00:00:00Z',
          commit_sha: 'abc',
          published_by: 'tester',
          status: 'success',
          content_state: {
            'lab1/part1/startercode': 'same-hash',
            'lab1/part1/scripts': 'same-hash',
            'lab1/part1/docs': 'same-hash',
            'lab1/part1/data': 'same-hash',
          },
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);

    const plan = await reconcile(config, client, config.publish_history?.[0], { forceAll: true });

    expect(plan.assignments[0].parts[0].type).toBe('update');
    expect(plan.assignments[0].parts[0].changedDirectories).toEqual([
      'startercode',
      'scripts',
      'docs',
      'data',
    ]);
  });

  it('skips assignment and part settings drift when global sync_settings is false', async () => {
    const config: Config = {
      ...baseConfig,
      publish_options: {
        ...baseConfig.publish_options!,
        sync_settings: false,
      },
      assignments: [{
        ...baseConfig.assignments[0],
        assignment_id: 'asn-1',
        name: 'Local Name',
        settings: { nosubmit: true },
        parts: [{
          ...baseConfig.assignments[0].parts[0],
          name: 'Local Part',
          settings: { session_length: '90' },
        }],
      }],
    };
    listAssignmentsMock.mockResolvedValue([{ id: 'asn-1', name: 'Remote Name', deleted: '0' }]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Remote Name', courseid: '201303', deleted: '0', nosubmit: false });
    getPartMock.mockResolvedValue({ id: 'part-1', seqnum: '0', name: 'Remote Part', deleted: '0', assignmentid: 'asn-1', courseid: '201303', session_length: '30' });

    const unchangedContent = {
      'lab1/part1/startercode': 'same-hash',
      'lab1/part1/scripts': 'same-hash',
      'lab1/part1/docs': 'same-hash',
      'lab1/part1/data': 'same-hash',
    };
    const plan = await reconcile(config, client, {
      timestamp: '2026-05-27T00:00:00.000Z',
      commit_sha: 'abc',
      published_by: 'tester',
      status: 'success',
      content_state: unchangedContent,
      settings_state: {},
    });

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
    expect(plan.assignments[0].parts[0].type).toBe('skip');
    expect(getAssignmentMock).toHaveBeenCalled();
    expect(getPartMock).not.toHaveBeenCalled();
  });

  it('allows a part sync_settings override when assignment/global settings sync is false', async () => {
    const config: Config = {
      ...baseConfig,
      publish_options: {
        ...baseConfig.publish_options!,
        sync_settings: false,
      },
      assignments: [{
        ...baseConfig.assignments[0],
        assignment_id: 'asn-1',
        sync_settings: false,
        settings: { nosubmit: true },
        parts: [{
          ...baseConfig.assignments[0].parts[0],
          sync_settings: true,
          settings: { session_length: '90' },
        }],
      }],
    };
    listAssignmentsMock.mockResolvedValue([{ id: 'asn-1', name: 'Lab 1', deleted: '0' }]);
    getAssignmentMock.mockResolvedValue({ id: 'asn-1', name: 'Lab 1', courseid: '201303', deleted: '0', nosubmit: false });
    getPartMock.mockResolvedValue({ id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', assignmentid: 'asn-1', courseid: '201303', session_length: '30' });

    const plan = await reconcile(config, client, {
      timestamp: '2026-05-27T00:00:00.000Z',
      commit_sha: 'abc',
      published_by: 'tester',
      status: 'success',
      content_state: {
        'lab1/part1/startercode': 'same-hash',
        'lab1/part1/scripts': 'same-hash',
        'lab1/part1/docs': 'same-hash',
        'lab1/part1/data': 'same-hash',
      },
    });

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
    expect(plan.assignments[0].parts[0]).toMatchObject({
      type: 'update',
      metadataChanged: true,
      contentChanged: false,
    });
    expect(getPartMock).toHaveBeenCalledWith(client, '201303', 'asn-1', 'part-1');
  });
});
