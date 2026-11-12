/**
 * Event Sink - pure service layer for event handling
 *
 * This module defines the EventSink interface and implementations for buffering
 * and processing service events. No logger imports allowed (kept pure).
 */

/**
 * Service event with level, optional code, message, and metadata
 */
export interface ServiceEvent {
  level: 'error' | 'warn' | 'info' | 'success' | 'debug' | 'plain' | 'newline';
  code?: string;
  message?: string;
  data?: unknown;
}

/**
 * Sink interface for emitting events
 */
export interface EventSink {
  emit(event: ServiceEvent): void;
}

/**
 * Collecting event sink that buffers events and replays them to another sink
 */
export class CollectingEventSink implements EventSink {
  private events: ServiceEvent[] = [];

  emit(event: ServiceEvent): void {
    this.events.push(event);
  }

  /**
   * Read the buffered events without consuming them.
   *
   * Returns a copy: the JSON report holds this array for the lifetime of the
   * command, and a caller mutating it must not corrupt the sink (or a later
   * flushTo, which stays valid after a drain).
   */
  drain(): readonly ServiceEvent[] {
    return [...this.events];
  }

  flushTo(sink: EventSink): void {
    for (const event of this.events) {
      sink.emit(event);
    }
  }
}
