import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import pino from 'pino';
import type { EventRecord, RateLimitConfig } from '../types.js';

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
  exitCode: number | null;
  errorCode: string | number | null;
  signal: NodeJS.Signals | null;
  channel: string | null;
};

type PipelineChannelSnapshot = {
  restarts: number;
  lastRestartAt: string | null;
  byReason: CounterMap;
  lastRestart: PipelineRestartMeta | null;
};

type PipelineSnapshot = PipelineChannelSnapshot & {
  attempts: CounterMap;
  byChannel: Record<string, PipelineChannelSnapshot>;
  deviceDiscovery: CounterMap;
  deviceDiscoveryByChannel: Record<string, CounterMap>;
  delayHistogram: HistogramSnapshot;
  attemptHistogram: HistogramSnapshot;
};

type SuppressionSnapshot = {
  total: number;
  byRule: CounterMap;
  byReason: CounterMap;
  byType: CounterMap;
  historyTotals: {
    historyCount: number;
    combinedHistoryCount: number;
  };
  lastEvent: {
    ruleId?: string;
    reason?: string;
    type?: 'window' | 'rate-limit';
    historyCount?: number | null;
    combinedHistoryCount?: number | null;
    rateLimit?: RateLimitConfig | null;
    cooldownMs?: number | null;
  } | null;
  rules: Record<string, SuppressionRuleSnapshot>;
};

type SuppressionRuleSnapshot = {
  total: number;
  byReason: CounterMap;
  history: {
    total: number;
    combinedTotal: number;
    lastCount: number | null;
    lastCombinedCount: number | null;
    lastType: 'window' | 'rate-limit' | null;
    lastRateLimit: RateLimitConfig | null;
    lastCooldownMs: number | null;
  };
};

type SuppressedEventMetric = {
  ruleId?: string;
  reason?: string;
  type?: 'window' | 'rate-limit';
  historyCount?: number;
  history?: number[];
  windowExpiresAt?: number;
  rateLimit?: RateLimitConfig;
  cooldownMs?: number;
  combinedHistoryCount?: number;
};

type RetentionTotals = {
  removedEvents: number;
  archivedSnapshots: number;
  prunedArchives: number;
};

type RetentionWarningSnapshot = {
  camera: string | null;
  path: string;
  reason: string;
};

type RetentionSnapshot = {
  runs: number;
  lastRunAt: string | null;
  warnings: number;
  warningsByCamera: CounterMap;
  lastWarning: RetentionWarningSnapshot | null;
  totals: RetentionTotals;
  totalsByCamera: Record<string, RetentionCameraTotals>;
};

type RetentionCameraTotals = {
  archivedSnapshots: number;
  prunedArchives: number;
};

type RetentionRunContext = RetentionTotals & {
  perCamera?: Record<string, RetentionCameraTotals>;
};

type DetectorSnapshot = {
  counters: CounterMap;
  lastRunAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  latency: LatencyStats | null;
  latencyHistogram: HistogramSnapshot;
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
    histogram: CounterMap;
  };
  latencies: Record<string, LatencyStats>;
  histograms: Record<string, HistogramSnapshot>;
  pipelines: {
    ffmpeg: PipelineSnapshot;
    audio: PipelineSnapshot;
  };
  suppression: SuppressionSnapshot;
  retention: RetentionSnapshot;
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

const PINO_LEVEL_ORDER = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const LOG_LEVEL_BUCKETS = PINO_LEVEL_ORDER.map(level => (pino.levels.values[level] ?? 0) + 1);
const LOG_LEVEL_HISTOGRAM: HistogramConfig = {
  buckets: LOG_LEVEL_BUCKETS,
  format: bucket => {
    const index = LOG_LEVEL_BUCKETS.indexOf(bucket);
    return index >= 0 ? PINO_LEVEL_ORDER[index] : 'fatal+';
  }
};

const RESTART_ATTEMPT_BUCKETS = [
  { upper: 1.5, label: '1' },
  { upper: 2.5, label: '2' },
  { upper: 3.5, label: '3' },
  { upper: 5.5, label: '4-5' },
  { upper: 10.5, label: '6-10' }
];

