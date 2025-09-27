import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import metrics from '../src/metrics/index.js';

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
    metrics.reset();
  });

  it('MotionLightNoiseWindowing expands windows under sustained noise and records gauges', () => {
    const motion = new MotionDetector(
      {
        source: 'noise-motion',
        diffThreshold: 6,
        areaThreshold: 0.2,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.2,
        noiseSmoothing: 0.2,
        areaSmoothing: 0.18,
        areaInflation: 1.1,
        areaDeltaThreshold: 0.05
      },
      bus
    );

    const light = new LightDetector(
      {
        source: 'noise-light',
        deltaThreshold: 18,
        smoothingFactor: 0.08,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 2,
        noiseSmoothing: 0.18
      },
      bus
    );

    const motionBase = createUniformFrame(16, 16, 96);
    const lightBase = createUniformFrame(12, 12, 110);
    motion.handleFrame(motionBase, 0);
    light.handleFrame(lightBase, 0);

    for (let i = 0; i < 36; i += 1) {
      const motionNoise = createFrame(16, 16, (x, y) => 96 + ((x * y + i) % 5 === 0 ? 75 : -65));
      const lightNoise = createFrame(12, 12, (x, y) => 110 + ((x + 2 * y + i) % 5 === 0 ? 55 : -45));
      motion.handleFrame(motionNoise, i + 1);
      light.handleFrame(lightNoise, i + 1);
    }

    const gaugeSnapshot = metrics.snapshot();
    expect(gaugeSnapshot.detectors.motion?.gauges?.noiseWindowMedian ?? 0).toBeGreaterThan(0.1);
    expect(gaugeSnapshot.detectors.motion?.gauges?.noiseWindowBoost ?? 0).toBeGreaterThan(1);
    expect(gaugeSnapshot.detectors.light?.gauges?.noiseWindowMedian ?? 0).toBeGreaterThan(0.05);
    expect(gaugeSnapshot.detectors.light?.gauges?.noiseWindowBoost ?? 0).toBeGreaterThanOrEqual(1);

    const motionTrigger = [
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 8)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 10)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 12)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 14))
    ];

    motionTrigger.forEach((frame, idx) => {
      motion.handleFrame(frame, 200 + idx);
    });

    const lightTrigger = [
      createUniformFrame(12, 12, 200),
      createUniformFrame(12, 12, 210),
      createUniformFrame(12, 12, 220),
      createUniformFrame(12, 12, 230)
    ];

    lightTrigger.forEach((frame, idx) => {
      light.handleFrame(frame, 400 + idx * 2);
    });

    const motionEvent = events.find(event => event.detector === 'motion');
    const lightEvent = events.find(event => event.detector === 'light');

    expect(motionEvent).toBeDefined();
    expect(lightEvent).toBeDefined();

    const motionMeta = motionEvent?.meta as Record<string, number>;
    const lightMeta = lightEvent?.meta as Record<string, number>;

    expect(motionMeta.sustainedNoiseBoost ?? 0).toBeGreaterThan(1);
    expect(motionMeta.noiseWindowMedian ?? 0).toBeGreaterThan(0.3);
    expect(motionMeta.effectiveDebounceFrames ?? 0).toBeGreaterThanOrEqual(3);
    expect(motionMeta.effectiveBackoffFrames ?? 0).toBeGreaterThanOrEqual(3);

    expect(lightMeta.sustainedNoiseBoost ?? 0).toBeGreaterThanOrEqual(1);
    expect(lightMeta.noiseWindowMedian ?? 0).toBeGreaterThan(0.2);
    expect(lightMeta.effectiveDebounceFrames ?? 0).toBeGreaterThanOrEqual(3);
    expect(lightMeta.effectiveBackoffFrames ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('MotionAdaptiveTrendReset reduces sustained noise boost after calm frames', () => {
    const detector = new MotionDetector(
      {
        source: 'reset-motion',
        diffThreshold: 5,
        areaThreshold: 0.08,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.1,
        noiseSmoothing: 0.18,
        areaSmoothing: 0.2,
        areaInflation: 1.05
      },
      bus
    );

    const base = createUniformFrame(14, 14, 18);
    detector.handleFrame(base, 0);

    for (let i = 0; i < 28; i += 1) {
      const noisy = createFrame(14, 14, (x, y) => 18 + ((x + y + i) % 4 === 0 ? 10 : -9));
      detector.handleFrame(noisy, i + 1);
    }

    for (let i = 0; i < 20; i += 1) {
      const calm = createFrame(14, 14, (x, y) => 18 + ((x + i) % 7 === 0 ? 1 : 0));
      detector.handleFrame(calm, 100 + i);
    }

    const gaugeSnapshot = metrics.snapshot();
    expect(gaugeSnapshot.detectors.motion?.gauges?.noiseWindowBoost ?? 0).toBeLessThanOrEqual(1.2);

    const triggerFrames = [
      createFrame(14, 14, (x, y) => (x < 7 ? 250 : 12)),
      createFrame(14, 14, (x, y) => (x < 7 ? 252 : 12)),
      createFrame(14, 14, (x, y) => (x < 7 ? 254 : 12))
    ];

    triggerFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, 200 + idx);
    });

    const event = events.find(entry => entry.detector === 'motion');
    expect(event).toBeDefined();
    const meta = event?.meta as Record<string, number>;
    expect(meta.sustainedNoiseBoost ?? 0).toBeLessThanOrEqual(1.3);
    expect(meta.noiseWindowPressure ?? 0).toBeLessThan(0.4);
    expect(meta.areaWindowMedian ?? 0).toBeGreaterThan(0);
  });

  it('MotionNoiseAdaptiveBackoff applies warmup padding and reload updates counters', () => {
    const detector = new MotionDetector(
      {
        source: 'warmup-motion',
        diffThreshold: 4,
        areaThreshold: 0.025,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.3,
        noiseSmoothing: 0.18,
        areaSmoothing: 0.2,
        areaInflation: 1.05,
        noiseWarmupFrames: 3,
        noiseBackoffPadding: 2
      },
      bus
    );

    const base = createUniformFrame(16, 16, 8);
    detector.handleFrame(base, 0);

    const noiseFrames = [
      createFrame(16, 16, (x, y) => 8 + ((x + y) % 3 === 0 ? 6 : -5)),
      createFrame(16, 16, (x, y) => 8 + ((x * y) % 4 === 0 ? 7 : -6)),
      createFrame(16, 16, (x, y) => 8 + ((2 * x + y) % 5 === 0 ? 8 : -6))
    ];

    noiseFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, 1 + idx);
    });

    expect(events).toHaveLength(0);

    let snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.gauges?.noiseWarmupRemaining ?? 0).toBe(0);

    const motionBurst = [
      createFrame(16, 16, (x, y) => (x < 8 ? 220 : 5)),
      createFrame(16, 16, (x, y) => (x < 8 ? 235 : 6)),
      createFrame(16, 16, (x, y) => (x < 8 ? 245 : 7)),
      createFrame(16, 16, (x, y) => (x < 8 ? 250 : 8)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 9)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 10)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 11)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 12))
    ];

    let ts = 100;
    for (const frame of motionBurst) {
      detector.handleFrame(frame, ts);
      ts += 1;
    }

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.gauges?.noiseWarmupRemaining ?? 0).toBe(0);
    expect(snapshot.detectors.motion?.gauges?.noiseBackoffPadding ?? 0).toBe(2);
    expect(snapshot.detectors.motion?.gauges?.effectiveBackoffFrames ?? 0).toBeGreaterThanOrEqual(4);

    detector.updateOptions({
      debounceFrames: 3,
      backoffFrames: 2,
      noiseWarmupFrames: 2,
      noiseBackoffPadding: 3
    });

    const recalibration = createUniformFrame(16, 16, 9);
    detector.handleFrame(recalibration, 200);

    const warmupNoise = createFrame(16, 16, (x, y) => 9 + ((x + 2 * y) % 4 === 0 ? 4 : -3));
    detector.handleFrame(warmupNoise, 201);

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.gauges?.noiseWarmupRemaining ?? 0).toBe(0);

    detector.handleFrame(warmupNoise, 202);

    const secondBurst = [
      createFrame(16, 16, (x, y) => (x < 8 ? 225 : 6)),
      createFrame(16, 16, (x, y) => (x < 8 ? 235 : 7)),
      createFrame(16, 16, (x, y) => (x < 8 ? 245 : 8)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 9)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 10)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 11)),
      createFrame(16, 16, (x, y) => (x < 8 ? 255 : 12))
    ];

    let secondTs = 300;
    for (const frame of secondBurst) {
      detector.handleFrame(frame, secondTs);
      secondTs += 1;
    }

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.gauges?.noiseWarmupRemaining ?? 0).toBe(0);
    expect(snapshot.detectors.motion?.gauges?.noiseBackoffPadding ?? 0).toBe(3);
    expect(snapshot.detectors.motion?.gauges?.effectiveDebounceFrames ?? 0).toBeGreaterThanOrEqual(3);
    expect(snapshot.detectors.motion?.gauges?.effectiveBackoffFrames ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('MotionLightAdaptiveBackoff suppresses noise bursts and tracks suppression metrics', () => {
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
    const meta = events[0].meta as Record<string, unknown>;
    expect(typeof meta.denoiseStrategy).toBe('string');
    expect(meta.denoiseStrategy).toContain('median');
    expect(meta.areaPct as number).toBeGreaterThan(0.05);
    expect(meta.effectiveDebounceFrames as number).toBeGreaterThanOrEqual(2);
    expect(meta.effectiveBackoffFrames as number).toBeGreaterThanOrEqual(3);
    expect(meta.noiseMultiplier as number).toBe(1.5);
    expect(meta.areaInflation as number).toBe(1);
    expect(meta.areaBaseline as number).toBeGreaterThan(0);
    expect(meta.noiseSuppressionFactor as number).toBeGreaterThan(0);
    expect(meta.suppressedFramesBeforeTrigger as number).toBeGreaterThanOrEqual(0);
    expect(meta.noiseFloor as number).toBeGreaterThanOrEqual(0);
    expect(meta.stabilizedAreaTrend).toBeDefined();

    detector.handleFrame(motionFrames[2], 200);
    expect(events).toHaveLength(1);

    const snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.counters?.suppressedFrames).toBeGreaterThan(0);
    expect(snapshot.detectors.motion?.counters?.backoffActivations ?? 0).toBeGreaterThan(0);
    expect(
      snapshot.detectors.motion?.counters?.suppressedFramesBeforeTrigger ?? 0
    ).toBeGreaterThanOrEqual(meta.suppressedFramesBeforeTrigger ?? 0);
  });

  it('MotionHotReloadResetsAdaptiveState rebuilds thresholds after updateOptions', () => {
    const detector = new MotionDetector(
      {
        source: 'hot-reload-camera',
        diffThreshold: 3,
        areaThreshold: 0.02,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 3,
        noiseMultiplier: 1.4,
        noiseSmoothing: 0.2,
        areaSmoothing: 0.15,
        areaInflation: 1.2,
        areaDeltaThreshold: 0.015
      },
      bus
    );

    const base = createUniformFrame(12, 12, 10);
    const softNoise = createUniformFrame(12, 12, 11);

    detector.handleFrame(base, 0);
    for (let i = 0; i < 3; i += 1) {
      detector.handleFrame(softNoise, i + 1);
    }

    const beforeUpdate = metrics.snapshot();
    expect(beforeUpdate.detectors.motion?.counters?.suppressedFrames ?? 0).toBeGreaterThan(0);

    detector.updateOptions({ areaThreshold: 0.05, debounceFrames: 3 });

    const suppressedBeforeReinit =
      beforeUpdate.detectors.motion?.counters?.suppressedFrames ?? 0;

    const recalibration = createUniformFrame(12, 12, 12);
    detector.handleFrame(recalibration, 100);

    const afterReinit = metrics.snapshot();
    expect(afterReinit.detectors.motion?.counters?.suppressedFrames ?? 0).toBe(
      suppressedBeforeReinit
    );

    const postUpdateSuppressed = createUniformFrame(12, 12, 13);

    detector.handleFrame(postUpdateSuppressed, 101);
    detector.handleFrame(postUpdateSuppressed, 102);

    const snapshotBeforeTrigger = metrics.snapshot();
    const baselineSuppressedBeforeTrigger =
      snapshotBeforeTrigger.detectors.motion?.counters?.suppressedFramesBeforeTrigger ?? 0;

    const activationFrames = [
      createFrame(12, 12, (x, y) => (x < 6 ? 210 : 12)),
      createFrame(12, 12, (x, y) => (x < 6 ? 220 : 12)),
      createFrame(12, 12, (x, y) => (x < 6 ? 230 : 12))
    ];

    activationFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, 200 + idx);
    });

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta.areaThreshold as number).toBeCloseTo(0.05, 5);
    expect(meta.effectiveDebounceFrames as number).toBeGreaterThanOrEqual(3);
    expect(meta.suppressedFramesBeforeTrigger).toBe(2);
    expect(typeof meta.denoiseStrategy).toBe('string');

    const snapshotAfterTrigger = metrics.snapshot();
    const increment =
      (snapshotAfterTrigger.detectors.motion?.counters?.suppressedFramesBeforeTrigger ?? 0) -
      baselineSuppressedBeforeTrigger;
    expect(increment).toBe(meta.suppressedFramesBeforeTrigger);
  });

  it('MotionDetectorIdleRebaseline clears suppression after prolonged inactivity', () => {
    const detector = new MotionDetector(
      {
        source: 'idle-camera',
        diffThreshold: 4,
        areaThreshold: 0.015,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        idleRebaselineMs: 50
      },
      bus
    );

    const base = createUniformFrame(10, 10, 12);
    const lowNoise = createUniformFrame(10, 10, 14);

    detector.handleFrame(base, 0);
    detector.handleFrame(lowNoise, 1);
    detector.handleFrame(lowNoise, 2);

    const beforeReset = metrics.snapshot();
    expect(beforeReset.detectors.motion?.counters?.suppressedFrames ?? 0).toBeGreaterThan(0);

    const shifted = createUniformFrame(10, 10, 35);
    detector.handleFrame(shifted, 200);

    expect(events).toHaveLength(0);

    const afterReset = metrics.snapshot();
    expect(afterReset.detectors.motion?.counters?.suppressedFrames).toBe(0);
    expect(afterReset.detectors.motion?.counters?.suppressedFramesBeforeTrigger).toBe(0);
    expect(afterReset.detectors.motion?.counters?.idleResets).toBe(1);

    const postReset = createUniformFrame(10, 10, 36);
    detector.handleFrame(postReset, 201);
    expect(events).toHaveLength(0);
  });

  it('MotionLightAdaptiveNoise preserves suppression counters across hot reloads', () => {
    const motion = new MotionDetector(
      {
        source: 'combo-motion',
        diffThreshold: 3,
        areaThreshold: 0.02,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.3,
        noiseSmoothing: 0.18,
        areaSmoothing: 0.18,
        idleRebaselineMs: 5_000
      },
      bus
    );

    const light = new LightDetector(
      {
        source: 'combo-light',
        deltaThreshold: 10,
        smoothingFactor: 0.06,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 2,
        noiseSmoothing: 0.14,
        idleRebaselineMs: 8_000
      },
      bus
    );

    const motionBase = createUniformFrame(12, 12, 10);
    const lightBase = createUniformFrame(12, 12, 25);
    motion.handleFrame(motionBase, 0);
    light.handleFrame(lightBase, 0);

    const motionNoise = createFrame(12, 12, (x, y) => 10 + ((x + y) % 4 === 0 ? 1 : 0));
    const lightNoise = createUniformFrame(12, 12, 27);

    for (let i = 1; i <= 4; i += 1) {
      motion.handleFrame(motionNoise, i);
      light.handleFrame(lightNoise, i);
    }

    const beforeUpdate = metrics.snapshot();
    const motionSuppressedBefore = beforeUpdate.detectors.motion?.counters?.suppressedFrames ?? 0;
    const lightSuppressedBefore = beforeUpdate.detectors.light?.counters?.suppressedFrames ?? 0;
    expect(motionSuppressedBefore).toBeGreaterThan(0);
    expect(lightSuppressedBefore).toBeGreaterThan(0);

    motion.updateOptions({ debounceFrames: 3, backoffFrames: 4 });
    light.updateOptions({ debounceFrames: 3, backoffFrames: 4 });

    motion.handleFrame(motionNoise, 10);
    light.handleFrame(lightNoise, 10);

    const motionTriggers = [
      createFrame(12, 12, (x, y) => (x < 6 ? 210 : 12)),
      createFrame(12, 12, (x, y) => (x < 6 ? 225 : 12)),
      createFrame(12, 12, (x, y) => (x < 6 ? 235 : 13)),
      createFrame(12, 12, (x, y) => (x < 6 ? 245 : 13))
    ];
    motionTriggers.forEach((frame, idx) => {
      motion.handleFrame(frame, 20 + idx);
    });

    const lightTriggers = [
      createUniformFrame(12, 12, 160),
      createUniformFrame(12, 12, 175),
      createUniformFrame(12, 12, 190),
      createUniformFrame(12, 12, 205)
    ];
    lightTriggers.forEach((frame, idx) => {
      light.handleFrame(frame, 40 + idx * 2);
    });

    const motionEvent = events.find(event => event.detector === 'motion');
    let lightEvent = events.find(event => event.detector === 'light');
    if (!lightEvent) {
      const reinforcement = [
        createUniformFrame(12, 12, 210),
        createUniformFrame(12, 12, 225),
        createUniformFrame(12, 12, 240)
      ];
      reinforcement.forEach((frame, idx) => {
        light.handleFrame(frame, 60 + idx * 3);
      });
      lightEvent = events.find(event => event.detector === 'light');
    }

    expect(motionEvent).toBeDefined();
    expect(lightEvent).toBeDefined();
    expect(typeof motionEvent?.meta?.denoiseStrategy).toBe('string');
    expect(typeof lightEvent?.meta?.denoiseStrategy).toBe('string');

    const afterUpdate = metrics.snapshot();
    expect(afterUpdate.detectors.motion?.counters?.suppressedFrames ?? 0).toBeGreaterThanOrEqual(
      motionSuppressedBefore
    );
    expect(afterUpdate.detectors.light?.counters?.suppressedFrames ?? 0).toBeGreaterThanOrEqual(
      lightSuppressedBefore
    );
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
    metrics.reset();
  });

  it('LightFlickerImmunity ignores flicker and records suppression counters', () => {
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
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta.delta as number).toBeGreaterThan(150);
    expect(meta.rawAdaptiveThreshold as number).toBeGreaterThanOrEqual(
      meta.deltaThreshold as number
    );
    expect(meta.adaptiveThreshold as number).toBeGreaterThan(meta.deltaThreshold as number);
    expect(meta.effectiveDebounceFrames as number).toBeGreaterThanOrEqual(2);
    expect(meta.effectiveBackoffFrames as number).toBeGreaterThanOrEqual(3);
    expect(meta.noiseMultiplier as number).toBe(3);
    expect(meta.debounceMultiplier as number).toBeGreaterThanOrEqual(1);
    expect(meta.backoffMultiplier as number).toBeGreaterThanOrEqual(1);
    expect(meta.suppressedFramesBeforeTrigger as number).toBeGreaterThanOrEqual(0);
    expect(meta.noiseFloor as number).toBeGreaterThanOrEqual(0);
    expect(meta.noiseSuppressionFactor as number).toBeGreaterThanOrEqual(1);
    expect(meta.previousBaseline as number).toBeLessThan(meta.baseline as number);
    expect(meta.baseline as number).toBeGreaterThan(20);
    expect(meta.stabilizedDelta as number).toBeGreaterThan(0);
    expect(typeof meta.denoiseStrategy).toBe('string');

    detector.handleFrame(brightShift[2], ts0 + 20000);
    expect(events).toHaveLength(1);

    const snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.counters?.suppressedFrames).toBeGreaterThan(0);
    expect(
      snapshot.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0
    ).toBeGreaterThanOrEqual(meta.suppressedFramesBeforeTrigger ?? 0);
  });

  it('LightOvernightWindowDebounce handles overnight hours and resets suppression state', () => {
    const detector = new LightDetector(
      {
        source: 'test-camera-light',
        deltaThreshold: 15,
        smoothingFactor: 0.08,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 3,
        noiseMultiplier: 2.2,
        noiseSmoothing: 0.12,
        normalHours: [{ start: 22, end: 6 }]
      },
      bus
    );

    const baseline = createUniformFrame(10, 10, 30);
    const withinNight = createUniformFrame(10, 10, 33);
    const outsideNight = createUniformFrame(10, 10, 38);

    const tsNightBaseline = new Date(2024, 0, 1, 23, 0, 0).getTime();
    detector.handleFrame(baseline, tsNightBaseline);

    const tsNightAdjustment = new Date(2024, 0, 2, 2, 0, 0).getTime();
    detector.handleFrame(withinNight, tsNightAdjustment);

    const tsMorning = new Date(2024, 0, 2, 7, 0, 0).getTime();
    detector.handleFrame(outsideNight, tsMorning);
    detector.handleFrame(outsideNight, tsMorning + 1000);

    const beforeUpdate = metrics.snapshot();
    expect(beforeUpdate.detectors.light?.counters?.suppressedFrames ?? 0).toBeGreaterThan(0);

    detector.updateOptions({
      debounceFrames: 3,
      normalHours: [{ start: 21, end: 5 }]
    });

    const suppressedBeforeReset =
      beforeUpdate.detectors.light?.counters?.suppressedFrames ?? 0;

    const tsNewBaseline = new Date(2024, 0, 3, 21, 30, 0).getTime();
    const newBaselineFrame = createUniformFrame(10, 10, 32);
    detector.handleFrame(newBaselineFrame, tsNewBaseline);

    const tsWithinNewHours = new Date(2024, 0, 3, 22, 15, 0).getTime();
    detector.handleFrame(createUniformFrame(10, 10, 34), tsWithinNewHours);

    const afterReset = metrics.snapshot();
    expect(afterReset.detectors.light?.counters?.suppressedFrames ?? 0).toBe(
      suppressedBeforeReset
    );

    const tsSuppressedStart = new Date(2024, 0, 4, 6, 0, 0).getTime();
    const suppressedPostUpdate = createUniformFrame(10, 10, 45);
    detector.handleFrame(suppressedPostUpdate, tsSuppressedStart);
    detector.handleFrame(suppressedPostUpdate, tsSuppressedStart + 1000);

    const snapshotBeforeTrigger = metrics.snapshot();
    const priorSuppressedBeforeTrigger =
      snapshotBeforeTrigger.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0;

    const triggerFrames = [
      createUniformFrame(10, 10, 200),
      createUniformFrame(10, 10, 210),
      createUniformFrame(10, 10, 220),
      createUniformFrame(10, 10, 230),
      createUniformFrame(10, 10, 240)
    ];
    triggerFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, tsSuppressedStart + 2000 + idx * 400);
    });

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, unknown>;
    expect(meta.delta as number).toBeGreaterThan(meta.deltaThreshold as number);
    expect(meta.effectiveDebounceFrames as number).toBeGreaterThanOrEqual(3);
    expect(meta.suppressedFramesBeforeTrigger).toBe(2);
    expect(typeof meta.denoiseStrategy).toBe('string');

    const snapshotAfterTrigger = metrics.snapshot();
    const diff =
      (snapshotAfterTrigger.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0) -
      priorSuppressedBeforeTrigger;
    expect(diff).toBe(meta.suppressedFramesBeforeTrigger);
  });

  it('LightDetectorIdleRebaseline rebuilds baseline after idle gaps', () => {
    const detector = new LightDetector(
      {
        source: 'idle-light-camera',
        deltaThreshold: 12,
        smoothingFactor: 0.1,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 2.5,
        noiseSmoothing: 0.15,
        idleRebaselineMs: 1000
      },
      bus
    );

    const baseline = createUniformFrame(8, 8, 20);
    const flicker = createUniformFrame(8, 8, 23);

    detector.handleFrame(baseline, 0);
    detector.handleFrame(flicker, 100);
    detector.handleFrame(flicker, 200);

    const beforeIdle = metrics.snapshot();
    expect(beforeIdle.detectors.light?.counters?.suppressedFrames ?? 0).toBeGreaterThan(0);

    const newBaseline = createUniformFrame(8, 8, 60);
    detector.handleFrame(newBaseline, 2000);

    expect(events).toHaveLength(0);

    const afterIdle = metrics.snapshot();
    expect(afterIdle.detectors.light?.counters?.suppressedFrames).toBe(0);
    expect(afterIdle.detectors.light?.counters?.suppressedFramesBeforeTrigger).toBe(0);
    expect(afterIdle.detectors.light?.counters?.idleResets).toBe(1);

    detector.handleFrame(createUniformFrame(8, 8, 62), 2100);
    expect(events).toHaveLength(0);
  });

  it('LightDetectorNoiseWindow enforces warmup and noise padding tuning', () => {
    const detector = new LightDetector(
      {
        source: 'warmup-light',
        deltaThreshold: 18,
        smoothingFactor: 0.07,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 2.2,
        noiseSmoothing: 0.16,
        noiseWarmupFrames: 2,
        noiseBackoffPadding: 1
      },
      bus
    );

    const baseline = createUniformFrame(12, 12, 30);
    detector.handleFrame(baseline, 0);

    const noiseFrames = [
      createUniformFrame(12, 12, 33),
      createUniformFrame(12, 12, 35)
    ];

    noiseFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, 1 + idx);
    });

    expect(events).toHaveLength(0);
    let snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.gauges?.noiseWarmupRemaining ?? 0).toBe(0);
    const initialDebounce = Math.max(
      1,
      snapshot.detectors.light?.gauges?.effectiveDebounceFrames ?? 0
    );

    const triggerIterations = Math.max(initialDebounce + 10, 12);
    for (let idx = 0; idx < triggerIterations && events.length === 0; idx += 1) {
      const frame = createUniformFrame(12, 12, 160 + idx * 15);
      detector.handleFrame(frame, 200 + idx * 2);
    }

    expect(events).toHaveLength(1);
    const firstMeta = events[0].meta as Record<string, number>;
    expect(firstMeta.noiseWarmupRemaining).toBe(0);
    expect(firstMeta.noiseBackoffPadding).toBe(1);
    expect(firstMeta.effectiveBackoffFrames).toBeGreaterThanOrEqual(3);
    expect(firstMeta.sustainedNoiseBoost).toBeGreaterThanOrEqual(1);
    expect(firstMeta.sustainedNoiseBoost).toBeLessThanOrEqual(4);

    detector.updateOptions({
      debounceFrames: 3,
      backoffFrames: 2,
      noiseWarmupFrames: 1,
      noiseBackoffPadding: 2
    });

    const recalibration = createUniformFrame(12, 12, 40);
    detector.handleFrame(recalibration, 400);
    detector.handleFrame(createUniformFrame(12, 12, 42), 401);

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.gauges?.noiseWarmupRemaining ?? 0).toBe(0);
    const updatedDebounce = Math.max(
      1,
      snapshot.detectors.light?.gauges?.effectiveDebounceFrames ?? 0
    );

    const followUpIterations = Math.max(updatedDebounce + 20, 24);
    for (let idx = 0; idx < followUpIterations; idx += 1) {
      const frame = createUniformFrame(12, 12, 200 + idx * 15);
      detector.handleFrame(frame, 500 + idx * 3);
      if (events.filter(event => event.detector === 'light').length >= 2) {
        break;
      }
    }

    expect(events.filter(event => event.detector === 'light')).toHaveLength(2);
    const secondLightEvent = events.filter(event => event.detector === 'light').at(-1);
    const secondMeta = secondLightEvent?.meta as Record<string, number>;
    expect(secondMeta.noiseWarmupRemaining).toBe(0);
    expect(secondMeta.noiseBackoffPadding).toBe(2);
    expect(secondMeta.effectiveBackoffFrames).toBeGreaterThanOrEqual(4);
    expect(secondMeta.sustainedNoiseBoost).toBeGreaterThanOrEqual(1);
    expect(secondMeta.sustainedNoiseBoost).toBeLessThanOrEqual(4);
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
