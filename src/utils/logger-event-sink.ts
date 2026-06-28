/**
 * Logger Event Sink - rendering adapter for service events
 *
 * Maps ServiceEvent objects to logger method calls, forwarding data as metadata
 * to error/warn/debug methods (P1 #8).
 */

import { logger } from './logger';
import { EventSink, ServiceEvent } from '../core/services/event-sink';

/**
 * Logger event sink that renders events via the logger
 */
export class LoggerEventSink implements EventSink {
  emit(event: ServiceEvent): void {
    const { level, message = '' } = event;

    switch (level) {
      case 'error':
        if (event.data !== undefined) { logger.error(message, event.data); } else { logger.error(message); }
        break;
      case 'warn':
        if (event.data !== undefined) { logger.warn(message, event.data); } else { logger.warn(message); }
        break;
      case 'debug':
        if (event.data !== undefined) { logger.debug(message, event.data); } else { logger.debug(message); }
        break;
      case 'info':
        logger.info(message);
        break;
      case 'success':
        logger.success(message);
        break;
      case 'plain':
        logger.plain(message);
        break;
      case 'newline':
        logger.newline();
        break;
    }
  }
}
