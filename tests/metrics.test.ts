import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '../src/eventBus.js';
import metrics, { MetricsRegistry } from '../src/metrics/index.js';
import { collectHealthChecks, registerHealthIndicator, resetAppLifecycle } from '../src/app.js';
import logger, { getLogLevel, setLogLevel } from '../src/logger.js';

function createBus() {
  const metrics = {
    recordEvent: vi.fn(),
    recordSuppressedEvent: vi.fn()
  };
  return new EventBus({
    store: vi.fn(),
    log: {
      info: vi.fn()
    } as any,
    metrics: metrics as any
  });
}

describe('MetricsCounters', () => {
  it('tracks detector counters when events are emitted', () => {
    const registry = new MetricsRegistry();
    const bus = createBus();
    const detach = registry.bindEventBus(bus);

    bus.emitEvent({
      ts: 123,
      source: 'camera:1',
      detector: 'motion',
      severity: 'warning',
      message: 'motion detected'
    });

    bus.emitEvent({
      ts: 456,
      source: 'camera:1',
      detector: 'person',
      severity: 'critical',
      message: 'person detected'
    });

    const snapshot = registry.snapshot();
    expect(snapshot.events.total).toBe(2);
    expect(snapshot.events.byDetector.motion).toBe(1);
    expect(snapshot.events.byDetector.person).toBe(1);
    expect(snapshot.events.bySeverity.warning).toBe(1);
    expect(snapshot.events.bySeverity.critical).toBe(1);

    detach();
  });

  it('records latency observations with timer helper', async () => {
    const registry = new MetricsRegistry();

    await registry.time('pipeline.latency', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });

    const snapshot = registry.snapshot();
    expect(snapshot.latencies['pipeline.latency']).toBeDefined();
    expect(snapshot.latencies['pipeline.latency'].count).toBe(1);
    expect(snapshot.latencies['pipeline.latency'].maxMs).toBeGreaterThan(0);
  });

  it('MetricsPipelineCounters records detector histograms and pipeline counters', () => {
    const registry = new MetricsRegistry();

    registry.observeDetectorLatency('motion', 42);
    registry.observeDetectorLatency('motion', 120);
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout', { delayMs: 1500, attempt: 2 });
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    registry.recordPipelineRestart('audio', 'spawn-error', { delayMs: 800, attempt: 1 });
    registry.recordSuppressedEvent('rule-1', 'cooldown');

    const snapshot = registry.snapshot();

    expect(snapshot.latencies['detector.motion.latency'].count).toBe(2);
    expect(snapshot.histograms['detector.motion.latency']['25-50']).toBe(1);
    expect(snapshot.histograms['detector.motion.latency']['100-250']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.restarts).toBe(2);
    expect(snapshot.pipelines.ffmpeg.byReason['watchdog-timeout']).toBe(2);
    expect(snapshot.pipelines.ffmpeg.lastRestart).toMatchObject({
      reason: 'watchdog-timeout',
      attempt: null,
      delayMs: null
    });
    expect(snapshot.pipelines.ffmpeg.restartHistory).toHaveLength(2);
    expect(snapshot.pipelines.ffmpeg.totalRestartDelayMs).toBe(1500);
    expect(snapshot.pipelines.ffmpeg.totalWatchdogBackoffMs).toBe(1500);
    expect(snapshot.pipelines.ffmpeg.delayHistogram['1000-2000']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.attemptHistogram['2']).toBe(1);
    expect(snapshot.pipelines.audio.restarts).toBe(1);
    expect(snapshot.pipelines.audio.lastRestart).toMatchObject({
      reason: 'spawn-error',
      attempt: 1,
      delayMs: 800
    });
    expect(snapshot.pipelines.audio.restartHistory).toHaveLength(1);
    expect(snapshot.pipelines.audio.totalRestartDelayMs).toBe(800);
    expect(snapshot.pipelines.audio.totalWatchdogBackoffMs).toBe(0);
    expect(snapshot.pipelines.audio.delayHistogram['500-1000']).toBe(1);
    expect(snapshot.pipelines.audio.attemptHistogram['1']).toBe(1);
    expect(snapshot.suppression.total).toBe(1);
    expect(snapshot.suppression.byRule['rule-1']).toBe(1);
    expect(snapshot.suppression.byReason['cooldown']).toBe(1);
    expect(snapshot.suppression.rules['rule-1']).toMatchObject({
      total: 1,
      byReason: { cooldown: 1 }
    });
  });

  it('MetricsPerChannel exposes detector log levels, per-channel restarts and suppression rules', () => {
    const registry = new MetricsRegistry();

    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout', { channel: 'video:lobby' });
    registry.recordPipelineRestart('ffmpeg', 'spawn-error', { channel: 'video:parking', attempt: 2 });
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout', { channel: 'video:lobby', attempt: 3 });
    registry.recordPipelineRestart('audio', 'spawn-error', { channel: 'audio:mic' });

    registry.incrementLogLevel('WARN', { detector: 'motion' });
    registry.incrementLogLevel('info', { detector: 'person' });
    registry.incrementLogLevel('INFO', { detector: 'person' });

    registry.recordSuppressedEvent('rule-1', 'cooldown');
    registry.recordSuppressedEvent('rule-1', 'cooldown');
    registry.recordSuppressedEvent('rule-2', 'rate-limit');

    const snapshot = registry.snapshot();

    expect(snapshot.logs.byDetector.motion.warn).toBe(1);
    expect(snapshot.logs.byDetector.person.info).toBe(2);

    expect(snapshot.pipelines.ffmpeg.byChannel['video:lobby'].restarts).toBe(2);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:lobby'].byReason['watchdog-timeout']).toBe(2);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:lobby'].restartHistory.length).toBeLessThanOrEqual(
      snapshot.pipelines.ffmpeg.byChannel['video:lobby'].historyLimit
    );
    expect(snapshot.pipelines.ffmpeg.byChannel['video:parking'].restarts).toBe(1);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:parking'].restartHistory.length).toBe(1);
    expect(snapshot.pipelines.audio.byChannel['audio:mic'].restarts).toBe(1);
    expect(snapshot.pipelines.audio.byChannel['audio:mic'].totalRestartDelayMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.pipelines.ffmpeg.attemptHistogram['2']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.attemptHistogram['3']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.delayHistogram).toEqual({});

    expect(snapshot.suppression.rules['rule-1'].total).toBe(2);
    expect(snapshot.suppression.rules['rule-1'].byReason['cooldown']).toBe(2);
    expect(snapshot.suppression.rules['rule-2'].total).toBe(1);
    expect(snapshot.suppression.rules['rule-2'].byReason['rate-limit']).toBe(1);
  });

  it('MetricsLightCounters track detector counters for motion and light backoff', () => {
    const registry = new MetricsRegistry();

    registry.incrementDetectorCounter('pose', 'forecasts');
    registry.incrementDetectorCounter('pose', 'forecasts', 2);
    registry.recordDetectorError('pose', 'forecast-failed');

    registry.incrementDetectorCounter('face', 'enrollments', 3);
    registry.incrementDetectorCounter('face', 'matches');
    registry.incrementDetectorCounter('face', 'misses', 2);
    registry.recordDetectorError('face', 'empty-embedding');

    registry.incrementDetectorCounter('object', 'classifications', 5);
    registry.incrementDetectorCounter('object', 'threats', 2);
    registry.incrementDetectorCounter('object', 'detections', 7);
    registry.incrementDetectorCounter('motion', 'backoffActivations', 2);
    registry.incrementDetectorCounter('motion', 'backoffSuppressedFrames', 3);
    registry.incrementDetectorCounter('light', 'backoffActivations');
    registry.incrementDetectorCounter('light', 'backoffSuppressedFrames', 4);

    const snapshot = registry.snapshot();

    expect(snapshot.detectors.pose.counters.forecasts).toBe(3);
    expect(snapshot.detectors.pose.counters.errors).toBe(1);
    expect(snapshot.detectors.pose.lastErrorMessage).toBe('forecast-failed');

    expect(snapshot.detectors.face.counters.enrollments).toBe(3);
    expect(snapshot.detectors.face.counters.matches).toBe(1);
    expect(snapshot.detectors.face.counters.misses).toBe(2);
    expect(snapshot.detectors.face.counters.errors).toBe(1);
    expect(snapshot.detectors.face.lastErrorMessage).toBe('empty-embedding');

    expect(snapshot.detectors.object.counters.classifications).toBe(5);
    expect(snapshot.detectors.object.counters.threats).toBe(2);
    expect(snapshot.detectors.object.counters.detections).toBe(7);
    expect(snapshot.detectors.object.lastRunAt).not.toBeNull();
    expect(snapshot.detectors.motion.counters.backoffActivations).toBe(2);
    expect(snapshot.detectors.motion.counters.backoffSuppressedFrames).toBe(3);
    expect(snapshot.detectors.light.counters.backoffActivations).toBe(1);
    expect(snapshot.detectors.light.counters.backoffSuppressedFrames).toBe(4);
  });

  it('MetricsDetectorCounters exposes pipeline and detector histograms', () => {
    const registry = new MetricsRegistry();

    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    registry.recordPipelineRestart('audio', 'spawn-error');

    registry.incrementDetectorCounter('motion', 'detections');
    registry.incrementDetectorCounter('motion', 'detections', 4);
    registry.recordDetectorError('motion', 'forecast-missed');

    const snapshot = registry.snapshot();

    expect(snapshot.histograms['pipeline.ffmpeg.restarts']).toMatchObject({
      '1-2': 1,
      '2-5': 1
    });
    expect(snapshot.histograms['pipeline.audio.restarts']).toMatchObject({
      '1-2': 1
    });
    expect(snapshot.histograms['detector.motion.counter.detections']).toMatchObject({
      '1-2': 1,
      '5-10': 1
    });
    expect(snapshot.histograms['detector.motion.counter.errors']).toMatchObject({
      '1-2': 1
    });
    expect(snapshot.histograms).toHaveProperty('logs.level');
  });

  it('MetricsPipelineJitterExport renders Prometheus histogram output with labels', () => {
    const registry = new MetricsRegistry();

    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout', { jitterMs: 50 });
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout', { jitterMs: 750 });

    const output = registry.exportHistogramForPrometheus('pipeline.ffmpeg.restart.jitter', {
      metricName: 'guardian_ffmpeg_restart_jitter',
      help: 'FFmpeg restart jitter in milliseconds',
      labels: { pipeline: 'ffmpeg' }
    });

    expect(output).toContain('# TYPE guardian_ffmpeg_restart_jitter histogram');
    expect(output).toContain('# HELP guardian_ffmpeg_restart_jitter FFmpeg restart jitter in milliseconds');
    expect(output).toMatch(/guardian_ffmpeg_restart_jitter_bucket\{[^}]*le="100"[^}]*\} 1/);
    expect(output).toMatch(/guardian_ffmpeg_restart_jitter_bucket\{[^}]*le="1000"[^}]*\} 2/);
    expect(output).toMatch(/guardian_ffmpeg_restart_jitter_bucket\{[^}]*le="\+Inf"[^}]*\} 2/);
    expect(output).toMatch(/guardian_ffmpeg_restart_jitter_sum\{[^}]*pipeline="ffmpeg"[^}]*\} 800/);
    expect(output).toMatch(/guardian_ffmpeg_restart_jitter_count\{[^}]*pipeline="ffmpeg"[^}]*\} 2/);
  });

  it('LoggerLevelMetrics captures level counters and per-detector histograms', () => {
    const defaultLevel = getLogLevel();
    setLogLevel('trace');
    metrics.reset();

    try {
      logger.trace('trace baseline');
      logger.debug({ detector: 'motion' }, 'debug baseline');
      logger.info({ detector: 'pose' }, 'info baseline');
      logger.warn({ detector: 'pose' }, 'warn baseline');
      logger.error({ detector: 'pose' }, 'error baseline');

      const snapshot = metrics.snapshot();
      expect(snapshot.logs.byLevel.trace).toBe(1);
      expect(snapshot.logs.byLevel.debug).toBe(1);
      expect(snapshot.logs.byLevel.info).toBe(1);
      expect(snapshot.logs.byLevel.warn).toBe(1);
      expect(snapshot.logs.byLevel.error).toBe(1);
      expect(snapshot.logs.byDetector.pose.info).toBe(1);
      expect(snapshot.logs.byDetector.pose.warn).toBe(1);
      expect(snapshot.logs.byDetector.pose.error).toBe(1);
      expect(snapshot.logs.histogram.trace).toBeGreaterThan(0);
      expect(snapshot.logs.histogram.error).toBeGreaterThan(0);
    } finally {
      setLogLevel(defaultLevel);
      metrics.reset();
    }
  });
});

