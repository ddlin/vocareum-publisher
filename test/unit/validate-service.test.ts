// test/unit/validate-service.test.ts
//
// Unit tests for validateWorkspace (offline validate service).

import { describe, it, expect, vi } from 'vitest';

// Mock logger so LoggerEventSink (used as default in validator.ts) doesn't blow up
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    plain: vi.fn(),
    newline: vi.fn(),
  },
}));

import { validateWorkspace } from '../../src/core/services/validate-service';
import { CollectingEventSink, type ServiceEvent } from '../../src/core/services/event-sink';
import type { ValidateContext } from '../../src/core/services/context';
import type { Config } from '../../src/types/config';
import * as path from 'path';

/** Capturing EventSink that stores emitted events for inspection. */
class CapturingEventSink extends CollectingEventSink {
  readonly captured: ServiceEvent[] = [];
  emit(event: ServiceEvent): void {
    this.captured.push(event);
    super.emit(event);
  }
}

/** Build a minimal ValidateContext around a given config + workspaceRoot */
function makeCtx(config: Config, workspaceRoot: string): ValidateContext & { sink: CapturingEventSink } {
  const sink = new CapturingEventSink();
  return {
    persistedConfig: config,
    effectiveConfig: config,
    configPath: path.join(workspaceRoot, 'vocareum.yaml'),
    workspaceRoot,
    events: sink,
    prompter: {
      confirm: vi.fn(),
      choice: vi.fn(),
      input: vi.fn(),
    },
    sink,
  };
}

/** Minimal valid config referring to a path that doesn't exist at projectRoot */
const missingFolderConfig: Config = {
  version: '1.0',
  vocareum: {
    org_id: 'org1',
    course_id: 'course1',
    template_assignment_id: '',
  },
  assignments: [
    {
      assignment_id: 'a1',
      name: 'Ghost Assignment',
      path: 'nonexistent-assignment-zzz',
      parts: [
        {
          part_id: 'p1',
          path: 'part1',
          name: 'Part 1',
        },
      ],
    },
  ],
  publish_options: {
    on_missing_id: 'skip',
    auto_commit: false,
  },
  publish_history: [],
};

const FIXTURE_ROOT = path.resolve('test/fixtures/sample-course');
const FIXTURE_CONFIG_PATH = path.join(FIXTURE_ROOT, 'vocareum.yaml');

describe('validateWorkspace', () => {
  it('returns errors listing missing_folder for a non-existent assignment path', async () => {
    // Use the project root as the workspace — "nonexistent-assignment-zzz" won't exist there.
    const ctx = makeCtx(missingFolderConfig, path.resolve(process.cwd()));

    const report = await validateWorkspace(ctx);

    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors.some(e => e.includes('missing_folder'))).toBe(true);
    expect(report.errors.some(e => e.includes('nonexistent-assignment-zzz'))).toBe(true);
  });

  it('returns empty errors and warnings for the clean sample-course fixture', async () => {
    const { loadConfig } = await import('../../src/core/config');
    const config = await loadConfig(FIXTURE_CONFIG_PATH);
    const ctx = makeCtx(config, FIXTURE_ROOT);

    const report = await validateWorkspace(ctx);

    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it('emits info and success events for a clean run', async () => {
    const { loadConfig } = await import('../../src/core/config');
    const config = await loadConfig(FIXTURE_CONFIG_PATH);
    const ctx = makeCtx(config, FIXTURE_ROOT);

    await validateWorkspace(ctx);

    const { captured } = ctx.sink;
    expect(captured.some(e => e.level === 'info' && e.message?.includes('Validating file structure'))).toBe(true);
    expect(captured.some(e => e.level === 'success' && e.message?.includes('valid'))).toBe(true);
  });
});
