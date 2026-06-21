import * as path from 'path';
import { promises as fs } from 'fs';

/**
 * True when `targetAbs` is equal to or below `baseAbs` lexically. Inputs are
 * resolved first so `..` segments and absolute target paths are normalized.
 */
export function isLexicallyInside(basePath: string, targetPath: string): boolean {
  const baseAbs = path.resolve(basePath);
  const targetAbs = path.resolve(targetPath);
  return targetAbs === baseAbs || targetAbs.startsWith(baseAbs + path.sep);
}

/**
 * Realpath of the target, or of its deepest existing ancestor when the leaf
 * does not exist yet. This resolves intermediate symlinks before a new file is
 * created below them.
 */
export async function deepestExistingRealpath(targetAbs: string): Promise<string> {
  let current = targetAbs;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

/**
 * True when a target path is lexically inside the base and its deepest existing
 * filesystem ancestor realpaths inside the base. Use for user/API supplied
 * paths before reads, writes, uploads, or deletes.
 */
export async function isPathConfinedToBase(basePath: string, targetPath: string): Promise<boolean> {
  const baseAbs = path.resolve(basePath);
  const targetAbs = path.resolve(targetPath);

  if (!isLexicallyInside(baseAbs, targetAbs)) {
    return false;
  }

  let baseReal: string;
  try {
    baseReal = await fs.realpath(baseAbs);
  } catch {
    return false;
  }

  const targetReal = await deepestExistingRealpath(targetAbs);
  return targetReal === baseReal || targetReal.startsWith(baseReal + path.sep);
}
