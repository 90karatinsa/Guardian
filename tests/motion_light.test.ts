import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

interface CapturedEvent {
  detector: string;
  meta?: Record<string, unknown>;
}

vi.mock('pngjs', () => {
  class FakePNG {
    width: number;
    height: number;
    data: Uint8Array;

    constructor({ width, height }: { width: number; height: number }) {
      this.width = width;
      this.height = height;
      this.data = new Uint8Array(width * height * 4);
    }
  }

  FakePNG.sync = {
    write(png: FakePNG) {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(png.width, 0);
      header.writeUInt32BE(png.height, 4);
      return Buffer.concat([header, Buffer.from(png.data)]);
    },
    read(buffer: Buffer) {
      const width = buffer.readUInt32BE(0);
      const height = buffer.readUInt32BE(4);
      const data = new Uint8Array(buffer.subarray(8));
      return { width, height, data };
    }
  } as const;

  return { PNG: FakePNG };
});

import { PNG } from 'pngjs';
import MotionDetector from '../src/video/motionDetector.js';
import LightDetector from '../src/video/lightDetector.js';

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

  it('MotionLightNoiseBackoff suppresses noise and emits single event for sustained motion', () => {
    const detector = new MotionDetector(
      {
        source: 'test-camera',
        diffThreshold: 4,
        areaThreshold: 0.02,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 3,
        noiseMultiplier: 1.5,
        noiseSmoothing: 0.2,
        areaSmoothing: 0.2,
        areaInflation: 1
      },
      bus
    );

    const base = createUniformFrame(16, 16, 8);
    const noiseFrames = [
      createFrame(16, 16, (x, y) => 8 + ((x + y) % 3 === 0 ? 1 : -1)),
      createFrame(16, 16, (x, y) => 8 + ((x * y) % 4 === 0 ? 1 : 0)),
      createFrame(16, 16, (x, y) => 8 + ((x + 2 * y) % 5 === 0 ? -1 : 1)),
      createFrame(16, 16, (x, y) => 8 + ((2 * x + y) % 6 === 0 ? 0 : 1))
    ];
    const motionFrames = [
      createFrame(16, 16, (x, y) => (x < 8 ? 220 : 5)),
      createFrame(16, 16, (x, y) => (x < 8 ? 235 : 6)),
      createFrame(16, 16, (x, y) => (x < 8 ? 245 : 7)),
      createFrame(16, 16, (x, y) => (x < 8 ? 250 : 8)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 10))
    ];

    detector.handleFrame(base, 0);
    noiseFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, idx + 1);
    });

    expect(events).toHaveLength(0);

    motionFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, 100 + idx);
    });

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('motion');
    const meta = events[0].meta as Record<string, number>;
    expect(meta.areaPct).toBeGreaterThan(0.05);
    expect(meta.effectiveDebounceFrames).toBeGreaterThanOrEqual(2);
    expect(meta.effectiveBackoffFrames).toBeGreaterThanOrEqual(3);
    expect(meta.noiseMultiplier).toBe(1.5);
    expect(meta.areaInflation).toBe(1);
    expect(meta.areaBaseline).toBeGreaterThan(0);
    expect(meta.noiseSuppressionFactor).toBeGreaterThan(0);
    expect(meta.suppressedFramesBeforeTrigger).toBeGreaterThanOrEqual(0);
    expect(meta.noiseFloor).toBeGreaterThanOrEqual(0);

    detector.handleFrame(motionFrames[2], 200);
    expect(events).toHaveLength(1);
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

  it('MotionLightNoiseBackoff ignores flicker and reports deliberate change', () => {
    const detector = new LightDetector(
      {
        source: 'test-camera',
        deltaThreshold: 12,
        smoothingFactor: 0.05,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 3,
        noiseMultiplier: 3,
        noiseSmoothing: 0.2
      },
      bus
    );

    const base = createUniformFrame(12, 12, 20);
    const noiseFrames = [
      createFrame(12, 12, (x, y) => 20 + ((x + y) % 4 === 0 ? 1 : -1)),
      createFrame(12, 12, (x, y) => 20 + ((x * y) % 5 === 0 ? -2 : 1)),
      createFrame(12, 12, (x, y) => 20 + ((2 * x + y) % 6 === 0 ? 2 : -1))
    ];
    const brightShift = [
      createUniformFrame(12, 12, 190),
      createUniformFrame(12, 12, 205),
      createUniformFrame(12, 12, 210),
      createUniformFrame(12, 12, 215)
    ];

    const ts0 = new Date('2024-01-01T03:00:00Z').getTime();
    detector.handleFrame(base, ts0);
    noiseFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, ts0 + (idx + 1) * 1000);
    });

    expect(events).toHaveLength(0);

    brightShift.forEach((frame, idx) => {
      detector.handleFrame(frame, ts0 + 10000 + idx * 1000);
    });

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('light');
    const meta = events[0].meta as Record<string, number>;
    expect(meta.delta).toBeGreaterThan(150);
    expect(meta.rawAdaptiveThreshold).toBeGreaterThanOrEqual(meta.deltaThreshold);
    expect(meta.adaptiveThreshold).toBeGreaterThan(meta.deltaThreshold);
    expect(meta.effectiveDebounceFrames).toBeGreaterThanOrEqual(2);
    expect(meta.effectiveBackoffFrames).toBeGreaterThanOrEqual(3);
    expect(meta.noiseMultiplier).toBe(3);
    expect(meta.debounceMultiplier).toBeGreaterThanOrEqual(1);
    expect(meta.backoffMultiplier).toBeGreaterThanOrEqual(1);
    expect(meta.suppressedFramesBeforeTrigger).toBeGreaterThanOrEqual(0);
    expect(meta.noiseFloor).toBeGreaterThanOrEqual(0);
    expect(meta.noiseSuppressionFactor).toBeGreaterThanOrEqual(1);
    expect(meta.previousBaseline).toBeLessThan(meta.baseline);
    expect(meta.baseline).toBeGreaterThan(20);

    detector.handleFrame(brightShift[2], ts0 + 20000);
    expect(events).toHaveLength(1);
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
