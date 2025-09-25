import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { EventRecord } from '../types.js';

type CounterMap = Record<string, number>;

type LatencyStats = {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  averageMs: number;
};

type HistogramSnapshot = Record<string, number>;

type PipelineRestartMeta = {
  reason: string;
  attempt: number | null;
  delayMs: number | null;
  baseDelayMs: number | null;
  minDelayMs: number | null;
  maxDelayMs: number | null;
  jitterMs: number | null;
};

type PipelineChannelSnapshot = {
  restarts: number;
  lastRestartAt: string | null;
  byReason: CounterMap;
  lastRestart: PipelineRestartMeta | null;
};

type PipelineSnapshot = PipelineChannelSnapshot & {
  byChannel: Record<string, PipelineChannelSnapshot>;
};

type SuppressionSnapshot = {
  total: number;
  byRule: CounterMap;
  byReason: CounterMap;
  rules: Record<string, { total: number; byReason: CounterMap }>;
};

type DetectorSnapshot = {
  counters: CounterMap;
  lastRunAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
};

type MetricsSnapshot = {
  createdAt: string;
  events: {
    total: number;
    lastEventAt: string | null;
    byDetector: CounterMap;
    bySeverity: CounterMap;
  };
  logs: {
    byLevel: CounterMap;
    byDetector: Record<string, CounterMap>;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
  };
  latencies: Record<string, LatencyStats>;
  histograms: Record<string, HistogramSnapshot>;
  pipelines: {
    ffmpeg: PipelineSnapshot;
    audio: PipelineSnapshot;
  };
  suppression: SuppressionSnapshot;
  detectors: Record<string, DetectorSnapshot>;
};

type HistogramConfig = {
  buckets: number[];
  format: (bucket: number, previous?: number) => string;
};

const DEFAULT_HISTOGRAM: HistogramConfig = {
  buckets: [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000],
  format: (bucket, previous) => {
    if (typeof previous === 'undefined') {
      return `<${bucket}`;
    }
    return previous === bucket ? `${bucket}` : `${previous}-${bucket}`;
  }
};

class MetricsRegistry {
  private readonly logLevelCounters = new Map<string, number>();
  private readonly logLevelByDetector = new Map<string, Map<string, number>>();
  private readonly detectorCounters = new Map<string, number>();
  private readonly severityCounters = new Map<string, number>();
  private readonly latencyStats = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>();
  private readonly histograms = new Map<string, Map<string, number>>();
  private readonly ffmpegRestartReasons = new Map<string, number>();
  private readonly audioRestartReasons = new Map<string, number>();
  private readonly ffmpegRestartsByChannel = new Map<string, PipelineChannelState>();
  private readonly audioRestartsByChannel = new Map<string, PipelineChannelState>();
  private lastFfmpegRestartMeta: PipelineRestartMeta | null = null;
  private lastAudioRestartMeta: PipelineRestartMeta | null = null;
  private readonly suppressionByRule = new Map<string, number>();
  private readonly suppressionByReason = new Map<string, number>();
  private readonly suppressionRules = new Map<string, SuppressionRuleState>();
  private readonly detectorMetrics = new Map<string, DetectorMetricState>();
  private totalEvents = 0;
  private lastEventTimestamp: number | null = null;
  private ffmpegRestarts = 0;
  private audioRestarts = 0;
  private lastFfmpegRestartAt: number | null = null;
  private lastAudioRestartAt: number | null = null;
  private suppressionTotal = 0;
  private lastErrorAt: number | null = null;
  private lastErrorMessage: string | null = null;

  reset() {
    this.logLevelCounters.clear();
    this.logLevelByDetector.clear();
    this.detectorCounters.clear();
    this.severityCounters.clear();
    this.latencyStats.clear();
    this.histograms.clear();
    this.ffmpegRestartReasons.clear();
    this.audioRestartReasons.clear();
    this.ffmpegRestartsByChannel.clear();
    this.audioRestartsByChannel.clear();
    this.lastFfmpegRestartMeta = null;
    this.lastAudioRestartMeta = null;
    this.suppressionByRule.clear();
    this.suppressionByReason.clear();
    this.suppressionRules.clear();
    this.detectorMetrics.clear();
    this.totalEvents = 0;
    this.lastEventTimestamp = null;
    this.ffmpegRestarts = 0;
    this.audioRestarts = 0;
    this.lastFfmpegRestartAt = null;
    this.lastAudioRestartAt = null;
    this.suppressionTotal = 0;
    this.lastErrorAt = null;
    this.lastErrorMessage = null;
  }

