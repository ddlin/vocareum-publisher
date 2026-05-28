
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { publishCommand } from '../../src/commands/publish';
import { VocareumClient } from '../../src/api/client';
import type { Config } from '../../src/types/config';
import type { AxiosRequestConfig } from 'axios';

// Mock dependencies
vi.mock('../../src/core/config', () => ({
    loadConfig: vi.fn(),
    updateConfig: vi.fn(),
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
    logger: {
        info: vi.fn(),
        success: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        newline: vi.fn(),
        plain: vi.fn(),
    },
}));

// Mock env utils
vi.mock('../../src/utils/env', () => ({
    loadDotEnvIfPresent: vi.fn(),
    isCI: vi.fn().mockReturnValue(true),
    getApiKeyOrThrow: vi.fn().mockReturnValue('test-api-key'),
    getOAuthClientId: vi.fn().mockReturnValue(undefined),
    getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
    getAuthModeEnv: vi.fn().mockReturnValue(undefined),
    getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
    getOAuthTokenUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3/oauth/token'),
}));

// Mock file system
vi.mock('../../src/utils/files', () => ({
    pathExists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue('content'),
    ensureDirectory: vi.fn().mockResolvedValue(undefined),
    readLocalDirectory: vi.fn().mockResolvedValue({ 'hello.txt': 'world' }),
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

describe('Integration: Publish Command', () => {
    const mockConfig: Config = {
        vocareum: {
            course_id: 'course-123',
            api_base_url: 'https://api.vocareum.com',
            org_id: 'org-123'
        },
        assignments: [
            {
                path: 'assignment1',
                name: 'Assignment 1',
                assignment_id: 'asn-123',
                parts: [
                    {
                        path: 'part1',
                        name: 'Part 1',
                        part_id: 'part-123',
                        directories: ['startercode']
                    }
                ]
            }
        ]
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

    it('should run dry-run with no changes', async () => {
        // Setup API mocks
        mockRequest.mockImplementation(async (config: AxiosRequestConfig) => {
            const url = config.url;
            const method = config.method;

            if (url.endsWith('/courses/course-123') && method === 'GET') {
                return { courses: [{ id: 'course-123', name: 'Test Course', org_id: 'org-123' }] };
            }

            if (url.includes('/assignments/asn-123') && method === 'GET') {
                return {
                    assignments: [{
                        id: 'asn-123',
                        name: 'Assignment 1',
                        parts: [{ id: 'part-123', name: 'Part 1', part_id: 'part-123' }]
                    }]
                };
            }
            if (url.endsWith('/assignments') && method === 'GET') {
                return { assignments: [{ id: 'asn-123', name: 'Assignment 1' }] };
            }
            if (url.includes('/parts') && method === 'GET') {
                // listParts
                return { parts: [{ id: 'part-123', name: 'Part 1', part_id: 'part-123' }] };
            }
            if (url.includes('/files') && method === 'GET') {
                // listKeys
                return [];
            }

            console.log('Unhandled URL in mock:', url);
            return {};
        });

        await publishCommand({
            dryRun: true,
            verbose: true,
            config: 'vocareum.yaml'
        });

        expect(loadConfig).toHaveBeenCalled();
        expect(VocareumClient).toHaveBeenCalled();
        expect(mockRequest).toHaveBeenCalled();
    });
});
