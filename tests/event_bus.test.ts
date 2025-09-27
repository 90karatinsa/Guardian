import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/eventBus.js';
import { MetricsRegistry } from '../src/metrics/index.js';
import { EventPayload } from '../src/types.js';

describe('EventSuppressionRateLimit', () => {
  let store: ReturnType<typeof vi.fn>;
  let log: { info: ReturnType<typeof vi.fn> };
  let metricsMock: {
    recordEvent: ReturnType<typeof vi.fn>;
    recordSuppressedEvent: ReturnType<typeof vi.fn>;
  };
  let bus: EventBus;

  const basePayload: EventPayload = {
    source: 'sensor:1',
    detector: 'test-detector',
    severity: 'warning',
    message: 'event'
  };

  beforeEach(() => {
    store = vi.fn();
    log = { info: vi.fn() };
    metricsMock = {
      recordEvent: vi.fn(),
      recordSuppressedEvent: vi.fn()
    };
    bus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics: metricsMock as any
    });
  });

  it('SuppressionRateLimitCooldown merges history and cooldown metadata', () => {
    bus.configureSuppression([
      {
        id: 'channel-limit',
        detector: 'test-detector',
        channel: 'alerts',
        rateLimit: { count: 2, perMs: 1000, cooldownMs: 800 },
        suppressForMs: 800,
        reason: 'alerts throttled'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'metrics' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 100, meta: { channel: 'alerts' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 300, meta: { channel: 'alerts' } })).toBe(true);

    expect(bus.emitEvent({ ...basePayload, ts: 450, meta: { channel: 'alerts' } })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 900, meta: { channel: 'alerts' } })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 1800, meta: { channel: 'alerts' } })).toBe(true);

    expect(store).toHaveBeenCalledTimes(4);
    const suppressionCalls = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta);
    expect(suppressionCalls).toHaveLength(2);

    const rateLimited = suppressionCalls[0] ?? {};
    expect(rateLimited.suppressionType).toBe('rate-limit');
    expect(rateLimited.suppressionHistoryCount).toBe(3);
    expect(Array.isArray(rateLimited.suppressionHistory)).toBe(true);
    expect((rateLimited.suppressedBy?.[0]?.historyCount as number) ?? 0).toBe(3);
    expect(rateLimited.rateLimitCooldownMs).toBe(800);
    expect(rateLimited.suppressedBy?.[0]?.cooldownMs).toBe(800);

    const windowSuppression = suppressionCalls[1] ?? {};
    expect(windowSuppression.suppressionType).toBe('window');
    expect((windowSuppression.suppressedBy?.[0]?.historyCount as number) ?? 0).toBeGreaterThanOrEqual(3);
    expect(windowSuppression.rateLimitCooldownMs).toBe(800);

    const metricArgs = metricsMock.recordSuppressedEvent.mock.calls.map(call => call[0]);
    expect(metricArgs[0]).toMatchObject({
      ruleId: 'channel-limit',
      reason: 'alerts throttled',
      type: 'rate-limit',
      historyCount: 3,
      combinedHistoryCount: 3,
      cooldownMs: 800
    });
    expect(metricArgs[1]).toMatchObject({ type: 'window', ruleId: 'channel-limit' });
  });

  it('EventSuppressionChannelMetrics records channel and window metadata', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'channel-limit',
        detector: 'test-detector',
        channel: 'video:lobby',
        rateLimit: { count: 1, perMs: 1000, cooldownMs: 400 },
        suppressForMs: 500,
        reason: 'lobby limited'
      }
    ]);

    expect(metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'video:lobby' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 100, meta: { channel: 'video:lobby' } })).toBe(false);

    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});
    expect(suppressedMeta).toHaveLength(1);
    const firstSuppression = suppressedMeta[0];
    expect(firstSuppression.suppressionChannel).toBe('video:lobby');
    expect(firstSuppression.suppressionChannels).toEqual(['video:lobby']);
    expect(firstSuppression.rateLimitCooldownRemainingMs).toBe(400);
    expect(firstSuppression.suppressionWindowRemainingMs).toBe(500);
    expect(firstSuppression.suppressedBy?.[0]?.windowRemainingMs).toBe(500);
    expect(firstSuppression.suppressedBy?.[0]?.cooldownRemainingMs).toBe(400);

    const snapshot = metrics.snapshot();
    const ruleHistory = snapshot.suppression.rules['channel-limit'];
    expect(ruleHistory).toBeDefined();
    expect(ruleHistory.history.lastChannel).toBe('video:lobby');
    expect(ruleHistory.history.lastWindowRemainingMs).toBe(500);
    expect(ruleHistory.history.lastCooldownRemainingMs).toBe(400);
    expect(snapshot.suppression.lastEvent?.channel).toBe('video:lobby');
    expect(snapshot.suppression.lastEvent?.windowRemainingMs).toBe(500);
    expect(snapshot.suppression.lastEvent?.cooldownRemainingMs).toBe(400);
  });

  it('EventSuppressionRateLimitWindow isolates cooldown per channel', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'per-channel',
        detector: 'test-detector',
        rateLimit: { count: 2, perMs: 1000, cooldownMs: 800 },
        suppressForMs: 600,
        reason: 'per-channel limit'
      }
    ]);

    expect(metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:a' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 100, meta: { channel: 'cam:a' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 200, meta: { channel: 'cam:a' } })).toBe(false);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 250, meta: { channel: 'cam:b' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 700, meta: { channel: 'cam:a' } })).toBe(false);

    const suppressionCalls = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});
    expect(suppressionCalls).toHaveLength(2);
    const firstSuppression = suppressionCalls[0];
    const secondSuppression = suppressionCalls[1];
    expect(firstSuppression.suppressionChannel).toBe('cam:a');
    expect(firstSuppression.suppressedBy?.[0]?.channel).toBe('cam:a');
    expect(Number(firstSuppression.cooldownRemainingMs ?? 0)).toBeLessThanOrEqual(800);
    expect(secondSuppression.suppressionChannel).toBe('cam:a');
    expect(secondSuppression.suppressedBy?.[0]?.channel).toBe('cam:a');
    expect(Number(secondSuppression.cooldownRemainingMs ?? 0)).toBeLessThanOrEqual(800);
    expect(Number(secondSuppression.cooldownRemainingMs ?? 0)).toBeLessThan(
      Number(firstSuppression.cooldownRemainingMs ?? Infinity)
    );

    const snapshot = metrics.snapshot();
    expect(snapshot.suppression.lastEvent?.channel).toBe('cam:a');
    expect(Number(snapshot.suppression.lastEvent?.cooldownRemainingMs ?? 0)).toBeLessThanOrEqual(800);
    expect(Number(snapshot.suppression.lastEvent?.cooldownRemainingMs ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it('EventSuppressionChannelRateLimit exposes per-channel window metadata', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'per-channel',
        detector: 'test-detector',
        rateLimit: { count: 1, perMs: 800, cooldownMs: 500 },
        suppressForMs: 600,
        reason: 'per-channel limit'
      }
    ]);

    metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:a' } });
    metricsBus.emitEvent({ ...basePayload, ts: 200, meta: { channel: 'cam:a' } });
    metricsBus.emitEvent({ ...basePayload, ts: 400, meta: { channel: 'cam:b' } });
    metricsBus.emitEvent({ ...basePayload, ts: 500, meta: { channel: 'cam:b' } });

    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});
    expect(suppressedMeta).toHaveLength(2);
    const firstState = suppressedMeta[0].suppressionChannelStates as Record<string, any>;
    expect(firstState).toBeDefined();
    expect(firstState['cam:a']).toMatchObject({
      hits: 1,
      cooldownRemainingMs: 500,
      windowRemainingMs: 600
    });
    expect(firstState['cam:a'].reasons).toContain('per-channel limit');
    const secondState = suppressedMeta[1].suppressionChannelStates as Record<string, any>;
    expect(secondState['cam:b'].hits).toBeGreaterThanOrEqual(1);
  });

  it('EventSuppressionMetricsHistogram tracks channel-specific counts', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'histogram-channel',
        detector: 'test-detector',
        rateLimit: { count: 1, perMs: 1000, cooldownMs: 400 },
        suppressForMs: 700,
        reason: 'histogram limit'
      }
    ]);

    metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:a' } });
    metricsBus.emitEvent({ ...basePayload, ts: 100, meta: { channel: 'cam:a' } });
    metricsBus.emitEvent({ ...basePayload, ts: 500, meta: { channel: 'cam:b' } });
    metricsBus.emitEvent({ ...basePayload, ts: 600, meta: { channel: 'cam:b' } });

    const snapshot = metrics.snapshot();
    expect(snapshot.suppression.byChannel['cam:a']).toBe(1);
    expect(snapshot.suppression.byChannel['cam:b']).toBe(1);
    expect(snapshot.suppression.rules['histogram-channel'].byChannel['cam:a']).toBe(1);
    expect(snapshot.suppression.rules['histogram-channel'].byChannel['cam:b']).toBe(1);
    const channelHist = snapshot.suppression.histogram.channel;
    expect(channelHist.cooldownMs['cam:a']).toBeDefined();
    expect(Object.values(channelHist.cooldownMs['cam:a'])).not.toHaveLength(0);
    expect(channelHist.windowRemainingMs['cam:b']).toBeDefined();
    expect(Object.values(channelHist.windowRemainingMs['cam:b'])).not.toHaveLength(0);
  });

  it('EventSuppressionMaxEvents enforces burst limits with history metadata', () => {
    bus.configureSuppression([
      {
        id: 'burst-limit',
        detector: 'test-detector',
        suppressForMs: 500,
        maxEvents: 3,
        reason: 'burst limited'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0 })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 100 })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 200 })).toBe(true);

    expect(bus.emitEvent({ ...basePayload, ts: 250 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 600 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 801 })).toBe(true);

    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta);
    expect(suppressedMeta).toHaveLength(2);
    const burstSuppression = suppressedMeta[0];
    expect(burstSuppression?.suppressedBy?.[0]?.historyCount).toBe(3);

    const metricArgs = metricsMock.recordSuppressedEvent.mock.calls.map(call => call[0]);
    expect(metricArgs[0]).toMatchObject({
      ruleId: 'burst-limit',
      historyCount: 3,
      maxEvents: 3
    });
    expect(metricArgs[0]?.history?.length).toBe(3);
  });

  it('EventSuppressionWindowBackoff deduplicates suppression history across repeated timestamps', () => {
    bus.configureSuppression([
      {
        id: 'window-backoff',
        detector: 'test-detector',
        suppressForMs: 600,
        reason: 'window backoff'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0 })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 200 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 200 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 400 })).toBe(false);

    const suppressionCalls = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});

    expect(suppressionCalls).toHaveLength(3);
    expect(suppressionCalls[0]?.suppressedBy?.[0]?.history).toEqual([0, 200]);
    expect(suppressionCalls[0]?.suppressionHistoryCount).toBe(2);
    expect(suppressionCalls[1]?.suppressedBy?.[0]?.history).toEqual([0, 200]);
    expect(suppressionCalls[1]?.suppressionHistoryCount).toBe(2);
    expect(suppressionCalls[2]?.suppressedBy?.[0]?.history).toEqual([0, 200, 400]);
    expect(suppressionCalls[2]?.suppressionHistoryCount).toBe(3);

    const metricDetails = metricsMock.recordSuppressedEvent.mock.calls.map(call => call[0]);
    expect(metricDetails).toHaveLength(3);
    expect(metricDetails[0]).toMatchObject({
      ruleId: 'window-backoff',
      history: [0, 200],
      historyCount: 2,
      combinedHistoryCount: 2
    });
    expect(metricDetails[1]).toMatchObject({ history: [0, 200], historyCount: 2 });
    expect(metricDetails[2]).toMatchObject({ history: [0, 200, 400], historyCount: 3 });
  });
});

