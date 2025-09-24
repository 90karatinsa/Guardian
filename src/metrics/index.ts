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
};

type PipelineSnapshot = {
  restarts: number;
  lastRestartAt: string | null;
  byReason: CounterMap;
  lastRestart: PipelineRestartMeta | null;
};

type SuppressionSnapshot = {
  total: number;
  byRule: CounterMap;
  byReason: CounterMap;
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
  private readonly detectorCounters = new Map<string, number>();
  private readonly severityCounters = new Map<string, number>();
  private readonly latencyStats = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>();
  private readonly histograms = new Map<string, Map<string, number>>();
  private readonly ffmpegRestartReasons = new Map<string, number>();
  private readonly audioRestartReasons = new Map<string, number>();
  private lastFfmpegRestartMeta: PipelineRestartMeta | null = null;
  private lastAudioRestartMeta: PipelineRestartMeta | null = null;
  private readonly suppressionByRule = new Map<string, number>();
  private readonly suppressionByReason = new Map<string, number>();
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
    this.detectorCounters.clear();
    this.severityCounters.clear();
    this.latencyStats.clear();
    this.histograms.clear();
    this.ffmpegRestartReasons.clear();
    this.audioRestartReasons.clear();
    this.lastFfmpegRestartMeta = null;
    this.lastAudioRestartMeta = null;
    this.suppressionByRule.clear();
    this.suppressionByReason.clear();
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

  incrementLogLevel(level: string, context?: { message?: string }) {
    const normalized = level.toLowerCase();
    const next = (this.logLevelCounters.get(normalized) ?? 0) + 1;
    this.logLevelCounters.set(normalized, next);

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
    if (ruleId) {
      this.suppressionByRule.set(ruleId, (this.suppressionByRule.get(ruleId) ?? 0) + 1);
    }
    if (reason) {
      this.suppressionByReason.set(reason, (this.suppressionByReason.get(reason) ?? 0) + 1);
    }
  }

  recordPipelineRestart(
    type: 'ffmpeg' | 'audio',
    reason: string,
    meta?: { delayMs?: number; attempt?: number }
  ) {
    const normalized = reason || 'unknown';
    if (type === 'ffmpeg') {
      this.ffmpegRestarts += 1;
      this.lastFfmpegRestartAt = Date.now();
      this.ffmpegRestartReasons.set(normalized, (this.ffmpegRestartReasons.get(normalized) ?? 0) + 1);
      this.lastFfmpegRestartMeta = {
        reason: normalized,
        attempt: typeof meta?.attempt === 'number' ? meta?.attempt : null,
        delayMs: typeof meta?.delayMs === 'number' ? meta?.delayMs : null
      };
    } else {
      this.audioRestarts += 1;
      this.lastAudioRestartAt = Date.now();
      this.audioRestartReasons.set(normalized, (this.audioRestartReasons.get(normalized) ?? 0) + 1);
      this.lastAudioRestartMeta = {
        reason: normalized,
        attempt: typeof meta?.attempt === 'number' ? meta?.attempt : null,
        delayMs: typeof meta?.delayMs === 'number' ? meta?.delayMs : null
      };
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
          lastRestart: this.lastFfmpegRestartMeta
        },
        audio: {
          restarts: this.audioRestarts,
          lastRestartAt: this.lastAudioRestartAt ? new Date(this.lastAudioRestartAt).toISOString() : null,
          byReason: mapFrom(this.audioRestartReasons),
          lastRestart: this.lastAudioRestartMeta
        }
      },
      suppression: {
        total: this.suppressionTotal,
        byRule: mapFrom(this.suppressionByRule),
        byReason: mapFrom(this.suppressionByReason)
      }
    };
  }
}

function mapFrom(source: Map<string, number>): CounterMap {
  return Object.fromEntries(Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b)));
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

export type { HistogramSnapshot, MetricsSnapshot, PipelineSnapshot, SuppressionSnapshot };
export { MetricsRegistry };
export default defaultRegistry;
