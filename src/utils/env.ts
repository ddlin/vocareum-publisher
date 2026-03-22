import { existsSync, readFileSync } from 'fs';

/**
 * CI environment variables that indicate we're running in a CI/CD system
 */
const CI_ENV_VARS = [
  'CI',              // Generic CI indicator (GitHub Actions, GitLab CI, etc.)
  'GITHUB_ACTIONS',  // GitHub Actions
  'GITLAB_CI',       // GitLab CI
  'CIRCLECI',        // CircleCI
  'TRAVIS',          // Travis CI
  'JENKINS_URL',     // Jenkins
  'BUILDKITE',       // Buildkite
  'TEAMCITY_VERSION', // TeamCity
  'TF_BUILD',        // Azure Pipelines
  'CODEBUILD_BUILD_ID', // AWS CodeBuild
] as const;

/**
 * Detect if running in a CI/CD environment
 * @returns true if any CI environment variable is set to a truthy value
 */
export function isCI(): boolean {
  for (const envVar of CI_ENV_VARS) {
    const value = process.env[envVar];
    if (value !== undefined && value !== '' && value !== '0' && value !== 'false') {
      return true;
    }
  }
  return false;
}

/**
 * Get the name of the detected CI provider
 * @returns CI provider name or undefined if not in CI
 */
export function getCIProvider(): string | undefined {
  if (process.env.GITHUB_ACTIONS === 'true') {
    return 'GitHub Actions';
  }
  if (process.env.GITLAB_CI === 'true') {
    return 'GitLab CI';
  }
  if (process.env.CIRCLECI === 'true') {
    return 'CircleCI';
  }
  if (process.env.TRAVIS === 'true') {
    return 'Travis CI';
  }
  if (process.env.JENKINS_URL !== undefined && process.env.JENKINS_URL !== '') {
    return 'Jenkins';
  }
  if (process.env.BUILDKITE === 'true') {
    return 'Buildkite';
  }
  if (process.env.TEAMCITY_VERSION !== undefined && process.env.TEAMCITY_VERSION !== '') {
    return 'TeamCity';
  }
  if (process.env.TF_BUILD === 'True') {
    return 'Azure Pipelines';
  }
  if (process.env.CODEBUILD_BUILD_ID !== undefined && process.env.CODEBUILD_BUILD_ID !== '') {
    return 'AWS CodeBuild';
  }
  if (process.env.CI === 'true') {
    return 'Unknown CI';
  }
  return undefined;
}

function normalizeValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Load API key from environment variables or throw error with helpful message
 * Supports both VOCAREUM_API_KEY and VOCAREUM_API_TOKEN
 * 
 * @returns The API key if found
 * @throws TypeError with detailed instructions if API key is not set
 */
export function getApiKeyOrThrow(): string {
  const apiKey = process.env.VOCAREUM_API_KEY ?? process.env.VOCAREUM_API_TOKEN;
  if (apiKey === undefined || apiKey === '') {
    const message = [
      'VOCAREUM_API_KEY environment variable is required.',
      '',
      'To fix:',
      '  1. Generate a token at Vocareum: Profile > Settings > Personal Access Tokens',
      '  2. Set it using one of these methods:',
      '     - Create a .env file with: VOCAREUM_API_KEY=your_token',
      '     - Export in shell: export VOCAREUM_API_KEY=your_token',
      '     - In CI/CD: add VOCAREUM_API_KEY as a repository secret',
    ].join('\n');
    throw new TypeError(message);
  }
  return apiKey;
}

export function loadDotEnvIfPresent(filePath: string = '.env'): void {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }

    const rawKey = trimmed.slice(0, idx).trim();
    const key = rawKey.replace(/^export\s+/, '');
    const value = normalizeValue(trimmed.slice(idx + 1));

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