describe('EventSuppressionWindowRecovery', () => {
  let store: ReturnType<typeof vi.fn>;
  let log: { info: ReturnType<typeof vi.fn> };
  let metricsMock: {
    recordEvent: ReturnType<typeof vi.fn>;
    recordSuppressedEvent: ReturnType<typeof vi.fn>;
  };
  let bus: EventBus;

  const basePayload: EventPayload = {
    source: 'sensor:2',
    detector: 'cooldown-detector',
    severity: 'info',
    message: 'cooldown event'
  };

  beforeEach(() => {
    store = vi.fn();
    log = { info: vi.fn() };
    metricsMock = {
      recordEvent: vi.fn(),
      recordSuppressedEvent: vi.fn()
    };
    bus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics: metricsMock as any
    });
  });

  it('recovers after window expiry and reports suppression metadata', () => {
    bus.configureSuppression([
      {
        id: 'cooldown',
        detector: 'cooldown-detector',
        suppressForMs: 600,
        reason: 'cooldown window'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0 })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 200 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 400 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 800 })).toBe(true);

    expect(store).toHaveBeenCalledTimes(2);
    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta);
    expect(suppressedMeta).toHaveLength(2);
    expect(suppressedMeta[0]).toMatchObject({
      suppressionRuleId: 'cooldown',
      suppressionType: 'window',
      suppressionHistoryCount: 2
    });
    expect((suppressedMeta[1]?.suppressionHistoryCount as number) ?? 0).toBe(3);

    expect(metricsMock.recordSuppressedEvent).toHaveBeenCalledTimes(2);
    expect(metricsMock.recordSuppressedEvent.mock.calls[0][0]).toMatchObject({
      ruleId: 'cooldown',
      reason: 'cooldown window',
      type: 'window'
    });
  });
});

