
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pullCommand } from '../../src/commands/pull';
import { VocareumClient } from '../../src/api/client';
import type { Config } from '../../src/types/config';
import type { AxiosRequestConfig } from 'axios';

// Mock dependencies
vi.mock('../../src/core/config', () => ({
    loadConfig: vi.fn(),
    updateConfig: vi.fn(),
    withConfigLock: vi.fn((_path: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
    logger: {
        info: vi.fn((...args) => console.log('[INFO]', ...args)),
        success: vi.fn((...args) => console.log('[SUCCESS]', ...args)),
        error: vi.fn((...args) => console.error('[ERROR]', ...args)),
        warn: vi.fn((...args) => console.warn('[WARN]', ...args)),
        debug: vi.fn((...args) => console.log('[DEBUG]', ...args)),
        newline: vi.fn(),
        plain: vi.fn((...args) => console.log('[PLAIN]', ...args)),
    },
}));

// Mock env utils
vi.mock('../../src/utils/env', () => ({
    loadDotEnvIfPresent: vi.fn(),
    isCI: vi.fn().mockReturnValue(false), // Default to false for interactive tests
    getApiKeyOrThrow: vi.fn().mockReturnValue('test-api-key'),
    getOAuthClientId: vi.fn().mockReturnValue(undefined),
    getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
    getAuthModeEnv: vi.fn().mockReturnValue(undefined),
    getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
    getOAuthTokenUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3/oauth/token'),
}));

// Mock file system
vi.mock('../../src/utils/files', () => ({
    pathExists: vi.fn().mockImplementation((p) => {
        // Return false for the new directory so it can be created
        if (typeof p === 'string' && p.includes('remote-assignment')) {
            return Promise.resolve(false);
        }
        return Promise.resolve(true); // Default to true for config existence checks
    }),
    readFile: vi.fn().mockResolvedValue('content'),
    ensureDirectory: vi.fn().mockResolvedValue(undefined),
    readLocalDirectory: vi.fn().mockResolvedValue({}),
    readDirectory: vi.fn().mockResolvedValue({}),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFileUnderBase: vi.fn().mockResolvedValue(undefined),
    validatePath: vi.fn(),
    calculateDirectoryHash: vi.fn().mockResolvedValue('hash'),
}));

// Mock Git utils
vi.mock('../../src/utils/git', () => ({
    getCommitSha: vi.fn().mockResolvedValue('test-sha'),
    getGitUserName: vi.fn().mockResolvedValue('test-user'),
    commitChanges: vi.fn().mockResolvedValue(undefined),
}));

// Mock prompts
vi.mock('../../src/utils/prompts', () => ({
    promptConfirm: vi.fn().mockResolvedValue(true),
    promptChoice: vi.fn(),
    prompt: vi.fn(),
}));

// Mock Client
const mockRequest = vi.fn();

vi.mock('../../src/api/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/api/client')>();
    return {
        ...actual,
        VocareumClient: vi.fn().mockImplementation(() => {
            return {
                request: mockRequest
            };
        }),
    };
});

import { loadConfig } from '../../src/core/config';
import { promptChoice, prompt } from '../../src/utils/prompts';
import { writeFile, ensureDirectory } from '../../src/utils/files';

