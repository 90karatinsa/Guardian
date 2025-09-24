import { EventEmitter } from 'node:events';
import logger from './logger.js';
import metrics from './metrics/index.js';
import { storeEvent } from './db.js';
import {
  EventPayload,
  EventRecord,
  EventSeverity,
  EventSuppressionRule,
  RateLimitConfig
} from './types.js';

const EVENT_CHANNEL = 'event';

interface EventBusDependencies {
  store: (event: EventRecord) => void;
  log: typeof logger;
}

interface InternalSuppressionRule {
  detectors?: string[];
  sources?: string[];
  severities?: EventSeverity[];
  suppressForMs?: number;
  rateLimit?: RateLimitConfig;
  reason: string;
  suppressedUntil: number;
  history: number[];
}

class EventBus extends EventEmitter {
  private suppressionRules: InternalSuppressionRule[] = [];
  private readonly store: (event: EventRecord) => void;
  private readonly log: typeof logger;

  constructor(dependencies: EventBusDependencies = { store: storeEvent, log: logger }) {
    super();
    this.store = dependencies.store;
    this.log = dependencies.log;

    this.on(EVENT_CHANNEL, event => {
      this.store(event);
      metrics.recordEvent(event);
      this.log.info(
        {
          detector: event.detector,
          source: event.source,
          severity: event.severity,
          meta: event.meta
        },
        event.message
      );
    });
  }

  configureSuppression(rules: EventSuppressionRule[]) {
    this.suppressionRules = rules.map(rule => normalizeSuppressionRule(rule));
  }

  resetSuppressionState() {
    for (const rule of this.suppressionRules) {
      rule.suppressedUntil = 0;
      rule.history = [];
    }
  }

  emitEvent(payload: EventPayload): boolean {
    const normalized: EventRecord = {
      ts: normalizeTimestamp(payload.ts),
      source: payload.source,
      detector: payload.detector,
      severity: payload.severity,
      message: payload.message,
      meta: payload.meta
    };

    const { suppressed, reason, matchedRules, ruleType } = this.evaluateSuppression(normalized);

    if (suppressed) {
      const meta = {
        ...normalized.meta,
        suppressed: true,
        suppressionReason: reason,
        suppressionType: ruleType
      };
      this.log.info(
        {
          detector: normalized.detector,
          source: normalized.source,
          severity: normalized.severity,
          meta
        },
        'Event suppressed'
      );
      return false;
    }

    for (const rule of matchedRules) {
      if (rule.suppressForMs) {
        rule.suppressedUntil = normalized.ts + rule.suppressForMs;
      }

      if (rule.rateLimit) {
        rule.history.push(normalized.ts);
      }
    }

    this.emit(EVENT_CHANNEL, normalized);
    return true;
  }

  private evaluateSuppression(event: EventRecord) {
    const matchedRules = this.suppressionRules.filter(rule => ruleMatchesEvent(rule, event));

    for (const rule of matchedRules) {
      if (rule.suppressForMs && event.ts < rule.suppressedUntil) {
        return {
          suppressed: true,
          reason: rule.reason,
          matchedRules: [],
          ruleType: 'window'
        } as const;
      }

      if (rule.rateLimit) {
        pruneHistory(rule, event.ts);
        if (rule.history.length >= rule.rateLimit.count) {
          return {
            suppressed: true,
            reason: rule.reason,
            matchedRules: [],
            ruleType: 'rate-limit'
          } as const;
        }
      }
    }

    return {
      suppressed: false,
      reason: undefined,
      matchedRules,
      ruleType: undefined
    } as const;
  }
}

function normalizeTimestamp(ts?: number | Date): number {
  if (typeof ts === 'undefined' || ts === null) {
    return Date.now();
  }

  if (ts instanceof Date) {
    return ts.getTime();
  }

  return ts;
}

const eventBus = new EventBus();

export default eventBus;
export { EventBus };
export type { EventRecord };

function normalizeSuppressionRule(rule: EventSuppressionRule): InternalSuppressionRule {
  return {
    detectors: asArray(rule.detector),
    sources: asArray(rule.source),
    severities: asArray(rule.severity),
    suppressForMs: rule.suppressForMs,
    rateLimit: rule.rateLimit,
    reason: rule.reason,
    suppressedUntil: 0,
    history: []
  };
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function ruleMatchesEvent(rule: InternalSuppressionRule, event: EventRecord): boolean {
  if (rule.detectors && !rule.detectors.includes(event.detector)) {
    return false;
  }

  if (rule.sources && !rule.sources.includes(event.source)) {
    return false;
  }

  if (rule.severities && !rule.severities.includes(event.severity)) {
    return false;
  }

  return true;
}

function pruneHistory(rule: InternalSuppressionRule, ts: number) {
  const windowMs = rule.rateLimit?.perMs;
  if (!windowMs) {
    rule.history = [];
    return;
  }

  const cutoff = ts - windowMs;
  let removeCount = 0;
  for (const time of rule.history) {
    if (time > cutoff) {
      break;
    }
    removeCount += 1;
  }
  if (removeCount > 0) {
    rule.history.splice(0, removeCount);
  }
}
