/**
 * Mapper Module
 *
 * Map template parts to configuration parts using sequence numbers.
 *
 * CRITICAL: seqnum is a STRING that must be parsed for sorting!
 */

import type { Part } from '../types/config';
import type { PartMapping } from '../types/state';

/**
 * Error thrown when part mapping fails
 */
export class PartMappingError extends Error {
  constructor(
    message: string,
    public expectedCount: number,
    public actualCount: number
  ) {
    super(message);
    this.name = 'PartMappingError';
  }
}

/**
 * Map configuration parts to API parts by seqnum order
 *
 * Config parts are mapped by array position (index 0, 1, 2...)
 * API parts are sorted by seqnum ("0", "1", "2"... parsed to numbers)
 *
 * CRITICAL: seqnum is a string like "0", "1", "2" - must parseInt for sorting!
 *
 * @param configParts - Parts from configuration (array order matters)
 * @param apiParts - Parts from Vocareum API (with seqnum)
 * @returns Array of part mappings
 * @throws PartMappingError if part counts don't match
 *
 * @example
 * // Config defines parts by array position
 * const configParts = [
 *   { path: "part1" },  // index 0
 *   { path: "part2" }   // index 1
 * ];
 *
 * // API returns parts possibly out of order
 * const apiParts = [
 *   { part_id: "222", seqnum: "1" },
 *   { part_id: "111", seqnum: "0" }
 * ];
 *
 * // Result: part1 -> 111 (seqnum 0), part2 -> 222 (seqnum 1)
 */
export function mapParts(
  configParts: Part[],
  apiParts: Array<{ id: string; seqnum: string }>
): PartMapping[] {
  if (configParts.length !== apiParts.length) {
    throw new PartMappingError(
      `Part count mismatch: config has ${configParts.length} parts, ` +
      `template has ${apiParts.length} parts`,
      configParts.length,
      apiParts.length
    );
  }

  // Sort API parts by seqnum (MUST parse string to number!)
  const sortedApiParts = [...apiParts].sort(
    (a, b) => parseInt(a.seqnum, 10) - parseInt(b.seqnum, 10)
  );

  // Map config parts (by array position) to API parts (by seqnum order)
  return configParts.map((configPart, index) => ({
    configPart,
    apiPartId: sortedApiParts[index].id,
    seqnum: sortedApiParts[index].seqnum,
  }));
}
