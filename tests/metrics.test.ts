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
    expect(snapshot.pipelines.audio.restarts).toBe(1);
    expect(snapshot.suppression.total).toBe(1);
    expect(snapshot.suppression.byRule['rule-1']).toBe(1);
    expect(snapshot.suppression.byReason['cooldown']).toBe(1);
  });
});