describe('MetricsSnapshotEnrichment', () => {
  beforeEach(() => {
    metrics.reset();
    resetAppLifecycle();
  });

  afterEach(() => {
    metrics.reset();
    resetAppLifecycle();
  });

  it('MetricsSuppressionCounters aggregates suppression history and exposes health context metrics', async () => {
    metrics.incrementLogLevel('info');
    metrics.incrementLogLevel('ERROR', { message: 'pipeline crash' });

    metrics.recordSuppressedEvent({
      ruleId: 'window-1',
      reason: 'cooldown',
      type: 'window',
      historyCount: 3
    });
    metrics.recordSuppressedEvent({
      ruleId: 'rate-1',
      reason: 'rate-limit',
      type: 'rate-limit',
      historyCount: 2,
      combinedHistoryCount: 5,
      rateLimit: { count: 4, perMs: 1000 },
      cooldownMs: 900,
      cooldownRemainingMs: 450,
      windowRemainingMs: 600
    });
    metrics.recordSuppressedEvent({
      ruleId: 'window-1',
      reason: 'cooldown',
      type: 'window',
      historyCount: 4,
      combinedHistoryCount: 4
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.logs.byLevel.info).toBe(1);
    expect(snapshot.logs.byLevel.error).toBe(1);
    expect(snapshot.logs.histogram.info).toBe(1);
    expect(snapshot.logs.histogram.error).toBe(1);
    expect(snapshot.logs.histogram.warn).toBe(0);
    expect(snapshot.suppression.byType.window).toBe(2);
    expect(snapshot.suppression.byType['rate-limit']).toBe(1);
    expect(snapshot.suppression.historyTotals.historyCount).toBe(9);
    expect(snapshot.suppression.historyTotals.combinedHistoryCount).toBe(9);
    expect(snapshot.suppression.rules['window-1'].history.total).toBe(7);
    expect(snapshot.suppression.rules['window-1'].history.lastType).toBe('window');
    expect(snapshot.suppression.rules['rate-1'].history.lastCooldownMs).toBe(900);
    expect(snapshot.suppression.lastEvent?.ruleId).toBe('window-1');
    expect(snapshot.suppression.lastEvent?.cooldownMs).toBeNull();
    expect(snapshot.suppression.histogram.historyCount['2-5']).toBe(3);
    expect(snapshot.suppression.histogram.combinedHistoryCount['2-5']).toBe(1);
    expect(snapshot.suppression.histogram.combinedHistoryCount['5-10']).toBe(1);
    expect(snapshot.suppression.histogram.cooldownMs['500-1000']).toBe(1);
    expect(snapshot.suppression.histogram.cooldownRemainingMs['250-500']).toBe(1);
    expect(snapshot.suppression.histogram.windowRemainingMs['500-1000']).toBe(1);

    const unregister = registerHealthIndicator('metrics-snapshot', context => {
      expect(context.metrics?.suppression.total).toBe(3);
      expect(context.metrics?.logs.byLevel.error).toBe(1);
      return {
        status: 'ok',
        details: {
          lastSuppressed: context.metrics?.suppression.lastEvent
        }
      };
    });

    const checks = await collectHealthChecks({
      service: { status: 'running', startedAt: Date.now() }
    });
    unregister();
    const metricsCheck = checks.find(check => check.name === 'metrics-snapshot');
    expect(metricsCheck?.details?.lastSuppressed?.ruleId).toBe('window-1');
  });

  it('MetricsAudioDeviceDiscovery exposes audio device discovery counters in health snapshots', async () => {
    metrics.recordAudioDeviceDiscovery('probe-failed', { channel: 'audio:lobby' });
    metrics.recordAudioDeviceDiscovery('probe-failed');
    metrics.recordAudioDeviceDiscovery('probe-success', { channel: 'audio:lobby' });

    const unregister = registerHealthIndicator('audio-device-discovery', context => {
      expect(context.metrics?.pipelines.audio.deviceDiscovery['probe-failed']).toBeGreaterThanOrEqual(2);
      expect(
        context.metrics?.pipelines.audio.deviceDiscoveryByChannel['audio:lobby']['probe-failed']
      ).toBe(1);
      return { status: 'ok' };
    });

    const checks = await collectHealthChecks({
      service: { status: 'running', startedAt: Date.now() }
    });
    unregister();

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.audio.deviceDiscovery['probe-failed']).toBeGreaterThanOrEqual(2);
    expect(snapshot.pipelines.audio.deviceDiscoveryByChannel['audio:lobby']['probe-failed']).toBe(1);

    const deviceCheck = checks.find(check => check.name === 'audio-device-discovery');
    expect(deviceCheck?.status).toBe('ok');
  });

  it('MetricsPipelineBackoffSnapshot exposes watchdog jitter and per-channel histograms', () => {
    metrics.recordPipelineRestart('ffmpeg', 'watchdog-timeout', {
      delayMs: 1800,
      attempt: 2,
      jitterMs: 120,
      channel: 'video:lobby'
    });
    metrics.recordPipelineRestart('ffmpeg', 'spawn-error', {
      delayMs: 60,
      attempt: 1,
      channel: 'video:lobby'
    });
    metrics.recordPipelineRestart('audio', 'watchdog-timeout', {
      delayMs: 900,
      attempt: 3,
      jitterMs: 45,
      channel: 'audio:mic'
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.ffmpeg.lastWatchdogJitterMs).toBe(120);
    expect(snapshot.pipelines.ffmpeg.watchdogBackoffByChannel['video:lobby']).toBe(1800);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:lobby'].watchdogBackoffMs).toBe(1800);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:lobby'].delayHistogram['1000-2000']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.byChannel['video:lobby'].attemptHistogram['2']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.restartHistogram.delay['1000-2000']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.restartHistogram.attempt['2']).toBe(1);
    expect(snapshot.pipelines.audio.lastWatchdogJitterMs).toBe(45);
    expect(snapshot.pipelines.audio.watchdogBackoffByChannel['audio:mic']).toBe(900);
    expect(snapshot.pipelines.audio.byChannel['audio:mic'].watchdogBackoffMs).toBe(900);
  });

  it('MetricsPipelineRestartHistogram tracks restart attempts and detector latency histograms', () => {
    metrics.recordPipelineRestart('ffmpeg', 'watchdog', {
      delayMs: 1200,
      attempt: 3,
      channel: 'video:front-door'
    });
    metrics.recordPipelineRestart('ffmpeg', 'spawn-error', {
      delayMs: 80,
      attempt: 1
    });
    metrics.recordPipelineRestart('audio', 'spawn-error', {
      delayMs: 300,
      attempt: 2,
      channel: 'audio:lobby'
    });

    metrics.observeDetectorLatency('pose', 75);
    metrics.observeDetectorLatency('audio-anomaly', 180);
    metrics.observeDetectorLatency('audio-anomaly', 40);

    const snapshot = metrics.snapshot();
    expect(snapshot.pipelines.ffmpeg.attempts['3']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.attempts['1']).toBe(1);
    expect(snapshot.pipelines.audio.attempts['2']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.delayHistogram['1000-2000']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.delayHistogram['50-100']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.attemptHistogram['3']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.attemptHistogram['1']).toBe(1);
    expect(snapshot.pipelines.audio.delayHistogram['250-500']).toBe(1);
    expect(snapshot.pipelines.audio.attemptHistogram['2']).toBe(1);

    const attemptHistogram = snapshot.histograms['pipeline.ffmpeg.restart.attempt'];
    expect(attemptHistogram?.['3']).toBe(1);
    expect(attemptHistogram?.['1']).toBe(1);

    const delayHistogram = snapshot.histograms['pipeline.ffmpeg.restart.delay'];
    expect(delayHistogram).toBeDefined();

    const poseLatency = snapshot.detectors.pose.latency;
    expect(poseLatency?.count).toBe(1);
    expect(snapshot.detectors.pose.latencyHistogram['50-100']).toBe(1);

    const anomalyLatency = snapshot.detectors['audio-anomaly'].latency;
    expect(anomalyLatency?.count).toBe(2);
    expect(snapshot.detectors['audio-anomaly'].latencyHistogram['25-50']).toBe(1);
    expect(snapshot.detectors['audio-anomaly'].latencyHistogram['100-250']).toBe(1);
  });
});
