import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { pullCommand } from '../../src/commands/pull';
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';
import { resolveThrottle } from '../../src/api/throttle';
import { VocareumClient } from '../../src/api/client';
import { downloadContent } from '../../src/api/content';

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
  mapAssignmentSettingsMock,
  mapPartSettingsMock,
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
  mapAssignmentSettingsMock: vi.fn(),
  mapPartSettingsMock: vi.fn(),
}));

vi.mock('../../src/core/config', () => ({
  loadConfig: loadConfigMock,
  updateConfig: updateConfigMock,
  withConfigLock: vi.fn((_path: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/core/reconciler', () => ({
  reconcile: reconcileMock,
}));

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    VocareumClient: vi.fn().mockImplementation(() => ({ request: vi.fn() })),
  };
});

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

vi.mock('../../src/api/throttle', () => ({
  resolveThrottle: vi.fn(() => ({ maxConcurrency: 1, minIntervalMs: 0, jitter: false })),
  DEFAULT_THROTTLE: { maxConcurrency: 1, minIntervalMs: 0, jitter: false },
}));

vi.mock('../../src/utils/settings', () => ({
  mapAssignmentSettings: mapAssignmentSettingsMock,
  mapPartSettings: mapPartSettingsMock,
}));

vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: loadDotEnvIfPresentMock,
  isCI: isCIMock,
  getApiKeyOrThrow: getApiKeyOrThrowMock,
  getOAuthClientId: vi.fn().mockReturnValue(undefined),
  getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
  getAuthModeEnv: vi.fn().mockReturnValue(undefined),
  getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
  getOAuthTokenUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3/oauth/token'),
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
    mapAssignmentSettingsMock.mockReturnValue({});
    mapPartSettingsMock.mockReturnValue({});
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
    // mapPartSettings normalizes remote submission_filters to the object form
    // that is equivalent to the local array form — return the normalized shape
    // so that comparePartSettings sees no drift.
    mapPartSettingsMock.mockReturnValue({ submission_filters: { include: ['*.py'] } });

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

  it('skips settings drift detection when global sync_settings is false', async () => {
    loadConfigMock.mockResolvedValue({
      ...config,
      publish_options: {
        ...config.publish_options!,
        sync_settings: false,
      },
    });

    await pullCommand({ nonInteractive: true });

    expect(getAssignmentMock).not.toHaveBeenCalled();
    expect(listPartsMock).not.toHaveBeenCalled();
    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(loggerSuccessMock).toHaveBeenCalledWith('No sync issues found.');
  });
});

