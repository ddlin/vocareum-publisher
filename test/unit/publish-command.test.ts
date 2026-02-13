import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { publishCommand } from '../../src/commands/publish';

const {
  loadConfigMock,
  publishMock,
  loadDotEnvIfPresentMock,
  isCIMock,
  loggerErrorMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerSuccessMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  publishMock: vi.fn(),
  loadDotEnvIfPresentMock: vi.fn(),
  isCIMock: vi.fn(),
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

vi.mock('../../src/api/client', () => ({
  VocareumClient: vi.fn().mockImplementation(() => ({ request: vi.fn() })),
}));

vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: loadDotEnvIfPresentMock,
  isCI: isCIMock,
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
