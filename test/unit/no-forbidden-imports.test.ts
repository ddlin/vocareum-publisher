import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => {
  const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
describe('architecture guards', () => {
  it('no process.exit outside src/index.ts', () => {
    expect(walk('src').filter((f) => f !== 'src/index.ts' && /process\.exit\s*\(/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
  it('src/core/services/ imports no logger/loadConfig/withConfigLock and constructs no client', () => {
    expect(walk('src/core/services').filter((f) => {
      const s = readFileSync(f, 'utf8');
      return /utils\/logger/.test(s) || /\bloadConfig\b/.test(s) || /\bwithConfigLock\b/.test(s) || /new VocareumClient\(/.test(s);
    })).toEqual([]);
  });
});
