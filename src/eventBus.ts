import { EventEmitter } from 'node:events';
import logger from './logger.js';
import metrics, { type MetricsRegistry, type SuppressedEventMetric } from './metrics/index.js';
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
  maxEvents?: number;
  reason: string;
  timeline: SuppressionTimeline;
  timelines: Map<string, SuppressionTimeline>;
  historyLimit: number;
}

type SuppressionTimeline = {
  suppressedUntil: number;
  history: number[];
};

type SuppressionHitType = 'window' | 'rate-limit';

interface SuppressionHit {
  rule: InternalSuppressionRule;
  type: SuppressionHitType;
  reason: string;
  history: number[];
  windowExpiresAt?: number;
  rateLimit?: RateLimitConfig;
  cooldownMs?: number;
  channel: string | null;
}

type ChannelSuppressionState = {
  hits: number;
  reasons: Set<string>;
  types: Set<SuppressionHitType>;
  windowRemainingMs: number | null;
  maxWindowRemainingMs: number | null;
  cooldownRemainingMs: number | null;
  maxCooldownRemainingMs: number | null;
  historyCount: number;
  combinedHistoryCount: number;
};

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
      resetTimeline(rule.timeline);
      rule.timelines.clear();
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
      const eventChannels = extractEventChannels(normalized.meta);
      const primary = evaluation.hits[0];
      const primaryChannel = primary?.channel ?? eventChannels[0] ?? null;
      const primaryWindowRemainingMs =
        primary && typeof primary.windowExpiresAt === 'number'
          ? Math.max(0, primary.windowExpiresAt - normalized.ts)
          : undefined;
      const primaryCooldownEndsAt =
        primary && typeof primary.cooldownMs === 'number'
          ? normalized.ts + primary.cooldownMs
          : undefined;
      const primaryWindowEndsAt = primary?.windowExpiresAt;
      const primaryCooldownRemainingMs =
        primary && typeof primary.cooldownMs === 'number'
          ? Math.max(
              0,
              typeof primaryWindowRemainingMs === 'number'
                ? Math.min(primary.cooldownMs, primaryWindowRemainingMs)
                : primary.cooldownMs
            )
          : undefined;
      const combinedHistory = mergeSuppressionHistory(evaluation.hits, normalized.ts);
      const channelStates = new Map<string, ChannelSuppressionState>();
      const suppressedBy = evaluation.hits.map(hit => {
        const history = dedupeAndSortHistory(hit.history);
        const windowRemainingMs =
          typeof hit.windowExpiresAt === 'number'
            ? Math.max(0, hit.windowExpiresAt - normalized.ts)
            : undefined;
        const cooldownRemainingMs =
          typeof hit.cooldownMs === 'number'
            ? Math.max(
                0,
                typeof hit.windowExpiresAt === 'number'
                  ? Math.min(hit.cooldownMs, Math.max(0, hit.windowExpiresAt - normalized.ts))
                  : hit.cooldownMs
              )
            : undefined;
        const cooldownExpiresAt =
          typeof cooldownRemainingMs === 'number'
            ? normalized.ts + cooldownRemainingMs
            : typeof hit.cooldownMs === 'number'
            ? normalized.ts + hit.cooldownMs
            : undefined;
        return {
          ruleId: hit.rule.id,
          reason: hit.reason,
          type: hit.type,
          suppressForMs: hit.rule.suppressForMs,
          rateLimit: hit.rule.rateLimit,
          maxEvents: hit.rule.maxEvents,
          windowExpiresAt: hit.windowExpiresAt,
          history,
          historyCount: history.length,
          rateLimitWindowMs: hit.rateLimit?.perMs,
          cooldownMs: hit.cooldownMs,
          channel: hit.channel ?? undefined,
          channels: [...eventChannels],
          windowRemainingMs,
          cooldownRemainingMs,
          cooldownExpiresAt
        };
      });
      suppressedBy.forEach((suppressedMeta, index) => {
        const hit = evaluation.hits[index];
        if (!hit) {
          return;
        }
        const candidateChannels = new Set<string>();
        if (suppressedMeta.channel) {
          candidateChannels.add(suppressedMeta.channel);
        }
        if (Array.isArray(suppressedMeta.channels)) {
          for (const channel of suppressedMeta.channels) {
            if (typeof channel === 'string' && channel.trim().length > 0) {
              candidateChannels.add(channel);
            }
          }
        }
        if (candidateChannels.size === 0) {
          return;
        }
        const historyCount =
          typeof suppressedMeta.historyCount === 'number' && Number.isFinite(suppressedMeta.historyCount)
            ? suppressedMeta.historyCount
            : 0;
        const combinedHistoryCount =
          typeof suppressedMeta.combinedHistoryCount === 'number' &&
          Number.isFinite(suppressedMeta.combinedHistoryCount)
            ? suppressedMeta.combinedHistoryCount
            : 0;
        for (const channel of candidateChannels) {
          const existing = channelStates.get(channel) ?? {
            hits: 0,
            reasons: new Set<string>(),
            types: new Set<SuppressionHitType>(),
            windowRemainingMs: null,
            maxWindowRemainingMs: null,
            cooldownRemainingMs: null,
            maxCooldownRemainingMs: null,
            historyCount: 0,
            combinedHistoryCount: 0
          } satisfies ChannelSuppressionState;
          existing.hits += 1;
          existing.reasons.add(hit.reason);
          existing.types.add(hit.type);
          if (typeof suppressedMeta.windowRemainingMs === 'number') {
            existing.windowRemainingMs = suppressedMeta.windowRemainingMs;
            existing.maxWindowRemainingMs =
              existing.maxWindowRemainingMs === null
                ? suppressedMeta.windowRemainingMs
                : Math.max(existing.maxWindowRemainingMs, suppressedMeta.windowRemainingMs);
          }
          if (typeof suppressedMeta.cooldownRemainingMs === 'number') {
            existing.cooldownRemainingMs = suppressedMeta.cooldownRemainingMs;
            existing.maxCooldownRemainingMs =
              existing.maxCooldownRemainingMs === null
                ? suppressedMeta.cooldownRemainingMs
                : Math.max(existing.maxCooldownRemainingMs, suppressedMeta.cooldownRemainingMs);
          }
          existing.historyCount = Math.max(existing.historyCount, historyCount);
          existing.combinedHistoryCount = Math.max(existing.combinedHistoryCount, combinedHistoryCount);
          channelStates.set(channel, existing);
        }
      });
      const meta = {
        ...normalized.meta,
        suppressed: true,
        suppressionReason: primary?.reason,
        suppressionType: primary?.type,
        suppressionRuleId: primary?.rule.id,
        suppressionWindowExpiresAt: primary?.windowExpiresAt,
        suppressionWindowEndsAt: primaryWindowEndsAt,
        rateLimitWindowMs: primary?.rateLimit?.perMs,
        rateLimitCooldownMs: primary?.cooldownMs,
        rateLimitCooldownRemainingMs: primaryCooldownRemainingMs,
        rateLimitCooldownEndsAt:
          typeof primaryCooldownRemainingMs === 'number'
            ? normalized.ts + primaryCooldownRemainingMs
            : primaryCooldownEndsAt,
        suppressionHistory: combinedHistory,
        suppressionHistoryCount: combinedHistory.length,
        suppressedBy,
        suppressionChannel: primaryChannel,
        suppressionChannels: [...eventChannels],
        suppressionWindowRemainingMs: primaryWindowRemainingMs,
        suppressionChannelStates: Object.fromEntries(
          Array.from(channelStates.entries()).map(([channel, state]) => [
            channel,
            {
              hits: state.hits,
              reasons: Array.from(state.reasons),
              types: Array.from(state.types),
              windowRemainingMs: state.windowRemainingMs,
              maxWindowRemainingMs: state.maxWindowRemainingMs,
              cooldownRemainingMs: state.cooldownRemainingMs,
              maxCooldownRemainingMs: state.maxCooldownRemainingMs,
              historyCount: state.historyCount,
              combinedHistoryCount: state.combinedHistoryCount
            }
          ])
        )
      };
      normalized.meta = meta;
      if (payload.meta && typeof payload.meta === 'object') {
        Object.assign(payload.meta, meta);
      } else {
        payload.meta = meta;
      }

      evaluation.hits.forEach((hit, index) => {
        const suppressedMeta = suppressedBy[index];
        const history = dedupeAndSortHistory(hit.history);
        const detail: SuppressedEventMetric = {
          ruleId: hit.rule.id,
          reason: hit.reason,
          type: hit.type,
          historyCount: history.length,
          history,
          windowExpiresAt: hit.windowExpiresAt,
          rateLimit: hit.rateLimit,
          cooldownMs: hit.cooldownMs,
          maxEvents: hit.rule.maxEvents,
          combinedHistoryCount: combinedHistory.length,
          channel: hit.channel ?? undefined,
          channels: [...eventChannels],
          windowRemainingMs: suppressedMeta.windowRemainingMs,
          cooldownRemainingMs: suppressedMeta.cooldownRemainingMs,
          cooldownExpiresAt: suppressedMeta.cooldownExpiresAt,
          channelStates: meta.suppressionChannelStates
        };
        this.metrics.recordSuppressedEvent(detail);
      });
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

    for (const match of evaluation.matchedRules) {
      if (match.rule.suppressForMs && !match.rule.rateLimit) {
        const suppressUntil = normalized.ts + match.rule.suppressForMs;
        if (suppressUntil > match.timeline.suppressedUntil) {
          match.timeline.suppressedUntil = suppressUntil;
        }
      }
    }

    this.emit(EVENT_CHANNEL, normalized);
    return true;
  }

  private evaluateSuppression(event: EventRecord) {
    const hits: SuppressionHit[] = [];
    const matchedRules: Array<{
      rule: InternalSuppressionRule;
      channel: string | null;
      timeline: SuppressionTimeline;
    }> = [];
    const eventChannels = extractEventChannels(event.meta);

    for (const rule of this.suppressionRules) {
      if (!ruleMatchesEvent(rule, event, eventChannels)) {
        continue;
      }

      const channel = resolveRuleChannel(rule, eventChannels);
      const timeline = getTimelineForRule(rule, channel);
      pruneTimeline(rule, timeline, event.ts);

      const windowActive = event.ts < timeline.suppressedUntil;
      const rateLimitConfig = rule.rateLimit;
      const normalizedMaxEvents =
        typeof rule.maxEvents === 'number' && rule.maxEvents > 0
          ? Math.floor(rule.maxEvents)
          : undefined;
      const rateLimitExceeded = Boolean(
        rateLimitConfig && timeline.history.length >= rateLimitConfig.count
      );

      const historySnapshot = [...timeline.history];

      if (windowActive) {
        recordTimelineHistory(timeline, event.ts, rule.historyLimit);
        if (normalizedMaxEvents && timeline.history.length > normalizedMaxEvents) {
          timeline.history.splice(0, timeline.history.length - normalizedMaxEvents);
        }
        const windowCooldown = rule.rateLimit ? normalizeCooldownMs(rule.rateLimit.cooldownMs) : 0;
        const history = dedupeAndSortHistory(timeline.history);
        hits.push({
          rule,
          type: 'window',
          reason: rule.reason,
          history,
          windowExpiresAt: timeline.suppressedUntil,
          rateLimit: rule.rateLimit,
          cooldownMs: windowCooldown > 0 ? windowCooldown : undefined,
          channel
        });
        continue;
      }

      if (normalizedMaxEvents && historySnapshot.length >= normalizedMaxEvents) {
        const windowMs = normalizeWindowMs(rule.suppressForMs);
        const windowExpiresAt =
          windowMs > 0 ? Math.max(timeline.suppressedUntil, event.ts + windowMs) : timeline.suppressedUntil;
        if (windowExpiresAt > 0 && windowExpiresAt > timeline.suppressedUntil) {
          timeline.suppressedUntil = windowExpiresAt;
        }
        const historyForMeta = dedupeAndSortHistory(historySnapshot.slice(-normalizedMaxEvents));
        hits.push({
          rule,
          type: 'window',
          reason: rule.reason,
          history: historyForMeta,
          windowExpiresAt: windowExpiresAt > 0 ? windowExpiresAt : undefined,
          rateLimit: rule.rateLimit,
          cooldownMs: undefined,
          channel
        });
        continue;
      }

      recordTimelineHistory(timeline, event.ts, rule.historyLimit);

      if (normalizedMaxEvents && timeline.history.length > normalizedMaxEvents) {
        timeline.history.splice(0, timeline.history.length - normalizedMaxEvents);
      }

      if (rateLimitExceeded && rateLimitConfig) {
        const historyLimit = rateLimitConfig.count;
        const relevantSnapshot =
          historyLimit && historyLimit > 0
            ? historySnapshot.slice(-historyLimit)
            : [...historySnapshot];
        const rateLimitHistory = dedupeAndSortHistory([...relevantSnapshot, event.ts]);
        const cooldownMs = normalizeCooldownMs(rateLimitConfig.cooldownMs);
        let windowUntil: number | undefined;
        if (rule.suppressForMs || cooldownMs > 0) {
          const suppressUntil = rule.suppressForMs ? event.ts + rule.suppressForMs : 0;
          const cooldownUntil = cooldownMs > 0 ? event.ts + cooldownMs : 0;
          windowUntil = Math.max(timeline.suppressedUntil, suppressUntil, cooldownUntil);
          if (windowUntil > 0) {
            timeline.suppressedUntil = windowUntil;
          }
        }
        hits.push({
          rule,
          type: 'rate-limit',
          reason: rule.reason,
          history: rateLimitHistory,
          windowExpiresAt: windowUntil,
          rateLimit: rateLimitConfig,
          cooldownMs: cooldownMs > 0 ? cooldownMs : undefined,
          channel
        });
        continue;
      }

      if (normalizedMaxEvents) {
        continue;
      }

      matchedRules.push({ rule, channel, timeline });
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
  const rateLimit = normalizeRateLimit(rule.rateLimit);
  const maxEvents = normalizeMaxEvents(rule.maxEvents);
  const windowMs = normalizeWindowMs(rule.suppressForMs);
  return {
    id: rule.id,
    detectors: asArray(rule.detector),
    sources: asArray(rule.source),
    severities: asArray(rule.severity),
    channels: asArray(rule.channel),
    suppressForMs: windowMs > 0 ? windowMs : undefined,
    rateLimit,
    maxEvents,
    reason: rule.reason,
    timeline: createTimeline(),
    timelines: new Map<string, SuppressionTimeline>(),
    historyLimit: Math.max(rateLimit?.count ?? 0, maxEvents ?? 0, 10)
  };
}

function createTimeline(): SuppressionTimeline {
  return {
    suppressedUntil: 0,
    history: []
  };
}

function resetTimeline(timeline: SuppressionTimeline) {
  timeline.suppressedUntil = 0;
  timeline.history.length = 0;
}

function asArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function ruleMatchesEvent(
  rule: InternalSuppressionRule,
  event: EventRecord,
  eventChannelsArg?: string[]
): boolean {
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
    const eventChannels = eventChannelsArg ?? extractEventChannels(event.meta);
    if (eventChannels.length === 0) {
      return false;
    }

    if (!eventChannels.some(channel => rule.channels?.includes(channel))) {
      return false;
    }
  }

  return true;
}