describe('pullCommand — unknown-only settings drift', () => {
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
        settings: { nosubmit: false },
        parts: [
          {
            part_id: 'part-1',
            path: 'part1',
            settings: {},
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
      course: { type: 'skip' },
      assignments: [],
      orphanedInVocareum: [],
      staleInConfig: [],
    });
    getAssignmentMock.mockResolvedValue({
      id: 'asn-1',
      name: 'Lab 1',
      deleted: '0',
      courseid: '201303',
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
    });
  });

  it('calls updateConfig with remote settings (including _unknown_settings) when only unknowns differ — batch mode', async () => {
    // Remote assignment has a new unknown field; known fields identical to local
    mapAssignmentSettingsMock.mockReturnValue({
      nosubmit: false,
      _unknown_settings: { vendor_flag: true },
    });
    // No known-field diff in parts
    mapPartSettingsMock.mockReturnValue({});

    await pullCommand({ batch: true });

    expect(updateConfigMock).toHaveBeenCalled();
    const callArg = updateConfigMock.mock.calls[0][1];
    const updatedAssignment = callArg.assignments?.find(
      (a: { path: string }) => a.path === 'lab1',
    );
    expect(updatedAssignment).toBeDefined();
    expect(updatedAssignment.settings).toMatchObject({
      nosubmit: false,
      _unknown_settings: { vendor_flag: true },
    });
  });

  it('clears local _unknown_settings when remote no longer returns any unknowns (stale unknowns)', async () => {
    // Local has _unknown_settings; remote no longer returns any unknown field.
    const configWithStaleUnknown: Config = {
      ...config,
      assignments: [
        {
          ...config.assignments[0],
          settings: {
            nosubmit: false,
            _unknown_settings: { stale_field: true },
          },
        },
      ],
    };
    loadConfigMock.mockResolvedValue(configWithStaleUnknown);
    // Remote returns only known fields — no _unknown_settings attached by the mapper.
    mapAssignmentSettingsMock.mockReturnValue({ nosubmit: false });
    mapPartSettingsMock.mockReturnValue({});

    await pullCommand({ batch: true });

    expect(updateConfigMock).toHaveBeenCalled();
    const callArg = updateConfigMock.mock.calls[0][1];
    const updatedAssignment = callArg.assignments?.find(
      (a: { path: string }) => a.path === 'lab1',
    );
    expect(updatedAssignment).toBeDefined();
    // _unknown_settings must be ABSENT in the merged settings (stale cleared).
    expect(updatedAssignment.settings).not.toHaveProperty('_unknown_settings');
    expect(updatedAssignment.settings.nosubmit).toBe(false);
  });

  it('does NOT report drift when local and remote _unknown_settings are identical', async () => {
    // Both local and remote have the same unknown — no drift expected
    const configWithUnknown: Config = {
      ...config,
      assignments: [
        {
          ...config.assignments[0],
          settings: {
            nosubmit: false,
            _unknown_settings: { vendor_flag: true },
          },
        },
      ],
    };
    loadConfigMock.mockResolvedValue(configWithUnknown);
    mapAssignmentSettingsMock.mockReturnValue({
      nosubmit: false,
      _unknown_settings: { vendor_flag: true },
    });
    mapPartSettingsMock.mockReturnValue({});

    await pullCommand({ nonInteractive: true });

    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(loggerSuccessMock).toHaveBeenCalledWith('No sync issues found.');
  });

  it('moves legacy top-level observed settings into _observed_settings during pull', async () => {
    const configWithLegacyObserved: Config = {
      ...config,
      assignments: [
        {
          ...config.assignments[0],
          settings: {
            nosubmit: false,
            description: 'Remote description',
          },
        },
      ],
    };
    loadConfigMock.mockResolvedValue(configWithLegacyObserved);
    mapAssignmentSettingsMock.mockReturnValue({
      nosubmit: false,
      _observed_settings: { description: 'Remote description' },
    });
    mapPartSettingsMock.mockReturnValue({});

    await pullCommand({ batch: true });

    expect(updateConfigMock).toHaveBeenCalled();
    const callArg = updateConfigMock.mock.calls[0][1];
    const updatedAssignment = callArg.assignments?.find(
      (a: { path: string }) => a.path === 'lab1',
    );
    expect(updatedAssignment?.settings).toMatchObject({
      nosubmit: false,
      _observed_settings: { description: 'Remote description' },
    });
    expect(updatedAssignment?.settings).not.toHaveProperty('description');
  });
});

describe('pullCommand — reporter lifecycle', () => {
  const minimalConfig = {
    version: '1.0',
    vocareum: { org_id: '1', course_id: '1', api_base_url: 'https://api.vocareum.com' },
    assignments: [{
      assignment_id: 'a1',
      name: 'Lab 1', path: 'lab1',
      create_from_template: false,
      parts: [],
    }],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
      sync_deletes: false, exclude_patterns: [],
    },
  };

  const emptyReconcileResult = {
    course: { type: 'skip' },
    assignments: [],
    orphanedInVocareum: [],
    staleInConfig: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    mapAssignmentSettingsMock.mockReturnValue({});
    mapPartSettingsMock.mockReturnValue({});
  });

  it('calls reporter.printSummary even when an internal step throws', async () => {
    const printSpy = vi.spyOn(UnknownFieldReporter.prototype, 'printSummary');
    loadConfigMock.mockRejectedValue(new Error('config bad'));

    await expect(pullCommand({ config: 'vocareum.yaml' })).rejects.toThrow();
    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });

  it('threads the reporter into detectSettingsDrift', async () => {
    loadConfigMock.mockResolvedValue(minimalConfig);
    reconcileMock.mockResolvedValue(emptyReconcileResult);
    getAssignmentMock.mockResolvedValue({
      id: 'a1', courseid: '1', name: 'Lab 1', deleted: '0',
    });
    listPartsMock.mockResolvedValue([]);

    await pullCommand({ config: 'vocareum.yaml', nonInteractive: true });

    expect(mapAssignmentSettingsMock).toHaveBeenCalled();
    const secondArg = mapAssignmentSettingsMock.mock.calls[0][1];
    expect(secondArg).toBeInstanceOf(UnknownFieldReporter);
  });
});

