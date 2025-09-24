import { describe, expect, it, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PNG } from 'pngjs';
import MotionDetector from '../src/video/motionDetector.js';
import LightDetector from '../src/video/lightDetector.js';

interface CapturedEvent {
  detector: string;
  meta?: Record<string, unknown>;
}

describe('MotionDetector', () => {
  let bus: EventEmitter;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new EventEmitter();
    events = [];
    bus.on('event', payload => {
      events.push({ detector: payload.detector, meta: payload.meta });
    });
  });

  it('ignores small changes below area threshold', () => {
    const detector = new MotionDetector(
      {
        source: 'test-camera',
        diffThreshold: 20,
        areaThreshold: 0.2,
        minIntervalMs: 0
      },
      bus
    );

    const base = createUniformFrame(16, 16, 10);
    const slightlyChanged = createFrame(16, 16, (x, y) => (x < 4 && y < 4 ? 50 : 10));

    detector.handleFrame(base, 0);
    detector.handleFrame(slightlyChanged, 1);

    expect(events).toHaveLength(0);
  });

  it('emits event when changed area exceeds threshold', () => {
    const detector = new MotionDetector(
      {
        source: 'test-camera',
        diffThreshold: 10,
        areaThreshold: 0.1,
        minIntervalMs: 0
      },
      bus
    );

    const base = createUniformFrame(10, 10, 10);
    const changed = createFrame(10, 10, (x, y) => (x < 5 ? 200 : 10));

    detector.handleFrame(base, 0);
    detector.handleFrame(changed, 1);

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('motion');
    expect(events[0].meta?.areaPct).toBeGreaterThan(0.4);
  });
});

describe('LightDetector', () => {
  let bus: EventEmitter;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new EventEmitter();
    events = [];
    bus.on('event', payload => {
      events.push({ detector: payload.detector, meta: payload.meta });
    });
  });

  it('detects sharp luminance changes outside normal hours', () => {
    const detector = new LightDetector(
      {
        source: 'test-camera',
        deltaThreshold: 20,
        normalHours: [{ start: 8, end: 20 }],
        smoothingFactor: 0,
        minIntervalMs: 0
      },
      bus
    );

    const dark = createUniformFrame(8, 8, 5);
    const bright = createUniformFrame(8, 8, 200);

    const ts1 = new Date('2024-01-01T06:00:00Z').getTime();
    const ts2 = new Date('2024-01-01T06:05:00Z').getTime();

    detector.handleFrame(dark, ts1);
    detector.handleFrame(bright, ts2);

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('light');
    expect(events[0].meta?.delta).toBeGreaterThan(150);
  });

  it('ignores changes during configured normal hours', () => {
    const detector = new LightDetector(
      {
        source: 'test-camera',
        deltaThreshold: 10,
        normalHours: [{ start: 7, end: 22 }],
        smoothingFactor: 0,
        minIntervalMs: 0
      },
      bus
    );

    const base = createUniformFrame(8, 8, 120);
    const brighter = createUniformFrame(8, 8, 180);

    const ts1 = new Date('2024-01-01T12:00:00Z').getTime();
    const ts2 = new Date('2024-01-01T12:01:00Z').getTime();

    detector.handleFrame(base, ts1);
    detector.handleFrame(brighter, ts2);

    expect(events).toHaveLength(0);
  });
});

function createUniformFrame(width: number, height: number, value: number) {
  return createFrame(width, height, () => value);
}

function createFrame(width: number, height: number, fn: (x: number, y: number) => number) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      const value = clamp(fn(x, y));
      png.data[idx] = value;
      png.data[idx + 1] = value;
      png.data[idx + 2] = value;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function clamp(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
