/**
 * Part Mapper Tests
 *
 * Tests for mapping template parts to config parts using seqnum.
 */

import { describe, it, expect } from 'vitest';
import { mapParts, PartMappingError } from '../../src/core/mapper';
import type { Part } from '../../src/types/config';

describe('mapParts', () => {
  it('should map parts by seqnum order', () => {
    const configParts: Part[] = [
      { part_id: null, path: 'part1', name: 'Part 1' },
      { part_id: null, path: 'part2', name: 'Part 2' },
    ];

    // API returns parts possibly out of order
    const apiParts = [
      { id: '222', seqnum: '1' },
      { id: '111', seqnum: '0' },
    ];

    const result = mapParts(configParts, apiParts);

    expect(result).toHaveLength(2);
    // part1 (index 0) should map to seqnum "0" -> part_id "111"
    expect(result[0].apiPartId).toBe('111');
    expect(result[0].seqnum).toBe('0');
    expect(result[0].configPart.path).toBe('part1');
    // part2 (index 1) should map to seqnum "1" -> part_id "222"
    expect(result[1].apiPartId).toBe('222');
    expect(result[1].seqnum).toBe('1');
    expect(result[1].configPart.path).toBe('part2');
  });

  it('should handle parts already in order', () => {
    const configParts: Part[] = [
      { part_id: null, path: 'part1' },
      { part_id: null, path: 'part2' },
      { part_id: null, path: 'part3' },
    ];

    const apiParts = [
      { id: '111', seqnum: '0' },
      { id: '222', seqnum: '1' },
      { id: '333', seqnum: '2' },
    ];

    const result = mapParts(configParts, apiParts);

    expect(result).toHaveLength(3);
    expect(result[0].apiPartId).toBe('111');
    expect(result[1].apiPartId).toBe('222');
    expect(result[2].apiPartId).toBe('333');
  });

  it('should throw on part count mismatch (more in API)', () => {
    const configParts: Part[] = [{ part_id: null, path: 'part1' }];

    const apiParts = [
      { id: '111', seqnum: '0' },
      { id: '222', seqnum: '1' },
    ];

    expect(() => mapParts(configParts, apiParts)).toThrow(PartMappingError);
    expect(() => mapParts(configParts, apiParts)).toThrow(
      'Part count mismatch: config has 1 parts, template has 2 parts'
    );
  });

  it('should throw on part count mismatch (more in config)', () => {
    const configParts: Part[] = [
      { part_id: null, path: 'part1' },
      { part_id: null, path: 'part2' },
      { part_id: null, path: 'part3' },
    ];

    const apiParts = [
      { id: '111', seqnum: '0' },
      { id: '222', seqnum: '1' },
    ];

    expect(() => mapParts(configParts, apiParts)).toThrow(PartMappingError);

    try {
      mapParts(configParts, apiParts);
    } catch (error) {
      expect(error).toBeInstanceOf(PartMappingError);
      expect((error as PartMappingError).expectedCount).toBe(3);
      expect((error as PartMappingError).actualCount).toBe(2);
    }
  });

  it('should handle single part', () => {
    const configParts: Part[] = [{ part_id: null, path: 'part1' }];

    const apiParts = [{ id: '123', seqnum: '0' }];

    const result = mapParts(configParts, apiParts);

    expect(result).toHaveLength(1);
    expect(result[0].apiPartId).toBe('123');
    expect(result[0].seqnum).toBe('0');
  });

  it('should handle empty arrays', () => {
    const configParts: Part[] = [];
    const apiParts: Array<{ id: string; seqnum: string }> = [];

    const result = mapParts(configParts, apiParts);

    expect(result).toHaveLength(0);
  });

  it('should correctly parse seqnum strings as numbers for sorting', () => {
    const configParts: Part[] = Array.from({ length: 11 }, (_, i) => ({
      part_id: null,
      path: `part${i + 1}`,
    }));

    // Create API parts with seqnum 0-10, but in random order
    const apiParts = [
      { id: 'p10', seqnum: '10' },
      { id: 'p1', seqnum: '1' },
      { id: 'p9', seqnum: '9' },
      { id: 'p2', seqnum: '2' },
      { id: 'p0', seqnum: '0' },
      { id: 'p5', seqnum: '5' },
      { id: 'p3', seqnum: '3' },
      { id: 'p7', seqnum: '7' },
      { id: 'p4', seqnum: '4' },
      { id: 'p6', seqnum: '6' },
      { id: 'p8', seqnum: '8' },
    ];

    const result = mapParts(configParts, apiParts);

    // Verify correct numeric ordering (not string ordering where "10" < "2")
    expect(result[0].apiPartId).toBe('p0');
    expect(result[1].apiPartId).toBe('p1');
    expect(result[2].apiPartId).toBe('p2');
    expect(result[9].apiPartId).toBe('p9');
    expect(result[10].apiPartId).toBe('p10');
  });
});
