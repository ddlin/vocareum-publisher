/**
 * Validates the structural contract of action.yml without needing the npm
 * package published.  Catches drift between the composite action definition
 * and the CLI inputs/flags it delegates to.
 *
 * Assertions are grounded in the CURRENT action.yml — run `git diff` after
 * modifying either file to spot new drift.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';

const ACTION_YML = join(__dirname, '../../action.yml');

interface ActionInput {
  description: string;
  required?: boolean;
  default?: string;
}

interface ActionStep {
  name?: string;
  id?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
}

interface ActionYml {
  name: string;
  description: string;
  inputs: Record<string, ActionInput>;
  outputs: Record<string, { description: string; value: string }>;
  runs: {
    using: string;
    steps: ActionStep[];
  };
}

const action = yaml.load(readFileSync(ACTION_YML, 'utf8')) as ActionYml;

describe('action.yml — structural contract', () => {
  it('is a composite action', () => {
    expect(action.runs).toBeDefined();
    expect(action.runs.using).toBe('composite');
  });

  it('has at least two steps (install + push)', () => {
    expect(Array.isArray(action.runs.steps)).toBe(true);
    expect(action.runs.steps.length).toBeGreaterThanOrEqual(2);
  });

  it('install step references vocareum-publisher', () => {
    const installStep = action.runs.steps[0];
    expect(installStep.run).toBeDefined();
    expect(installStep.run).toContain('vocareum-publisher');
  });

  it('install step installs and runs the vocgit CLI', () => {
    const installStep = action.runs.steps[0];
    expect(installStep.run).toContain('vocgit');
    expect(installStep.shell).toBe('bash');
  });

  it('push step invokes vocgit with the push subcommand', () => {
    const pushStep = action.runs.steps.find(s => s.id === 'push');
    expect(pushStep).toBeDefined();
    expect(pushStep!.run).toContain('vocgit');
    expect(pushStep!.run).toContain('push');
  });

  it('push step has shell: bash', () => {
    const pushStep = action.runs.steps.find(s => s.id === 'push');
    expect(pushStep!.shell).toBe('bash');
  });
});

describe('action.yml — declared inputs', () => {
  const EXPECTED_INPUTS = [
    'config-file',
    'root',
    'api-key',
    'auth',
    'client-id',
    'client-secret',
    'dry-run',
    'non-interactive',
    'assignment',
    'part',
    'force-all',
    'sync-deletes',
    'auto-commit',
    'verbose',
  ] as const;

  it('declares all expected inputs', () => {
    for (const input of EXPECTED_INPUTS) {
      expect(action.inputs, `input "${input}" should be declared`).toHaveProperty(input);
    }
  });

  it('config-file has a default of vocareum.yaml', () => {
    expect(action.inputs['config-file'].default).toBe('vocareum.yaml');
  });

  it('dry-run defaults to false', () => {
    expect(action.inputs['dry-run'].default).toBe('false');
  });

  it('non-interactive defaults to true (CI-safe)', () => {
    expect(action.inputs['non-interactive'].default).toBe('true');
  });

  it('auth defaults to token', () => {
    expect(action.inputs['auth'].default).toBe('token');
  });
});

describe('action.yml — input wiring to push step env', () => {
  const pushStep = action.runs.steps.find(s => s.id === 'push');

  it('wires api-key to VOCAREUM_API_KEY', () => {
    expect(pushStep!.env?.['VOCAREUM_API_KEY']).toContain('inputs.api-key');
  });

  it('wires auth to VOCAREUM_AUTH_MODE', () => {
    expect(pushStep!.env?.['VOCAREUM_AUTH_MODE']).toContain('inputs.auth');
  });

  it('wires client-id to VOCAREUM_OAUTH_CLIENT_ID', () => {
    expect(pushStep!.env?.['VOCAREUM_OAUTH_CLIENT_ID']).toContain('inputs.client-id');
  });

  it('wires client-secret to VOCAREUM_OAUTH_CLIENT_SECRET', () => {
    expect(pushStep!.env?.['VOCAREUM_OAUTH_CLIENT_SECRET']).toContain('inputs.client-secret');
  });

  it('wires config-file to CONFIG_FILE', () => {
    expect(pushStep!.env?.['CONFIG_FILE']).toContain('inputs.config-file');
  });

  it('wires dry-run to DRY_RUN', () => {
    expect(pushStep!.env?.['DRY_RUN']).toContain('inputs.dry-run');
  });

  it('wires root to WORKSPACE_ROOT', () => {
    expect(pushStep!.env?.['WORKSPACE_ROOT']).toContain('inputs.root');
  });
});

describe('action.yml — outputs', () => {
  it('declares a success output', () => {
    expect(action.outputs).toHaveProperty('success');
  });

  it('success output value references the push step', () => {
    expect(action.outputs['success'].value).toContain('steps.push.outputs.success');
  });
});