  incrementLogLevel(level: string, context?: { message?: string; detector?: string }) {
    const normalized = level.toLowerCase();
    const next = (this.logLevelCounters.get(normalized) ?? 0) + 1;
    this.logLevelCounters.set(normalized, next);

    if (context?.detector) {
      const detectorKey = context.detector;
      const detectorMap = this.logLevelByDetector.get(detectorKey) ?? new Map<string, number>();
      detectorMap.set(normalized, (detectorMap.get(normalized) ?? 0) + 1);
      this.logLevelByDetector.set(detectorKey, detectorMap);
    }

    if (normalized === 'error' || normalized === 'fatal') {
      this.lastErrorAt = Date.now();
      if (context?.message) {
        this.lastErrorMessage = context.message;
      }
    }
  }

  recordEvent(event: EventRecord) {
    this.totalEvents += 1;
    this.lastEventTimestamp = event.ts;

    const detector = event.detector ?? 'unknown';
    this.detectorCounters.set(detector, (this.detectorCounters.get(detector) ?? 0) + 1);

    const severity = event.severity ?? 'info';
    this.severityCounters.set(severity, (this.severityCounters.get(severity) ?? 0) + 1);
  }

  recordSuppressedEvent(ruleId?: string, reason?: string) {
    this.suppressionTotal += 1;
    if (reason) {
      this.suppressionByReason.set(reason, (this.suppressionByReason.get(reason) ?? 0) + 1);
    }
    if (ruleId) {
      this.suppressionByRule.set(ruleId, (this.suppressionByRule.get(ruleId) ?? 0) + 1);
      const ruleState = this.suppressionRules.get(ruleId) ?? {
        total: 0,
        byReason: new Map<string, number>()
      };
      ruleState.total += 1;
      if (reason) {
        ruleState.byReason.set(reason, (ruleState.byReason.get(reason) ?? 0) + 1);
      }
      this.suppressionRules.set(ruleId, ruleState);
    }
  }

  incrementDetectorCounter(detector: string, counter: string, amount = 1) {
    if (!Number.isFinite(amount)) {
      return;
    }
    const state = getDetectorMetricState(this.detectorMetrics, detector);
    const current = state.counters.get(counter) ?? 0;
    state.counters.set(counter, current + amount);
    state.lastRunAt = Date.now();
  }

  recordDetectorError(detector: string, message: string) {
    const state = getDetectorMetricState(this.detectorMetrics, detector);
    state.lastRunAt = Date.now();
    state.lastErrorAt = Date.now();
    state.lastErrorMessage = message;
    const current = state.counters.get('errors') ?? 0;
    state.counters.set('errors', current + 1);
  }

  recordPipelineRestart(
    type: 'ffmpeg' | 'audio',
    reason: string,
    meta?: {
      delayMs?: number;
      attempt?: number;
      baseDelayMs?: number;
      minDelayMs?: number;
      maxDelayMs?: number;
      jitterMs?: number;
      channel?: string;
    }
  ) {
    const normalized = reason || 'unknown';
    const channel = meta?.channel;
    if (type === 'ffmpeg') {
      this.ffmpegRestarts += 1;
      this.lastFfmpegRestartAt = Date.now();
      this.ffmpegRestartReasons.set(normalized, (this.ffmpegRestartReasons.get(normalized) ?? 0) + 1);
      const metaPayload: PipelineRestartMeta = {
        reason: normalized,
        attempt: typeof meta?.attempt === 'number' ? meta?.attempt : null,
        delayMs: typeof meta?.delayMs === 'number' ? meta?.delayMs : null,
        baseDelayMs: typeof meta?.baseDelayMs === 'number' ? meta?.baseDelayMs : null,
        minDelayMs: typeof meta?.minDelayMs === 'number' ? meta?.minDelayMs : null,
        maxDelayMs: typeof meta?.maxDelayMs === 'number' ? meta?.maxDelayMs : null,
        jitterMs: typeof meta?.jitterMs === 'number' ? meta?.jitterMs : null
      };
      this.lastFfmpegRestartMeta = metaPayload;
      if (channel) {
        const state = getPipelineChannelState(this.ffmpegRestartsByChannel, channel);
        updatePipelineChannelState(state, metaPayload, normalized);
      }
    } else {
      this.audioRestarts += 1;
      this.lastAudioRestartAt = Date.now();
      this.audioRestartReasons.set(normalized, (this.audioRestartReasons.get(normalized) ?? 0) + 1);
      const metaPayload: PipelineRestartMeta = {
        reason: normalized,
        attempt: typeof meta?.attempt === 'number' ? meta?.attempt : null,
        delayMs: typeof meta?.delayMs === 'number' ? meta?.delayMs : null,
        baseDelayMs: typeof meta?.baseDelayMs === 'number' ? meta?.baseDelayMs : null,
        minDelayMs: typeof meta?.minDelayMs === 'number' ? meta?.minDelayMs : null,
        maxDelayMs: typeof meta?.maxDelayMs === 'number' ? meta?.maxDelayMs : null,
        jitterMs: typeof meta?.jitterMs === 'number' ? meta?.jitterMs : null
      };
      this.lastAudioRestartMeta = metaPayload;
      if (channel) {
        const state = getPipelineChannelState(this.audioRestartsByChannel, channel);
        updatePipelineChannelState(state, metaPayload, normalized);
      }
    }

    const delay = meta?.delayMs;
    if (typeof delay === 'number' && delay >= 0) {
      const metric = `pipeline.${type}.restart.delay`;
      this.observeLatency(metric, delay);
      this.observeHistogram(metric, delay);
    }
  }

