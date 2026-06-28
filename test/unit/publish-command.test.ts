import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { publishCommand } from '../../src/commands/publish';
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';
import { resolveThrottle } from '../../src/api/throttle';
import { VocareumClient } from '../../src/api/client';

const {
  loadConfigMock,
  planPushMock,
  executePushMock,
  loadDotEnvIfPresentMock,
  isCIMock,
  getApiKeyOrThrowMock,
  loggerErrorMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerSuccessMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  planPushMock: vi.fn(),
  executePushMock: vi.fn(),
  loadDotEnvIfPresentMock: vi.fn(),
  isCIMock: vi.fn(),
  getApiKeyOrThrowMock: vi.fn().mockReturnValue('test-api-key'),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerSuccessMock: vi.fn(),
}));

vi.mock('../../src/core/config', () => ({
  loadConfig: loadConfigMock,
  withConfigLock: vi.fn((_path: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/core/session', () => ({
  withSession: vi.fn((_path: string, fn: (session: unknown) => Promise<unknown>) =>
    fn({ applyConfigUpdate: vi.fn().mockResolvedValue(undefined) })
  ),
}));

vi.mock('../../src/core/services/push-service', () => ({
  planPush: planPushMock,
  executePush: executePushMock,
}));

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    VocareumClient: vi.fn().mockImplementation(() => ({ request: vi.fn() })),
  };
});

vi.mock('../../src/api/throttle', () => ({
  resolveThrottle: vi.fn(() => ({ maxConcurrency: 1, minIntervalMs: 0, jitter: false })),
  DEFAULT_THROTTLE: { maxConcurrency: 1, minIntervalMs: 0, jitter: false },
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

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: loggerErrorMock,
    warn: loggerWarnMock,
    info: loggerInfoMock,
    success: loggerSuccessMock,
    newline: vi.fn(),
    debug: vi.fn(),
    plain: vi.fn(),
  },
}));

vi.mock('../../src/utils/prompts', () => ({
  promptConfirm: vi.fn().mockResolvedValue(true),
}));

/** Minimal stub PushPlan with no assignments (no-changes scenario). */
const STUB_PLAN = {
  intent: { assignments: [] },
  preconditions: { configDigest: '', contentHashes: {}, assignmentIds: [], partIds: [], remoteAssumptions: [] },
  semanticFingerprint: 'stub-fp',
  summary: 'No changes',
};

describe('publishCommand option wiring', () => {
  const baseConfig: Config = {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: '201303',
      template_assignment_id: 'tmpl',
      api_base_url: 'https://api.vocareum.com',
    },
    assignments: [],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip',
      auto_commit: true,
      abort_on_error: true,
      sync_deletes: true,
      exclude_patterns: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    loadConfigMock.mockResolvedValue(baseConfig);
    planPushMock.mockResolvedValue(STUB_PLAN);
    executePushMock.mockResolvedValue({ success: true, summary: 'ok', failed: [], created: [], updated: [], skipped: [], contentState: {} });
  });

  it('should force-disable autoCommit in CI and pass scoped publish options', async () => {
    isCIMock.mockReturnValue(true);

    await publishCommand({
      config: 'custom.yaml',
      assignment: 'lab1',
      part: 'part1',
      forceAll: true,
      onMissingId: 'abort',
      abortOnError: true,
    });

    // planPush is called with a PushContext and PushRequest
    expect(planPushMock).toHaveBeenCalledTimes(1);
    const [ctx, req] = planPushMock.mock.calls[0];
    expect(req).toMatchObject({
      autoCommit: false,   // CI forces false
      nonInteractive: true,
      assignment: 'lab1',
      part: 'part1',
      forceAll: true,
      onMissingId: 'abort',
      abortOnError: true,
    });
    expect(ctx.configPath).toMatch(/custom\.yaml$/);
    expect(ctx.workspaceRoot).toBeTruthy();
  });

  it('should fall back to config publish_options for onMissingId and abortOnError', async () => {
    isCIMock.mockReturnValue(false);

    await publishCommand({ config: 'vocareum.yaml' });

    expect(planPushMock).toHaveBeenCalledTimes(1);
    const [, req] = planPushMock.mock.calls[0];
    expect(req.onMissingId).toBe('skip');
    expect(req.abortOnError).toBe(true);
    expect(req.syncDeletes).toBe(true);
  });
});

describe('publishCommand — reporter lifecycle', () => {
  const minimalConfig = {
    version: '1.0',
    vocareum: { org_id: '1', course_id: '1', api_base_url: 'https://api.vocareum.com' },
    assignments: [],
    publish_history: [],
    publish_options: {
      on_missing_id: 'skip', auto_commit: false, abort_on_error: false,
      sync_deletes: false, exclude_patterns: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VOCAREUM_API_KEY = 'token';
    isCIMock.mockReturnValue(false);
  });

  it('constructs an UnknownFieldReporter and passes it to executePush()', async () => {
    planPushMock.mockResolvedValue(STUB_PLAN);
    executePushMock.mockResolvedValue({ success: true, failed: [], created: [], updated: [], skipped: [], contentState: {}, summary: '' });
    loadConfigMock.mockResolvedValue(minimalConfig);

    await publishCommand({ config: 'vocareum.yaml' });

    expect(executePushMock).toHaveBeenCalled();
    // executePush signature: (session, ctx, req, plan, reporter?)
    const fifthArg = executePushMock.mock.calls[0][4];
    expect(fifthArg).toBeInstanceOf(UnknownFieldReporter);
  });

  it('calls reporter.printSummary even when executePush() throws', async () => {
    const printSpy = vi.spyOn(UnknownFieldReporter.prototype, 'printSummary');
    planPushMock.mockResolvedValue(STUB_PLAN);
    executePushMock.mockRejectedValue(new Error('boom'));
    loadConfigMock.mockResolvedValue(minimalConfig);

    await expect(publishCommand({ config: 'vocareum.yaml' })).rejects.toThrow();

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});

describe('publishCommand resolves throttle before using the client', () => {
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

  it('does not construct the client or call planPush when throttle resolution throws', async () => {
    vi.mocked(resolveThrottle).mockImplementationOnce(() => { throw new Error('bad throttle env'); });
    await expect(publishCommand({ config: 'vocareum.yaml' })).rejects.toThrow('bad throttle env');
    expect(vi.mocked(VocareumClient)).not.toHaveBeenCalled();
    expect(planPushMock).not.toHaveBeenCalled();
  });
});