describe('Integration: Pull Command', () => {
    const mockConfig: Config = {
        vocareum: {
            course_id: 'course-123',
            api_base_url: 'https://api.vocareum.com',
            org_id: 'org-123'
        },
        assignments: [] // Empty local config to simulate orphan
    };

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.VOCAREUM_API_KEY = 'test-key';
        vi.mocked(loadConfig).mockResolvedValue(mockConfig);
        mockRequest.mockReset();
    });

    afterEach(() => {
        delete process.env.VOCAREUM_API_KEY;
    });

    it('should detect orphan and skip in non-interactive mode', async () => {
        // Setup API mocks
        mockRequest.mockImplementation(async (config: AxiosRequestConfig) => {
            const url = config.url;
            const method = config.method;

            if (url.endsWith('/courses/course-123') && method === 'GET') {
                return { courses: [{ id: 'course-123', name: 'Test Course', org_id: 'org-123' }] };
            }

            if (url.endsWith('/assignments') && method === 'GET') {
                // Return one assignment that is NOT in local config
                return { assignments: [{ id: 'asn-remote', name: 'Remote Assignment' }] };
            }

            if (url.includes('/assignments/asn-remote') && method === 'GET') {
                return {
                    assignments: [{
                        id: 'asn-remote',
                        name: 'Remote Assignment',
                        parts: [{ id: 'part-remote', name: 'Part 1', part_id: 'part-remote' }]
                    }]
                };
            }

            if (url.includes('/parts') && method === 'GET') {
                return { parts: [{ id: 'part-remote', name: 'Part 1', part_id: 'part-remote' }] };
            }

            return {};
        });

        await pullCommand({
            nonInteractive: true,
            verbose: true,
            config: 'vocareum.yaml'
        });

        expect(loadConfig).toHaveBeenCalled();
        expect(VocareumClient).toHaveBeenCalled();
        expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({
            url: expect.stringContaining('/assignments'),
            method: 'GET'
        }));
    });

    it('should import orphan when user selects Import', async () => {
        // Setup API mocks
        mockRequest.mockImplementation(async (config: AxiosRequestConfig) => {
            const url = config.url;
            const method = config.method;

            if (url.endsWith('/courses/course-123') && method === 'GET') {
                return { courses: [{ id: 'course-123', name: 'Test Course', org_id: 'org-123' }] };
            }

            // List assignments
            if (url.endsWith('/assignments') && method === 'GET') {
                return { assignments: [{ id: 'asn-remote', name: 'Remote Assignment' }] };
            }

            // Files operations - check first since URL contains /parts and /assignments
            if (url.includes('/files') && method === 'GET') {
                // listFiles (has dir param but no filename)
                if (config.params && config.params.dir && !config.params.filename) {
                    if (config.params.dir === 'startercode') {
                        return { files: [{ path: 'test.txt' }] };
                    }
                    return { files: [] };
                }
                // Download file (has filename param)
                if (config.params && config.params.filename) {
                    return Buffer.from('file-content');
                }
            }

            // List parts / Get part - check before assignment details since URL contains both
            if (url.includes('/parts') && method === 'GET') {
                // If the URL ends with /parts, it's listParts
                if (url.endsWith('/parts')) {
                    return { parts: [{ id: 'part-remote', name: 'Part 1', part_id: 'part-remote', seqnum: '1' }] };
                }
                // If it has a part ID, it's getPart
                if (url.includes('/parts/part-remote')) {
                    return { parts: [{ id: 'part-remote', name: 'Part 1', part_id: 'part-remote', seqnum: '1', submission_filters: {} }] };
                }
            }

            // Get assignment details - must come AFTER parts check
            if (url.includes('/assignments/asn-remote') && method === 'GET') {
                return {
                    assignments: [{
                        id: 'asn-remote',
                        name: 'Remote Assignment',
                        parts: [{ id: 'part-remote', name: 'Part 1', part_id: 'part-remote' }]
                    }]
                };
            }

            return { parts: [{ id: 'part-remote', name: 'Part 1', part_id: 'part-remote' }] }; // Fallback
        });

        // Mock prompts to select Import
        vi.mocked(promptChoice).mockResolvedValue('Import to local repository');
        vi.mocked(prompt).mockResolvedValue('remote-assignment'); // Directory name

        await pullCommand({
            nonInteractive: false, // Interactive mode
            verbose: true,
            config: 'vocareum.yaml'
        });

        // Verify directory creation and file writing
        expect(ensureDirectory).toHaveBeenCalled();
        expect(writeFile).toHaveBeenCalled();
    });
});