const RESTART_ATTEMPT_HISTOGRAM: HistogramConfig = {
  buckets: RESTART_ATTEMPT_BUCKETS.map(entry => entry.upper),
  format: bucket => {
    const match = RESTART_ATTEMPT_BUCKETS.find(entry => entry.upper === bucket);
    return match ? match.label : '10+';
  }
};

type DetectorLatencyState = {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
};

class MetricsRegistry {
  private readonly logLevelCounters = new Map<string, number>();
  private readonly logLevelByDetector = new Map<string, Map<string, number>>();
  private readonly logLevelHistogram = new Map<string, number>();
  private readonly detectorCounters = new Map<string, number>();
  private readonly severityCounters = new Map<string, number>();
  private readonly latencyStats = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>();
  private readonly histograms = new Map<string, Map<string, number>>();
  private readonly ffmpegRestartReasons = new Map<string, number>();
  private readonly audioRestartReasons = new Map<string, number>();
  private readonly ffmpegRestartsByChannel = new Map<string, PipelineChannelState>();
  private readonly audioRestartsByChannel = new Map<string, PipelineChannelState>();
  private readonly ffmpegRestartAttempts = new Map<string, number>();
  private readonly audioRestartAttempts = new Map<string, number>();
  private readonly audioDeviceDiscovery = new Map<string, number>();
  private readonly audioDeviceDiscoveryByChannel = new Map<string, Map<string, number>>();
  private lastFfmpegRestartMeta: PipelineRestartMeta | null = null;
  private lastAudioRestartMeta: PipelineRestartMeta | null = null;
  private readonly suppressionByRule = new Map<string, number>();
  private readonly suppressionByReason = new Map<string, number>();
  private readonly suppressionByType = new Map<string, number>();
  private readonly suppressionRules = new Map<string, SuppressionRuleState>();
  private lastSuppressedEvent: {
    ruleId?: string;
    reason?: string;
    type?: 'window' | 'rate-limit';
    historyCount?: number | null;
    combinedHistoryCount?: number | null;
    rateLimit?: RateLimitConfig | null;
    cooldownMs?: number | null;
  } | null = null;
  private suppressionHistoryCount = 0;
  private suppressionCombinedHistoryCount = 0;
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
  private retentionRuns = 0;
  private lastRetentionRunAt: number | null = null;
  private retentionWarnings = 0;
  private readonly retentionWarningsByCamera = new Map<string, number>();
  private lastRetentionWarning: RetentionWarningSnapshot | null = null;
  private retentionTotals: RetentionTotals = {
    removedEvents: 0,
    archivedSnapshots: 0,
    prunedArchives: 0
  };
  private readonly retentionTotalsByCamera = new Map<string, RetentionCameraTotals>();

  reset() {
    this.logLevelCounters.clear();
    this.logLevelByDetector.clear();
    this.logLevelHistogram.clear();
    this.detectorCounters.clear();
    this.severityCounters.clear();
    this.latencyStats.clear();
    this.histograms.clear();
    this.ffmpegRestartReasons.clear();
    this.audioRestartReasons.clear();
    this.ffmpegRestartsByChannel.clear();
    this.audioRestartsByChannel.clear();
    this.ffmpegRestartAttempts.clear();
    this.audioRestartAttempts.clear();
    this.audioDeviceDiscovery.clear();
    this.audioDeviceDiscoveryByChannel.clear();
    this.lastFfmpegRestartMeta = null;
    this.lastAudioRestartMeta = null;
    this.suppressionByRule.clear();
    this.suppressionByReason.clear();
    this.suppressionByType.clear();
    this.suppressionRules.clear();
    this.lastSuppressedEvent = null;
    this.suppressionHistoryCount = 0;
    this.suppressionCombinedHistoryCount = 0;
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
    this.retentionRuns = 0;
    this.lastRetentionRunAt = null;
    this.retentionWarnings = 0;
    this.retentionWarningsByCamera.clear();
    this.lastRetentionWarning = null;
    this.retentionTotals = { removedEvents: 0, archivedSnapshots: 0, prunedArchives: 0 };
    this.retentionTotalsByCamera.clear();
  }