describe('MetricsSuppressionSnapshot', () => {
  it('captures suppression history totals and channel metadata', () => {
    const registry = new MetricsRegistry();
    registry.reset();

    registry.recordSuppressedEvent({
      ruleId: 'window-backoff',
      reason: 'window backoff',
      type: 'window',
      historyCount: 2,
      combinedHistoryCount: 2,
      channel: 'video:lobby',
      channels: ['video:lobby'],
      cooldownMs: 600,
      windowExpiresAt: Date.now() + 600,
      windowRemainingMs: 500,
      cooldownRemainingMs: 400
    });

    registry.recordSuppressedEvent({
      ruleId: 'window-backoff',
      reason: 'window backoff',
      type: 'window',
      historyCount: 3,
      combinedHistoryCount: 3,
      channel: 'video:lobby',
      channels: ['video:lobby', 'alerts'],
      cooldownMs: 600,
      windowExpiresAt: Date.now() + 400,
      windowRemainingMs: 250,
      cooldownRemainingMs: 200
    });

    const snapshot = registry.snapshot();
    expect(snapshot.suppression.total).toBe(2);
    expect(snapshot.suppression.historyTotals.historyCount).toBe(5);
    expect(snapshot.suppression.historyTotals.combinedHistoryCount).toBe(5);
    expect(snapshot.suppression.lastEvent?.channel).toBe('video:lobby');
    expect(snapshot.suppression.lastEvent?.channels).toEqual(['video:lobby', 'alerts']);
    expect(snapshot.suppression.lastEvent?.cooldownRemainingMs).toBe(200);
    expect(snapshot.suppression.lastEvent?.windowRemainingMs).toBe(250);

    const ruleSnapshot = snapshot.suppression.rules['window-backoff'];
    expect(ruleSnapshot.total).toBe(2);
    expect(ruleSnapshot.history.total).toBe(5);
    expect(ruleSnapshot.history.combinedTotal).toBe(5);
    expect(ruleSnapshot.history.lastCount).toBe(3);
    expect(ruleSnapshot.history.lastCombinedCount).toBe(3);
    expect(ruleSnapshot.history.lastChannel).toBe('video:lobby');
    expect(ruleSnapshot.history.lastChannels).toEqual(['video:lobby', 'alerts']);
    expect(ruleSnapshot.history.lastCooldownMs).toBe(600);
    expect(ruleSnapshot.history.lastCooldownRemainingMs).toBe(200);
    expect(ruleSnapshot.history.lastWindowRemainingMs).toBe(250);
  });
});

