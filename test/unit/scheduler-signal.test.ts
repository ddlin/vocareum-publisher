import { describe, it, expect } from 'vitest';
import { RequestScheduler } from '../../src/api/scheduler';

/** Deterministic scheduler: no spacing, injected clock/timers/RNG. */
function make(maxConcurrency: number, random: () => number = () => 0.5): RequestScheduler {
  return new RequestScheduler({
    maxConcurrency,
    minIntervalMs: 0,
    jitter: false,
    now: () => 0,
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    random,
  });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function held(): { task: () => Promise<void>; finish: () => void } {
  let finish!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  return { task: () => gate, finish };
}

describe('RequestScheduler signal', () => {
  it('S7a: abort while queued removes the waiter, keeps activeCount, and the next waiter runs', async () => {
    const s = make(1);
    const h = held();
    const p1 = s.schedule(h.task);
    await tick();
    const ac = new AbortController();
    const reason = new Error('deadline');
    const p2 = s.schedule(async () => 'never', ac.signal);
    const p2Result = p2.then(() => 'resolved', (e: unknown) => e);
    let ran3 = false;
    const p3 = s.schedule(async () => { ran3 = true; return 'three'; });
    await tick();
    ac.abort(reason);
    expect(await p2Result).toBe(reason);
    const internals = s as unknown as { activeCount: number; queue: unknown[] };
    expect(internals.activeCount).toBe(1);
    expect(internals.queue).toHaveLength(1);
    expect(ran3).toBe(false);
    h.finish();
    await p1;
    expect(await p3).toBe('three');
    expect(internals.activeCount).toBe(0);
    expect(internals.queue).toHaveLength(0);
  });

  it('S7e: an already-aborted signal rejects without enqueueing; the next waiter runs', async () => {
    const s = make(1);
    const h = held();
    const p1 = s.schedule(h.task);
    await tick();
    const ac = new AbortController();
    const reason = new Error('already');
    ac.abort(reason);
    const internals = s as unknown as { activeCount: number; queue: unknown[] };
    const p2 = s.schedule(async () => 'never', ac.signal);
    await expect(p2).rejects.toBe(reason);
    expect(internals.queue).toHaveLength(0);
    expect(internals.activeCount).toBe(1);
    const p3 = s.schedule(async () => 'next');
    h.finish();
    await p1;
    expect(await p3).toBe('next');
    expect(internals.activeCount).toBe(0);
  });

  it('S7e: abort at the head of the queue (concurrency 1) lets the next waiter run', async () => {
    const s = make(1);
    const h = held();
    const p1 = s.schedule(h.task);
    await tick();
    const ac = new AbortController();
    const head = s.schedule(async () => 'never', ac.signal).catch((e: unknown) => e);
    const p3 = s.schedule(async () => 'next');
    await tick();
    ac.abort(new Error('head'));
    await head;
    h.finish();
    await p1;
    expect(await p3).toBe('next');
  });

  it('never exceeds the cap and never underflows across 50 seeded random aborts', async () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const cap = 3;
    const s = make(cap, random);
    const internals = s as unknown as { activeCount: number };
    let running = 0;
    let maxRunning = 0;
    const finishers: Array<() => void> = [];
    const results: Array<Promise<unknown>> = [];
    const controllers: AbortController[] = [];
    for (let i = 0; i < 50; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      results.push(
        s.schedule(() => new Promise<void>((res) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          finishers.push(() => { running--; res(); });
        }), ac.signal).catch(() => 'aborted'),
      );
    }
    await tick();
    for (const ac of controllers) {
      if (random() < 0.5) { ac.abort(new Error('x')); }
      expect(internals.activeCount).toBeGreaterThanOrEqual(0);
      expect(internals.activeCount).toBeLessThanOrEqual(cap);
    }
    // Drain: finish whatever is running until all settle.
    for (let i = 0; i < 200 && finishers.length > 0; i++) {
      finishers.shift()!();
      await tick();
      expect(internals.activeCount).toBeGreaterThanOrEqual(0);
    }
    await Promise.all(results);
    expect(maxRunning).toBeLessThanOrEqual(cap);
    expect(internals.activeCount).toBe(0);
  });

  it('without a signal behaves as before', async () => {
    const s = make(1);
    expect(await s.schedule(async () => 7)).toBe(7);
  });
});