  observeLatency(metric: string, durationMs: number) {
    const current = this.latencyStats.get(metric) ?? {
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0
    };

    const minMs = Math.min(current.minMs, durationMs);
    const maxMs = Math.max(current.maxMs, durationMs);

    const next = {
      count: current.count + 1,
      totalMs: current.totalMs + durationMs,
      minMs,
      maxMs
    };

    this.latencyStats.set(metric, next);
  }

  observeHistogram(metric: string, durationMs: number, config: HistogramConfig = DEFAULT_HISTOGRAM) {
    const histogram = this.histograms.get(metric) ?? new Map<string, number>();
    if (!this.histograms.has(metric)) {
      this.histograms.set(metric, histogram);
    }

    const bucketLabel = resolveHistogramBucket(durationMs, config);
    histogram.set(bucketLabel, (histogram.get(bucketLabel) ?? 0) + 1);
  }

  observeDetectorLatency(detector: string, durationMs: number) {
    const metricName = `detector.${detector}.latency`;
    this.observeLatency(metricName, durationMs);
    this.observeHistogram(metricName, durationMs);
  }

  async time<T>(metric: string, fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const duration = performance.now() - start;
      this.observeLatency(metric, duration);
    }
  }

  bindEventBus(bus: EventEmitter): () => void {
    const handler = (event: EventRecord) => {
      this.recordEvent(event);
    };

    bus.on('event', handler);
    return () => {
      bus.off('event', handler);
    };
  }

  snapshot(): MetricsSnapshot {
    return {
      createdAt: new Date().toISOString(),
      events: {
        total: this.totalEvents,
        lastEventAt: this.lastEventTimestamp ? new Date(this.lastEventTimestamp).toISOString() : null,
        byDetector: mapFrom(this.detectorCounters),
        bySeverity: mapFrom(this.severityCounters)
      },
      logs: {
        byLevel: mapFrom(this.logLevelCounters),
        byDetector: mapFromNested(this.logLevelByDetector),
        lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
        lastErrorMessage: this.lastErrorMessage
      },
      latencies: mapFromLatencies(this.latencyStats),
      histograms: mapFromHistograms(this.histograms),
      pipelines: {
        ffmpeg: {
          restarts: this.ffmpegRestarts,
          lastRestartAt: this.lastFfmpegRestartAt ? new Date(this.lastFfmpegRestartAt).toISOString() : null,
          byReason: mapFrom(this.ffmpegRestartReasons),
          lastRestart: this.lastFfmpegRestartMeta,
          byChannel: mapFromPipelineChannels(this.ffmpegRestartsByChannel)
        },
        audio: {
          restarts: this.audioRestarts,
          lastRestartAt: this.lastAudioRestartAt ? new Date(this.lastAudioRestartAt).toISOString() : null,
          byReason: mapFrom(this.audioRestartReasons),
          lastRestart: this.lastAudioRestartMeta,
          byChannel: mapFromPipelineChannels(this.audioRestartsByChannel)
        }
      },
      suppression: {
        total: this.suppressionTotal,
        byRule: mapFrom(this.suppressionByRule),
        byReason: mapFrom(this.suppressionByReason),
        rules: mapFromSuppressionRules(this.suppressionRules)
      },
      detectors: mapFromDetectors(this.detectorMetrics)
    };
  }
}

type PipelineChannelState = {
  restarts: number;
  lastRestartAt: number | null;
  byReason: Map<string, number>;
  lastRestart: PipelineRestartMeta | null;
};

type SuppressionRuleState = {
  total: number;
  byReason: Map<string, number>;
};

type DetectorMetricState = {
  counters: Map<string, number>;
  lastRunAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
};

