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
  minJitterMs: number | null;
  maxJitterMs: number | null;
  exitCode: number | null;
  errorCode: string | number | null;
  signal: NodeJS.Signals | null;
  channel: string | null;
  at: string | null;
};

type PipelineChannelSnapshot = {
  restarts: number;
  watchdogRestarts: number;
  lastRestartAt: string | null;
  byReason: CounterMap;
  lastRestart: PipelineRestartMeta | null;
  restartHistory: PipelineRestartHistorySnapshot[];
  historyLimit: number;
  droppedHistory: number;
  totalRestartDelayMs: number;
  totalWatchdogBackoffMs: number;
  watchdogBackoffMs: number;
  lastWatchdogJitterMs: number | null;
  totalJitterMs: number;
  lastJitterMs: number | null;
  jitterHistogram: HistogramSnapshot;
  delayHistogram: HistogramSnapshot;
  attemptHistogram: HistogramSnapshot;
};

type PipelineRestartHistorySnapshot = {
  reason: string;
  attempt: number | null;
  delayMs: number | null;
  baseDelayMs: number | null;
  minDelayMs: number | null;
  maxDelayMs: number | null;
  jitterMs: number | null;
  minJitterMs: number | null;
  maxJitterMs: number | null;
  exitCode: number | null;
  errorCode: string | number | null;
  signal: NodeJS.Signals | null;
  at: string;
};

type PipelineSnapshot = PipelineChannelSnapshot & {
  attempts: CounterMap;
  byChannel: Record<string, PipelineChannelSnapshot>;
  deviceDiscovery: CounterMap;
  deviceDiscoveryByChannel: Record<string, CounterMap>;
  delayHistogram: HistogramSnapshot;
  attemptHistogram: HistogramSnapshot;
  watchdogBackoffByChannel: Record<string, number>;
  watchdogRestartsByChannel: Record<string, number>;
  lastWatchdogJitterMs: number | null;
  restartHistogram: {
    delay: HistogramSnapshot;
    attempt: HistogramSnapshot;
  };
};

type SuppressionSnapshot = {
  total: number;
  byRule: CounterMap;
  byReason: CounterMap;
  byType: CounterMap;
  byChannel: CounterMap;
  byChannelReason: Record<string, CounterMap>;
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
    maxEvents?: number | null;
    channel?: string | null;
    channels?: string[] | null;
    windowExpiresAt?: string | null;
    windowRemainingMs?: number | null;
    windowEndsAt?: string | null;
    cooldownRemainingMs?: number | null;
    cooldownEndsAt?: string | null;
    channelStates?: Record<
      string,
      {
        hits?: number;
        reasons?: string[];
        types?: Array<'window' | 'rate-limit'>;
        windowRemainingMs?: number | null;
        cooldownRemainingMs?: number | null;
        historyCount?: number | null;
        combinedHistoryCount?: number | null;
      }
    > | null;
  } | null;
  rules: Record<string, SuppressionRuleSnapshot>;
  histogram: {
    historyCount: HistogramSnapshot;
    combinedHistoryCount: HistogramSnapshot;
    cooldownMs: HistogramSnapshot;
    cooldownRemainingMs: HistogramSnapshot;
    windowRemainingMs: HistogramSnapshot;
    channel: {
      cooldownMs: Record<string, HistogramSnapshot>;
      cooldownRemainingMs: Record<string, HistogramSnapshot>;
      windowRemainingMs: Record<string, HistogramSnapshot>;
      historyCount: Record<string, HistogramSnapshot>;
    };
  };
};

type SuppressionRuleSnapshot = {
  total: number;
  byReason: CounterMap;
  byChannel: CounterMap;
  history: {
    total: number;
    combinedTotal: number;
    lastCount: number | null;
    lastCombinedCount: number | null;
    lastType: 'window' | 'rate-limit' | null;
    lastRateLimit: RateLimitConfig | null;
    lastCooldownMs: number | null;
    lastMaxEvents: number | null;
    lastChannel: string | null;
    lastChannels: string[] | null;
    lastWindowExpiresAt: string | null;
    lastWindowRemainingMs: number | null;
    lastCooldownRemainingMs: number | null;
    lastCooldownEndsAt: string | null;
  };
};

type SuppressedEventMetric = {
  ruleId?: string;
  reason?: string;
  type?: 'window' | 'rate-limit';
  historyCount?: number;
  history?: number[];
  combinedHistory?: number[];
  windowExpiresAt?: number;
  rateLimit?: RateLimitConfig;
  cooldownMs?: number;
  maxEvents?: number;
  combinedHistoryCount?: number;
  channel?: string;
  channels?: string[];
  windowRemainingMs?: number;
  cooldownRemainingMs?: number;
  cooldownExpiresAt?: number;
  channelStates?: Record<
    string,
    {
      hits?: number;
      reasons?: string[];
      types?: Array<'window' | 'rate-limit'>;
      windowRemainingMs?: number | null;
      maxWindowRemainingMs?: number | null;
      cooldownRemainingMs?: number | null;
      maxCooldownRemainingMs?: number | null;
      historyCount?: number | null;
      combinedHistoryCount?: number | null;
      history?: number[];
      combinedHistory?: number[];
    }
  >;
};

type RetentionTotals = {
  removedEvents: number;
  archivedSnapshots: number;
  prunedArchives: number;
};

