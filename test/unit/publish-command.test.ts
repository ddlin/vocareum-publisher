import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { publishCommand } from '../../src/commands/publish';
import { UnknownFieldReporter } from '../../src/utils/unknown-field-reporter';

const {
  loadConfigMock,
  publishMock,
  loadDotEnvIfPresentMock,
  isCIMock,
  getApiKeyOrThrowMock,
  loggerErrorMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerSuccessMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  publishMock: vi.fn(),
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
}));

vi.mock('../../src/core/publisher', () => ({
  publish: publishMock,
}));

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/api/client')>();
  return {
    ...actual,
    VocareumClient: vi.fn().mockImplementation(() => ({ request: vi.fn() })),
  };
});

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
  },
}));

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
    publishMock.mockResolvedValue({ success: true, summary: 'ok', failed: [] });
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

    expect(publishMock).toHaveBeenCalledTimes(1);
    const passedOptions = publishMock.mock.calls[0][2];
    expect(passedOptions).toMatchObject({
      autoCommit: false,
      nonInteractive: true,
      assignment: 'lab1',
      part: 'part1',
      forceAll: true,
      onMissingId: 'abort',
      abortOnError: true,
      configPath: 'custom.yaml',
    });
  });

  it('should fall back to config publish_options for onMissingId and abortOnError', async () => {
    isCIMock.mockReturnValue(false);

    await publishCommand({ config: 'vocareum.yaml' });

    const passedOptions = publishMock.mock.calls[0][2];
    expect(passedOptions.onMissingId).toBe('skip');
    expect(passedOptions.abortOnError).toBe(true);
    expect(passedOptions.syncDeletes).toBe(true);
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

  it('constructs an UnknownFieldReporter and passes it as the 4th argument to publish()', async () => {
    publishMock.mockResolvedValue({ success: true, failed: [], succeeded: [] });
    loadConfigMock.mockResolvedValue(minimalConfig);

    await publishCommand({ config: 'vocareum.yaml' });

    expect(publishMock).toHaveBeenCalled();
    const fourthArg = publishMock.mock.calls[0][3];
    expect(fourthArg).toBeInstanceOf(UnknownFieldReporter);
  });

  it('calls reporter.printSummary even when publish() throws', async () => {
    const printSpy = vi.spyOn(UnknownFieldReporter.prototype, 'printSummary');
    publishMock.mockRejectedValue(new Error('boom'));
    loadConfigMock.mockResolvedValue(minimalConfig);

    await expect(publishCommand({ config: 'vocareum.yaml' })).rejects.toThrow();

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
