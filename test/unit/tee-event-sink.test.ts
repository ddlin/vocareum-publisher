import { describe, it, expect } from 'vitest';
import { TeeEventSink } from '../../src/utils/tee-event-sink';
import { CollectingEventSink } from '../../src/core/services/event-sink';

describe('TeeEventSink', () => {
  it('delivers every event to every sink, in order', () => {
    const a = new CollectingEventSink();
    const b = new CollectingEventSink();
    const tee = new TeeEventSink([a, b]);
    tee.emit({ level: 'warn', message: 'one' });
    tee.emit({ level: 'info', message: 'two' });
    expect(a.drain().map((e) => e.message)).toEqual(['one', 'two']);
    expect(b.drain().map((e) => e.message)).toEqual(['one', 'two']);
  });

  it('still delivers to later sinks when an earlier one throws', () => {
    // The report must not be lost because a rendering sink failed.
    const exploding = { emit: () => { throw new Error('render failed'); } };
    const collecting = new CollectingEventSink();
    const tee = new TeeEventSink([exploding, collecting]);
    expect(() => tee.emit({ level: 'info', message: 'survives' })).not.toThrow();
    expect(collecting.drain()).toHaveLength(1);
  });
});