export type RetentionWarningSnapshot = {
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
  gauges: CounterMap;
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
    currentLevel: string;
    lastLevelChangeAt: string | null;
    levelChanges: CounterMap;
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

type PrometheusHistogramOptions = {
  metricName?: string;
  help?: string;
  labels?: Record<string, string>;
};

type PrometheusGaugeOptions = {
  metricName?: string;
  help?: string;
  labels?: Record<string, string>;
};

type PrometheusLogLevelOptions = {
  levelMetricName?: string;
  levelHelp?: string;
  detectorMetricName?: string;
  detectorHelp?: string;
  lastErrorMetricName?: string;
  lastErrorHelp?: string;
  stateMetricName?: string;
  stateHelp?: string;
  changeMetricName?: string;
  changeHelp?: string;
  lastChangeMetricName?: string;
  lastChangeHelp?: string;
  labels?: Record<string, string>;
};

type PrometheusDetectorOptions = {
  counterMetricName?: string;
  counterHelp?: string;
  gaugeMetricName?: string;
  gaugeHelp?: string;
  labels?: Record<string, string>;
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

const COUNTER_HISTOGRAM: HistogramConfig = {
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
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

type PipelineType = 'ffmpeg' | 'audio';
type PipelineHistogramVariant = 'delay' | 'attempt' | 'jitter' | 'restarts';

const DEFAULT_RESTART_HISTORY_LIMIT = 50;

const PIPELINE_HISTOGRAM_SUFFIX: Record<PipelineHistogramVariant, string> = {
  delay: 'restart_delay_ms',
  attempt: 'restart_attempt',
  jitter: 'restart_jitter_ms',
  restarts: 'restarts_total'
} as const;

const PIPELINE_HISTOGRAM_HELP: Record<PipelineHistogramVariant, string> = {
  delay: 'Pipeline restart delay in milliseconds',
  attempt: 'Pipeline restart attempts recorded for exponential backoff',
  jitter: 'Pipeline restart jitter applied in milliseconds',
  restarts: 'Pipeline restart counter histogram'
} as const;

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
  private currentLogLevel = 'info';
  private lastLogLevelChangeAt: number | null = null;
  private readonly logLevelChangeCounters = new Map<string, number>();
  private readonly detectorCounters = new Map<string, number>();
  private readonly severityCounters = new Map<string, number>();
  private readonly latencyStats = new Map<string, { count: number; totalMs: number; minMs: number; maxMs: number }>();
  private readonly histograms = new Map<string, Map<string, number>>();
  private readonly histogramStats = new Map<string, { sum: number; count: number }>();
  private readonly histogramConfigs = new Map<string, HistogramConfig>();
  private readonly reservedHistograms: Array<{ metric: string; config: HistogramConfig }> = [];
  private readonly ffmpegRestartReasons = new Map<string, number>();
  private readonly audioRestartReasons = new Map<string, number>();
  private readonly ffmpegRestartsByChannel = new Map<string, PipelineChannelState>();
  private readonly audioRestartsByChannel = new Map<string, PipelineChannelState>();
  private readonly ffmpegRestartState = createPipelineChannelState();
  private readonly audioRestartState = createPipelineChannelState();
  private readonly ffmpegRestartAttempts = new Map<string, number>();
  private readonly audioRestartAttempts = new Map<string, number>();
  private readonly audioDeviceDiscovery = new Map<string, number>();
  private readonly audioDeviceDiscoveryByChannel = new Map<string, Map<string, number>>();
  private lastFfmpegRestartMeta: PipelineRestartMeta | null = null;
  private lastAudioRestartMeta: PipelineRestartMeta | null = null;
  private readonly suppressionByRule = new Map<string, number>();
  private readonly suppressionByReason = new Map<string, number>();
  private readonly suppressionByType = new Map<string, number>();
  private readonly suppressionByChannel = new Map<string, number>();
  private readonly suppressionRules = new Map<string, SuppressionRuleState>();
  private readonly suppressionChannelCooldownHistogram = new Map<string, Map<string, number>>();
  private readonly suppressionChannelCooldownRemainingHistogram = new Map<
    string,
    Map<string, number>
  >();
  private readonly suppressionChannelWindowHistogram = new Map<string, Map<string, number>>();
  private readonly suppressionChannelHistoryHistogram = new Map<string, Map<string, number>>();
  private readonly suppressionChannelReasonCounters = new Map<string, Map<string, number>>();
  private lastSuppressedEvent: {
    ruleId?: string;
    reason?: string;
    type?: 'window' | 'rate-limit';
    historyCount?: number | null;
    combinedHistoryCount?: number | null;
    rateLimit?: RateLimitConfig | null;
    cooldownMs?: number | null;
    maxEvents?: number | null;
    channel?: string | null;
    channels?: string[] | null;
    windowExpiresAt?: number | null;
    windowRemainingMs?: number | null;
    windowEndsAt?: number | null;
    cooldownRemainingMs?: number | null;
    cooldownEndsAt?: number | null;
    channelStates?: SuppressedEventMetric['channelStates'];
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

  constructor() {
    this.registerReservedHistogram('logs.level', LOG_LEVEL_HISTOGRAM);
    this.registerReservedHistogram('pipeline.ffmpeg.restart.delay', DEFAULT_HISTOGRAM);
    this.registerReservedHistogram('pipeline.ffmpeg.restart.attempt', RESTART_ATTEMPT_HISTOGRAM);
    this.registerReservedHistogram('pipeline.ffmpeg.restarts', COUNTER_HISTOGRAM);
    this.registerReservedHistogram('pipeline.ffmpeg.restart.jitter', DEFAULT_HISTOGRAM);
    this.registerReservedHistogram('pipeline.audio.restart.delay', DEFAULT_HISTOGRAM);
    this.registerReservedHistogram('pipeline.audio.restart.attempt', RESTART_ATTEMPT_HISTOGRAM);
    this.registerReservedHistogram('pipeline.audio.restarts', COUNTER_HISTOGRAM);
    this.registerReservedHistogram('pipeline.audio.restart.jitter', DEFAULT_HISTOGRAM);
    this.registerReservedHistogram('suppression.historyCount', COUNTER_HISTOGRAM);
    this.registerReservedHistogram('suppression.combinedHistoryCount', COUNTER_HISTOGRAM);
    this.registerReservedHistogram('suppression.cooldownMs', DEFAULT_HISTOGRAM);
    this.registerReservedHistogram('suppression.cooldownRemainingMs', DEFAULT_HISTOGRAM);
    this.registerReservedHistogram('suppression.windowRemainingMs', DEFAULT_HISTOGRAM);
  }

  reset() {
    this.logLevelCounters.clear();
    this.logLevelByDetector.clear();
    this.logLevelHistogram.clear();
    this.logLevelChangeCounters.clear();
    this.currentLogLevel = 'info';
    this.lastLogLevelChangeAt = null;
    this.detectorCounters.clear();
    this.severityCounters.clear();
    this.latencyStats.clear();
    this.histograms.clear();
    this.histogramStats.clear();
    this.histogramConfigs.clear();
    this.restoreReservedHistograms();
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
    resetPipelineChannelState(this.ffmpegRestartState);
    resetPipelineChannelState(this.audioRestartState);
    this.suppressionByRule.clear();
    this.suppressionByReason.clear();
    this.suppressionByType.clear();
    this.suppressionByChannel.clear();
    this.suppressionRules.clear();
    this.suppressionChannelCooldownHistogram.clear();
    this.suppressionChannelCooldownRemainingHistogram.clear();
    this.suppressionChannelWindowHistogram.clear();
    this.suppressionChannelHistoryHistogram.clear();
    this.suppressionChannelReasonCounters.clear();
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

  private registerReservedHistogram(metric: string, config: HistogramConfig) {
    this.reservedHistograms.push({ metric, config });
    this.ensureHistogram(metric, config);
  }

  private restoreReservedHistograms() {
    for (const entry of this.reservedHistograms) {
      this.ensureHistogram(entry.metric, entry.config);
    }
  }

  private ensureHistogram(metric: string, config: HistogramConfig) {
    const histogram = this.histograms.get(metric);
    if (histogram) {
      const existing = this.histogramConfigs.get(metric);
      if (!existing || existing !== config) {
        this.histogramConfigs.set(metric, config);
      }
      return histogram;
    }
    const map = new Map<string, number>();
    this.histograms.set(metric, map);
    this.histogramConfigs.set(metric, config);
    return map;
  }

  private clearHistogram(metric: string) {
    this.histograms.delete(metric);
    this.histogramConfigs.delete(metric);
    this.histogramStats.delete(metric);
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

  recordLogLevelChange(level: string, previous?: string | null) {
    const normalized = level.toLowerCase();
    const previousNormalized = typeof previous === 'string' ? previous.toLowerCase() : null;
    this.currentLogLevel = normalized;
    if (previousNormalized && previousNormalized === normalized) {
      return;
    }
    if (previousNormalized) {
      this.lastLogLevelChangeAt = Date.now();
      this.logLevelChangeCounters.set(
        normalized,
        (this.logLevelChangeCounters.get(normalized) ?? 0) + 1
      );
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
    const recordSuppressionChannelHistogram = (
      registry: Map<string, Map<string, number>>,
      channel: string,
      value: number
    ) => {
      if (!Number.isFinite(value) || value < 0) {
        return;
      }
      const bucket = resolveHistogramBucket(value, DEFAULT_HISTOGRAM);
      const histogram = registry.get(channel);
      if (histogram) {
        histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
        return;
      }
      const created = new Map<string, number>();
      created.set(bucket, 1);
      registry.set(channel, created);
    };
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
      this.observeHistogram('suppression.historyCount', normalizedDetail.historyCount, COUNTER_HISTOGRAM);
    }
    if (
      typeof normalizedDetail.combinedHistoryCount === 'number' &&
      Number.isFinite(normalizedDetail.combinedHistoryCount)
    ) {
      this.suppressionCombinedHistoryCount += normalizedDetail.combinedHistoryCount;
      this.observeHistogram(
        'suppression.combinedHistoryCount',
        normalizedDetail.combinedHistoryCount,
        COUNTER_HISTOGRAM
      );
    }
    const cooldownValue =
      typeof normalizedDetail.cooldownMs === 'number' && Number.isFinite(normalizedDetail.cooldownMs)
        ? normalizedDetail.cooldownMs
        : null;
    const normalizedChannelStates = normalizedDetail.channelStates
      ? Object.fromEntries(
          Object.entries(normalizedDetail.channelStates)
            .map(([key, value]) => [
              typeof key === 'string' ? key.trim() : '',
              value ?? {}
            ])
            .filter(([key]) => key.length > 0)
        )
      : null;
    const detailChannels = Array.isArray(normalizedDetail.channels)
      ? normalizedDetail.channels
          .map(channel => (typeof channel === 'string' ? channel.trim() : ''))
          .filter(channel => channel.length > 0)
      : [];
    const explicitChannel =
      typeof normalizedDetail.channel === 'string' && normalizedDetail.channel.trim().length > 0
        ? normalizedDetail.channel.trim()
        : null;
    const channelSet = new Set<string>();
    for (const channel of detailChannels) {
      channelSet.add(channel);
    }
    if (explicitChannel) {
      channelSet.add(explicitChannel);
    }
    if (normalizedChannelStates) {
      for (const channel of Object.keys(normalizedChannelStates)) {
        channelSet.add(channel);
      }
    }
    const channelList = Array.from(channelSet).sort((a, b) => a.localeCompare(b));
    const primaryChannel = explicitChannel ?? channelList[0] ?? null;
    const windowExpiresAtValue =
      typeof normalizedDetail.windowExpiresAt === 'number' &&
      Number.isFinite(normalizedDetail.windowExpiresAt)
        ? normalizedDetail.windowExpiresAt
        : null;
    const windowRemainingValue =
      typeof normalizedDetail.windowRemainingMs === 'number' &&
      Number.isFinite(normalizedDetail.windowRemainingMs)
        ? Math.max(0, normalizedDetail.windowRemainingMs)
        : null;
    const cooldownRemainingValue =
      typeof normalizedDetail.cooldownRemainingMs === 'number' &&
      Number.isFinite(normalizedDetail.cooldownRemainingMs)
        ? Math.max(0, normalizedDetail.cooldownRemainingMs)
        : null;
    const cooldownExpiresAtValue =
      typeof normalizedDetail.cooldownExpiresAt === 'number' &&
      Number.isFinite(normalizedDetail.cooldownExpiresAt)
        ? normalizedDetail.cooldownExpiresAt
        : null;
    let effectiveCooldownEndsAt = cooldownExpiresAtValue;
    if (
      effectiveCooldownEndsAt === null &&
      typeof windowExpiresAtValue === 'number' &&
      typeof windowRemainingValue === 'number' &&
      typeof cooldownRemainingValue === 'number'
    ) {
      const eventTs = windowExpiresAtValue - windowRemainingValue;
      if (Number.isFinite(eventTs)) {
        effectiveCooldownEndsAt = eventTs + cooldownRemainingValue;
      }
    }
    if (typeof cooldownValue === 'number') {
      this.observeHistogram('suppression.cooldownMs', cooldownValue);
    }
    if (typeof windowRemainingValue === 'number') {
      this.observeHistogram('suppression.windowRemainingMs', windowRemainingValue);
    }
    if (typeof cooldownRemainingValue === 'number') {
      this.observeHistogram('suppression.cooldownRemainingMs', cooldownRemainingValue);
    }
    if (channelList.length > 0) {
      for (const channel of channelList) {
        this.suppressionByChannel.set(channel, (this.suppressionByChannel.get(channel) ?? 0) + 1);
        const channelState = normalizedChannelStates?.[channel];
        const channelCooldown =
          typeof channelState?.cooldownRemainingMs === 'number' &&
          Number.isFinite(channelState.cooldownRemainingMs)
            ? Math.max(0, channelState.cooldownRemainingMs ?? 0)
            : cooldownRemainingValue;
        const channelWindow =
          typeof channelState?.windowRemainingMs === 'number' &&
          Number.isFinite(channelState.windowRemainingMs)
            ? Math.max(0, channelState.windowRemainingMs ?? 0)
            : windowRemainingValue;
        const channelHistoryCount =
          typeof channelState?.historyCount === 'number' && Number.isFinite(channelState.historyCount)
            ? Math.max(0, channelState.historyCount ?? 0)
            : null;
        const channelCooldownTotal =
          typeof cooldownValue === 'number' ? cooldownValue : channelState?.cooldownRemainingMs ?? null;

        if (typeof channelCooldownTotal === 'number' && Number.isFinite(channelCooldownTotal)) {
          recordSuppressionChannelHistogram(
            this.suppressionChannelCooldownHistogram,
            channel,
            channelCooldownTotal
          );
        }
        if (typeof channelWindow === 'number') {
          recordSuppressionChannelHistogram(
            this.suppressionChannelWindowHistogram,
            channel,
            channelWindow
          );
        }
        if (typeof channelCooldown === 'number') {
          recordSuppressionChannelHistogram(
            this.suppressionChannelCooldownRemainingHistogram,
            channel,
            channelCooldown
          );
        }
        if (typeof channelHistoryCount === 'number') {
          recordSuppressionChannelHistogram(
            this.suppressionChannelHistoryHistogram,
            channel,
            channelHistoryCount
          );
        } else if (
          typeof normalizedDetail.historyCount === 'number' &&
          Number.isFinite(normalizedDetail.historyCount)
        ) {
          recordSuppressionChannelHistogram(
            this.suppressionChannelHistoryHistogram,
            channel,
            normalizedDetail.historyCount
          );
        }

        const reasonsForChannel = Array.isArray(channelState?.reasons) && channelState?.reasons?.length
          ? channelState.reasons.filter(reasonKey => typeof reasonKey === 'string' && reasonKey.trim().length > 0)
          : reason
          ? [reason]
          : [];
        if (reasonsForChannel.length > 0) {
          const counter = this.suppressionChannelReasonCounters.get(channel) ?? new Map<string, number>();
          for (const entry of reasonsForChannel) {
            const normalizedReason = entry.trim();
            counter.set(normalizedReason, (counter.get(normalizedReason) ?? 0) + 1);
          }
          this.suppressionChannelReasonCounters.set(channel, counter);
        }
      }
    }
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
      cooldownMs: cooldownValue,
      maxEvents:
        typeof normalizedDetail.maxEvents === 'number' && Number.isFinite(normalizedDetail.maxEvents)
          ? normalizedDetail.maxEvents
          : null,
      channel: primaryChannel,
      channels: channelList.length > 0 ? [...channelList] : null,
      channelStates: normalizedChannelStates,
      windowExpiresAt: windowExpiresAtValue,
      windowRemainingMs: windowRemainingValue,
      cooldownRemainingMs: cooldownRemainingValue,
      windowEndsAt: windowExpiresAtValue,
      cooldownEndsAt: effectiveCooldownEndsAt
    };
    if (ruleId) {
      this.suppressionByRule.set(ruleId, (this.suppressionByRule.get(ruleId) ?? 0) + 1);
      const ruleState = this.suppressionRules.get(ruleId) ?? {
        total: 0,
        byReason: new Map<string, number>(),
        byChannel: new Map<string, number>(),
        historyCount: 0,
        combinedHistoryCount: 0,
        lastHistoryCount: null,
        lastCombinedHistoryCount: null,
        lastType: null,
        lastRateLimit: null,
        lastCooldownMs: null,
        lastMaxEvents: null,
        lastChannel: null,
        lastChannels: null,
        lastWindowExpiresAt: null,
        lastWindowRemainingMs: null,
        lastCooldownRemainingMs: null,
        lastCooldownEndsAt: null
      };
      ruleState.total += 1;
      if (reason) {
        ruleState.byReason.set(reason, (ruleState.byReason.get(reason) ?? 0) + 1);
      }
      if (channelList.length > 0) {
        for (const channel of channelList) {
          ruleState.byChannel.set(channel, (ruleState.byChannel.get(channel) ?? 0) + 1);
        }
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
      if (typeof normalizedDetail.maxEvents === 'number' && Number.isFinite(normalizedDetail.maxEvents)) {
        ruleState.lastMaxEvents = normalizedDetail.maxEvents;
      }
      ruleState.lastChannel = primaryChannel;
      ruleState.lastChannels = channelList.length > 0 ? [...channelList] : null;
      ruleState.lastWindowExpiresAt = windowExpiresAtValue;
      ruleState.lastWindowRemainingMs = windowRemainingValue;
      ruleState.lastCooldownRemainingMs = cooldownRemainingValue;
      ruleState.lastCooldownEndsAt = effectiveCooldownEndsAt;
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
    const next = current + amount;
    if (!Number.isFinite(next)) {
      return;
    }
    state.counters.set(counter, next);
    state.lastRunAt = Date.now();
    if (next >= 0) {
      const metricName = `detector.${detector}.counter.${counter}`;
      this.observeHistogram(metricName, next, COUNTER_HISTOGRAM);
    }
  }

  resetDetectorCounters(detector: string, counters: string | string[]) {
    const list = Array.isArray(counters) ? counters : [counters];
    if (list.length === 0) {
      return;
    }
    const state = getDetectorMetricState(this.detectorMetrics, detector);
    const now = Date.now();
    for (const counter of list) {
      state.counters.set(counter, 0);
    }
    state.lastRunAt = now;
  }

  setDetectorGauge(detector: string, gauge: string, value: number) {
    if (!Number.isFinite(value)) {
      return;
    }
    const state = getDetectorMetricState(this.detectorMetrics, detector);
    state.lastRunAt = Date.now();
    state.gauges.set(gauge, value);
  }

  recordDetectorError(detector: string, message: string) {
    const state = getDetectorMetricState(this.detectorMetrics, detector);
    state.lastRunAt = Date.now();
    state.lastErrorAt = Date.now();
    state.lastErrorMessage = message;
    const current = state.counters.get('errors') ?? 0;
    const next = current + 1;
    state.counters.set('errors', next);
    this.observeHistogram(`detector.${detector}.counter.errors`, next, COUNTER_HISTOGRAM);
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
      minJitterMs?: number;
      maxJitterMs?: number;
      channel?: string;
      exitCode?: number | null;
      errorCode?: string | number | null;
      signal?: NodeJS.Signals | null;
      at?: number;
    }
  ) {
    const normalized = reason || 'unknown';
    const channel = meta?.channel;
    const occurredAt = typeof meta?.at === 'number' ? meta.at : Date.now();
    if (type === 'ffmpeg') {
      this.ffmpegRestarts += 1;
      this.observeHistogram('pipeline.ffmpeg.restarts', this.ffmpegRestarts, COUNTER_HISTOGRAM);
      this.lastFfmpegRestartAt = occurredAt;
      this.ffmpegRestartReasons.set(normalized, (this.ffmpegRestartReasons.get(normalized) ?? 0) + 1);
      const metaPayload: PipelineRestartMeta = {
        reason: normalized,
        attempt: typeof meta?.attempt === 'number' ? meta?.attempt : null,
        delayMs: typeof meta?.delayMs === 'number' ? meta?.delayMs : null,
        baseDelayMs: typeof meta?.baseDelayMs === 'number' ? meta?.baseDelayMs : null,
        minDelayMs: typeof meta?.minDelayMs === 'number' ? meta?.minDelayMs : null,
        maxDelayMs: typeof meta?.maxDelayMs === 'number' ? meta?.maxDelayMs : null,
        jitterMs: typeof meta?.jitterMs === 'number' ? meta?.jitterMs : null,
        minJitterMs: typeof meta?.minJitterMs === 'number' ? meta?.minJitterMs : null,
        maxJitterMs: typeof meta?.maxJitterMs === 'number' ? meta?.maxJitterMs : null,
        exitCode: typeof meta?.exitCode === 'number' ? meta?.exitCode : null,
        errorCode:
          typeof meta?.errorCode === 'string' || typeof meta?.errorCode === 'number'
            ? meta?.errorCode
            : null,
        signal: meta?.signal ?? null,
        channel: meta?.channel ?? null,
        at: new Date(occurredAt).toISOString()
      };
      this.lastFfmpegRestartMeta = metaPayload;
      updatePipelineChannelState(this.ffmpegRestartState, metaPayload, normalized, occurredAt);
      if (channel) {
        const state = getPipelineChannelState(this.ffmpegRestartsByChannel, channel);
        updatePipelineChannelState(state, metaPayload, normalized, occurredAt);
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
      this.observeHistogram('pipeline.audio.restarts', this.audioRestarts, COUNTER_HISTOGRAM);
      this.lastAudioRestartAt = occurredAt;
      this.audioRestartReasons.set(normalized, (this.audioRestartReasons.get(normalized) ?? 0) + 1);
      const metaPayload: PipelineRestartMeta = {
        reason: normalized,
        attempt: typeof meta?.attempt === 'number' ? meta?.attempt : null,
        delayMs: typeof meta?.delayMs === 'number' ? meta?.delayMs : null,
        baseDelayMs: typeof meta?.baseDelayMs === 'number' ? meta?.baseDelayMs : null,
        minDelayMs: typeof meta?.minDelayMs === 'number' ? meta?.minDelayMs : null,
        maxDelayMs: typeof meta?.maxDelayMs === 'number' ? meta?.maxDelayMs : null,
        jitterMs: typeof meta?.jitterMs === 'number' ? meta?.jitterMs : null,
        minJitterMs: typeof meta?.minJitterMs === 'number' ? meta?.minJitterMs : null,
        maxJitterMs: typeof meta?.maxJitterMs === 'number' ? meta?.maxJitterMs : null,
        exitCode: typeof meta?.exitCode === 'number' ? meta?.exitCode : null,
        errorCode:
          typeof meta?.errorCode === 'string' || typeof meta?.errorCode === 'number'
            ? meta?.errorCode
            : null,
        signal: meta?.signal ?? null,
        channel: meta?.channel ?? null,
        at: new Date(occurredAt).toISOString()
      };
      this.lastAudioRestartMeta = metaPayload;
      updatePipelineChannelState(this.audioRestartState, metaPayload, normalized, occurredAt);
      if (channel) {
        const state = getPipelineChannelState(this.audioRestartsByChannel, channel);
        updatePipelineChannelState(state, metaPayload, normalized, occurredAt);
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

    if (typeof meta?.jitterMs === 'number' && Number.isFinite(meta.jitterMs)) {
      const jitter = Math.abs(meta.jitterMs);
      const jitterMetric = `pipeline.${type}.restart.jitter`;
      this.observeHistogram(jitterMetric, jitter);
      if (channel) {
        const channelMetric = `${jitterMetric}.channel.${channel}`;
        this.observeHistogram(channelMetric, jitter);
      }
    }
  }

  clearPipelineChannel(pipeline: PipelineType, channel: string) {
    const registry = pipeline === 'ffmpeg' ? this.ffmpegRestartsByChannel : this.audioRestartsByChannel;
    if (!registry.delete(channel)) {
      return;
    }

    const jitterMetric = `pipeline.${pipeline}.restart.jitter.channel.${channel}`;
    this.clearHistogram(jitterMetric);
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

  observeHistogram(metric: string, duration: number, config: HistogramConfig = DEFAULT_HISTOGRAM) {
    const histogramConfig = this.histogramConfigs.get(metric) ?? config;
    const histogram = this.ensureHistogram(metric, histogramConfig);

    if (Number.isFinite(duration)) {
      const stats = this.histogramStats.get(metric);
      if (stats) {
        stats.sum += duration;
        stats.count += 1;
      } else {
        this.histogramStats.set(metric, { sum: duration, count: 1 });
      }
    }

    const bucketLabel = resolveHistogramBucket(duration, histogramConfig);
    histogram.set(bucketLabel, (histogram.get(bucketLabel) ?? 0) + 1);
  }

  exportHistogramForPrometheus(metric: string, options: PrometheusHistogramOptions = {}): string {
    const histogram = this.histograms.get(metric);
    if (!histogram) {
      return '';
    }
    const histogramConfig = this.histogramConfigs.get(metric) ?? DEFAULT_HISTOGRAM;
    const stats = this.histogramStats.get(metric);
    return formatPrometheusHistogram(metric, histogram, histogramConfig, stats, options);
  }

  exportLogLevelMetrics() {
    return {
      byLevel: mapLogLevelCounters(this.logLevelCounters),
      byDetector: mapFromNested(this.logLevelByDetector),
      histogram: mapLogLevelCounters(this.logLevelHistogram),
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      lastErrorMessage: this.lastErrorMessage,
      currentLevel: this.currentLogLevel,
      lastLevelChangeAt: this.lastLogLevelChangeAt
        ? new Date(this.lastLogLevelChangeAt).toISOString()
        : null,
      levelChanges: mapFrom(this.logLevelChangeCounters)
    };
  }

  exportLogLevelCountersForPrometheus(options: PrometheusLogLevelOptions = {}) {
    const baseLabels = options.labels ?? {};
    const lines: string[] = [];

    const levelCounters = mapLogLevelCounters(this.logLevelCounters);
    const levelSamples = Object.entries(levelCounters).map(([level, value]) => ({
      value,
      labels: { level }
    }));
    const levelMetric = formatPrometheusGauge(
      'logs.level.total',
      levelSamples,
      {
        metricName: options.levelMetricName ?? 'guardian_log_level_total',
        help: options.levelHelp ?? 'Total log events grouped by Pino level',
        labels: baseLabels
      }
    );
    if (levelMetric) {
      lines.push(levelMetric);
    }

    const stateMetric = formatPrometheusGauge(
      'logs.level.state',
      [
        {
          value: 1,
          labels: { level: this.currentLogLevel }
        }
      ],
      {
        metricName: options.stateMetricName ?? 'guardian_log_level_state',
        help: options.stateHelp ?? 'Current active Pino log level reported by Guardian',
        labels: baseLabels
      }
    );
    if (stateMetric) {
      lines.push(stateMetric);
    }

    const changeSamples = Array.from(this.logLevelChangeCounters.entries()).map(
      ([level, value]) => ({
        value,
        labels: { level }
      })
    );
    const changeMetric = formatPrometheusGauge('logs.level.change.total', changeSamples, {
      metricName: options.changeMetricName ?? 'guardian_log_level_change_total',
      help: options.changeHelp ?? 'Total log level changes grouped by target level',
      labels: baseLabels
    });
    if (changeMetric) {
      lines.push(changeMetric);
    }

    const detectorSamples: Array<{ value: number; labels: Record<string, string> }> = [];
    for (const [detector, counters] of this.logLevelByDetector.entries()) {
      for (const [level, value] of counters.entries()) {
        detectorSamples.push({
          value,
          labels: { detector, level: level.toLowerCase() }
        });
      }
    }
    const detectorMetric = formatPrometheusGauge(
      'logs.level.detector.total',
      detectorSamples,
      {
        metricName: options.detectorMetricName ?? 'guardian_log_level_detector_total',
        help:
          options.detectorHelp ?? 'Total log events grouped by Pino level and detector source',
        labels: baseLabels
      }
    );
    if (detectorMetric) {
      lines.push(detectorMetric);
    }

    if (this.lastErrorAt) {
      const lastErrorMetric = formatPrometheusGauge(
        'logs.level.last_error_timestamp_seconds',
        [
          {
            value: Math.floor(this.lastErrorAt / 1000),
            labels: {}
          }
        ],
        {
          metricName:
            options.lastErrorMetricName ?? 'guardian_log_last_error_timestamp_seconds',
          help:
            options.lastErrorHelp ??
            'Unix timestamp (seconds) for the most recent error or fatal log entry',
          labels: baseLabels
        }
      );
      if (lastErrorMetric) {
        lines.push(lastErrorMetric);
      }
    }

    if (this.lastLogLevelChangeAt) {
      const lastChangeMetric = formatPrometheusGauge(
        'logs.level.last_change_timestamp_seconds',
        [
          {
            value: Math.floor(this.lastLogLevelChangeAt / 1000),
            labels: {}
          }
        ],
        {
          metricName:
            options.lastChangeMetricName ?? 'guardian_log_level_last_change_timestamp_seconds',
          help:
            options.lastChangeHelp ??
            'Unix timestamp (seconds) for the most recent log level change',
          labels: baseLabels
        }
      );
      if (lastChangeMetric) {
        lines.push(lastChangeMetric);
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  exportPipelineWatchdogCounters() {
    const project = (state: PipelineChannelState, channels: Map<string, PipelineChannelState>) => ({
      total: state.watchdogRestarts,
      backoffMs: state.totalWatchdogBackoffMs,
      lastJitterMs: state.lastWatchdogJitterMs,
      byChannel: mapWatchdogRestartsByChannel(channels),
      backoffByChannel: mapWatchdogBackoffByChannel(channels)
    });

    return {
      ffmpeg: project(this.ffmpegRestartState, this.ffmpegRestartsByChannel),
      audio: project(this.audioRestartState, this.audioRestartsByChannel)
    };
  }

  exportPipelineRestartHistogram(
    pipeline: PipelineType,
    variant: PipelineHistogramVariant,
    options: PrometheusHistogramOptions = {}
  ): string {
    const key =
      variant === 'restarts'
        ? `pipeline.${pipeline}.restarts`
        : `pipeline.${pipeline}.restart.${variant}`;

    const metricName = options.metricName ?? `guardian_${pipeline}_${PIPELINE_HISTOGRAM_SUFFIX[variant]}`;
    const baseOptions: PrometheusHistogramOptions = {
      ...options,
      metricName,
      help: options.help ?? PIPELINE_HISTOGRAM_HELP[variant],
      labels: { pipeline, ...(options.labels ?? {}) }
    };

    const rendered: string[] = [];
    const baseHistogram = this.exportHistogramForPrometheus(key, baseOptions);
    if (baseHistogram) {
      rendered.push(baseHistogram);
    }

    if (variant === 'jitter') {
      const prefix = `${key}.channel.`;
      const channelMetrics = Array.from(this.histograms.keys())
        .filter(metricKey => metricKey.startsWith(prefix))
        .sort((a, b) => a.localeCompare(b));

      for (const metricKey of channelMetrics) {
        const channel = metricKey.slice(prefix.length);
        const channelHistogram = this.exportHistogramForPrometheus(metricKey, {
          ...options,
          metricName: `${metricName}_channel_${channel}`,
          labels: { pipeline, channel, ...(options.labels ?? {}) }
        });
        if (channelHistogram) {
          rendered.push(channelHistogram);
        }
      }
    }

    return rendered.join('\n\n');
  }

  exportDetectorLatencyHistogram(
    detector: string,
    options: PrometheusHistogramOptions = {}
  ): string {
    return this.exportHistogramForPrometheus(`detector.${detector}.latency`, options);
  }

  exportDetectorCountersForPrometheus(options: PrometheusDetectorOptions = {}) {
    const baseLabels = options.labels ?? {};
    const counterSamples: Array<{ value: number; labels: Record<string, string> }> = [];
    const gaugeSamples: Array<{ value: number; labels: Record<string, string> }> = [];

    for (const [detector, state] of this.detectorMetrics.entries()) {
      for (const [counter, value] of state.counters.entries()) {
        counterSamples.push({
          value,
          labels: { detector, counter }
        });
      }
      for (const [gauge, value] of state.gauges.entries()) {
        gaugeSamples.push({
          value,
          labels: { detector, gauge }
        });
      }
    }

    const lines: string[] = [];
    const counterMetric = formatPrometheusGauge('detector.counter.total', counterSamples, {
      metricName: options.counterMetricName ?? 'guardian_detector_counter_total',
      help: options.counterHelp ?? 'Detector counter totals grouped by detector and counter name',
      labels: baseLabels
    });
    if (counterMetric) {
      lines.push(counterMetric);
    }

    const gaugeMetric = formatPrometheusGauge('detector.gauge', gaugeSamples, {
      metricName: options.gaugeMetricName ?? 'guardian_detector_gauge',
      help: options.gaugeHelp ?? 'Detector gauge values grouped by detector and gauge name',
      labels: baseLabels
    });
    if (gaugeMetric) {
      lines.push(gaugeMetric);
    }

    return lines.filter(Boolean).join('\n');
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
    const ffmpegByChannel = mapFromPipelineChannels(this.ffmpegRestartsByChannel);
    const audioByChannel = mapFromPipelineChannels(this.audioRestartsByChannel);
    const ffmpegDelaySnapshot = mapHistogram(ffmpegDelayHistogram ?? new Map());
    const ffmpegAttemptSnapshot = mapHistogram(ffmpegAttemptHistogram ?? new Map());
    const audioDelaySnapshot = mapHistogram(audioDelayHistogram ?? new Map());
    const audioAttemptSnapshot = mapHistogram(audioAttemptHistogram ?? new Map());
    const lastSuppressedEventSnapshot = this.lastSuppressedEvent
      ? {
          ruleId: this.lastSuppressedEvent.ruleId,
          reason: this.lastSuppressedEvent.reason,
          type: this.lastSuppressedEvent.type ?? null,
          historyCount:
            typeof this.lastSuppressedEvent.historyCount === 'number'
              ? this.lastSuppressedEvent.historyCount
              : null,
          combinedHistoryCount:
            typeof this.lastSuppressedEvent.combinedHistoryCount === 'number'
              ? this.lastSuppressedEvent.combinedHistoryCount
              : null,
          rateLimit: this.lastSuppressedEvent.rateLimit ? { ...this.lastSuppressedEvent.rateLimit } : null,
          cooldownMs:
            typeof this.lastSuppressedEvent.cooldownMs === 'number'
              ? this.lastSuppressedEvent.cooldownMs
              : null,
          maxEvents:
            typeof this.lastSuppressedEvent.maxEvents === 'number'
              ? this.lastSuppressedEvent.maxEvents
              : null,
          channel: this.lastSuppressedEvent.channel ?? null,
          channels: this.lastSuppressedEvent.channels
            ? [...this.lastSuppressedEvent.channels]
            : this.lastSuppressedEvent.channel
            ? [this.lastSuppressedEvent.channel]
            : null,
          windowExpiresAt:
            typeof this.lastSuppressedEvent.windowExpiresAt === 'number'
              ? new Date(this.lastSuppressedEvent.windowExpiresAt).toISOString()
              : null,
          windowRemainingMs:
            typeof this.lastSuppressedEvent.windowRemainingMs === 'number'
              ? this.lastSuppressedEvent.windowRemainingMs
              : null,
          windowEndsAt:
            typeof this.lastSuppressedEvent.windowEndsAt === 'number'
              ? new Date(this.lastSuppressedEvent.windowEndsAt).toISOString()
              : null,
          cooldownRemainingMs:
            typeof this.lastSuppressedEvent.cooldownRemainingMs === 'number'
              ? this.lastSuppressedEvent.cooldownRemainingMs
              : null,
          cooldownEndsAt:
            typeof this.lastSuppressedEvent.cooldownEndsAt === 'number'
              ? new Date(this.lastSuppressedEvent.cooldownEndsAt).toISOString()
              : null,
          channelStates: mapSuppressionChannelStates(this.lastSuppressedEvent.channelStates)
        }
      : null;
    const logLevelSnapshot = mapLogLevelCounters(this.logLevelCounters);
    const logHistogramSnapshot = mapLogLevelCounters(this.logLevelHistogram);
    const suppressionChannelHistogramSnapshot = {
      cooldownMs: mapSuppressionChannelHistograms(this.suppressionChannelCooldownHistogram),
      cooldownRemainingMs: mapSuppressionChannelHistograms(
        this.suppressionChannelCooldownRemainingHistogram
      ),
      windowRemainingMs: mapSuppressionChannelHistograms(this.suppressionChannelWindowHistogram),
      historyCount: mapSuppressionChannelHistograms(this.suppressionChannelHistoryHistogram)
    };
    const suppressionHistogramSnapshot = {
      historyCount: mapHistogram(this.histograms.get('suppression.historyCount') ?? new Map()),
      combinedHistoryCount: mapHistogram(
        this.histograms.get('suppression.combinedHistoryCount') ?? new Map()
      ),
      cooldownMs: mapHistogram(this.histograms.get('suppression.cooldownMs') ?? new Map()),
      cooldownRemainingMs: mapHistogram(
        this.histograms.get('suppression.cooldownRemainingMs') ?? new Map()
      ),
      windowRemainingMs: mapHistogram(
        this.histograms.get('suppression.windowRemainingMs') ?? new Map()
      ),
      channel: suppressionChannelHistogramSnapshot
    };

    return {
      createdAt: new Date().toISOString(),
      events: {
        total: this.totalEvents,
        lastEventAt: this.lastEventTimestamp ? new Date(this.lastEventTimestamp).toISOString() : null,
        byDetector: mapFrom(this.detectorCounters),
        bySeverity: mapFrom(this.severityCounters)
      },
      logs: {
        byLevel: logLevelSnapshot,
        byDetector: mapFromNested(this.logLevelByDetector),
        lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
        lastErrorMessage: this.lastErrorMessage,
        histogram: logHistogramSnapshot,
        currentLevel: this.currentLogLevel,
        lastLevelChangeAt: this.lastLogLevelChangeAt
          ? new Date(this.lastLogLevelChangeAt).toISOString()
          : null,
        levelChanges: mapFrom(this.logLevelChangeCounters)
      },
      latencies: mapFromLatencies(this.latencyStats),
      histograms: mapFromHistograms(this.histograms),
      pipelines: {
        ffmpeg: {
          restarts: this.ffmpegRestarts,
          watchdogRestarts: this.ffmpegRestartState.watchdogRestarts,
          lastRestartAt: this.lastFfmpegRestartAt ? new Date(this.lastFfmpegRestartAt).toISOString() : null,
          byReason: mapFrom(this.ffmpegRestartReasons),
          lastRestart: this.lastFfmpegRestartMeta,
          restartHistory: mapHistory(this.ffmpegRestartState.restartHistory),
          historyLimit: this.ffmpegRestartState.historyLimit,
          droppedHistory: this.ffmpegRestartState.droppedHistory,
          totalRestartDelayMs: this.ffmpegRestartState.totalDelayMs,
          totalWatchdogBackoffMs: this.ffmpegRestartState.totalWatchdogBackoffMs,
          watchdogBackoffMs: this.ffmpegRestartState.totalWatchdogBackoffMs,
          lastWatchdogJitterMs: this.ffmpegRestartState.lastWatchdogJitterMs,
          totalJitterMs: this.ffmpegRestartState.totalJitterMs,
          lastJitterMs: this.ffmpegRestartState.lastJitterMs,
          jitterHistogram: mapHistogram(this.ffmpegRestartState.jitterHistogram),
          attempts: mapFrom(this.ffmpegRestartAttempts),
          byChannel: ffmpegByChannel,
          watchdogBackoffByChannel: mapWatchdogBackoffByChannel(this.ffmpegRestartsByChannel),
          watchdogRestartsByChannel: mapWatchdogRestartsByChannel(this.ffmpegRestartsByChannel),
          deviceDiscovery: {},
          deviceDiscoveryByChannel: {},
          delayHistogram: ffmpegDelaySnapshot,
          attemptHistogram: ffmpegAttemptSnapshot,
          restartHistogram: {
            delay: ffmpegDelaySnapshot,
            attempt: ffmpegAttemptSnapshot
          }
        },
        audio: {
          restarts: this.audioRestarts,
          watchdogRestarts: this.audioRestartState.watchdogRestarts,
          lastRestartAt: this.lastAudioRestartAt ? new Date(this.lastAudioRestartAt).toISOString() : null,
          byReason: mapFrom(this.audioRestartReasons),
          lastRestart: this.lastAudioRestartMeta,
          restartHistory: mapHistory(this.audioRestartState.restartHistory),
          historyLimit: this.audioRestartState.historyLimit,
          droppedHistory: this.audioRestartState.droppedHistory,
          totalRestartDelayMs: this.audioRestartState.totalDelayMs,
          totalWatchdogBackoffMs: this.audioRestartState.totalWatchdogBackoffMs,
          watchdogBackoffMs: this.audioRestartState.totalWatchdogBackoffMs,
          lastWatchdogJitterMs: this.audioRestartState.lastWatchdogJitterMs,
          totalJitterMs: this.audioRestartState.totalJitterMs,
          lastJitterMs: this.audioRestartState.lastJitterMs,
          jitterHistogram: mapHistogram(this.audioRestartState.jitterHistogram),
          attempts: mapFrom(this.audioRestartAttempts),
          byChannel: audioByChannel,
          watchdogBackoffByChannel: mapWatchdogBackoffByChannel(this.audioRestartsByChannel),
          watchdogRestartsByChannel: mapWatchdogRestartsByChannel(this.audioRestartsByChannel),
          deviceDiscovery: mapFrom(this.audioDeviceDiscovery),
          deviceDiscoveryByChannel: mapFromNested(this.audioDeviceDiscoveryByChannel),
          delayHistogram: audioDelaySnapshot,
          attemptHistogram: audioAttemptSnapshot,
          restartHistogram: {
            delay: audioDelaySnapshot,
            attempt: audioAttemptSnapshot
          }
        }
      },
      suppression: {
        total: this.suppressionTotal,
        byRule: mapFrom(this.suppressionByRule),
        byReason: mapFrom(this.suppressionByReason),
        byType: mapFrom(this.suppressionByType),
        byChannel: mapFrom(this.suppressionByChannel),
        byChannelReason: mapFromNested(this.suppressionChannelReasonCounters),
        historyTotals: {
          historyCount: this.suppressionHistoryCount,
          combinedHistoryCount: this.suppressionCombinedHistoryCount
        },
        lastEvent: lastSuppressedEventSnapshot,
        rules: mapFromSuppressionRules(this.suppressionRules),
        histogram: suppressionHistogramSnapshot
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
  watchdogRestarts: number;
  lastRestartAt: number | null;
  byReason: Map<string, number>;
  lastRestart: PipelineRestartMeta | null;
  restartHistory: PipelineRestartHistoryRecord[];
  historyLimit: number;
  droppedHistory: number;
  totalDelayMs: number;
  totalWatchdogBackoffMs: number;
  lastWatchdogJitterMs: number | null;
  delayHistogram: Map<string, number>;
  attemptHistogram: Map<string, number>;
};

type PipelineRestartHistoryRecord = {
  reason: string;
  attempt: number | null;
  delayMs: number | null;
  baseDelayMs: number | null;
  minDelayMs: number | null;
  maxDelayMs: number | null;
  jitterMs: number | null;
  minJitterMs: number | null;
  maxJitterMs: number | null;
  exitCode: number | null;
  errorCode: string | number | null;
  signal: NodeJS.Signals | null;
  at: number;
};

function mapHistory(entries: PipelineRestartHistoryRecord[]): PipelineRestartHistorySnapshot[] {
  return entries.map(entry => ({
    reason: entry.reason,
    attempt: entry.attempt,
    delayMs: entry.delayMs,
    baseDelayMs: entry.baseDelayMs,
    minDelayMs: entry.minDelayMs,
    maxDelayMs: entry.maxDelayMs,
    jitterMs: entry.jitterMs,
    minJitterMs: entry.minJitterMs,
    maxJitterMs: entry.maxJitterMs,
    exitCode: entry.exitCode,
    errorCode: entry.errorCode,
    signal: entry.signal,
    at: new Date(entry.at).toISOString()
  }));
}

type SuppressionRuleState = {
  total: number;
  byReason: Map<string, number>;
  byChannel: Map<string, number>;
  historyCount: number;
  combinedHistoryCount: number;
  lastHistoryCount: number | null;
  lastCombinedHistoryCount: number | null;
  lastType: 'window' | 'rate-limit' | null;
  lastRateLimit: RateLimitConfig | null;
  lastCooldownMs: number | null;
  lastMaxEvents: number | null;
  lastChannel: string | null;
  lastChannels: string[] | null;
  lastWindowExpiresAt: number | null;
  lastWindowRemainingMs: number | null;
  lastCooldownRemainingMs: number | null;
  lastCooldownEndsAt: number | null;
};

type DetectorMetricState = {
  counters: Map<string, number>;
  gauges: Map<string, number>;
  lastRunAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  latency: DetectorLatencyState | null;
  latencyHistogram: Map<string, number> | null;
};

function mapLogLevelCounters(source: Map<string, number>): CounterMap {
  const normalized = new Map<string, number>();
  for (const [key, value] of source.entries()) {
    normalized.set(key.toLowerCase(), value);
  }
  const result: CounterMap = {};
  for (const level of PINO_LEVEL_ORDER) {
    result[level] = normalized.get(level) ?? 0;
  }
  for (const [key, value] of normalized.entries()) {
    if (!(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

function mapFrom(source: Map<string, number>): CounterMap {
  return Object.fromEntries(Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b)));
}

function mapFromNested(source: Map<string, Map<string, number>>): Record<string, CounterMap> {
  const result: Record<string, CounterMap> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, inner] of ordered) {
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
    result[metric] = mapHistogram(histogram);
  }
  return result;
}

function mapSuppressionChannelHistograms(
  source: Map<string, Map<string, number>>
): Record<string, HistogramSnapshot> {
  const result: Record<string, HistogramSnapshot> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, histogram] of ordered) {
    result[channel] = mapHistogram(histogram);
  }
  return result;
}

function mapSuppressionChannelStates(
  source: SuppressedEventMetric['channelStates'] | undefined
): SuppressedEventMetric['channelStates'] | null {
  if (!source) {
    return null;
  }
  const result: SuppressedEventMetric['channelStates'] = {};
  const entries = Object.entries(source).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, state] of entries) {
    if (!channel) {
      continue;
    }
    const reasons = Array.isArray(state?.reasons)
      ? Array.from(
          new Set(
            state.reasons
              .map(reason => (typeof reason === 'string' ? reason.trim() : ''))
              .filter(reason => reason.length > 0)
          )
        )
      : undefined;
    const types = Array.isArray(state?.types)
      ? Array.from(
          new Set(
            state.types.filter(type => type === 'window' || type === 'rate-limit')
          )
        )
      : undefined;
    const historyArray = Array.isArray(state?.history)
      ? Array.from(
          new Set(
            state.history
              .map(value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined))
              .filter((value): value is number => typeof value === 'number')
          )
        ).sort((a, b) => a - b)
      : undefined;
    const combinedHistoryArray = Array.isArray(state?.combinedHistory)
      ? Array.from(
          new Set(
            state.combinedHistory
              .map(value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined))
              .filter((value): value is number => typeof value === 'number')
          )
        ).sort((a, b) => a - b)
      : undefined;
    result[channel] = {
      hits: typeof state?.hits === 'number' ? state.hits : undefined,
      reasons: reasons && reasons.length > 0 ? reasons : undefined,
      types: types && types.length > 0 ? types : undefined,
      windowRemainingMs:
        typeof state?.windowRemainingMs === 'number' ? state.windowRemainingMs : null,
      maxWindowRemainingMs:
        typeof state?.maxWindowRemainingMs === 'number' ? state.maxWindowRemainingMs : null,
      cooldownRemainingMs:
        typeof state?.cooldownRemainingMs === 'number' ? state.cooldownRemainingMs : null,
      maxCooldownRemainingMs:
        typeof state?.maxCooldownRemainingMs === 'number' ? state.maxCooldownRemainingMs : null,
      historyCount: typeof state?.historyCount === 'number' ? state.historyCount : null,
      combinedHistoryCount:
        typeof state?.combinedHistoryCount === 'number' ? state.combinedHistoryCount : null,
      history: historyArray,
      combinedHistory: combinedHistoryArray
    };
  }
  return result;
}

function mapFromPipelineChannels(source: Map<string, PipelineChannelState>): Record<string, PipelineChannelSnapshot> {
  const result: Record<string, PipelineChannelSnapshot> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, state] of ordered) {
    result[channel] = {
      restarts: state.restarts,
      watchdogRestarts: state.watchdogRestarts,
      lastRestartAt: state.lastRestartAt ? new Date(state.lastRestartAt).toISOString() : null,
      byReason: mapFrom(state.byReason),
      lastRestart: state.lastRestart,
      restartHistory: mapHistory(state.restartHistory),
      historyLimit: state.historyLimit,
      droppedHistory: state.droppedHistory,
      totalRestartDelayMs: state.totalDelayMs,
      totalWatchdogBackoffMs: state.totalWatchdogBackoffMs,
      watchdogBackoffMs: state.totalWatchdogBackoffMs,
      lastWatchdogJitterMs: state.lastWatchdogJitterMs,
      totalJitterMs: state.totalJitterMs,
      lastJitterMs: state.lastJitterMs,
      jitterHistogram: mapHistogram(state.jitterHistogram),
      delayHistogram: mapHistogram(state.delayHistogram),
      attemptHistogram: mapHistogram(state.attemptHistogram)
    };
  }
  return result;
}

function mapHistogram(source: Map<string, number>): HistogramSnapshot {
  const ordered = Array.from(source.entries()).sort(([a], [b]) => compareHistogramKeys(a, b));
  return Object.fromEntries(ordered);
}

function sanitizeHistogramLabels(labels?: Record<string, string>): Record<string, string> {
  if (!labels) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (key === 'le') {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function formatPrometheusHistogram(
  metricKey: string,
  histogram: Map<string, number>,
  config: HistogramConfig,
  stats: { sum: number; count: number } | undefined,
  options: PrometheusHistogramOptions
): string {
  const defaultName = `guardian_${metricKey}`;
  const metricName = sanitizePrometheusMetricName(options.metricName ?? defaultName);
  const help = options.help ? escapePrometheusHelp(options.help) : null;
  const lines: string[] = [];
  if (help) {
    lines.push(`# HELP ${metricName} ${help}`);
  }
  lines.push(`# TYPE ${metricName} histogram`);

  const baseLabels = sanitizeHistogramLabels(options.labels);
  const baseLabelString = formatPrometheusLabels(baseLabels);

  let cumulative = 0;
  let previous: number | undefined;
  for (const bucket of config.buckets) {
    const bucketKey = config.format(bucket, previous);
    const count = histogram.get(bucketKey) ?? 0;
    cumulative += count;
    const bucketLabels = { ...baseLabels, le: formatPrometheusLe(bucket) };
    lines.push(
      `${metricName}_bucket${formatPrometheusLabels(bucketLabels)} ${formatPrometheusValue(cumulative)}`
    );
    previous = bucket;
  }

  const overflowLabel = `${config.buckets[config.buckets.length - 1]}+`;
  const overflowCount = histogram.get(overflowLabel) ?? 0;
  const recordedTotal = cumulative + overflowCount;
  const totalCount = Math.max(recordedTotal, stats?.count ?? 0);
  const infLabels = { ...baseLabels, le: '+Inf' };
  lines.push(
    `${metricName}_bucket${formatPrometheusLabels(infLabels)} ${formatPrometheusValue(totalCount)}`
  );

  const sumValue = stats?.sum ?? 0;
  lines.push(`${metricName}_sum${baseLabelString} ${formatPrometheusValue(sumValue)}`);
  lines.push(`${metricName}_count${baseLabelString} ${formatPrometheusValue(totalCount)}`);

  return lines.join('\n');
}

function formatPrometheusGauge(
  metricKey: string,
  samples: Array<{ value: number; labels?: Record<string, string> }>,
  options: PrometheusGaugeOptions
): string {
  const filtered = samples.filter(sample => Number.isFinite(sample.value));
  if (filtered.length === 0) {
    return '';
  }

  const defaultName = `guardian_${metricKey}`;
  const metricName = sanitizePrometheusMetricName(options.metricName ?? defaultName);
  const help = options.help ? escapePrometheusHelp(options.help) : null;
  const baseLabels = sanitizeHistogramLabels(options.labels);

  const normalized = filtered.map(sample => {
    const mergedLabels = { ...baseLabels, ...sanitizeHistogramLabels(sample.labels) };
    const labelString = formatPrometheusLabels(mergedLabels);
    return {
      value: sample.value,
      labels: mergedLabels,
      labelString
    };
  });

  normalized.sort((a, b) => {
    if (a.labelString === b.labelString) {
      return a.value - b.value;
    }
    return a.labelString.localeCompare(b.labelString);
  });

  const lines: string[] = [];
  if (help) {
    lines.push(`# HELP ${metricName} ${help}`);
  }
  lines.push(`# TYPE ${metricName} gauge`);

  for (const sample of normalized) {
    lines.push(`${metricName}${sample.labelString} ${formatPrometheusValue(sample.value)}`);
  }

  return lines.join('\n');
}

function sanitizePrometheusMetricName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, '_');
  const collapsed = sanitized.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  const lower = collapsed.toLowerCase();
  if (!lower) {
    return 'guardian_metric';
  }
  if (/^[0-9]/.test(lower)) {
    return `guardian_${lower}`;
  }
  return lower;
}

function sanitizePrometheusLabelName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, '_');
  const collapsed = sanitized.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  const lower = collapsed.toLowerCase();
  if (!lower) {
    return 'label';
  }
  if (/^[0-9]/.test(lower)) {
    return `_${lower}`;
  }
  return lower;
}

function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapePrometheusHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, ' ');
}

function formatPrometheusLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) {
    return '';
  }
  const normalized = entries.map(([key, value]) => [sanitizePrometheusLabelName(key), value] as const);
  normalized.sort(([a], [b]) => a.localeCompare(b));
  const rendered = normalized.map(([key, value]) => `${key}="${escapePrometheusLabelValue(value)}"`);
  return `{${rendered.join(',')}}`;
}

function formatPrometheusValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  if (value === 0) {
    return '0';
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  const fixed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return fixed.length > 0 ? fixed : '0';
}

function formatPrometheusLe(value: number): string {
  return formatPrometheusValue(value);
}

function mapWatchdogBackoffByChannel(
  source: Map<string, PipelineChannelState>
): Record<string, number> {
  const result: Record<string, number> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, state] of ordered) {
    result[channel] = state.totalWatchdogBackoffMs;
  }
  return result;
}

