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
      cooldownMs: 800,
      cooldownExpiresAt: expect.any(Number)
    });
    expect(metricArgs[1]).toMatchObject({ type: 'window', ruleId: 'channel-limit' });
  });

  it('EventSuppressionChannelNormalization normalizes rule and event channels', () => {
    bus.configureSuppression([
      {
        id: 'normalized',
        detector: 'test-detector',
        channel: ['LobbyCam', 'AuDiO:Mic-A'],
        suppressForMs: 200,
        reason: 'normalized channels'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'LobbyCam' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 50, meta: { channel: 'VIDEO:LOBBYCAM' } })).toBe(false);

    expect(bus.emitEvent({ ...basePayload, ts: 250, meta: { channel: 'AuDiO:Mic-A' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 300, meta: { channel: 'audio:MIC-a' } })).toBe(false);

    expect(store).toHaveBeenCalledTimes(2);

    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});

    expect(suppressedMeta).toHaveLength(2);
    const [videoSuppression, audioSuppression] = suppressedMeta;

    expect(videoSuppression.suppressionChannel).toBe('video:lobbycam');
    expect(videoSuppression.suppressionChannels).toEqual(['video:lobbycam']);
    expect(audioSuppression.suppressionChannel).toBe('audio:mic-a');
    expect(audioSuppression.suppressionChannels).toEqual(['audio:mic-a']);

    expect(metricsMock.recordSuppressedEvent).toHaveBeenCalledTimes(2);
    const metricDetails = metricsMock.recordSuppressedEvent.mock.calls.map(call => call[0]);
    expect(metricDetails[0]).toMatchObject({
      channel: 'video:lobbycam',
      channels: ['video:lobbycam']
    });
    expect(metricDetails[1]).toMatchObject({
      channel: 'audio:mic-a',
      channels: ['audio:mic-a']
    });
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
    expect(firstSuppression.suppressionWindowEndsAt).toBe(1000);
    expect(firstSuppression.rateLimitCooldownEndsAt).toBe(1000);
    expect(firstSuppression.suppressedBy?.[0]?.cooldownExpiresAt).toBe(1000);
    expect(Number(firstSuppression.cooldownRemainingMs ?? 0)).toBeLessThanOrEqual(800);
    expect(secondSuppression.suppressionChannel).toBe('cam:a');
    expect(secondSuppression.suppressedBy?.[0]?.channel).toBe('cam:a');
    expect(Number(secondSuppression.cooldownRemainingMs ?? 0)).toBeLessThanOrEqual(800);
    expect(Number(secondSuppression.cooldownRemainingMs ?? 0)).toBeLessThan(
      Number(firstSuppression.cooldownRemainingMs ?? Infinity)
    );
    expect(secondSuppression.rateLimitCooldownEndsAt).toBe(1000);
    expect(secondSuppression.suppressedBy?.[0]?.cooldownExpiresAt).toBeDefined();

    const snapshot = metrics.snapshot();
    expect(snapshot.suppression.lastEvent?.channel).toBe('cam:a');
    expect(Number(snapshot.suppression.lastEvent?.cooldownRemainingMs ?? 0)).toBeLessThanOrEqual(800);
    expect(Number(snapshot.suppression.lastEvent?.cooldownRemainingMs ?? 0)).toBeGreaterThanOrEqual(0);
    expect(snapshot.suppression.lastEvent?.windowEndsAt).toBeDefined();
    expect(snapshot.suppression.lastEvent?.cooldownEndsAt).toMatch(/T/);
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

  it('EventSuppressionCooldownWindow aggregates per-channel cooldown feedback', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'channel-rate',
        detector: 'test-detector',
        channel: 'cam:1',
        rateLimit: { count: 1, perMs: 600, cooldownMs: 400 },
        suppressForMs: 500,
        reason: 'rate limited'
      },
      {
        id: 'channel-window',
        detector: 'test-detector',
        channel: 'cam:1',
        suppressForMs: 700,
        reason: 'window limited'
      }
    ]);

    expect(metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:1' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 100, meta: { channel: 'cam:1' } })).toBe(false);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 350, meta: { channel: 'cam:1' } })).toBe(false);

    const suppressionMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});
    expect(suppressionMeta.length).toBeGreaterThanOrEqual(2);
    const firstSuppression = suppressionMeta[0];
    expect(firstSuppression.suppressionChannelStates?.['cam:1']?.hits).toBeGreaterThanOrEqual(1);
    expect(firstSuppression.suppressionChannelStates?.['cam:1']?.reasons).toEqual(
      expect.arrayContaining(['rate limited'])
    );

    const snapshot = metrics.snapshot();
    expect(snapshot.suppression.byChannel['cam:1']).toBeGreaterThanOrEqual(2);
    const channelReasons = snapshot.suppression.byChannelReason['cam:1'];
    expect(channelReasons['rate limited']).toBeGreaterThanOrEqual(1);
    expect(channelReasons['window limited']).toBeGreaterThanOrEqual(1);
    const historyHistogram = snapshot.suppression.histogram.channel.historyCount['cam:1'];
    expect(Object.keys(historyHistogram)).not.toHaveLength(0);
    const lastStates = snapshot.suppression.lastEvent?.channelStates?.['cam:1'];
    expect(lastStates?.historyCount).toBeGreaterThanOrEqual(1);
    expect(lastStates?.reasons).toEqual(expect.arrayContaining(['window limited']));
  });

  it('EventSuppressionMetricsSnapshot exposes cooldown endpoints and history', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'window-limit',
        detector: 'test-detector',
        rateLimit: { count: 1, perMs: 500, cooldownMs: 900 },
        suppressForMs: 600,
        reason: 'window limit'
      }
    ]);

    metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:z' } });
    metricsBus.emitEvent({ ...basePayload, ts: 200, meta: { channel: 'cam:z' } });

    const snapshot = metrics.snapshot();
    const lastEvent = snapshot.suppression.lastEvent;
    expect(lastEvent?.cooldownEndsAt).toBeTruthy();
    expect(lastEvent?.windowEndsAt).toBeTruthy();
    const cooldownEndsAtTs = lastEvent?.cooldownEndsAt
      ? Date.parse(lastEvent.cooldownEndsAt)
      : Number.NaN;
    expect(Number.isFinite(cooldownEndsAtTs)).toBe(true);
    const ruleHistory = snapshot.suppression.rules['window-limit'];
    expect(ruleHistory).toBeDefined();
    expect(ruleHistory.history.lastCooldownEndsAt).toBe(lastEvent?.cooldownEndsAt ?? null);
  });

  it('EventSuppressionWindowRateLimitMerge combines channel histories for overlapping hits', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'window-rule',
        detector: 'test-detector',
        channel: 'cam:1',
        suppressForMs: 600,
        reason: 'window limited'
      },
      {
        id: 'rate-rule',
        detector: 'test-detector',
        channel: 'cam:1',
        rateLimit: { count: 1, perMs: 500, cooldownMs: 400 },
        suppressForMs: 400,
        reason: 'rate limited'
      }
    ]);

    expect(metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:1' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 250, meta: { channel: 'cam:1' } })).toBe(false);

    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});
    expect(suppressedMeta).toHaveLength(1);
    const merged = suppressedMeta[0];
    expect(Array.isArray(merged.suppressedBy)).toBe(true);
    expect(merged.suppressedBy?.length).toBeGreaterThanOrEqual(2);
    merged.suppressedBy?.forEach(entry => {
      expect(entry?.combinedHistoryCount).toBe(merged.suppressionHistoryCount);
      expect(entry?.combinedHistory).toEqual(merged.suppressionHistory);
    });

    const channelState = merged.suppressionChannelStates?.['cam:1'];
    expect(channelState?.historyCount).toBe(merged.suppressionHistoryCount);
    expect(channelState?.combinedHistoryCount).toBe(merged.suppressionHistoryCount);
    expect(channelState?.history).toEqual(merged.suppressionHistory);
    expect(channelState?.combinedHistory).toEqual(merged.suppressionHistory);

    const snapshot = metrics.snapshot();
    const lastState = snapshot.suppression.lastEvent?.channelStates?.['cam:1'];
    expect(lastState?.historyCount).toBe(channelState?.historyCount ?? null);
    expect(lastState?.combinedHistoryCount).toBe(channelState?.combinedHistoryCount ?? null);
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

  it('EventSuppressionMaxEventsWindow applies per-channel windows and updates histograms', () => {
    const metrics = new MetricsRegistry();
    metrics.reset();
    const metricsBus = new EventBus({
      store: event => store(event),
      log: log as any,
      metrics
    });

    metricsBus.configureSuppression([
      {
        id: 'channel-window',
        detector: 'test-detector',
        suppressForMs: 800,
        maxEvents: 2,
        reason: 'channel burst'
      }
    ]);

    expect(metricsBus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'cam:a' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 120, meta: { channel: 'cam:a' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 200, meta: { channel: 'cam:a' } })).toBe(false);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 210, meta: { channel: 'cam:b' } })).toBe(true);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 750, meta: { channel: 'cam:a' } })).toBe(false);
    expect(metricsBus.emitEvent({ ...basePayload, ts: 1205, meta: { channel: 'cam:a' } })).toBe(true);

    const suppressedMeta = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta ?? {});
    expect(suppressedMeta).toHaveLength(2);
    const firstSuppression = suppressedMeta[0];
    expect(firstSuppression.suppressionChannel).toBe('cam:a');
    expect(firstSuppression.suppressedBy?.[0]?.historyCount).toBe(2);
    expect(firstSuppression.suppressedBy?.[0]?.windowRemainingMs).toBe(800);
    const secondSuppression = suppressedMeta[1];
    expect(secondSuppression.suppressedBy?.[0]?.historyCount).toBe(2);
    expect(Number(secondSuppression.suppressedBy?.[0]?.windowRemainingMs ?? 0)).toBeLessThanOrEqual(800);

    const snapshot = metrics.snapshot();
    expect(snapshot.suppression.lastEvent?.historyCount).toBe(2);
    expect(snapshot.suppression.lastEvent?.maxEvents).toBe(2);
    const historyHistogram = snapshot.suppression.histogram.historyCount;
    expect(historyHistogram['2-5']).toBeGreaterThanOrEqual(2);
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
      channels: ['video:lobby', 'video:alerts'],
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
    expect(snapshot.suppression.lastEvent?.channels).toEqual(['video:lobby', 'video:alerts']);
    expect(snapshot.suppression.lastEvent?.cooldownRemainingMs).toBe(200);
    expect(snapshot.suppression.lastEvent?.windowRemainingMs).toBe(250);

    const ruleSnapshot = snapshot.suppression.rules['window-backoff'];
    expect(ruleSnapshot.total).toBe(2);
    expect(ruleSnapshot.history.total).toBe(5);
    expect(ruleSnapshot.history.combinedTotal).toBe(5);
    expect(ruleSnapshot.history.lastCount).toBe(3);
    expect(ruleSnapshot.history.lastCombinedCount).toBe(3);
    expect(ruleSnapshot.history.lastChannel).toBe('video:lobby');
    expect(ruleSnapshot.history.lastChannels).toEqual(['video:lobby', 'video:alerts']);
    expect(ruleSnapshot.history.lastCooldownMs).toBe(600);
    expect(ruleSnapshot.history.lastCooldownRemainingMs).toBe(200);
    expect(ruleSnapshot.history.lastWindowRemainingMs).toBe(250);
  });
});

