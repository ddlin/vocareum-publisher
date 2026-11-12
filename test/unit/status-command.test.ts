import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import { statusCommand } from '../../src/commands/status';
import { getApiBaseUrlEnv, getAuthModeEnv } from '../../src/utils/env';

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
  getApiBaseUrlEnv: vi.fn().mockReturnValue(undefined),
  getV3ApiBaseUrl: vi.fn().mockReturnValue('https://labs.vocareum.com/api/v3'),
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

  it('emits a single parseable JSON envelope on stdout', async () => {
    await statusCommand({ json: true });

    expect(stdoutWrites).toHaveLength(1);
    const doc = JSON.parse(stdoutWrites[0]) as {
      schema_version: string;
      command: string;
      payload: Record<string, unknown>;
    };
    expect(doc.schema_version).toBe('1.0');
    expect(doc.command).toBe('status');
    expect(doc.payload.payload_schema_version).toBe(2);
    expect(doc.payload.course).toEqual({ org_id: '1', course_id: '201303' });
    // Statuses cover CONTENT changes only — settings drift needs the API.
    expect(doc.payload.scope).toBe('content');
  });

  it('includes per-assignment local scan statuses', async () => {
    await statusCommand({ json: true });

    const doc = JSON.parse(stdoutWrites[0]) as { payload: {
      assignments: Array<{ path: string; status: string; parts: Array<{ path: string; status: string }> }>;
      summary: Record<string, number>;
    } };

    // No publish history in the fixture → everything is unknown
    expect(doc.payload.assignments).toHaveLength(1);
    expect(doc.payload.assignments[0]).toMatchObject({ path: 'lab1', status: 'unknown' });
    expect(doc.payload.assignments[0].parts[0]).toMatchObject({ path: 'part1', status: 'unknown' });
    expect(doc.payload.summary.unknown).toBe(1);
  });

  it('reports auth mode and configured flag', async () => {
    process.env.VOCAREUM_API_KEY = 'k';
    try {
      await statusCommand({ json: true });
    } finally {
      delete process.env.VOCAREUM_API_KEY;
    }

    const doc = JSON.parse(stdoutWrites[0]) as { payload: { auth: { mode: string; configured: boolean } } };
    expect(doc.payload.auth).toEqual({ mode: 'token', configured: true });
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

    const doc = JSON.parse(stdoutWrites[0]) as { payload: { last_push: { commit_sha: string } } };
    expect(doc.payload.last_push.commit_sha).toBe('old');
  });

  it('still prints the human report without --json', async () => {
    await statusCommand({});

    const combined = stdoutWrites.join('');
    expect(combined).toContain('Current Vocareum Publisher status');
  });
});

