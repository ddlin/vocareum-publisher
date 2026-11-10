import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as yaml from 'js-yaml';
import { initCommand } from '../../src/commands/init';

const {
  pathExistsMock,
  writeFileMock,
  promptMock,
  promptConfirmMock,
  promptChoiceMock,
} = vi.hoisted(() => ({
  pathExistsMock: vi.fn(),
  writeFileMock: vi.fn(),
  promptMock: vi.fn(),
  promptConfirmMock: vi.fn(),
  promptChoiceMock: vi.fn(),
}));

vi.mock('../../src/utils/files', () => ({
  pathExists: pathExistsMock,
  writeFile: writeFileMock,
}));

vi.mock('../../src/utils/prompts', () => ({
  prompt: promptMock,
  promptConfirm: promptConfirmMock,
  promptChoice: promptChoiceMock,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), debug: vi.fn() },
}));

const NA = 'https://api.vocareum.com';
const EU = 'https://api.eu.vocareum.com';

/** api_base_url from the single vocareum.yaml write. */
function writtenApiBaseUrl(): string {
  expect(writeFileMock).toHaveBeenCalledTimes(1);
  const [path, body] = writeFileMock.mock.calls[0] as [string, string];
  expect(path).toBe('vocareum.yaml');
  const doc = yaml.load(body) as { vocareum: { api_base_url: string } };
  return doc.vocareum.api_base_url;
}

/** Pick the inquirer list entry whose label starts with the region code. */
function chooseRegion(code: 'NA' | 'EU'): void {
  promptChoiceMock.mockImplementation((_msg: string, choices: string[]) => {
    const hit = choices.find(c => c.startsWith(code));
    if (hit === undefined) { throw new Error(`no ${code} choice in ${choices.join(' | ')}`); }
    return Promise.resolve(hit);
  });
}

const savedEnv = {
  apiBaseUrl: process.env.VOCAREUM_API_BASE_URL,
  allowCustom: process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL,
};

describe('initCommand — region / API host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VOCAREUM_API_BASE_URL;
    delete process.env.VOCAREUM_ALLOW_CUSTOM_BASE_URL;
    pathExistsMock.mockResolvedValue(false);
    writeFileMock.mockResolvedValue(undefined);
    // org, course; no templates
    promptMock.mockImplementation((msg: string) =>
      Promise.resolve(msg.includes('Organization') ? '292' : msg.includes('Course') ? '215500' : ''));
    promptConfirmMock.mockResolvedValue(false);
  });

  afterEach(() => {
    for (const [key, value] of [
      ['VOCAREUM_API_BASE_URL', savedEnv.apiBaseUrl],
      ['VOCAREUM_ALLOW_CUSTOM_BASE_URL', savedEnv.allowCustom],
    ] as const) {
      if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
    }
  });

  it('--region eu writes the EU host without prompting for region', async () => {
    await initCommand({ region: 'eu' });
    expect(writtenApiBaseUrl()).toBe(EU);
    expect(promptChoiceMock).not.toHaveBeenCalled();
  });

  it('--region na writes the NA host', async () => {
    await initCommand({ region: 'na' });
    expect(writtenApiBaseUrl()).toBe(NA);
  });

  it('--region is case-insensitive', async () => {
    await initCommand({ region: 'EU' });
    expect(writtenApiBaseUrl()).toBe(EU);
  });

  it('plain init prompts for region with NA listed first (the default) and writes NA', async () => {
    promptChoiceMock.mockImplementation((_msg: string, choices: string[]) => Promise.resolve(choices[0]));
    await initCommand({});
    const [, choices] = promptChoiceMock.mock.calls[0] as [string, string[]];
    expect(choices[0]).toMatch(/^NA\b.*api\.vocareum\.com/);
    expect(choices[1]).toMatch(/^EU\b.*api\.eu\.vocareum\.com/);
    expect(writtenApiBaseUrl()).toBe(NA);
  });

  it('interactive pick of EU writes the EU host', async () => {
    chooseRegion('EU');
    await initCommand({});
    expect(writtenApiBaseUrl()).toBe(EU);
  });

  it('asks for the region before the org ID (IDs are tenant-specific)', async () => {
    chooseRegion('EU');
    await initCommand({});
    const regionOrder = promptChoiceMock.mock.invocationCallOrder[0];
    const orgOrder = promptMock.mock.invocationCallOrder[0];
    expect(regionOrder).toBeLessThan(orgOrder);
  });

  it('--api-base-url with the EU host writes it (trailing slash dropped)', async () => {
    await initCommand({ apiBaseUrl: `${EU}/` });
    expect(writtenApiBaseUrl()).toBe(EU);
    expect(promptChoiceMock).not.toHaveBeenCalled();
  });

  it('--api-base-url with the full EU /api/v2 URL is accepted as written', async () => {
    await initCommand({ apiBaseUrl: `${EU}/api/v2` });
    expect(writtenApiBaseUrl()).toBe(`${EU}/api/v2`);
  });

  it('--api-base-url with an unknown host is refused before any prompt or write', async () => {
    await expect(initCommand({ apiBaseUrl: 'https://api.eu.vocareum.com.evil.com' })).rejects.toThrow(/Insecure/);
    expect(promptMock).not.toHaveBeenCalled();
    expect(promptConfirmMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('--api-base-url with http:// is refused', async () => {
    await expect(initCommand({ apiBaseUrl: 'http://api.eu.vocareum.com' })).rejects.toThrow(/Insecure/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('--api-base-url with the v3 host is refused (token auth is v2-only)', async () => {
    await expect(initCommand({ apiBaseUrl: 'https://labs.vocareum.com/api/v3' })).rejects.toThrow(/Insecure/);
  });

  it('--region and --api-base-url together are refused', async () => {
    await expect(initCommand({ region: 'eu', apiBaseUrl: EU })).rejects.toThrow(/either --region or --api-base-url/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('an unknown --region is refused (programmatic callers bypass commander choices)', async () => {
    await expect(initCommand({ region: 'apac' })).rejects.toThrow(/Unknown region/);
  });

  it('VOCAREUM_API_BASE_URL is used when no flag is given, without prompting', async () => {
    process.env.VOCAREUM_API_BASE_URL = EU;
    await initCommand({});
    expect(writtenApiBaseUrl()).toBe(EU);
    expect(promptChoiceMock).not.toHaveBeenCalled();
  });

  it('a flag beats VOCAREUM_API_BASE_URL', async () => {
    process.env.VOCAREUM_API_BASE_URL = EU;
    await initCommand({ region: 'na' });
    expect(writtenApiBaseUrl()).toBe(NA);
  });

  it('an unallowlisted VOCAREUM_API_BASE_URL is refused', async () => {
    process.env.VOCAREUM_API_BASE_URL = 'https://evil.example.com';
    await expect(initCommand({})).rejects.toThrow(/Insecure/);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('a declined overwrite writes nothing even when --region is valid', async () => {
    pathExistsMock.mockResolvedValue(true);
    promptConfirmMock.mockResolvedValueOnce(false);
    await initCommand({ region: 'eu' });
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
