import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, updateConfig, withConfigLock, ConfigError, validateConfig } from '../../src/core/config';
import { AssignmentSettingsSchema, PartSettingsSchema } from '../../src/types/config';

describe('updateConfig stale assignment actions', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-config-test-'));
    configPath = path.join(tempDir, 'vocareum.yaml');

    const yaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
  template_assignment_id: "tmpl-1"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    create_from_template: false
    parts:
      - part_id: "part-1"
        path: "part1"
  - assignment_id: "asn-2"
    name: "Lab 2"
    path: "lab2"
    create_from_template: false
    parts:
      - part_id: "part-2"
        path: "part1"
`;

    await fs.writeFile(configPath, yaml, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should reset assignment and part IDs for selected paths', async () => {
    await updateConfig(configPath, {
      reset_assignment_ids: ['lab1'],
    });

    const updated = await loadConfig(configPath);
    const resetAssignment = updated.assignments.find((a) => a.path === 'lab1');
    const untouchedAssignment = updated.assignments.find((a) => a.path === 'lab2');

    expect(resetAssignment?.assignment_id).toBeNull();
    expect(resetAssignment?.create_from_template).toBe(true);
    expect(resetAssignment?.parts[0].part_id).toBeNull();
    expect(untouchedAssignment?.assignment_id).toBe('asn-2');
    expect(untouchedAssignment?.parts[0].part_id).toBe('part-2');
  });

  it('should remove assignments for selected paths', async () => {
    await updateConfig(configPath, {
      remove_assignments: ['lab2'],
    });

    const updated = await loadConfig(configPath);

    expect(updated.assignments).toHaveLength(1);
    expect(updated.assignments[0].path).toBe('lab1');
  });

  it('should persist template_assignment_id when adding new assignment', async () => {
    await updateConfig(configPath, {
      assignments: [{
        path: 'lab-new',
        name: 'New Lab',
        assignment_id: null,
        create_from_template: true,
        template_assignment_id: 'tmpl-specific',
        parts: [{ path: 'part1', part_id: null }],
      }],
    });

    const updated = await loadConfig(configPath);
    const newAssignment = updated.assignments.find((a) => a.path === 'lab-new');

    expect(newAssignment).toBeDefined();
    expect(newAssignment?.template_assignment_id).toBe('tmpl-specific');
    expect(newAssignment?.create_from_template).toBe(true);
  });

  it('should parse multiple template IDs and assignment-level template override', async () => {
    const yaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
  template_assignment_id: "tmpl-default"
  template_assignment_ids:
    - "tmpl-default"
    - "tmpl-alt"
assignments:
  - assignment_id: null
    name: "Lab 3"
    path: "lab3"
    create_from_template: true
    template_assignment_id: "tmpl-alt"
    parts:
      - part_id: null
        path: "part1"
`;
    await fs.writeFile(configPath, yaml, 'utf8');

    const loaded = await loadConfig(configPath);

    expect(loaded.vocareum.template_assignment_ids).toEqual(['tmpl-default', 'tmpl-alt']);
    expect(loaded.assignments[0].template_assignment_id).toBe('tmpl-alt');
  });

  it('should accept numeric tag values returned by Vocareum', async () => {
    const yaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    create_from_template: false
    parts:
      - part_id: "part-1"
        path: "part1"
        settings:
          tags:
            average_lab_time: 240
`;
    await fs.writeFile(configPath, yaml, 'utf8');

    const loaded = await loadConfig(configPath);

    expect(loaded.assignments[0].parts[0].settings?.tags).toEqual({
      average_lab_time: 240,
    });
  });
});

describe('atomic config writes and locking', () => {
  let tempDir: string;
  let configPath: string;

  const baseYaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    parts:
      - part_id: "part-1"
        path: "part1"
`;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-config-lock-test-'));
    configPath = path.join(tempDir, 'vocareum.yaml');
    await fs.writeFile(configPath, baseYaml, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('updateConfig leaves no temp file behind after a successful write', async () => {
    await updateConfig(configPath, { excluded_assignments: ['x-1'] });

    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(['vocareum.yaml']);

    const updated = await loadConfig(configPath);
    expect(updated.vocareum.excluded_assignments).toContain('x-1');
  });

  it('withConfigLock runs the function and removes the lock afterwards', async () => {
    const result = await withConfigLock(configPath, async () => 'done');

    expect(result).toBe('done');
    const entries = await fs.readdir(tempDir);
    expect(entries).not.toContain('vocareum.yaml.lock');
  });

  it('withConfigLock removes the lock even when the function throws', async () => {
    await expect(
      withConfigLock(configPath, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const entries = await fs.readdir(tempDir);
    expect(entries).not.toContain('vocareum.yaml.lock');
  });

  it('withConfigLock fails fast when another run holds a fresh lock', async () => {
    await fs.writeFile(`${configPath}.lock`, JSON.stringify({ pid: 99999 }), 'utf8');

    await expect(withConfigLock(configPath, async () => 'x')).rejects.toThrow(ConfigError);
    await expect(withConfigLock(configPath, async () => 'x')).rejects.toThrow(/another vocgit/i);
  });

  it('withConfigLock does not steal an old lock that may still belong to a live run', async () => {
    const lockPath = `${configPath}.lock`;
    await fs.writeFile(lockPath, JSON.stringify({ pid: 99999 }), 'utf8');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(lockPath, past, past);

    await expect(withConfigLock(configPath, async () => 'recovered')).rejects.toThrow(ConfigError);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain('99999');
  });

  it('withConfigLock does not remove a replacement lock it does not own', async () => {
    const lockPath = `${configPath}.lock`;
    const replacement = JSON.stringify({ token: 'replacement-owner' });

    await withConfigLock(configPath, async () => {
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, replacement, { flag: 'wx' });
    });

    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(replacement);
  });
});

describe('loadConfig returns schema-parsed data', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voc-config-parse-test-'));
    configPath = path.join(tempDir, 'vocareum.yaml');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('applies schema transforms (lowercase exam_mode normalized to uppercase)', async () => {
    const yaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    settings:
      exam_mode: timed
      grading_visibility: all
    parts:
      - part_id: "part-1"
        path: "part1"
`;
    await fs.writeFile(configPath, yaml, 'utf8');

    const loaded = await loadConfig(configPath);

    expect(loaded.assignments[0].settings?.exam_mode).toBe('TIMED');
    expect(loaded.assignments[0].settings?.grading_visibility).toBe('ALL');
  });

  it('applies schema defaults for omitted fields', async () => {
    const yaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    parts:
      - part_id: "part-1"
        path: "part1"
`;
    await fs.writeFile(configPath, yaml, 'utf8');

    const loaded = await loadConfig(configPath);

    expect(loaded.vocareum.api_base_url).toBe('https://api.vocareum.com');
    expect(loaded.vocareum.excluded_assignments).toEqual([]);
    expect(loaded.publish_history).toEqual([]);
    expect(loaded.assignments[0].create_from_template).toBe(false);
  });

  it('coerces string databricks_maxusers to number', async () => {
    const yaml = `version: "1.0"
vocareum:
  org_id: "1"
  course_id: "201303"
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    parts:
      - part_id: "part-1"
        path: "part1"
        settings:
          databricks_maxusers: "25"
`;
    await fs.writeFile(configPath, yaml, 'utf8');

    const loaded = await loadConfig(configPath);

    expect(loaded.assignments[0].parts[0].settings?.databricks_maxusers).toBe(25);
  });

  it('preserves unknown keys so updateConfig does not strip user data', async () => {
    const yaml = `version: "1.0"
custom_top_level: keep-me
vocareum:
  org_id: "1"
  course_id: "201303"
  custom_vendor_field: vendor-value
assignments:
  - assignment_id: "asn-1"
    name: "Lab 1"
    path: "lab1"
    custom_assignment_note: note
    parts:
      - part_id: "part-1"
        path: "part1"
        custom_part_note: pnote
`;
    await fs.writeFile(configPath, yaml, 'utf8');

    const loaded = await loadConfig(configPath) as Record<string, unknown>;

    expect(loaded.custom_top_level).toBe('keep-me');
    expect((loaded.vocareum as Record<string, unknown>).custom_vendor_field).toBe('vendor-value');
    expect((loaded.assignments as Record<string, unknown>[])[0].custom_assignment_note).toBe('note');
    expect(((loaded.assignments as { parts: Record<string, unknown>[] }[])[0].parts)[0].custom_part_note).toBe('pnote');
  });
});

describe('_unknown_settings preservation in Zod schemas', () => {
  it('AssignmentSettingsSchema preserves _unknown_settings through parse', () => {
    const input = {
      nosubmit: true,
      _unknown_settings: { vendor_field: 'abc', new_flag: 42 },
    };
    const parsed = AssignmentSettingsSchema.parse(input);
    expect(parsed?._unknown_settings).toEqual({ vendor_field: 'abc', new_flag: 42 });
  });

  it('PartSettingsSchema preserves _unknown_settings through parse', () => {
    const input = {
      session_length: '60',
      _unknown_settings: { lab_extra: { nested: true }, arr: [1, 2, 3] },
    };
    const parsed = PartSettingsSchema.parse(input);
    expect(parsed?._unknown_settings).toEqual({
      lab_extra: { nested: true },
      arr: [1, 2, 3],
    });
  });

  it('AssignmentSettingsSchema accepts settings without _unknown_settings', () => {
    const parsed = AssignmentSettingsSchema.parse({ nosubmit: true });
    expect(parsed?._unknown_settings).toBeUndefined();
  });

  it('PartSettingsSchema accepts settings without _unknown_settings', () => {
    const parsed = PartSettingsSchema.parse({ session_length: '60' });
    expect(parsed?._unknown_settings).toBeUndefined();
  });
});

describe('_observed_settings preservation in Zod schemas', () => {
  it('AssignmentSettingsSchema preserves _observed_settings through parse', () => {
    const input = {
      nosubmit: true,
      _observed_settings: { description: 'Remote only', exam_duration: 45 },
    };
    const parsed = AssignmentSettingsSchema.parse(input);
    expect(parsed?._observed_settings).toEqual({
      description: 'Remote only',
      exam_duration: 45,
    });
  });

  it('PartSettingsSchema preserves _observed_settings through parse', () => {
    const input = {
      session_length: '60',
      _observed_settings: { deadlinedate: '2026-12-31T23:59:00Z' },
    };
    const parsed = PartSettingsSchema.parse(input);
    expect(parsed?._observed_settings).toEqual({
      deadlinedate: '2026-12-31T23:59:00Z',
    });
  });
});

describe('throttle config validation', () => {
  const base = {
    version: '1.0',
    vocareum: { org_id: 'o1', course_id: 'c1' },
    assignments: [],
  };
  const withThrottle = (throttle: unknown) => ({
    ...base,
    vocareum: { ...base.vocareum, throttle },
  });

  it('accepts a valid throttle block', () => {
    const r = validateConfig(withThrottle({ max_concurrency: 2, min_interval_ms: 500, jitter: false }));
    expect(r.valid).toBe(true);
  });

  it('accepts absent throttle (uses defaults later)', () => {
    expect(validateConfig(base).valid).toBe(true);
  });

  it('rejects a string number for max_concurrency', () => {
    expect(validateConfig(withThrottle({ max_concurrency: '2' })).valid).toBe(false);
  });

  it('rejects negative min_interval_ms', () => {
    expect(validateConfig(withThrottle({ min_interval_ms: -100 })).valid).toBe(false);
  });

  it('rejects max_concurrency above 5', () => {
    expect(validateConfig(withThrottle({ max_concurrency: 10000 })).valid).toBe(false);
  });

  it('rejects non-integer max_concurrency', () => {
    expect(validateConfig(withThrottle({ max_concurrency: 1.5 })).valid).toBe(false);
  });

  it('rejects min_interval_ms above 60000', () => {
    expect(validateConfig(withThrottle({ min_interval_ms: 60001 })).valid).toBe(false);
  });

  it('rejects wrong type for jitter', () => {
    expect(validateConfig(withThrottle({ jitter: 'yes' })).valid).toBe(false);
  });

  it('rejects unknown keys inside throttle (strict)', () => {
    expect(validateConfig(withThrottle({ maxConcurrency: 1 })).valid).toBe(false);
  });

  it('rejects an array for throttle', () => {
    expect(validateConfig(withThrottle([])).valid).toBe(false);
  });

  it('rejects throttle nested in itself', () => {
    expect(validateConfig(withThrottle({ throttle: { max_concurrency: 1 } })).valid).toBe(false);
  });
});
