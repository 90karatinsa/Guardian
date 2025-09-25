import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/eventBus.js';
import { MetricsRegistry } from '../src/metrics/index.js';

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
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    registry.recordPipelineRestart('ffmpeg', 'watchdog-timeout');
    registry.recordPipelineRestart('audio', 'spawn-error');
    registry.recordSuppressedEvent('rule-1', 'cooldown');

    const snapshot = registry.snapshot();

    expect(snapshot.latencies['detector.motion.latency'].count).toBe(2);
    expect(snapshot.histograms['detector.motion.latency']['25-50']).toBe(1);
    expect(snapshot.histograms['detector.motion.latency']['100-250']).toBe(1);
    expect(snapshot.pipelines.ffmpeg.restarts).toBe(2);
    expect(snapshot.pipelines.ffmpeg.byReason['watchdog-timeout']).toBe(2);
    expect(snapshot.pipelines.ffmpeg.lastRestart).toEqual({
      reason: 'watchdog-timeout',
      attempt: null,
      delayMs: null,
      baseDelayMs: null,
      minDelayMs: null,
      maxDelayMs: null,
      jitterMs: null
    });
    expect(snapshot.pipelines.audio.restarts).toBe(1);
    expect(snapshot.pipelines.audio.lastRestart).toEqual({
      reason: 'spawn-error',
      attempt: null,
      delayMs: null,
      baseDelayMs: null,
      minDelayMs: null,
      maxDelayMs: null,
      jitterMs: null
    });
    expect(snapshot.suppression.total).toBe(1);
    expect(snapshot.suppression.byRule['rule-1']).toBe(1);
    expect(snapshot.suppression.byReason['cooldown']).toBe(1);
    expect(snapshot.suppression.rules['rule-1']).toEqual({
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
    expect(snapshot.pipelines.ffmpeg.byChannel['video:parking'].restarts).toBe(1);
    expect(snapshot.pipelines.audio.byChannel['audio:mic'].restarts).toBe(1);

    expect(snapshot.suppression.rules['rule-1'].total).toBe(2);
    expect(snapshot.suppression.rules['rule-1'].byReason['cooldown']).toBe(2);
    expect(snapshot.suppression.rules['rule-2'].total).toBe(1);
    expect(snapshot.suppression.rules['rule-2'].byReason['rate-limit']).toBe(1);
  });

  it('MetricsDetectorCounters tracks pose, face and object detector counters', () => {
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
  });
});
