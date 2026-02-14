import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newCommand } from '../../src/commands/new';

const {
  loadConfigMock,
  updateConfigMock,
  pathExistsMock,
  ensureDirectoryMock,
  promptMock,
  promptConfirmMock,
  promptChoiceMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
  loggerSuccessMock,
  loggerDebugMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  updateConfigMock: vi.fn(),
  pathExistsMock: vi.fn(),
  ensureDirectoryMock: vi.fn(),
  promptMock: vi.fn(),
  promptConfirmMock: vi.fn(),
  promptChoiceMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerSuccessMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('../../src/core/config', () => ({
  loadConfig: loadConfigMock,
  updateConfig: updateConfigMock,
}));

vi.mock('../../src/utils/files', () => ({
  pathExists: pathExistsMock,
  ensureDirectory: ensureDirectoryMock,
}));

vi.mock('../../src/utils/prompts', () => ({
  prompt: promptMock,
  promptConfirm: promptConfirmMock,
  promptChoice: promptChoiceMock,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
    success: loggerSuccessMock,
    debug: loggerDebugMock,
  },
}));

describe('newCommand template selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // First call checks vocareum.yaml, second checks assignment directory
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_id: 'tmpl-default',
        template_assignment_ids: ['tmpl-default', 'tmpl-alt'],
        api_base_url: 'https://api.vocareum.com',
        excluded_assignments: [],
      },
      assignments: [],
      publish_history: [],
    });

    promptChoiceMock.mockResolvedValue('tmpl-alt');
    updateConfigMock.mockResolvedValue(undefined);
    ensureDirectoryMock.mockResolvedValue(undefined);
  });

  it('should prompt for template choice and persist selected template per assignment', async () => {
    await newCommand('lab-new');

    expect(promptChoiceMock).toHaveBeenCalledWith(
      'Select template assignment ID for this assignment:',
      ['tmpl-default', 'tmpl-alt']
    );

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    const updatePayload = updateConfigMock.mock.calls[0][1];
    expect(updatePayload.assignments).toHaveLength(1);
    expect(updatePayload.assignments[0].template_assignment_id).toBe('tmpl-alt');
    expect(updatePayload.assignments[0].create_from_template).toBe(true);
  });
});
