import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateStructure } from '../../src/core/validator';
import type { Config } from '../../src/types/config';

function makeConfig(assignmentPath: string, partPath = 'part1'): Config {
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
        path: assignmentPath,
        create_from_template: false,
        settings: {},
        parts: [{ part_id: 'part-1', path: partPath, settings: {} }],
      },
    ],
    publish_history: [],
  } as unknown as Config;
}

describe('validateStructure workspace confinement', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voc-validator-')));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('flags an escaping assignment path as invalid_structure, never missing_folder', async () => {
    // '../outside' may well EXIST relative to the workspace — it must still be
    // rejected, and must not become a missing_folder that `vocgit fix` would create.
    const result = await validateStructure(makeConfig('../outside'), tempDir);

    expect(result.valid).toBe(false);
    const errors = result.errors.filter((e) => e.path.includes('outside'));
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.type).toBe('invalid_structure');
      expect(error.message).toMatch(/escapes/);
    }
  });

  it('flags an absolute assignment path as invalid_structure', async () => {
    const result = await validateStructure(makeConfig('/etc'), tempDir);

    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe('invalid_structure');
  });

  it('flags an escaping part path under a valid assignment', async () => {
    await fs.mkdir(path.join(tempDir, 'lab1'), { recursive: true });
    const result = await validateStructure(makeConfig('lab1', '../../outside'), tempDir);

    expect(result.valid).toBe(false);
    const partError = result.errors.find((e) => e.message.includes('escapes'));
    expect(partError).toBeDefined();
    expect(partError?.type).toBe('invalid_structure');
  });

  it('flags a symlinked assignment directory that escapes the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-validator-out-'));
    try {
      await fs.symlink(outside, path.join(tempDir, 'lab-link'));
      const result = await validateStructure(makeConfig('lab-link'), tempDir);

      expect(result.valid).toBe(false);
      expect(result.errors[0].type).toBe('invalid_structure');
      expect(result.errors[0].message).toMatch(/escapes/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('flags a required content directory symlink that escapes the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-validator-out-'));
    try {
      const config = makeConfig('lab1');
      config.assignments[0].parts[0].directories = ['startercode'];
      await fs.mkdir(path.join(tempDir, 'lab1', 'part1'), { recursive: true });
      await fs.symlink(outside, path.join(tempDir, 'lab1', 'part1', 'startercode'));

      const result = await validateStructure(config, tempDir);

      expect(result.valid).toBe(false);
      const directoryError = result.errors.find((e) => e.path.endsWith('startercode'));
      expect(directoryError?.type).toBe('invalid_structure');
      expect(directoryError?.message).toMatch(/escapes/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('flags a default content directory symlink that escapes the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-validator-out-'));
    try {
      const config = makeConfig('lab1');
      await fs.mkdir(path.join(tempDir, 'lab1', 'part1'), { recursive: true });
      await fs.symlink(outside, path.join(tempDir, 'lab1', 'part1', 'startercode'));

      const result = await validateStructure(config, tempDir);

      expect(result.valid).toBe(false);
      const directoryError = result.errors.find((e) => e.path.endsWith('startercode'));
      expect(directoryError?.type).toBe('invalid_structure');
      expect(directoryError?.message).toMatch(/escapes/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('reports a genuinely missing in-workspace path as missing_folder (fixable)', async () => {
    const result = await validateStructure(makeConfig('lab1'), tempDir);

    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe('missing_folder');
  });
});
