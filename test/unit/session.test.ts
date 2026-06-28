import { describe, it, expect, vi } from 'vitest';

const calls: string[] = [];

vi.mock('../../src/core/config', () => ({
  withConfigLock: vi.fn(async (configPath: string, fn: () => Promise<void>) => {
    calls.push('lock');
    try {
      await fn();
    } finally {
      calls.push('unlock');
    }
  }),
  updateConfig: vi.fn(async () => {
    calls.push('update');
  }),
}));

import { withSession } from '../../src/core/session';
import type { LockedSession } from '../../src/core/session';

describe('withSession', () => {
  it('calls lock, update, unlock in order', async () => {
    calls.length = 0;

    await withSession('/path/to/vocareum.yaml', async (session: LockedSession) => {
      await session.applyConfigUpdate({ assignments: [] });
    });

    expect(calls).toEqual(['lock', 'update', 'unlock']);
  });
});
