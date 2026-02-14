import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newCommand } from '../../src/commands/new';

const {
  loadConfigMock,
  updateConfigMock,
  pathExistsMock,
  ensureDirectoryMock,
  writeFileMock,
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
  writeFileMock: vi.fn(),
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
  writeFile: writeFileMock,
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
        templates: [
          { id: 'tmpl-default', name: 'Standard Lab', course_id: '201303' },
          { id: 'tmpl-alt', name: 'Cloud Lab', course_id: '999' },
        ],
        api_base_url: 'https://api.vocareum.com',
        excluded_assignments: [],
      },
      assignments: [],
      publish_history: [],
    });

    // User selects the second template (in different course) by its display string
    promptChoiceMock.mockResolvedValue('Cloud Lab (course:999, id:tmpl-alt)');
    updateConfigMock.mockResolvedValue(undefined);
    ensureDirectoryMock.mockResolvedValue(undefined);
  });

  it('should prompt for template choice with names and show course for cross-course templates', async () => {
    await newCommand('lab-new');

    // Templates in same course show just (id), templates in different course show (course:X, id:Y)
    expect(promptChoiceMock).toHaveBeenCalledWith(
      'Select template for this assignment:',
      ['Standard Lab (tmpl-default)', 'Cloud Lab (course:999, id:tmpl-alt)']
    );

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    const updatePayload = updateConfigMock.mock.calls[0][1];
    expect(updatePayload.assignments).toHaveLength(1);
    expect(updatePayload.assignments[0].template_assignment_id).toBe('tmpl-alt');
    expect(updatePayload.assignments[0].create_from_template).toBe(true);
  });

  it('should handle legacy template_assignment_ids format with auto-generated names', async () => {
    vi.clearAllMocks();
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        template_assignment_ids: ['tmpl-legacy-1', 'tmpl-legacy-2'],
        api_base_url: 'https://api.vocareum.com',
        excluded_assignments: [],
      },
      assignments: [],
      publish_history: [],
    });

    // Legacy templates are assumed to be in main course, so just show (id)
    promptChoiceMock.mockResolvedValue('Template tmpl-legacy-2 (tmpl-legacy-2)');

    await newCommand('lab-legacy');

    expect(promptChoiceMock).toHaveBeenCalledWith(
      'Select template for this assignment:',
      ['Template tmpl-legacy-1 (tmpl-legacy-1)', 'Template tmpl-legacy-2 (tmpl-legacy-2)']
    );

    const updatePayload = updateConfigMock.mock.calls[0][1];
    expect(updatePayload.assignments[0].template_assignment_id).toBe('tmpl-legacy-2');
  });

  it('should show only (id) for templates in same course as main course', async () => {
    vi.clearAllMocks();
    pathExistsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    loadConfigMock.mockResolvedValue({
      version: '1.0',
      vocareum: {
        org_id: '1',
        course_id: '201303',
        templates: [
          { id: 'tmpl-same', name: 'Same Course Template', course_id: '201303' },
        ],
        api_base_url: 'https://api.vocareum.com',
        excluded_assignments: [],
      },
      assignments: [],
      publish_history: [],
    });

    await newCommand('lab-same');

    // Single template - no prompt, just logs
    expect(promptChoiceMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'Using template: Same Course Template (tmpl-same)'
    );
  });
});
