import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/eventBus.js';
import { EventPayload } from '../src/types.js';

describe('EventSuppression', () => {
  let store: ReturnType<typeof vi.fn>;
  let log: { info: ReturnType<typeof vi.fn> };
  let bus: EventBus;

  const basePayload: EventPayload = {
    source: 'sensor:1',
    detector: 'test-detector',
    severity: 'warning',
    message: 'test message'
  };

  beforeEach(() => {
    store = vi.fn();
    log = { info: vi.fn() };
    bus = new EventBus({
      store: event => {
        store(event);
      },
      log: log as any
    });
  });

  it('suppresses events within configured cooldown window', () => {
    bus.configureSuppression([
      {
        detector: 'test-detector',
        source: 'sensor:1',
        suppressForMs: 1000,
        reason: 'cooldown'
      }
    ]);

    const first = bus.emitEvent({ ...basePayload, ts: 0 });
    const suppressed = bus.emitEvent({ ...basePayload, ts: 500 });
    const allowedAgain = bus.emitEvent({ ...basePayload, ts: 1500 });

    expect(first).toBe(true);
    expect(suppressed).toBe(false);
    expect(allowedAgain).toBe(true);
    expect(store).toHaveBeenCalledTimes(2);

    const suppressionCall = log.info.mock.calls.find(([, message]) => message === 'Event suppressed');
    expect(suppressionCall?.[0]?.meta).toMatchObject({
      suppressed: true,
      suppressionReason: 'cooldown',
      suppressionType: 'window'
    });
  });

  it('applies rate limit counters per rule', () => {
    bus.configureSuppression([
      {
        detector: 'test-detector',
        rateLimit: { count: 2, perMs: 1000 },
        reason: 'rate limit'
      }
    ]);

    expect(bus.emitEvent({ ...basePayload, ts: 0 })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 200 })).toBe(true);
    expect(bus.emitEvent({ ...basePayload, ts: 400 })).toBe(false);
    expect(bus.emitEvent({ ...basePayload, ts: 1600 })).toBe(true);

    expect(store).toHaveBeenCalledTimes(3);

    const suppressionCall = log.info.mock.calls.find(([, message]) => message === 'Event suppressed');
    expect(suppressionCall?.[0]?.meta).toMatchObject({
      suppressionReason: 'rate limit',
      suppressionType: 'rate-limit'
    });
  });
});
