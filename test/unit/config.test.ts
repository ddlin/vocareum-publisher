import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, updateConfig } from '../../src/core/config';

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
});