describe('pullCommand resolves throttle before using the client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: { org_id: '1', course_id: 'c1', api_base_url: 'https://api.vocareum.com' },
      assignments: [],
      publish_options: {},
      publish_history: [],
    });
    vi.mocked(resolveThrottle).mockReturnValue({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
  });

  it('does not construct the client or call reconcile when throttle resolution throws', async () => {
    vi.mocked(resolveThrottle).mockImplementationOnce(() => { throw new Error('bad throttle env'); });
    await expect(pullCommand({ nonInteractive: true })).rejects.toThrow('bad throttle env');
    expect(vi.mocked(VocareumClient)).not.toHaveBeenCalled();
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

describe('pullCommand content-drift gating', () => {
  const twoAssignmentConfig: Config = {
    version: '1.0',
    vocareum: { org_id: '1', course_id: 'c1', api_base_url: 'https://api.vocareum.com', excluded_assignments: [] },
    assignments: [
      { assignment_id: 'a-lab1', name: 'lab1', path: 'lab1', create_from_template: false, settings: {},
        parts: [{ part_id: 'p1', path: 'part1', settings: {} }] },
      { assignment_id: 'a-lab2', name: 'lab2', path: 'lab2', create_from_template: false, settings: {},
        parts: [{ part_id: 'p2', path: 'part1', settings: {} }] },
    ],
    publish_options: { on_missing_id: 'skip', auto_commit: false, abort_on_error: false, sync_deletes: false, exclude_patterns: [] },
    publish_history: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
    loadConfigMock.mockResolvedValue(twoAssignmentConfig);
    updateConfigMock.mockResolvedValue(undefined);
    getAssignmentMock.mockRejectedValue(new Error('skip settings drift'));
    reconcileMock.mockResolvedValue({
      config: twoAssignmentConfig, course: { type: 'skip' }, assignments: [],
      summary: { coursesToUpdate: 0, assignmentsToCreate: 0, assignmentsToUpdate: 0, assignmentsWithDiscoveredIds: 0, assignmentsToSkip: 0, partsToCreate: 0, partsToUpdate: 0, estimatedApiCalls: 0 },
      orphanedInVocareum: [], staleInConfig: [],
    });
    vi.mocked(downloadContent).mockResolvedValue({});
  });

  it('bare pull does NOT download content for drift', async () => {
    await pullCommand({ nonInteractive: true });
    expect(vi.mocked(downloadContent)).not.toHaveBeenCalled();
  });

  it('--content downloads content for all linked parts', async () => {
    await pullCommand({ nonInteractive: true, content: true });
    expect(vi.mocked(downloadContent)).toHaveBeenCalled();
    const courseIds = vi.mocked(downloadContent).mock.calls.map((c) => c[2]); // assignmentId arg
    expect(new Set(courseIds)).toEqual(new Set(['a-lab1', 'a-lab2']));
  });

  it('--content --assignment lab1 downloads only lab1 parts', async () => {
    await pullCommand({ nonInteractive: true, content: true, assignment: ['lab1'] });
    expect(vi.mocked(downloadContent)).toHaveBeenCalled();
    const assignmentIds = vi.mocked(downloadContent).mock.calls.map((c) => c[2]);
    expect(new Set(assignmentIds)).toEqual(new Set(['a-lab1']));
  });
});
