/**
 * Deep equality check for plain JSON values (objects, arrays, primitives).
 * Handles key-order differences in objects. No external dependencies, so it
 * is safe to import from anywhere, including src/core/services/*.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) { return true; }
  if (a === null || a === undefined || b === null || b === undefined) { return a === b; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { return false; }
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) { return false; }
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
