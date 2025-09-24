import { EventEmitter } from 'node:events';
import logger from './logger.js';
import { storeEvent } from './db.js';
import { EventPayload, EventRecord } from './types.js';

const EVENT_CHANNEL = 'event';

class EventBus extends EventEmitter {
  emitEvent(payload: EventPayload) {
    const normalized: EventRecord = {
      ts: normalizeTimestamp(payload.ts),
      source: payload.source,
      detector: payload.detector,
      severity: payload.severity,
      message: payload.message,
      meta: payload.meta
    };

    this.emit(EVENT_CHANNEL, normalized);
  }
}

function normalizeTimestamp(ts?: number | Date): number {
  if (!ts) {
    return Date.now();
  }

  if (ts instanceof Date) {
    return ts.getTime();
  }

  return ts;
}

const eventBus = new EventBus();

eventBus.on(EVENT_CHANNEL, event => {
  storeEvent(event);
  logger.info(
    {
      detector: event.detector,
      source: event.source,
      severity: event.severity,
      meta: event.meta
    },
    event.message
  );
});

export default eventBus;
export type { EventRecord };
