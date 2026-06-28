/**
 * Unit tests for inspectStatus — pure data, no events emitted.
 *
 * Uses the sample-course fixture (test/fixtures/sample-course) so real path
 * confinement and directory scans exercise a real workspace layout.
 */
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../../src/types/config';
import type { StatusContext } from '../../src/core/services/context';
import { CollectingEventSink } from '../../src/core/services/event-sink';
import { inspectStatus } from '../../src/core/services/status-service';
import * as localScan from '../../src/core/local-scan';

vi.mock('../../src/utils/git', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  getCommitSha: vi.fn().mockResolvedValue('abc1234'),
  hasUncommittedChanges: vi.fn().mockResolvedValue(false),
}));

const FIXTURE_ROOT = path.resolve('test/fixtures/sample-course');
const FIXTURE_CONFIG = path.join(FIXTURE_ROOT, 'vocareum.yaml');

/** Minimal config matching the sample-course fixture */
function makeFixtureConfig(): Config {
  return {
    version: '1.0',
    vocareum: {
      org_id: 'org-1',
      course_id: 'crs-42',
      template_assignment_id: undefined,
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

function makeContext(config: Config, sinkOverride?: CollectingEventSink): StatusContext {
  const events = sinkOverride ?? new CollectingEventSink();
  return {
    persistedConfig: config,
    effectiveConfig: config,
    configPath: FIXTURE_CONFIG,
    workspaceRoot: FIXTURE_ROOT,
    events,
    prompter: {
      confirm: () => Promise.reject(new Error('no prompts in unit tests')),
      choice: () => Promise.reject(new Error('no prompts in unit tests')),
      input: () => Promise.reject(new Error('no prompts in unit tests')),
    },
    runtime: {
      ci: false,
      ciProvider: undefined,
      authMode: 'token',
      credentialLabel: 'API key',
      credentialsConfigured: false,
    },
  };
}

describe('inspectStatus', () => {
  it('returns correct assignment count from config when scanContent: true', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);
    const report = await inspectStatus(ctx, { scanContent: true });

    // 1 assignment in the fixture config
    expect(report.assignments).toHaveLength(1);
    // No publish history → assignment is "unknown"
    expect(report.summary.unknown).toBe(1);
  });

  it('does NOT call scanLocalContent on the human path (scanContent omitted)', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);
    const spy = vi.spyOn(localScan, 'scanLocalContent');

    const report = await inspectStatus(ctx); // no scanContent option → human path

    expect(spy).not.toHaveBeenCalled();
    expect(report.assignments).toHaveLength(0);
    spy.mockRestore();
  });

  it('DOES call scanLocalContent when scanContent: true (json path)', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);
    const spy = vi.spyOn(localScan, 'scanLocalContent');

    await inspectStatus(ctx, { scanContent: true });

    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('returns correct auth mode from context runtime', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);
    ctx.runtime.authMode = 'oauth';
    ctx.runtime.credentialsConfigured = true;

    const report = await inspectStatus(ctx);

    expect(report.auth).toEqual({ mode: 'oauth', configured: true });
  });

  it('emits ZERO events — rendering is the caller\'s responsibility', async () => {
    const config = makeFixtureConfig();
    const sink = new CollectingEventSink();
    const ctx = makeContext(config, sink);

    await inspectStatus(ctx);

    // Flush to a plain array to count emitted events
    const emitted: unknown[] = [];
    sink.flushTo({ emit: (e) => { emitted.push(e); } });
    expect(emitted).toHaveLength(0);
  });

  it('includes the correct course from config', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);

    const report = await inspectStatus(ctx);

    expect(report.course).toEqual({ org_id: 'org-1', course_id: 'crs-42' });
  });

  it('schema_version is 1 and scope is content', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);

    const report = await inspectStatus(ctx);

    expect(report.schema_version).toBe(1);
    expect(report.scope).toBe('content');
  });

  it('last_push is null when publish_history is empty', async () => {
    const config = makeFixtureConfig();
    const ctx = makeContext(config);

    const report = await inspectStatus(ctx);

    expect(report.last_push).toBeNull();
  });

  it('last_push uses publish_history[0] (the scanner/publisher baseline)', async () => {
    const config = makeFixtureConfig();
    config.publish_history = [
      {
        timestamp: '2026-06-01T00:00:00Z',
        commit_sha: 'abc',
        published_by: 'user',
        status: 'success',
        content_state: {},
      },
    ];
    const ctx = makeContext(config);

    const report = await inspectStatus(ctx);

    expect(report.last_push?.commit_sha).toBe('abc');
  });
});
