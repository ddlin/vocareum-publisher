import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import type { VocareumClient } from '../../src/api/client';
import { reconcile } from '../../src/core/reconciler';

const {
  getCourseMock,
  listAssignmentsMock,
  listPartsMock,
  calculateDirectoryHashMock,
} = vi.hoisted(() => ({
  getCourseMock: vi.fn(),
  listAssignmentsMock: vi.fn(),
  listPartsMock: vi.fn(),
  calculateDirectoryHashMock: vi.fn(),
}));

vi.mock('../../src/api/courses', () => ({
  getCourse: getCourseMock,
}));

vi.mock('../../src/api/assignments', () => ({
  listAssignments: listAssignmentsMock,
}));

vi.mock('../../src/api/parts', () => ({
  listParts: listPartsMock,
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
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0' },
    ]);
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

  it('should detect assignment metadata change when points differ', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: { points: '100' },
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0', points: '50' },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(true);
  });

  it('should detect assignment metadata change when published differs', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: { published: true },
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0', published: '0' },
    ]);

    const plan = await reconcile(config, client, undefined);

    expect(plan.assignments[0].assignmentMetadataChanged).toBe(true);
  });

  it('should not flag assignment metadata changed when published matches', async () => {
    const config: Config = {
      ...baseConfig,
      assignments: [
        {
          ...baseConfig.assignments[0],
          assignment_id: 'asn-1',
          settings: { published: true },
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0', published: '1' },
    ]);

    const plan = await reconcile(config, client, undefined);

    // No name change, no other metadata change
    expect(plan.assignments[0].assignmentMetadataChanged).toBe(false);
  });

  it('should detect part metadata change when description differs', async () => {
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
              settings: { description: 'New description' },
            },
          ],
        },
      ],
    };

    listAssignmentsMock.mockResolvedValue([
      { id: 'asn-1', name: 'Lab 1', deleted: '0' },
    ]);
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', description: 'Old description' },
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
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0', description: 'Same', cloud_labs: true },
    ]);

    const plan = await reconcile(config, client, publishHistory);

    expect(plan.assignments[0].parts[0].type).toBe('skip');
    expect(plan.assignments[0].parts[0].metadataChanged).toBeUndefined();
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
});
