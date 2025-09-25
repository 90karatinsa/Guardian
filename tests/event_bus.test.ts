import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/eventBus.js';
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

