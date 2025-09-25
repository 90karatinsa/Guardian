import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/eventBus.js';
import { EventPayload } from '../src/types.js';

describe('EventSuppression', () => {
  let store: ReturnType<typeof vi.fn>;
  let log: { info: ReturnType<typeof vi.fn> };
  let bus: EventBus;
  let metricsMock: { recordEvent: ReturnType<typeof vi.fn>; recordSuppressedEvent: ReturnType<typeof vi.fn> };

  const basePayload: EventPayload = {
    source: 'sensor:1',
    detector: 'test-detector',
    severity: 'warning',
    message: 'test message'
  };

  beforeEach(() => {
    store = vi.fn();
    log = { info: vi.fn() };
    metricsMock = {
      recordEvent: vi.fn(),
      recordSuppressedEvent: vi.fn()
    };
    bus = new EventBus({
      store: event => {
        store(event);
      },
      log: log as any,
      metrics: metricsMock as any
    });
  });

  it('EventSuppressionRateLimit filters by channel before applying rate limits', () => {
    bus.configureSuppression([
      {
        id: 'channel-limit',
        detector: 'test-detector',
        channel: 'alerts',
        rateLimit: { count: 2, perMs: 1000 },
        reason: 'alerts throttled'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'metrics' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 50, meta: { channel: 'alerts' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 200, meta: { channel: 'alerts' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 300, meta: { channel: 'alerts' } })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 1600, meta: { channel: 'alerts' } })).toBe(true);

    expect(store).toHaveBeenCalledTimes(4);
    expect(metricsMock.recordSuppressedEvent).toHaveBeenCalledWith('channel-limit', 'alerts throttled');

    const suppressionCall = log.info.mock.calls.find(([, message]) => message === 'Event suppressed');
    expect(suppressionCall?.[0]?.meta).toMatchObject({
      suppressionReason: 'alerts throttled',
      suppressionType: 'rate-limit',
      suppressionRuleId: 'channel-limit'
    });
    expect(suppressionCall?.[0]?.meta?.suppressionHistoryCount).toBe(3);
    expect(Array.isArray(suppressionCall?.[0]?.meta?.suppressionHistory)).toBe(true);
    expect((suppressionCall?.[0]?.meta?.suppressionHistory as unknown[])?.length).toBe(3);
    const suppressedBy = suppressionCall?.[0]?.meta?.suppressedBy as Array<Record<string, unknown>>;
    expect(Array.isArray(suppressedBy)).toBe(true);
    expect(suppressedBy?.[0]).toMatchObject({ ruleId: 'channel-limit', type: 'rate-limit', historyCount: 3 });
    expect((suppressedBy?.[0]?.history as unknown[])?.length).toBe(3);
  });

  it('EventSuppressionRateLimit combines rate limit triggers with cooldown windows', () => {
    bus.configureSuppression([
      {
        id: 'combo',
        detector: 'test-detector',
        suppressForMs: 1000,
        rateLimit: { count: 2, perMs: 500 },
        reason: 'combo suppression'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0, meta: { channel: 'alerts' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 200, meta: { channel: 'alerts' } })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 300, meta: { channel: 'alerts' } })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 900, meta: { channel: 'alerts' } })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 1400, meta: { channel: 'alerts' } })).toBe(true);

    expect(store).toHaveBeenCalledTimes(3);
    expect(metricsMock.recordSuppressedEvent).toHaveBeenCalledWith('combo', 'combo suppression');

    const rateLimitedCall = log.info.mock.calls
      .filter(([, message]) => message === 'Event suppressed')
      .map(call => call[0]?.meta);

    expect(rateLimitedCall[0]).toMatchObject({
      suppressionType: 'rate-limit',
      suppressionRuleId: 'combo'
    });
    expect(rateLimitedCall[0]?.suppressedBy?.[0]).toMatchObject({ type: 'rate-limit', historyCount: 2 });
    expect((rateLimitedCall[0]?.suppressedBy?.[0]?.history as unknown[])?.length).toBe(2);
    expect(rateLimitedCall[1]).toMatchObject({
      suppressionType: 'window',
      suppressionRuleId: 'combo'
    });
    expect(rateLimitedCall[1]?.suppressedBy?.[0]).toMatchObject({ type: 'window' });
    expect(rateLimitedCall[1]?.suppressionWindowExpiresAt).toBeGreaterThan(rateLimitedCall[1]?.suppressionHistory?.[0] ?? 0);
  });
});
