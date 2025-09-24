import { EventEmitter } from 'node:events';
import logger from './logger.js';
import metrics, { type MetricsRegistry } from './metrics/index.js';
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
  metrics?: MetricsRegistry;
}

interface InternalSuppressionRule {
  id: string;
  detectors?: string[];
  sources?: string[];
  severities?: EventSeverity[];
  channels?: string[];
  suppressForMs?: number;
  rateLimit?: RateLimitConfig;
  reason: string;
  suppressedUntil: number;
  history: number[];
}

type SuppressionHitType = 'window' | 'rate-limit';

interface SuppressionHit {
  rule: InternalSuppressionRule;
  type: SuppressionHitType;
  reason: string;
}

class EventBus extends EventEmitter {
  private suppressionRules: InternalSuppressionRule[] = [];
  private readonly store: (event: EventRecord) => void;
  private readonly log: typeof logger;
  private readonly metrics: MetricsRegistry;

  constructor(dependencies: EventBusDependencies = { store: storeEvent, log: logger }) {
    super();
    this.store = dependencies.store;
    this.log = dependencies.log;
    this.metrics = dependencies.metrics ?? metrics;

    this.on(EVENT_CHANNEL, event => {
      this.store(event);
      this.metrics.recordEvent(event);
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
    this.resetSuppressionState();
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

    const evaluation = this.evaluateSuppression(normalized);

    if (evaluation.suppressed) {
      const primary = evaluation.hits[0];
      const meta = {
        ...normalized.meta,
        suppressed: true,
        suppressionReason: primary?.reason,
        suppressionType: primary?.type,
        suppressionRuleId: primary?.rule.id,
        suppressedBy: evaluation.hits.map(hit => ({
          ruleId: hit.rule.id,
          reason: hit.reason,
          type: hit.type,
          suppressForMs: hit.rule.suppressForMs,
          rateLimit: hit.rule.rateLimit
        }))
      };
      for (const hit of evaluation.hits) {
        this.metrics.recordSuppressedEvent(hit.rule.id, hit.reason);
      }
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

    for (const rule of evaluation.matchedRules) {
      if (rule.suppressForMs && !rule.rateLimit) {
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
    const hits: SuppressionHit[] = [];
    const matchedRules: InternalSuppressionRule[] = [];

    for (const rule of this.suppressionRules) {
      if (!ruleMatchesEvent(rule, event)) {
        continue;
      }

      matchedRules.push(rule);

      if (rule.suppressForMs && event.ts < rule.suppressedUntil) {
        hits.push({ rule, type: 'window', reason: rule.reason });
        continue;
      }

      if (rule.rateLimit) {
        pruneHistory(rule, event.ts);
        if (rule.history.length >= rule.rateLimit.count) {
          hits.push({ rule, type: 'rate-limit', reason: rule.reason });
          if (rule.suppressForMs) {
            rule.suppressedUntil = Math.max(rule.suppressedUntil, event.ts + rule.suppressForMs);
          }
          rule.history.push(event.ts);
        }
      }
    }

    if (hits.length > 0) {
      return {
        suppressed: true,
        hits,
        matchedRules: []
      } as const;
    }

    return {
      suppressed: false,
      hits,
      matchedRules
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
    id: rule.id,
    detectors: asArray(rule.detector),
    sources: asArray(rule.source),
    severities: asArray(rule.severity),
    channels: asArray(rule.channel),
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

  if (rule.channels) {
    const eventChannels = extractEventChannels(event.meta);
    if (eventChannels.length === 0) {
      return false;
    }

    if (!eventChannels.some(channel => rule.channels?.includes(channel))) {
      return false;
    }
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

function extractEventChannels(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) {
    return [];
  }

  const candidate = meta.channel;

  if (typeof candidate === 'string') {
    return [candidate];
  }

  if (Array.isArray(candidate)) {
    return candidate.filter((value): value is string => typeof value === 'string');
  }

  return [];
}
