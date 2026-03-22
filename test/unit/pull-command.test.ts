import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { pullCommand } from '../../src/commands/pull';

const {
  loadConfigMock,
  updateConfigMock,
  reconcileMock,
  getAssignmentMock,
  listPartsMock,
  getPartMock,
  loadDotEnvIfPresentMock,
  isCIMock,
  getApiKeyOrThrowMock,
  loggerWarnMock,
  loggerSuccessMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  updateConfigMock: vi.fn(),
  reconcileMock: vi.fn(),
  getAssignmentMock: vi.fn(),
  listPartsMock: vi.fn(),
  getPartMock: vi.fn(),
  loadDotEnvIfPresentMock: vi.fn(),
  isCIMock: vi.fn(),
  getApiKeyOrThrowMock: vi.fn().mockReturnValue('test-api-key'),
  loggerWarnMock: vi.fn(),
  loggerSuccessMock: vi.fn(),
}));

vi.mock('../../src/core/config', () => ({
  loadConfig: loadConfigMock,
  updateConfig: updateConfigMock,
}));

vi.mock('../../src/core/reconciler', () => ({
  reconcile: reconcileMock,
}));

vi.mock('../../src/api/client', () => ({
  VocareumClient: vi.fn().mockImplementation(() => ({ request: vi.fn() })),
}));

vi.mock('../../src/api/assignments', () => ({
  getAssignment: getAssignmentMock,
}));

vi.mock('../../src/api/parts', () => ({
  listParts: listPartsMock,
  getPart: getPartMock,
}));

vi.mock('../../src/api/content', () => ({
  downloadContent: vi.fn(),
}));

vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: loadDotEnvIfPresentMock,
  isCI: isCIMock,
  getApiKeyOrThrow: getApiKeyOrThrowMock,
}));

vi.mock('../../src/utils/prompts', () => ({
  prompt: vi.fn(),
  promptChoice: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: loggerWarnMock,
    info: vi.fn(),
    success: loggerSuccessMock,
    debug: vi.fn(),
    plain: vi.fn(),
    newline: vi.fn(),
  },
}));

describe('pullCommand settings drift behavior', () => {
  const config: Config = {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: '201303',
      template_assignment_id: 'tmpl-1',
      api_base_url: 'https://api.vocareum.com',
      excluded_assignments: [],
    },
    assignments: [
      {
        assignment_id: 'asn-1',
        name: 'Lab 1',
        path: 'lab1',
        create_from_template: false,
        settings: {},
        parts: [
          {
            part_id: 'part-1',
            path: 'part1',
            settings: {
              submission_filters: ['*.py'],
            },
          },
        ],
      },
    ],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: false,
      abort_on_error: false,
      sync_deletes: false,
      exclude_patterns: [],
    },
    publish_history: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    loadConfigMock.mockResolvedValue(config);
    updateConfigMock.mockResolvedValue(undefined);
    reconcileMock.mockResolvedValue({
      config,
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
      staleInConfig: [],
    });
  });

  it('should not report drift for equivalent submission_filters array vs object', async () => {
    getAssignmentMock.mockResolvedValue({
      id: 'asn-1',
      name: 'Lab 1',
      deleted: '0',
    });
    listPartsMock.mockResolvedValue([
      { id: 'part-1', seqnum: '0', name: 'Part 1', deleted: '0' },
    ]);
    getPartMock.mockResolvedValue({
      id: 'part-1',
      seqnum: '0',
      name: 'Part 1',
      deleted: '0',
      assignmentid: 'asn-1',
      courseid: '201303',
      submission_filters: { include: ['*.py'] },
    });

    await pullCommand({ nonInteractive: true });

    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(loggerSuccessMock).toHaveBeenCalledWith('No sync issues found.');
  });

  it('should warn when settings fetch fails for an assignment', async () => {
    getAssignmentMock.mockRejectedValue(new Error('network error'));

    await pullCommand({ nonInteractive: true });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Could not fetch settings for assignment "Lab 1" (ID: asn-1): network error'
    );
    expect(updateConfigMock).not.toHaveBeenCalled();
  });
});