function pruneTimeline(rule: InternalSuppressionRule, timeline: SuppressionTimeline, ts: number) {
  const windowMs =
    rule.rateLimit?.perMs ?? (rule.maxEvents && rule.suppressForMs ? rule.suppressForMs : 0);
  if (windowMs && windowMs > 0) {
    const cutoff = ts - windowMs;
    let removeCount = 0;
    for (const time of timeline.history) {
      if (time > cutoff) {
        break;
      }
      removeCount += 1;
    }
    if (removeCount > 0) {
      timeline.history.splice(0, removeCount);
    }
  }

  if (timeline.history.length > 1) {
    sortHistory(timeline.history);
    dedupeSortedInPlace(timeline.history);
  }

  if (rule.historyLimit > 0 && timeline.history.length > rule.historyLimit) {
    timeline.history.splice(0, timeline.history.length - rule.historyLimit);
  }
}

function recordTimelineHistory(
  timeline: SuppressionTimeline,
  ts: number,
  historyLimit: number
) {
  if (!Number.isFinite(ts)) {
    return;
  }
  if (timeline.history.length === 0) {
    timeline.history.push(ts);
  } else {
    const last = timeline.history[timeline.history.length - 1];
    if (ts >= last) {
      if (ts !== last) {
        timeline.history.push(ts);
      }
    } else {
      timeline.history.push(ts);
      sortHistory(timeline.history);
    }
    if (timeline.history.length > 1) {
      dedupeSortedInPlace(timeline.history);
    }
  }
  if (historyLimit > 0 && timeline.history.length > historyLimit) {
    timeline.history.splice(0, timeline.history.length - historyLimit);
  }
}

