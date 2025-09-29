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

  it('MotionTemporalMedianSuppressesNoise', () => {
    const detector = new MotionDetector(
      {
        source: 'temporal-motion',
        diffThreshold: 4,
        areaThreshold: 0.05,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.1,
        noiseSmoothing: 0.12,
        areaSmoothing: 0.18,
        areaInflation: 1.05,
        noiseWarmupFrames: 0,
        temporalMedianWindow: 5,
        temporalMedianBackoffSmoothing: 0.45
      },
      bus
    );

    const baseFrame = createUniformFrame(12, 12, 42);
    detector.handleFrame(baseFrame, 0);

    for (let i = 0; i < 12; i += 1) {
      const phase = i % 3;
      const flicker = phase < 2
        ? createFrame(12, 12, (x, y) => (x < 6 ? 232 : 42 + ((x + y + i) % 6)))
        : createFrame(12, 12, (x, y) => 42 + ((x * 2 + y + i) % 5 === 0 ? 4 : -3));
      detector.handleFrame(flicker, i + 1);
    }

    const motionSnapshot = metrics.snapshot();
    expect(events.some(event => event.detector === 'motion')).toBe(false);
    expect(motionSnapshot.detectors.motion?.gauges?.temporalWindow ?? 0).toBeGreaterThan(0);
    expect(motionSnapshot.detectors.motion?.gauges?.temporalSuppression ?? 0).toBeGreaterThan(0);
    expect(motionSnapshot.detectors.motion?.gauges?.effectiveDebounceFrames ?? 0).toBeGreaterThanOrEqual(3);
    expect(motionSnapshot.detectors.motion?.gauges?.temporalGateMultiplier ?? 1).toBeGreaterThan(1);
  });

  it('MotionZeroBackoffRespected', () => {
    const detector = new MotionDetector(
      {
        source: 'zero-backoff-motion',
        diffThreshold: 4,
        areaThreshold: 0.05,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 0,
        noiseMultiplier: 1.1,
        noiseSmoothing: 0.12,
        areaSmoothing: 0.18,
        areaInflation: 1.05,
        noiseWarmupFrames: 0,
        temporalMedianWindow: 5,
        temporalMedianBackoffSmoothing: 0.45
      },
      bus
    );

    const baseline = createUniformFrame(12, 12, 42);
    detector.handleFrame(baseline, 0);

    for (let i = 0; i < 18; i += 1) {
      const phase = i % 3;
      const noisy =
        phase < 2
          ? createFrame(12, 12, (x, y) => (x < 6 ? 232 : 42 + ((x + y + i) % 6)))
          : createFrame(12, 12, (x, y) => 42 + ((x * 2 + y + i) % 5 === 0 ? 4 : -3));
      detector.handleFrame(noisy, i + 1);
    }

    const snapshot = metrics.snapshot();
    expect(events.some(event => event.detector === 'motion')).toBe(false);
    const effectiveBackoff = snapshot.detectors.motion?.gauges?.effectiveBackoffFrames ?? -1;
    expect(effectiveBackoff).toBe(0);
    expect(snapshot.detectors.motion?.gauges?.noiseBackoffPadding ?? 0).toBeGreaterThanOrEqual(0);
    expect(snapshot.detectors.motion?.counters?.backoffSuppressedFrames ?? 0).toBe(0);

    const history = (
      detector as unknown as {
        getHistorySnapshot(limit: number): Array<{ backoff: boolean; reason: string }>;
      }
    ).getHistorySnapshot(32);
    expect(history.some(entry => entry.backoff || entry.reason === 'backoff')).toBe(false);
  });

  it('MotionFrameResizeRecovery resumes detection after frame size changes', () => {
    const detector = new MotionDetector(
      {
        source: 'resize-motion',
        diffThreshold: 1,
        areaThreshold: 0.05,
        minIntervalMs: 0,
        debounceFrames: 1,
        backoffFrames: 0,
        noiseMultiplier: 1,
        noiseSmoothing: 0.08,
        areaSmoothing: 0.1,
        areaInflation: 1.05,
        areaDeltaThreshold: 0.02,
        noiseWarmupFrames: 0,
        temporalMedianWindow: 3,
        temporalMedianBackoffSmoothing: 0.2
      },
      bus
    );

    const smallBaseline = createUniformFrame(6, 6, 32);
    detector.handleFrame(smallBaseline, 0);

    const smallMotion = createFrame(6, 6, (x, y) => (x < 3 ? 240 : 32 + ((x + y) % 3)));
    detector.handleFrame(smallMotion, 1);
    detector.handleFrame(smallMotion, 2);

    const initialEvents = events.filter(event => event.detector === 'motion');
    expect(initialEvents.length).toBeGreaterThanOrEqual(1);

    const largeBaseline = createUniformFrame(10, 10, 28);
    detector.handleFrame(largeBaseline, 3);

    const largeMotion = createFrame(10, 10, (x, y) => (x < 5 ? 250 : 28 + ((x + y) % 5)));
    detector.handleFrame(largeMotion, 4);
    detector.handleFrame(largeMotion, 5);

    const motionEvents = events.filter(event => event.detector === 'motion');
    expect(motionEvents.length).toBeGreaterThanOrEqual(2);
    const lastEvent = motionEvents.at(-1);
    expect(lastEvent?.meta).toBeDefined();
    const lastMeta = lastEvent?.meta as Record<string, unknown>;
    expect(typeof lastMeta.areaThreshold).toBe('number');
  });

  it('LightTemporalMedianBackoff', () => {
    const detector = new LightDetector(
      {
        source: 'temporal-light',
        deltaThreshold: 15,
        smoothingFactor: 0.1,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 1,
        noiseMultiplier: 1.4,
        noiseSmoothing: 0.12,
        noiseWarmupFrames: 0,
        temporalMedianWindow: 6,
        temporalMedianBackoffSmoothing: 0.4
      },
      bus
    );

    const baseFrame = createUniformFrame(10, 10, 60);
    detector.handleFrame(baseFrame, 0);

    for (let i = 0; i < 15; i += 1) {
      const phase = i % 3;
      const flicker = phase < 2
        ? createUniformFrame(10, 10, 210 + phase * 6 + (i % 3))
        : createFrame(10, 10, (x, y) => 60 + ((x + y + i) % 5 === 0 ? 4 : -4));
      detector.handleFrame(flicker, i + 1);
    }

    const lightSnapshot = metrics.snapshot();
    expect(events.some(event => event.detector === 'light')).toBe(false);
    expect(lightSnapshot.detectors.light?.gauges?.temporalWindow ?? 0).toBeGreaterThan(0);
    expect(lightSnapshot.detectors.light?.gauges?.temporalSuppression ?? 0).toBeGreaterThan(0);
    expect(lightSnapshot.detectors.light?.gauges?.effectiveBackoffFrames ?? 0).toBeGreaterThanOrEqual(2);
    expect(lightSnapshot.detectors.light?.gauges?.temporalGateMultiplier ?? 1).toBeGreaterThan(1);
    expect(lightSnapshot.detectors.light?.gauges?.temporalAdaptiveThreshold ?? 0).toBeGreaterThan(0);
  });

  it('MotionDetectorNoiseBackoffPadding adapts debounce/backoff under sustained noise', () => {
    const motion = new MotionDetector(
      {
        source: 'adaptive-motion',
        diffThreshold: 5,
        areaThreshold: 0.32,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.1,
        noiseSmoothing: 0.08,
        areaSmoothing: 0.18,
        areaInflation: 1.08,
        areaDeltaThreshold: 0.05,
        noiseWarmupFrames: 0,
        noiseBackoffPadding: 0
      },
      bus
    );

    const baseline = createUniformFrame(16, 16, 90);
    motion.handleFrame(baseline, 0);

    for (let i = 0; i < 45; i += 1) {
      const noiseFrame = createFrame(16, 16, (x, y) => {
        const offset = ((x * 5 + y * 7 + i * 3) % 15) - 7;
        return 90 + offset * 3;
      });
      motion.handleFrame(noiseFrame, i + 1);
    }

    let snapshot = metrics.snapshot();
    const initialPadding = snapshot.detectors.motion?.gauges?.noiseBackoffPadding ?? 0;
    const initialDebounce = snapshot.detectors.motion?.gauges?.effectiveDebounceFrames ?? 0;

    const internals = motion as unknown as {
      noiseLevel: number;
      noiseWindow: number[];
      suppressedFrames: number;
      pendingSuppressedFramesBeforeTrigger: number;
      noiseBackoffPadding: number;
      baseNoiseBackoffPadding: number;
      activationFrames: number;
      backoffFrames: number;
    };
    internals.noiseLevel = 1;
    internals.noiseWindow.length = 0;
    internals.noiseWindow.push(...Array(30).fill(1.35));
    internals.noiseBackoffPadding = 0;
    internals.baseNoiseBackoffPadding = 0;

    const triggerFrame = createFrame(16, 16, (x, y) => (x < 12 ? 255 : 35 + ((x + y) % 5) * 8));

    internals.activationFrames = 20;
    internals.suppressedFrames = 0;
    internals.pendingSuppressedFramesBeforeTrigger = 18;
    internals.backoffFrames = 0;

    motion.handleFrame(triggerFrame, 200);

    const motionEvents = events.filter(event => event.detector === 'motion');
    expect(motionEvents.length).toBeGreaterThanOrEqual(1);
    const meta = motionEvents.at(-1)?.meta as Record<string, number>;
    expect(meta).toBeDefined();
    snapshot = metrics.snapshot();
    const paddingGauge = snapshot.detectors.motion?.gauges?.noiseBackoffPadding ?? 0;
    const debounceGauge = snapshot.detectors.motion?.gauges?.effectiveDebounceFrames ?? 0;
    expect(paddingGauge).toBeGreaterThan(initialPadding);
    expect(debounceGauge).toBeGreaterThan(initialDebounce);
    expect((meta?.noiseBackoffPadding ?? 0)).toBeGreaterThan(initialPadding);
    expect((meta?.effectiveDebounceFrames ?? 0)).toBeGreaterThan(initialDebounce);
    expect((meta?.effectiveBackoffFrames ?? 0)).toBeGreaterThanOrEqual(4);

    expect(snapshot.detectors.motion?.counters?.backoffActivations ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('MotionLightNoiseWindowing expands windows under sustained noise and records gauges', () => {
    const motion = new MotionDetector(
      {
        source: 'noise-motion',
        diffThreshold: 6,
        areaThreshold: 0.2,
        minIntervalMs: 0,
        debounceFrames: 1,
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

  it('LightDetectorOvernightNormalHours reconfigures normal hours and updates gauges', () => {
    const light = new LightDetector(
      {
        source: 'overnight-light',
        deltaThreshold: 18,
        smoothingFactor: 0.08,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.8,
        noiseSmoothing: 0.15,
        idleRebaselineMs: 0,
        noiseWarmupFrames: 0
      },
      bus
    );

    const baseFrame = createUniformFrame(12, 12, 60);
    const primingTs = Date.UTC(2023, 6, 1, 20, 0, 0);
    light.handleFrame(baseFrame, primingTs);

    for (let i = 0; i < 80; i += 1) {
      const noisy = createFrame(12, 12, () => ((i + 1) % 2 === 0 ? 210 : 10));
      light.handleFrame(noisy, primingTs + (i + 1) * 10_000);
    }

    let snapshot = metrics.snapshot();
    const preUpdateBoost = snapshot.detectors.light?.gauges?.noiseWindowBoost ?? 1;
    expect((light as any).sustainedNoiseBoost).toBeGreaterThan(1);
    expect(preUpdateBoost).toBeGreaterThanOrEqual(1);

    light.updateOptions({
      normalHours: [{ start: 23, end: 6 }],
      noiseWarmupFrames: 0,
      debounceFrames: 1,
      backoffFrames: 3
    });

    const overnightBaselineTs = Date.UTC(2023, 6, 1, 23, 30, 0);
    light.handleFrame(baseFrame, overnightBaselineTs);
    light.handleFrame(createUniformFrame(12, 12, 62), overnightBaselineTs + 10_000);

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.gauges?.normalHoursActive).toBe(1);
    expect(snapshot.detectors.light?.gauges?.noiseWindowBoost ?? 0).toBeLessThanOrEqual(1.1);

    for (let i = 0; i < 6; i += 1) {
      const calmOvernight = createFrame(
        12,
        12,
        (x, y) => 62 + ((x * 2 + y + i) % 5 === 0 ? 3 : -3)
      );
      light.handleFrame(calmOvernight, overnightBaselineTs + (i + 2) * 10_000);
    }

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.gauges?.normalHoursActive).toBe(1);

    events = [];

    const triggerStartTs = Date.UTC(2023, 6, 2, 7, 0, 0);
    const requiredDebounce = Math.max(
      3,
      snapshot.detectors.light?.gauges?.effectiveDebounceFrames ?? 3
    );

    for (let i = 0; i < requiredDebounce + 6; i += 1) {
      const level = 150 + i * 12;
      light.handleFrame(createUniformFrame(12, 12, level), triggerStartTs + i * 10_000);
      if (events.some(event => event.detector === 'light')) {
        break;
      }
    }

    const lightEvent = events.find(event => event.detector === 'light');
    expect(lightEvent).toBeDefined();

    const meta = lightEvent?.meta as Record<string, unknown>;
    expect(meta?.normalHoursActive).toBe(false);
    expect(meta?.normalHours).toEqual([{ start: 23, end: 6 }]);
    expect((meta?.sustainedNoiseBoost as number) ?? 0).toBeGreaterThanOrEqual(1);

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.gauges?.normalHoursActive).toBe(0);
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

  it('MotionLightRebaselineWindows recalibrates after sustained noise pressure', () => {
    const motion = new MotionDetector(
      {
        source: 'rebaseline-motion',
        diffThreshold: 6,
        areaThreshold: 0.04,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.1,
        noiseSmoothing: 0.2,
        areaSmoothing: 0.2,
        areaInflation: 1.05
      },
      bus
    );

    const light = new LightDetector(
      {
        source: 'rebaseline-light',
        deltaThreshold: 12,
        smoothingFactor: 0.1,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.8,
        noiseSmoothing: 0.2
      },
      bus
    );

    const baseMotion = createUniformFrame(14, 14, 32);
    const baseLight = createUniformFrame(12, 12, 140);
    motion.handleFrame(baseMotion, 0);
    light.handleFrame(baseLight, 0);

    for (let i = 0; i < 36; i += 1) {
      const noisyMotion = createFrame(14, 14, (x, y) => 32 + ((x * 3 + y + i) % 2 === 0 ? 40 : -35));
      const noisyLight = createFrame(12, 12, (x, y) => 140 + ((x + 2 * y + i) % 3 === 0 ? 50 : -45));
      motion.handleFrame(noisyMotion, i + 1);
      light.handleFrame(noisyLight, i + 1);
    }

    let snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.gauges?.rebaselineCountdown ?? 0).toBeGreaterThan(0);
    expect(snapshot.detectors.light?.gauges?.rebaselineCountdown ?? 0).toBeGreaterThan(0);

    for (let i = 0; i < 24; i += 1) {
      const noisyMotion = createFrame(14, 14, (x, y) => 30 + ((x + y + i) % 2 === 0 ? 35 : -30));
      const noisyLight = createFrame(12, 12, (x, y) => 135 + ((x * 2 + y + i) % 2 === 0 ? 48 : -42));
      motion.handleFrame(noisyMotion, 100 + i);
      light.handleFrame(noisyLight, 100 + i);
    }

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.motion?.counters?.adaptiveRebaselines ?? 0).toBeGreaterThan(0);
    expect(snapshot.detectors.light?.counters?.adaptiveRebaselines ?? 0).toBeGreaterThan(0);
    expect(snapshot.detectors.motion?.gauges?.rebaselineCountdown ?? 0).toBe(0);
    expect(snapshot.detectors.light?.gauges?.rebaselineCountdown ?? 0).toBe(0);
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

  it('MotionDetectorOptionUpdatePreservesSuppression', () => {
    const detector = new MotionDetector(
      {
        source: 'option-preserve',
        diffThreshold: 4,
        areaThreshold: 0.03,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.25,
        noiseSmoothing: 0.18,
        areaSmoothing: 0.18,
        noiseBackoffPadding: 1
      },
      bus
    );

    const base = createUniformFrame(12, 12, 20);
    detector.handleFrame(base, 0);

    const noiseFrames = [
      createFrame(12, 12, (x, y) => 20 + ((x + y) % 3 === 0 ? 4 : -3)),
      createFrame(12, 12, (x, y) => 20 + ((x * 2 + y) % 4 === 0 ? 5 : -4)),
      createFrame(12, 12, (x, y) => 20 + ((x + 2 * y) % 5 === 0 ? 6 : -5))
    ];

    noiseFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, idx + 1);
    });

    const baselineSnapshot = metrics.snapshot();
    const suppressedBefore = baselineSnapshot.detectors.motion?.counters?.suppressedFrames ?? 0;

    expect(suppressedBefore).toBeGreaterThan(0);

    detector.updateOptions({ noiseBackoffPadding: 3 });

    const activationFrames = [
      createFrame(12, 12, (x, y) => (x < 6 ? 255 : 18)),
      createFrame(12, 12, (x, y) => (x < 6 ? 255 : 19)),
      createFrame(12, 12, (x, y) => (x < 6 ? 255 : 20))
    ];

    activationFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, 100 + idx);
    });

    const event = events.find(entry => entry.detector === 'motion');
    expect(event).toBeDefined();
    const meta = event?.meta as Record<string, number>;
    expect(meta.noiseBackoffPadding).toBe(3);
    expect(meta.suppressedFramesBeforeTrigger).toBe(suppressedBefore);

    const afterSnapshot = metrics.snapshot();
    const beforeMetric = baselineSnapshot.detectors.motion?.counters?.suppressedFramesBeforeTrigger ?? 0;
    const afterMetric = afterSnapshot.detectors.motion?.counters?.suppressedFramesBeforeTrigger ?? 0;
    expect(afterMetric - beforeMetric).toBe(suppressedBefore);
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
    expect(afterReset.detectors.light?.counters?.suppressedFrames ?? 0).toBe(0);
    expect(afterReset.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0).toBe(0);

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

  it('LightNormalHoursFlushSuppression clears suppression history when normal hours resume', () => {
    const detector = new LightDetector(
      {
        source: 'normal-hours-flush',
        deltaThreshold: 14,
        smoothingFactor: 0.08,
        minIntervalMs: 0,
        debounceFrames: 2,
        backoffFrames: 2,
        noiseMultiplier: 1.1,
        noiseSmoothing: 0.1,
        idleRebaselineMs: 0,
        normalHours: [{ start: 6, end: 7 }]
      },
      bus
    );

    const baseline = createUniformFrame(12, 12, 40);
    const suppressed = createUniformFrame(12, 12, 52);
    const candidate = createUniformFrame(12, 12, 70);

    const tsBaseline = Date.UTC(2024, 0, 1, 5, 30, 0);
    detector.handleFrame(baseline, tsBaseline);

    for (let i = 0; i < 3; i += 1) {
      detector.handleFrame(suppressed, tsBaseline + (i + 1) * 1000);
    }

    const tsCandidate = tsBaseline + 10_000;
    detector.handleFrame(candidate, tsCandidate);

    expect(events).toHaveLength(0);

    const pendingInjected = 3;
    (detector as any).pendingSuppressedFramesBeforeTrigger = pendingInjected;
    (detector as any).updatePendingSuppressedGauge();
    metrics.incrementDetectorCounter('light', 'suppressedFramesBeforeTrigger', pendingInjected);

    let snapshot = metrics.snapshot();
    expect(
      snapshot.detectors.light?.gauges?.pendingSuppressedFramesBeforeTrigger ?? 0
    ).toBeGreaterThanOrEqual(pendingInjected);
    expect(snapshot.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0).toBeGreaterThanOrEqual(
      pendingInjected
    );
    expect(snapshot.detectors.light?.counters?.suppressedFrames ?? 0).toBeGreaterThan(0);

    const tsNormal = Date.UTC(2024, 0, 1, 6, 0, 0);
    detector.handleFrame(baseline, tsNormal);

    snapshot = metrics.snapshot();
    expect(snapshot.detectors.light?.gauges?.pendingSuppressedFramesBeforeTrigger ?? 0).toBe(0);
    expect(snapshot.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0).toBe(0);
    expect(snapshot.detectors.light?.counters?.suppressedFrames ?? 0).toBe(0);

    events = [];

    const tsOutside = Date.UTC(2024, 0, 1, 7, 1, 0);
    const triggerFrames = [
      120,
      132,
      144,
      156,
      168,
      180,
      192,
      204,
      216,
      228,
      240,
      252,
      264,
      276
    ].map(value => createUniformFrame(12, 12, value));

    triggerFrames.forEach((frame, idx) => {
      detector.handleFrame(frame, tsOutside + idx * 1000);
    });

    const lightEvent = events.find(event => event.detector === 'light');
    expect(lightEvent).toBeDefined();

    const meta = lightEvent?.meta as Record<string, number>;
    expect(meta.suppressedFramesBeforeTrigger).toBe(0);
    expect(meta.normalHoursActive).toBe(false);

    const afterSnapshot = metrics.snapshot();
    expect(afterSnapshot.detectors.light?.counters?.suppressedFramesBeforeTrigger ?? 0).toBe(0);
    expect(afterSnapshot.detectors.light?.gauges?.pendingSuppressedFramesBeforeTrigger ?? 0).toBe(0);
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