describe('statusCommand — API host / region', () => {
  let stdoutWrites: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  type ApiField = { base_url: string; host: string; region: string | null; source: string; allowlisted: boolean; malformed: boolean };

  function configWithHost(apiBaseUrl: string): Config {
    const config = makeConfig();
    config.vocareum.api_base_url = apiBaseUrl;
    return config;
  }

  beforeEach(() => {
    loadConfigMock.mockReset();
    vi.mocked(getApiBaseUrlEnv).mockReturnValue(undefined);
    vi.mocked(getAuthModeEnv).mockReturnValue(undefined);
    stdoutWrites = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.mocked(getApiBaseUrlEnv).mockReturnValue(undefined);
    vi.mocked(getAuthModeEnv).mockReturnValue(undefined);
  });

  it('--json reports the NA host from vocareum.yaml', async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    await statusCommand({ json: true });
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api).toEqual({
      base_url: 'https://api.vocareum.com/api/v2',
      host: 'api.vocareum.com',
      region: 'na',
      source: 'config',
      allowlisted: true,
      malformed: false,
    });
  });

  it('--json reports the EU host from vocareum.yaml', async () => {
    loadConfigMock.mockResolvedValue(configWithHost('https://api.eu.vocareum.com'));
    await statusCommand({ json: true });
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api).toMatchObject({ host: 'api.eu.vocareum.com', region: 'eu', source: 'config', allowlisted: true });
  });

  it('--json shows VOCAREUM_API_BASE_URL winning over vocareum.yaml', async () => {
    loadConfigMock.mockResolvedValue(makeConfig()); // NA in yaml
    vi.mocked(getApiBaseUrlEnv).mockReturnValue('https://api.eu.vocareum.com');
    await statusCommand({ json: true });
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api).toMatchObject({ region: 'eu', source: 'env' });
  });

  it('--json flags an unallowlisted host instead of throwing', async () => {
    loadConfigMock.mockResolvedValue(configWithHost('https://staging.example.com'));
    await statusCommand({ json: true });
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api).toMatchObject({ host: 'staging.example.com', region: null, allowlisted: false });
  });

  it('human output names the EU host, region, and source', async () => {
    loadConfigMock.mockResolvedValue(configWithHost('https://api.eu.vocareum.com'));
    await statusCommand({});
    expect(stdoutWrites.join('')).toContain('- API host: api.eu.vocareum.com (EU, from vocareum.yaml)');
  });

  it('human output warns when the host is not allowlisted', async () => {
    loadConfigMock.mockResolvedValue(configWithHost('https://staging.example.com'));
    await statusCommand({});
    expect(stdoutWrites.join('')).toMatch(/API host: staging\.example\.com \(custom host, from vocareum\.yaml\) — NOT allowlisted/);
  });

  it('never prints credentials pasted into the URL (userinfo, query, fragment)', async () => {
    const secret = 'secret-token-123';
    loadConfigMock.mockResolvedValue(configWithHost(`https://${secret}@api.eu.vocareum.com/api/v2?k=${secret}#${secret}`));
    await statusCommand({ json: true });
    await statusCommand({});
    expect(stdoutWrites.join('')).not.toContain(secret);
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api.base_url).toBe('https://api.eu.vocareum.com/api/v2');
    // ...and it is reported as refused, not as a usable EU host.
    expect(doc.payload.api).toMatchObject({ allowlisted: false, malformed: true, region: null });
    expect(stdoutWrites.join('')).toMatch(/API host: api\.eu\.vocareum\.com \(custom host, from vocareum\.yaml\) — MALFORMED/);
  });

  it('never echoes an unparsable host value', async () => {
    loadConfigMock.mockResolvedValue(configWithHost('not a url secret-token-456'));
    await statusCommand({ json: true });
    await statusCommand({});
    expect(stdoutWrites.join('')).not.toContain('secret-token-456');
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api).toMatchObject({ base_url: '<invalid URL>', host: '<invalid URL>', allowlisted: false });
  });

  it('OAuth human output names VOCAREUM_API_V3_BASE_URL, not the v2 variable', async () => {
    loadConfigMock.mockResolvedValue(makeConfig());
    vi.mocked(getAuthModeEnv).mockReturnValue('oauth');
    const saved = process.env.VOCAREUM_API_V3_BASE_URL;
    process.env.VOCAREUM_API_V3_BASE_URL = 'https://labs.vocareum.com/api/v3';
    try {
      await statusCommand({});
    } finally {
      if (saved === undefined) { delete process.env.VOCAREUM_API_V3_BASE_URL; } else { process.env.VOCAREUM_API_V3_BASE_URL = saved; }
    }
    const out = stdoutWrites.join('');
    expect(out).toContain('- API host: labs.vocareum.com (NA, from VOCAREUM_API_V3_BASE_URL)');
    expect(out).not.toContain('from VOCAREUM_API_BASE_URL');
  });

  it('human output names directories an incomplete pull left blocked from push', async () => {
    const config = makeConfig();
    config.publish_history = [{
      timestamp: '2026-11-09T00:00:00Z', commit_sha: 'x', published_by: 'pull-command', status: 'failed',
      content_state: { 'lab1/part1/startercode': 'incomplete-pull', 'lab1/part1/docs': 'abc123' },
    }] as unknown as Config['publish_history'];
    loadConfigMock.mockResolvedValue(config);
    const stderrWrites: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderrWrites.push(String(chunk)); return true; });
    try {
      await statusCommand({});
    } finally {
      errSpy.mockRestore();
    }
    const out = stdoutWrites.join('') + stderrWrites.join('');
    expect(out).toMatch(/Incomplete pull: push refuses 1 directory until a complete pull .*: lab1\/part1\/startercode/);
    expect(out).not.toMatch(/lab1\/part1\/docs/);
  });

  it('--json in OAuth mode reports the v3 host', async () => {
    loadConfigMock.mockResolvedValue(configWithHost('https://api.eu.vocareum.com'));
    vi.mocked(getAuthModeEnv).mockReturnValue('oauth');
    await statusCommand({ json: true });
    const doc = JSON.parse(stdoutWrites[0]) as { payload: { api: ApiField } };
    expect(doc.payload.api).toMatchObject({ host: 'labs.vocareum.com', region: 'na', allowlisted: true });
  });
});
