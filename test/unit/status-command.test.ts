import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { statusCommand } from '../../src/commands/status';

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock('../../src/core/config', () => ({
  loadConfig: loadConfigMock,
}));

vi.mock('../../src/utils/env', () => ({
  loadDotEnvIfPresent: vi.fn(),
  isCI: vi.fn().mockReturnValue(false),
  getCIProvider: vi.fn().mockReturnValue(undefined),
  getAuthModeEnv: vi.fn().mockReturnValue(undefined),
  getOAuthClientId: vi.fn().mockReturnValue(undefined),
  getOAuthClientSecret: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../src/utils/git', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCurrentBranch: vi.fn().mockResolvedValue('master'),
  getCommitSha: vi.fn().mockResolvedValue('abc1234'),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
}));

function makeConfig(): Config {
  return {
    version: '1.0',
    vocareum: {
      org_id: '1',
      course_id: '201303',
      template_assignment_ids: [],
      templates: [],
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
          { part_id: 'part-1', path: 'part1', directories: ['startercode'], settings: {} },
        ],
      },
    ],
    publish_history: [],
  } as unknown as Config;
}

describe('statusCommand --json', () => {
  let stdoutWrites: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadConfigMock.mockReset();
    loadConfigMock.mockResolvedValue(makeConfig());
    stdoutWrites = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    delete process.env.VOCAREUM_API_KEY;
    delete process.env.VOCAREUM_API_TOKEN;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('emits a single parseable JSON document on stdout with schema_version 1', async () => {
    await statusCommand({ json: true });

    expect(stdoutWrites).toHaveLength(1);
    const doc = JSON.parse(stdoutWrites[0]) as Record<string, unknown>;
    expect(doc.schema_version).toBe(1);
    expect(doc.course).toEqual({ org_id: '1', course_id: '201303' });
    // Statuses cover CONTENT changes only — settings drift needs the API.
    expect(doc.scope).toBe('content');
  });

  it('includes per-assignment local scan statuses', async () => {
    await statusCommand({ json: true });

    const doc = JSON.parse(stdoutWrites[0]) as {
      assignments: Array<{ path: string; status: string; parts: Array<{ path: string; status: string }> }>;
      summary: Record<string, number>;
    };

    // No publish history in the fixture → everything is unknown
    expect(doc.assignments).toHaveLength(1);
    expect(doc.assignments[0]).toMatchObject({ path: 'lab1', status: 'unknown' });
    expect(doc.assignments[0].parts[0]).toMatchObject({ path: 'part1', status: 'unknown' });
    expect(doc.summary.unknown).toBe(1);
  });

  it('reports auth mode and configured flag', async () => {
    process.env.VOCAREUM_API_KEY = 'k';
    try {
      await statusCommand({ json: true });
    } finally {
      delete process.env.VOCAREUM_API_KEY;
    }

    const doc = JSON.parse(stdoutWrites[0]) as { auth: { mode: string; configured: boolean } };
    expect(doc.auth).toEqual({ mode: 'token', configured: true });
  });

  it('keeps stdout pure JSON (no human banner) in json mode', async () => {
    await statusCommand({ json: true });

    const combined = stdoutWrites.join('');
    expect(combined).not.toContain('Current Vocareum Publisher status');
  });

  it('last_push uses publish_history[0] — the same baseline the scanner and publisher trust', async () => {
    const config = makeConfig();
    // Deliberately unsorted: [0] is OLDER than [1]. Push trusts [0]; the
    // report must agree with the scan baseline, not pick the max timestamp.
    config.publish_history = [
      {
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'old',
        published_by: 'test',
        status: 'success',
        content_state: {},
      },
      {
        timestamp: '2026-06-05T00:00:00Z',
        commit_sha: 'newer-but-not-first',
        published_by: 'test',
        status: 'success',
        content_state: {},
      },
    ];
    loadConfigMock.mockResolvedValue(config);

    await statusCommand({ json: true });

    const doc = JSON.parse(stdoutWrites[0]) as { last_push: { commit_sha: string } };
    expect(doc.last_push.commit_sha).toBe('old');
  });

  it('still prints the human report without --json', async () => {
    await statusCommand({});

    const combined = stdoutWrites.join('');
    expect(combined).toContain('Current Vocareum Publisher status');
  });
});