  incrementLogLevel(level: string, context?: { message?: string; detector?: string }) {
    const normalized = level.toLowerCase();
    const next = (this.logLevelCounters.get(normalized) ?? 0) + 1;
    this.logLevelCounters.set(normalized, next);

    this.logLevelHistogram.set(normalized, (this.logLevelHistogram.get(normalized) ?? 0) + 1);
    const levelValue = pino.levels.values[normalized as keyof typeof pino.levels.values];
    if (typeof levelValue === 'number' && Number.isFinite(levelValue)) {
      this.observeHistogram('logs.level', levelValue, LOG_LEVEL_HISTOGRAM);
    }

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

  recordSuppressedEvent(detail?: SuppressedEventMetric | string, legacyReason?: string) {
    const normalizedDetail: SuppressedEventMetric =
      typeof detail === 'string' || typeof detail === 'undefined'
        ? { ruleId: typeof detail === 'string' ? detail : undefined, reason: legacyReason }
        : detail ?? {};
    const ruleId = normalizedDetail.ruleId;
    const reason = normalizedDetail.reason;
    this.suppressionTotal += 1;
    if (reason) {
      this.suppressionByReason.set(reason, (this.suppressionByReason.get(reason) ?? 0) + 1);
    }
    if (normalizedDetail.type) {
      this.suppressionByType.set(
        normalizedDetail.type,
        (this.suppressionByType.get(normalizedDetail.type) ?? 0) + 1
      );
    }
    if (typeof normalizedDetail.historyCount === 'number' && Number.isFinite(normalizedDetail.historyCount)) {
      this.suppressionHistoryCount += normalizedDetail.historyCount;
    }
    if (
      typeof normalizedDetail.combinedHistoryCount === 'number' &&
      Number.isFinite(normalizedDetail.combinedHistoryCount)
    ) {
      this.suppressionCombinedHistoryCount += normalizedDetail.combinedHistoryCount;
    }
    const cooldownValue =
      typeof normalizedDetail.cooldownMs === 'number' && Number.isFinite(normalizedDetail.cooldownMs)
        ? normalizedDetail.cooldownMs
        : null;
    this.lastSuppressedEvent = {
      ruleId,
      reason,
      type: normalizedDetail.type,
      historyCount:
        typeof normalizedDetail.historyCount === 'number' ? normalizedDetail.historyCount : null,
      combinedHistoryCount:
        typeof normalizedDetail.combinedHistoryCount === 'number'
          ? normalizedDetail.combinedHistoryCount
          : null,
      rateLimit: normalizedDetail.rateLimit ?? null,
      cooldownMs: cooldownValue
    };
    if (ruleId) {
      this.suppressionByRule.set(ruleId, (this.suppressionByRule.get(ruleId) ?? 0) + 1);
      const ruleState = this.suppressionRules.get(ruleId) ?? {
        total: 0,
        byReason: new Map<string, number>(),
        historyCount: 0,
        combinedHistoryCount: 0,
        lastHistoryCount: null,
        lastCombinedHistoryCount: null,
        lastType: null,
        lastRateLimit: null,
        lastCooldownMs: null
      };
      ruleState.total += 1;
      if (reason) {
        ruleState.byReason.set(reason, (ruleState.byReason.get(reason) ?? 0) + 1);
      }
      if (typeof normalizedDetail.historyCount === 'number' && Number.isFinite(normalizedDetail.historyCount)) {
        ruleState.historyCount += normalizedDetail.historyCount;
        ruleState.lastHistoryCount = normalizedDetail.historyCount;
      }
      if (
        typeof normalizedDetail.combinedHistoryCount === 'number' &&
        Number.isFinite(normalizedDetail.combinedHistoryCount)
      ) {
        ruleState.combinedHistoryCount += normalizedDetail.combinedHistoryCount;
        ruleState.lastCombinedHistoryCount = normalizedDetail.combinedHistoryCount;
      }
      if (normalizedDetail.type) {
        ruleState.lastType = normalizedDetail.type;
      }
      if (normalizedDetail.rateLimit) {
        ruleState.lastRateLimit = normalizedDetail.rateLimit;
      }
      if (cooldownValue !== null) {
        ruleState.lastCooldownMs = cooldownValue;
      }
      this.suppressionRules.set(ruleId, ruleState);
    }
  }

  recordRetentionRun(context: RetentionRunContext) {
    this.retentionRuns += 1;
    this.lastRetentionRunAt = Date.now();
    this.retentionTotals = {
      removedEvents: this.retentionTotals.removedEvents + (context.removedEvents ?? 0),
      archivedSnapshots: this.retentionTotals.archivedSnapshots + (context.archivedSnapshots ?? 0),
      prunedArchives: this.retentionTotals.prunedArchives + (context.prunedArchives ?? 0)
    };
    if (context.perCamera) {
      for (const [camera, stats] of Object.entries(context.perCamera)) {
        if (!camera) {
          continue;
        }
        const existing = this.retentionTotalsByCamera.get(camera) ?? {
          archivedSnapshots: 0,
          prunedArchives: 0
        };
        const archived =
          typeof stats?.archivedSnapshots === 'number' && Number.isFinite(stats.archivedSnapshots)
            ? stats.archivedSnapshots
            : 0;
        const pruned =
          typeof stats?.prunedArchives === 'number' && Number.isFinite(stats.prunedArchives)
            ? stats.prunedArchives
            : 0;
        existing.archivedSnapshots += archived;
        existing.prunedArchives += pruned;
        this.retentionTotalsByCamera.set(camera, existing);
      }
    }
  }

  recordRetentionWarning(warning: { camera?: string | null; path: string; reason: string }) {
    this.retentionWarnings += 1;
    const cameraKey = warning.camera ?? 'unknown';
    this.retentionWarningsByCamera.set(
      cameraKey,
      (this.retentionWarningsByCamera.get(cameraKey) ?? 0) + 1
    );
    this.lastRetentionWarning = {
      camera: warning.camera ?? null,
      path: warning.path,
      reason: warning.reason
    };
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
      exitCode?: number | null;
      errorCode?: string | number | null;
      signal?: NodeJS.Signals | null;
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
        jitterMs: typeof meta?.jitterMs === 'number' ? meta?.jitterMs : null,
        exitCode: typeof meta?.exitCode === 'number' ? meta?.exitCode : null,
        errorCode:
          typeof meta?.errorCode === 'string' || typeof meta?.errorCode === 'number'
            ? meta?.errorCode
            : null,
        signal: meta?.signal ?? null,
        channel: meta?.channel ?? null
      };
      this.lastFfmpegRestartMeta = metaPayload;
      if (channel) {
        const state = getPipelineChannelState(this.ffmpegRestartsByChannel, channel);
        updatePipelineChannelState(state, metaPayload, normalized);
      }
      if (typeof meta?.attempt === 'number' && meta.attempt >= 0) {
        const attemptKey = String(meta.attempt);
        this.ffmpegRestartAttempts.set(
          attemptKey,
          (this.ffmpegRestartAttempts.get(attemptKey) ?? 0) + 1
        );
        this.observeHistogram('pipeline.ffmpeg.restart.attempt', meta.attempt, RESTART_ATTEMPT_HISTOGRAM);
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
        jitterMs: typeof meta?.jitterMs === 'number' ? meta?.jitterMs : null,
        exitCode: typeof meta?.exitCode === 'number' ? meta?.exitCode : null,
        errorCode:
          typeof meta?.errorCode === 'string' || typeof meta?.errorCode === 'number'
            ? meta?.errorCode
            : null,
        signal: meta?.signal ?? null,
        channel: meta?.channel ?? null
      };
      this.lastAudioRestartMeta = metaPayload;
      if (channel) {
        const state = getPipelineChannelState(this.audioRestartsByChannel, channel);
        updatePipelineChannelState(state, metaPayload, normalized);
      }
      if (typeof meta?.attempt === 'number' && meta.attempt >= 0) {
        const attemptKey = String(meta.attempt);
        this.audioRestartAttempts.set(
          attemptKey,
          (this.audioRestartAttempts.get(attemptKey) ?? 0) + 1
        );
        this.observeHistogram('pipeline.audio.restart.attempt', meta.attempt, RESTART_ATTEMPT_HISTOGRAM);
      }
    }