function mapFrom(source: Map<string, number>): CounterMap {
  return Object.fromEntries(Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function mapFromNested(source: Map<string, Map<string, number>>): Record<string, CounterMap> {
  const result: Record<string, CounterMap> = {};
  for (const [key, inner] of source.entries()) {
    result[key] = mapFrom(inner);
  }
  return result;
}

function mapFromLatencies(
  source: Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>
): Record<string, LatencyStats> {
  const result: Record<string, LatencyStats> = {};
  for (const [name, stats] of source.entries()) {
    result[name] = {
      count: stats.count,
      totalMs: stats.totalMs,
      minMs: stats.minMs === Number.POSITIVE_INFINITY ? 0 : stats.minMs,
      maxMs: stats.maxMs,
      averageMs: stats.count === 0 ? 0 : stats.totalMs / stats.count
    };
  }
  return result;
}

function mapFromHistograms(source: Map<string, Map<string, number>>): Record<string, HistogramSnapshot> {
  const result: Record<string, HistogramSnapshot> = {};
  for (const [metric, histogram] of source.entries()) {
    const ordered = Array.from(histogram.entries()).sort(([a], [b]) => compareHistogramKeys(a, b));
    result[metric] = Object.fromEntries(ordered);
  }
  return result;
}

function mapFromPipelineChannels(source: Map<string, PipelineChannelState>): Record<string, PipelineChannelSnapshot> {
  const result: Record<string, PipelineChannelSnapshot> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, state] of ordered) {
    result[channel] = {
      restarts: state.restarts,
      lastRestartAt: state.lastRestartAt ? new Date(state.lastRestartAt).toISOString() : null,
      byReason: mapFrom(state.byReason),
      lastRestart: state.lastRestart
    };
  }
  return result;
}

function mapFromSuppressionRules(source: Map<string, SuppressionRuleState>): Record<string, { total: number; byReason: CounterMap }> {
  const result: Record<string, { total: number; byReason: CounterMap }> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [ruleId, state] of ordered) {
    result[ruleId] = {
      total: state.total,
      byReason: mapFrom(state.byReason)
    };
  }
  return result;
}

function mapFromDetectors(source: Map<string, DetectorMetricState>): Record<string, DetectorSnapshot> {
  const result: Record<string, DetectorSnapshot> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [detector, state] of ordered) {
    result[detector] = {
      counters: mapFrom(state.counters),
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      lastErrorAt: state.lastErrorAt ? new Date(state.lastErrorAt).toISOString() : null,
      lastErrorMessage: state.lastErrorMessage
    };
  }
  return result;
}

function getPipelineChannelState(map: Map<string, PipelineChannelState>, channel: string): PipelineChannelState {
  const existing = map.get(channel);
  if (existing) {
    return existing;
  }
  const created: PipelineChannelState = {
    restarts: 0,
    lastRestartAt: null,
    byReason: new Map<string, number>(),
    lastRestart: null
  };
  map.set(channel, created);
  return created;
}

function updatePipelineChannelState(
  state: PipelineChannelState,
  meta: PipelineRestartMeta,
  reason: string
) {
  state.restarts += 1;
  state.lastRestartAt = Date.now();
  state.byReason.set(reason, (state.byReason.get(reason) ?? 0) + 1);
  state.lastRestart = meta;
}

function getDetectorMetricState(map: Map<string, DetectorMetricState>, detector: string): DetectorMetricState {
  const existing = map.get(detector);
  if (existing) {
    return existing;
  }
  const created: DetectorMetricState = {
    counters: new Map<string, number>(),
    lastRunAt: null,
    lastErrorAt: null,
    lastErrorMessage: null
  };
  map.set(detector, created);
  return created;
}

function compareHistogramKeys(a: string, b: string) {
  const extract = (key: string) => {
    if (key.startsWith('<')) {
      return [parseFloat(key.slice(1)), -1] as const;
    }
    if (key.endsWith('+')) {
      return [parseFloat(key.slice(0, -1)), Number.POSITIVE_INFINITY] as const;
    }
    const [start, end] = key.split('-').map(Number);
    return [start, end ?? start] as const;
  };

  const [aStart, aEnd] = extract(a);
  const [bStart, bEnd] = extract(b);
  if (aStart === bStart) {
    return aEnd - bEnd;
  }
  return aStart - bStart;
}

function resolveHistogramBucket(duration: number, config: HistogramConfig) {
  const { buckets, format } = config;
  let previous = 0;
  for (const bucket of buckets) {
    if (duration < bucket) {
      return format(bucket, previous === 0 ? undefined : previous);
    }
    previous = bucket;
  }
  return `${buckets[buckets.length - 1]}+`;
}

const defaultRegistry = new MetricsRegistry();

export type {
  HistogramSnapshot,
  MetricsSnapshot,
  PipelineChannelSnapshot,
  PipelineSnapshot,
  SuppressionSnapshot,
  DetectorSnapshot
};
export { MetricsRegistry };
export default defaultRegistry;