function mapWatchdogRestartsByChannel(
  source: Map<string, PipelineChannelState>
): Record<string, number> {
  const result: Record<string, number> = {};
  const ordered = Array.from(source.entries()).sort(([a], [b]) => a.localeCompare(b));
  for (const [channel, state] of ordered) {
    result[channel] = state.watchdogRestarts;
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
      byChannel: mapFrom(state.byChannel),
      history: {
        total: state.historyCount,
        combinedTotal: state.combinedHistoryCount,
        lastCount: state.lastHistoryCount,
        lastCombinedCount: state.lastCombinedHistoryCount,
        lastType: state.lastType,
        lastRateLimit: state.lastRateLimit,
        lastCooldownMs: state.lastCooldownMs,
        lastMaxEvents: state.lastMaxEvents,
        lastChannel: state.lastChannel ?? null,
        lastChannels: state.lastChannels ? [...state.lastChannels] : null,
        lastWindowExpiresAt:
          typeof state.lastWindowExpiresAt === 'number'
            ? new Date(state.lastWindowExpiresAt).toISOString()
            : null,
        lastWindowRemainingMs:
          typeof state.lastWindowRemainingMs === 'number' ? state.lastWindowRemainingMs : null,
        lastCooldownRemainingMs:
          typeof state.lastCooldownRemainingMs === 'number' ? state.lastCooldownRemainingMs : null
        ,
        lastCooldownEndsAt:
          typeof state.lastCooldownEndsAt === 'number'
            ? new Date(state.lastCooldownEndsAt).toISOString()
            : null
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
      gauges: mapFrom(state.gauges),
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

function createPipelineChannelState(): PipelineChannelState {
  return {
    restarts: 0,
    watchdogRestarts: 0,
    lastRestartAt: null,
    byReason: new Map<string, number>(),
    lastRestart: null,
    restartHistory: [],
    historyLimit: DEFAULT_RESTART_HISTORY_LIMIT,
    droppedHistory: 0,
    totalDelayMs: 0,
    totalWatchdogBackoffMs: 0,
    lastWatchdogJitterMs: null,
    totalJitterMs: 0,
    lastJitterMs: null,
    jitterHistogram: new Map<string, number>(),
    delayHistogram: new Map<string, number>(),
    attemptHistogram: new Map<string, number>()
  };
}

function resetPipelineChannelState(state: PipelineChannelState) {
  state.restarts = 0;
  state.watchdogRestarts = 0;
  state.lastRestartAt = null;
  state.byReason.clear();
  state.lastRestart = null;
  state.restartHistory.length = 0;
  state.droppedHistory = 0;
  state.totalDelayMs = 0;
  state.totalWatchdogBackoffMs = 0;
  state.lastWatchdogJitterMs = null;
  state.totalJitterMs = 0;
  state.lastJitterMs = null;
  state.jitterHistogram.clear();
  state.delayHistogram.clear();
  state.attemptHistogram.clear();
}

function getPipelineChannelState(map: Map<string, PipelineChannelState>, channel: string): PipelineChannelState {
  const existing = map.get(channel);
  if (existing) {
    return existing;
  }
  const created = createPipelineChannelState();
  map.set(channel, created);
  return created;
}

function updatePipelineChannelState(
  state: PipelineChannelState,
  meta: PipelineRestartMeta,
  reason: string,
  occurredAt: number
) {
  state.restarts += 1;
  if (reason === 'watchdog-timeout') {
    state.watchdogRestarts += 1;
  }
  state.lastRestartAt = occurredAt;
  state.byReason.set(reason, (state.byReason.get(reason) ?? 0) + 1);
  state.lastRestart = meta;
  if (typeof meta.delayMs === 'number' && meta.delayMs >= 0) {
    state.totalDelayMs += meta.delayMs;
    const delayBucket = resolveHistogramBucket(meta.delayMs, DEFAULT_HISTOGRAM);
    state.delayHistogram.set(delayBucket, (state.delayHistogram.get(delayBucket) ?? 0) + 1);
    if (reason === 'watchdog-timeout') {
      state.totalWatchdogBackoffMs += meta.delayMs;
      if (typeof meta.jitterMs === 'number') {
        state.lastWatchdogJitterMs = meta.jitterMs;
      }
    }
  } else if (reason === 'watchdog-timeout' && typeof meta.jitterMs === 'number') {
    state.lastWatchdogJitterMs = meta.jitterMs;
  }
  if (typeof meta.jitterMs === 'number' && Number.isFinite(meta.jitterMs)) {
    state.lastJitterMs = meta.jitterMs;
    state.totalJitterMs += Math.abs(meta.jitterMs);
    const jitterBucket = resolveHistogramBucket(Math.abs(meta.jitterMs), DEFAULT_HISTOGRAM);
    state.jitterHistogram.set(jitterBucket, (state.jitterHistogram.get(jitterBucket) ?? 0) + 1);
    if (reason === 'watchdog-timeout') {
      state.lastWatchdogJitterMs = meta.jitterMs;
    }
  }
  if (typeof meta.attempt === 'number' && meta.attempt >= 0) {
    const attemptBucket = resolveHistogramBucket(meta.attempt, RESTART_ATTEMPT_HISTOGRAM);
    state.attemptHistogram.set(
      attemptBucket,
      (state.attemptHistogram.get(attemptBucket) ?? 0) + 1
    );
  }
  const record: PipelineRestartHistoryRecord = {
    reason,
    attempt: meta.attempt,
    delayMs: meta.delayMs,
    baseDelayMs: meta.baseDelayMs,
    minDelayMs: meta.minDelayMs,
    maxDelayMs: meta.maxDelayMs,
    jitterMs: meta.jitterMs,
    minJitterMs: meta.minJitterMs,
    maxJitterMs: meta.maxJitterMs,
    exitCode: meta.exitCode,
    errorCode: meta.errorCode,
    signal: meta.signal,
    at: occurredAt
  };
  state.restartHistory.push(record);
  if (state.restartHistory.length > state.historyLimit) {
    const overflow = state.restartHistory.length - state.historyLimit;
    state.restartHistory.splice(0, overflow);
    state.droppedHistory += overflow;
  }
}

function getDetectorMetricState(map: Map<string, DetectorMetricState>, detector: string): DetectorMetricState {
  const existing = map.get(detector);
  if (existing) {
    return existing;
  }
  const created: DetectorMetricState = {
    counters: new Map<string, number>(),
    gauges: new Map<string, number>(),
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
  RetentionSnapshot,
  RetentionWarningSnapshot,
  PrometheusHistogramOptions,
  PrometheusGaugeOptions,
  PrometheusLogLevelOptions,
  PrometheusDetectorOptions
};
export { MetricsRegistry };
export default defaultRegistry;
