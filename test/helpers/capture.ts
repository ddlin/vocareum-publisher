import { vi } from 'vitest';

/** Run something with stdout captured; returns everything written to stdout. */
export async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    chunks.push(String(s)); return true;
  });
  try { await run(); } finally { spy.mockRestore(); }
  return chunks.join('');
}

/** Parse the documents a --json run wrote to stdout. */
export function documents(raw: string): Array<Record<string, unknown>> {
  return raw.split('\n').filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