    const delay = meta?.delayMs;
    if (typeof delay === 'number' && delay >= 0) {
      const metric = `pipeline.${type}.restart.delay`;
      this.observeLatency(metric, delay);
      this.observeHistogram(metric, delay);
    }
  }

  recordAudioDeviceDiscovery(reason: string, meta: { channel?: string } = {}) {
    const normalized = reason || 'unknown';
    this.audioDeviceDiscovery.set(
      normalized,
      (this.audioDeviceDiscovery.get(normalized) ?? 0) + 1
    );

    if (meta.channel) {
      const byReason = this.audioDeviceDiscoveryByChannel.get(meta.channel) ?? new Map<string, number>();
      byReason.set(normalized, (byReason.get(normalized) ?? 0) + 1);
      this.audioDeviceDiscoveryByChannel.set(meta.channel, byReason);
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
    const state = getDetectorMetricState(this.detectorMetrics, detector);
    state.lastRunAt = Date.now();
    const latency: DetectorLatencyState = state.latency ?? {
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0
    };
    latency.count += 1;
    latency.totalMs += durationMs;
    latency.minMs = Math.min(latency.minMs, durationMs);
    latency.maxMs = Math.max(latency.maxMs, durationMs);
    state.latency = latency;
    const histogram = state.latencyHistogram ?? new Map<string, number>();
    const bucketLabel = resolveHistogramBucket(durationMs, DEFAULT_HISTOGRAM);
    histogram.set(bucketLabel, (histogram.get(bucketLabel) ?? 0) + 1);
    state.latencyHistogram = histogram;
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
    const ffmpegDelayHistogram = this.histograms.get('pipeline.ffmpeg.restart.delay');
    const ffmpegAttemptHistogram = this.histograms.get('pipeline.ffmpeg.restart.attempt');
    const audioDelayHistogram = this.histograms.get('pipeline.audio.restart.delay');
    const audioAttemptHistogram = this.histograms.get('pipeline.audio.restart.attempt');

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
        lastErrorMessage: this.lastErrorMessage,
        histogram: mapFrom(this.logLevelHistogram)
      },
      latencies: mapFromLatencies(this.latencyStats),
      histograms: mapFromHistograms(this.histograms),
      pipelines: {
        ffmpeg: {
          restarts: this.ffmpegRestarts,
          lastRestartAt: this.lastFfmpegRestartAt ? new Date(this.lastFfmpegRestartAt).toISOString() : null,
          byReason: mapFrom(this.ffmpegRestartReasons),
          lastRestart: this.lastFfmpegRestartMeta,
          attempts: mapFrom(this.ffmpegRestartAttempts),
          byChannel: mapFromPipelineChannels(this.ffmpegRestartsByChannel),
          deviceDiscovery: {},
          deviceDiscoveryByChannel: {},
          delayHistogram: mapFrom(ffmpegDelayHistogram ?? new Map()),
          attemptHistogram: mapFrom(ffmpegAttemptHistogram ?? new Map())
        },
        audio: {
          restarts: this.audioRestarts,
          lastRestartAt: this.lastAudioRestartAt ? new Date(this.lastAudioRestartAt).toISOString() : null,
          byReason: mapFrom(this.audioRestartReasons),
          lastRestart: this.lastAudioRestartMeta,
          attempts: mapFrom(this.audioRestartAttempts),
          byChannel: mapFromPipelineChannels(this.audioRestartsByChannel),
          deviceDiscovery: mapFrom(this.audioDeviceDiscovery),
          deviceDiscoveryByChannel: mapFromNested(this.audioDeviceDiscoveryByChannel),
          delayHistogram: mapFrom(audioDelayHistogram ?? new Map()),
          attemptHistogram: mapFrom(audioAttemptHistogram ?? new Map())
        }
      },
      suppression: {
        total: this.suppressionTotal,
        byRule: mapFrom(this.suppressionByRule),
        byReason: mapFrom(this.suppressionByReason),
        byType: mapFrom(this.suppressionByType),
        historyTotals: {
          historyCount: this.suppressionHistoryCount,
          combinedHistoryCount: this.suppressionCombinedHistoryCount
        },
        lastEvent: this.lastSuppressedEvent ? { ...this.lastSuppressedEvent } : null,
        rules: mapFromSuppressionRules(this.suppressionRules)
      },
      retention: {
        runs: this.retentionRuns,
        lastRunAt: this.lastRetentionRunAt ? new Date(this.lastRetentionRunAt).toISOString() : null,
        warnings: this.retentionWarnings,
        warningsByCamera: mapFrom(this.retentionWarningsByCamera),
        lastWarning: this.lastRetentionWarning ? { ...this.lastRetentionWarning } : null,
        totals: { ...this.retentionTotals },
        totalsByCamera: mapFromRetentionCameras(this.retentionTotalsByCamera)
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
  historyCount: number;
  combinedHistoryCount: number;
  lastHistoryCount: number | null;
  lastCombinedHistoryCount: number | null;
  lastType: 'window' | 'rate-limit' | null;
  lastRateLimit: RateLimitConfig | null;
  lastCooldownMs: number | null;
};

type DetectorMetricState = {
  counters: Map<string, number>;
  lastRunAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  latency: DetectorLatencyState | null;
  latencyHistogram: Map<string, number> | null;
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

function mapFromSuppressionRules(source: Map<string, SuppressionRuleState>): Record<string, SuppressionRuleSnapshot> {
  const result: Record<string, SuppressionRuleSnapshot> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [ruleId, state] of ordered) {
    result[ruleId] = {
      total: state.total,
      byReason: mapFrom(state.byReason),
      history: {
        total: state.historyCount,
        combinedTotal: state.combinedHistoryCount,
        lastCount: state.lastHistoryCount,
        lastCombinedCount: state.lastCombinedHistoryCount,
        lastType: state.lastType,
        lastRateLimit: state.lastRateLimit,
        lastCooldownMs: state.lastCooldownMs
      }
    };
  }
  return result;
}

function mapFromRetentionCameras(
  source: Map<string, RetentionCameraTotals>
): Record<string, RetentionCameraTotals> {
  const result: Record<string, RetentionCameraTotals> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [camera, totals] of ordered) {
    result[camera] = {
      archivedSnapshots: totals.archivedSnapshots,
      prunedArchives: totals.prunedArchives
    };
  }
  return result;
}

