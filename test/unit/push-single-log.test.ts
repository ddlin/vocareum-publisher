import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('push failure reporting (AGENTS.md #14)', () => {
  it('publish.ts throws CommandFailureError, never a plain Error', () => {
    const source = readFileSync('src/commands/publish.ts', 'utf8');
    expect(source.includes("throw new Error('Push completed with errors')")).toBe(false);
    expect(source.includes("new CommandFailureError('Push completed with errors'")).toBe(true);
  });

  it('the push action no longer prefixes a second "Unhandled error" line', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    expect(source.includes('Unhandled error:')).toBe(false);
  });
});
