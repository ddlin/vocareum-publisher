/**
 * Fan one event stream out to several sinks.
 *
 * Lives in utils/, not core/services/, because its practical use is pairing a
 * CollectingEventSink (for the JSON report) with a LoggerEventSink (for stderr),
 * and services may not import the logger.
 */
import type { EventSink, ServiceEvent } from '../core/services/event-sink';

export class TeeEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  emit(event: ServiceEvent): void {
    for (const sink of this.sinks) {
      // One sink failing must not cost the others their event: losing the
      // captured report because a renderer threw would be the worse outcome.
      try {
        sink.emit(event);
      } catch {
        // Intentionally swallowed - there is nowhere safe to report this.
      }
    }
  }
}
