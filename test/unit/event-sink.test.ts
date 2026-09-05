import { describe, it, expect, vi } from 'vitest';
const calls: Array<[string, unknown, unknown]> = [];
vi.mock('../../src/utils/logger', () => ({ logger: {
  info: (m: string) => calls.push(['info', m, undefined]),
  success: (m: string) => calls.push(['success', m, undefined]),
  warn: (m: string, meta?: unknown) => calls.push(['warn', m, meta]),
  error: (m: string, meta?: unknown) => calls.push(['error', m, meta]),
  debug: (m: string, meta?: unknown) => calls.push(['debug', m, meta]),
  plain: (m: string) => calls.push(['plain', m, undefined]),
  newline: () => calls.push(['newline', '', undefined]),
} }));
import { CollectingEventSink, type ServiceEvent } from '../../src/core/services/event-sink';
import { LoggerEventSink } from '../../src/utils/logger-event-sink';

describe('event sinks', () => {
  it('forwards data as meta for error/warn/debug (P1 #8)', () => {
    calls.length = 0;
    const s = new LoggerEventSink();
    s.emit({ level: 'error', message: 'boom', data: { file: 'x' } });
    s.emit({ level: 'debug', message: 'dbg', data: { n: 1 } });
    expect(calls).toEqual([['error', 'boom', { file: 'x' }], ['debug', 'dbg', { n: 1 }]]);
  });
  it('CollectingEventSink buffers then replays', () => {
    calls.length = 0; const c = new CollectingEventSink();
    c.emit({ level: 'success', message: 'done' }); c.flushTo(new LoggerEventSink());
    expect(calls).toEqual([['success', 'done', undefined]]);
  });
});

describe('CollectingEventSink.drain', () => {
  it('returns buffered events in emission order', () => {
    const sink = new CollectingEventSink();
    sink.emit({ level: 'warn', code: 'a', message: 'first' });
    sink.emit({ level: 'info', message: 'second' });
    expect(sink.drain().map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('does not expose the internal buffer for mutation', () => {
    const sink = new CollectingEventSink();
    sink.emit({ level: 'warn', message: 'kept' });
    const drained = sink.drain() as ServiceEvent[];
    drained.push({ level: 'info', message: 'injected' });
    expect(sink.drain()).toHaveLength(1);
  });

  it('leaves flushTo working after drain', () => {
    const sink = new CollectingEventSink();
    sink.emit({ level: 'info', message: 'x' });
    sink.drain();
    const seen: string[] = [];
    sink.flushTo({ emit: (e) => { seen.push(e.message ?? ''); } });
    expect(seen).toEqual(['x']);
  });
});
