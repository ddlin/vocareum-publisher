import { describe, it, expect } from 'vitest';
import { VocareumClient } from '../../src/api/client';
import { TokenAuthProvider } from '../../src/api/auth/token-auth-provider';
import { RequestScheduler } from '../../src/api/scheduler';

describe('VocareumClient scheduler injection', () => {
  it('uses an injected scheduler if provided', () => {
    const authProvider = new TokenAuthProvider('test-token', 'https://api.vocareum.com');
    const sharedScheduler = new RequestScheduler({
      maxConcurrency: 2,
      minIntervalMs: 100,
      jitter: false,
    });

    const client = new VocareumClient(authProvider, undefined, sharedScheduler);

    expect((client as any).scheduler).toBe(sharedScheduler);
  });

  it('constructs a default scheduler if not provided', () => {
    const authProvider = new TokenAuthProvider('test-token', 'https://api.vocareum.com');
    const throttle = {
      maxConcurrency: 1,
      minIntervalMs: 300,
      jitter: true,
    };

    const client = new VocareumClient(authProvider, throttle);

    const scheduler = (client as any).scheduler;
    expect(scheduler).toBeInstanceOf(RequestScheduler);
    expect((scheduler as any).maxConcurrency).toBe(1);
    expect((scheduler as any).minIntervalMs).toBe(300);
    expect((scheduler as any).jitter).toBe(true);
  });
});