function resolveRuleChannel(rule: InternalSuppressionRule, eventChannels: string[]): string | null {
  if (rule.channels && rule.channels.length > 0) {
    for (const channel of eventChannels) {
      if (rule.channels.includes(channel)) {
        return channel;
      }
    }
    return rule.channels[0] ?? null;
  }
  return eventChannels[0] ?? null;
}

function getTimelineForRule(
  rule: InternalSuppressionRule,
  channel: string | null
): SuppressionTimeline {
  const normalized = typeof channel === 'string' ? channel.trim() : '';
  if (!normalized) {
    return rule.timeline;
  }
  const existing = rule.timelines.get(normalized);
  if (existing) {
    return existing;
  }
  const created = createTimeline();
  rule.timelines.set(normalized, created);
  return created;
}

function normalizeRateLimit(rateLimit?: RateLimitConfig): RateLimitConfig | undefined {
  if (!rateLimit) {
    return undefined;
  }
  const count = Math.max(1, Math.floor(rateLimit.count));
  const perMs = Math.max(1, Math.floor(rateLimit.perMs));
  const cooldown = normalizeCooldownMs(rateLimit.cooldownMs);
  const normalized: RateLimitConfig = { count, perMs };
  if (cooldown > 0) {
    normalized.cooldownMs = cooldown;
  }
  return normalized;
}

function normalizeCooldownMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeMaxEvents(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeWindowMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(value));
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

function mergeSuppressionHistory(hits: SuppressionHit[], eventTs: number): number[] {
  if (hits.length === 0) {
    return [];
  }

  const merged = new Set<number>();

  for (const hit of hits) {
    for (const entry of hit.history) {
      merged.add(entry);
    }

    if (!hit.history.includes(eventTs)) {
      merged.add(eventTs);
    }
  }

  return dedupeAndSortHistory([...merged]);
}

function sortHistory(history: number[]) {
  history.sort((a, b) => a - b);
}

function dedupeSortedInPlace(history: number[]) {
  if (history.length < 2) {
    return;
  }
  let writeIndex = 1;
  let previous = history[0];
  for (let index = 1; index < history.length; index += 1) {
    const value = history[index];
    if (value === previous) {
      continue;
    }
    previous = value;
    history[writeIndex] = value;
    writeIndex += 1;
  }
  history.length = writeIndex;
}

function dedupeAndSortHistory(history: number[]): number[] {
  if (history.length <= 1) {
    return history.slice();
  }
  const sorted = history.slice().sort((a, b) => a - b);
  const result: number[] = [];
  let previous: number | null = null;
  for (const value of sorted) {
    if (previous !== null && value === previous) {
      continue;
    }
    result.push(value);
    previous = value;
  }
  return result;
}
