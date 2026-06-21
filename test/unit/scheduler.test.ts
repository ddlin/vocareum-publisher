import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestScheduler } from '../../src/api/scheduler';

afterEach(() => { vi.useRealTimers(); });

describe('RequestScheduler', () => {
  it('runs the first task immediately and spaces the next by minIntervalMs (concurrency 1)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 1000, jitter: false });
    const order: number[] = [];
    const p1 = s.schedule(async () => { order.push(1); });
    const p2 = s.schedule(async () => { order.push(2); });
    await p1;
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it('runs queued tasks in strict FIFO order (concurrency 1)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 100, jitter: false });
    const order: string[] = [];
    const ps = ['A', 'B', 'C'].map((n) => s.schedule(async () => { order.push(n); }));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(ps);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('fires a spacing-blocked task via timer even with nothing else in flight', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 500, jitter: false });
    const order: string[] = [];
    await s.schedule(async () => { order.push('first'); });
    const p = s.schedule(async () => { order.push('second'); });
    expect(order).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(order).toEqual(['first', 'second']);
  });

  it('does not delay when minIntervalMs is 0', async () => {
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => s.schedule(async () => { order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it('caps in-flight tasks at maxConcurrency', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 3, minIntervalMs: 0, jitter: false });
    let started = 0;
    const release: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      void s.schedule(() => new Promise<void>((res) => { started++; release.push(res); }));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(3);
    release[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(4);
    release.forEach((r) => r());
  });

  it('applies jitter at the low edge (random=0 -> -40%)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 1000, jitter: true, random: () => 0 });
    const order: string[] = [];
    await s.schedule(async () => { order.push('a'); });
    const p = s.schedule(async () => { order.push('b'); });
    await vi.advanceTimersByTimeAsync(599);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['a', 'b']);
  });

  it('applies jitter at the high edge (random=1 -> +40%)', async () => {
    vi.useFakeTimers();
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 1000, jitter: true, random: () => 1 });
    const order: string[] = [];
    await s.schedule(async () => { order.push('a'); });
    const p = s.schedule(async () => { order.push('b'); });
    await vi.advanceTimersByTimeAsync(1399);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(order).toEqual(['a', 'b']);
  });

  it('releases the slot even when a task throws', async () => {
    const s = new RequestScheduler({ maxConcurrency: 1, minIntervalMs: 0, jitter: false });
    await expect(s.schedule(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const ran = await s.schedule(async () => 'ok');
    expect(ran).toBe('ok');
  });
});
