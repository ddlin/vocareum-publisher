/**
 * Session Module — Locked Session Writer
 *
 * Provides the primary interface for code that needs to acquire a lock and
 * apply configuration updates. The session holds the lock for the duration
 * of the user function and releases it when done.
 */

import { withConfigLock, updateConfig } from './config';
import type { ConfigUpdates } from '../types/config';

/**
 * A session that holds the config lock and can apply updates.
 */
export interface LockedSession {
  /**
   * Apply configuration updates while holding the lock.
   * Delegates to updateConfig, which performs no locking of its own.
   */
  applyConfigUpdate(updates: ConfigUpdates): Promise<void>;
}

/**
 * Acquire a config lock and run an operation within it.
 *
 * @param configPath - Path to vocareum.yaml
 * @param fn - Function to run while holding the lock; receives a LockedSession
 * @returns The return value of fn
 */
export async function withSession<T>(
  configPath: string,
  fn: (session: LockedSession) => Promise<T>
): Promise<T> {
  return withConfigLock(configPath, async () => {
    const session: LockedSession = {
      applyConfigUpdate: (updates: ConfigUpdates) => updateConfig(configPath, updates),
    };
    return fn(session);
  });
}