function mapFromDetectors(source: Map<string, DetectorMetricState>): Record<string, DetectorSnapshot> {
  const result: Record<string, DetectorSnapshot> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [detector, state] of ordered) {
    const histogramEntries = state.latencyHistogram
      ? Array.from(state.latencyHistogram.entries()).sort(([a], [b]) => compareHistogramKeys(a, b))
      : [];
    result[detector] = {
      counters: mapFrom(state.counters),
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
      lastErrorAt: state.lastErrorAt ? new Date(state.lastErrorAt).toISOString() : null,
      lastErrorMessage: state.lastErrorMessage,
      latency:
        state.latency
          ? {
              count: state.latency.count,
              totalMs: state.latency.totalMs,
              minMs: state.latency.minMs === Number.POSITIVE_INFINITY ? 0 : state.latency.minMs,
              maxMs: state.latency.maxMs,
              averageMs:
                state.latency.count === 0 ? 0 : state.latency.totalMs / state.latency.count
            }
          : null,
      latencyHistogram: Object.fromEntries(histogramEntries)
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
    lastErrorMessage: null,
    latency: null,
    latencyHistogram: null
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
  DetectorSnapshot,
  SuppressedEventMetric,
  RetentionSnapshot
};
export { MetricsRegistry };
export default defaultRegistry;
