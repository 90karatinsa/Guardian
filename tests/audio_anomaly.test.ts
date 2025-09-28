import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import AudioAnomalyDetector, {
  type AudioAnomalyThresholdSchedule,
  type NightHoursConfig
} from '../src/audio/anomaly.js';

interface CapturedEvent {
  detector: string;
  meta?: Record<string, unknown>;
}

const { extractSpy } = vi.hoisted(() => ({
  extractSpy: vi.fn(
    (
      features: string[],
      buffer: Float32Array,
      options: { sampleRate?: number; bufferSize?: number } | undefined
    ) => {
      const sampleRate = options?.sampleRate ?? 1;
      const result: Record<string, number> = {};

      if (features.includes('rms')) {
        result.rms = computeRms(buffer);
      }

      if (features.includes('spectralCentroid')) {
        result.spectralCentroid = estimateSpectralCentroid(buffer, sampleRate);
      }

      return result;
    }
  )
}));

vi.mock('meyda', () => {
  return {
    default: {
      extract: extractSpy
    }
  };
});

describe('AudioAnomalyWindowing', () => {
  const sampleRate = 16000;
  const frameSize = 1024;
  const hopSize = 512;
  const frameDurationMs = (frameSize / sampleRate) * 1000;
  const hopDurationMs = (hopSize / sampleRate) * 1000;
  const dayTs = new Date(2024, 0, 1, 10, 30).getTime();
  let bus: EventEmitter;
  let events: CapturedEvent[];

  beforeEach(() => {
    extractSpy.mockClear();
    bus = new EventEmitter();
    events = [];
    bus.on('event', payload => {
      events.push({ detector: payload.detector, meta: payload.meta });
    });
  });

  it('AudioAnomalyWindowing accumulates until min trigger duration then emits once', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        minIntervalMs: 500,
        thresholds: {
          day: {
            rms: 0.2,
            rmsWindowMs: 180,
            minTriggerDurationMs: 120
          }
        },
        centroidJumpThreshold: 5000
      },
      bus
    );

    detector.handleChunk(createConstantFrame(frameSize, 0.18), dayTs);
    for (let i = 1; i <= 6; i += 1) {
      detector.handleChunk(createConstantFrame(frameSize, 0.95), dayTs + i * hopDurationMs);
    }

    expect(events).toHaveLength(1);
    const eventMeta = events[0].meta ?? {};
    expect(eventMeta.triggeredBy).toBe('rms');
    const thresholds = eventMeta.thresholds as Record<string, unknown>;
    expect(thresholds?.profile).toBe('day');
    expect(Number(thresholds?.rmsWindowMs)).toBeCloseTo(192, 5);
    expect(Number(thresholds?.minTriggerDurationMs)).toBeCloseTo(128, 5);
    const state = eventMeta.state as Record<string, any>;
    expect(Number(state?.rms?.durationMs ?? 0)).toBeGreaterThanOrEqual(
      Number(thresholds?.minTriggerDurationMs ?? 0)
    );
    const windowMs = Number(state?.rms?.windowMs ?? 0);
    const alignedWindow = Number(thresholds?.rmsWindowMs ?? 0);
    expect(windowMs).toBeCloseTo(alignedWindow, 5);
    expect(alignedWindow % hopDurationMs).toBeCloseTo(0, 5);
    expect(Number(state?.centroid?.recoveryMs ?? 0)).toBeGreaterThanOrEqual(0);
    const recovery = eventMeta.recoveryMs as Record<string, number>;
    expect(Number(recovery?.rmsMs ?? 0)).toBe(0);

    expect(extractSpy).toHaveBeenCalled();
    const firstCall = extractSpy.mock.calls[0];
    expect(firstCall?.[0]).toContain('rms');
    expect(firstCall?.[2]?.bufferSize).toBe(frameSize);
  });

  it('AudioAnomalyWindowBlend blends thresholds during transitions', () => {
    const transitionTs = new Date(2024, 0, 1, 22, 5).getTime();
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        minIntervalMs: 500,
        thresholds: {
          day: {
            rms: 0.6,
            rmsWindowMs: 200,
            minTriggerDurationMs: 220
          },
          night: {
            rms: 0.12,
            rmsWindowMs: 320,
            minTriggerDurationMs: 64
          },
          blendMinutes: 60
        },
        nightHours: { start: 22, end: 6 }
      },
      bus
    );

    detector.handleChunk(createConstantFrame(frameSize, 0.12), dayTs);
    detector.handleChunk(createConstantFrame(frameSize, 0.18), dayTs + hopDurationMs);

    expect(events).toHaveLength(0);

    const nightWarmup = createConstantFrame(frameSize, 0.08);
    const nightLoud = createConstantFrame(frameSize, 0.45);

    detector.handleChunk(nightWarmup, transitionTs);
    detector.handleChunk(nightWarmup, transitionTs + hopDurationMs);
    for (let i = 2; i <= 12; i += 1) {
      const ts = transitionTs + i * hopDurationMs;
      detector.handleChunk(nightLoud, ts);
    }

    expect(events).toHaveLength(1);
    const meta = events[0].meta ?? {};
    expect(meta.triggeredBy).toBe('rms');
    const thresholds = meta.thresholds as Record<string, unknown>;
    expect(thresholds?.profile).toBe('transition');
    const weights = thresholds?.weights as Record<string, number>;
    expect(Number(weights?.night ?? 0)).toBeGreaterThan(Number(weights?.day ?? 0));
    expect(Number(weights?.night ?? 0)).toBeGreaterThan(0.5);
    expect(Number(weights?.day ?? 0)).toBeGreaterThan(0);
    expect(Number(thresholds?.rms)).toBeGreaterThan(0.12);
    expect(Number(thresholds?.rms)).toBeLessThan(0.6);
    const blendedWindow = Number(thresholds?.rmsWindowMs ?? 0);
    expect(blendedWindow).toBeGreaterThan(200);
    expect(blendedWindow).toBeLessThanOrEqual(320);
    expect(blendedWindow % hopDurationMs).toBeCloseTo(0, 5);
    const blendedCentroid = Number(thresholds?.centroidWindowMs ?? 0);
    expect(blendedCentroid).toBeGreaterThan(200);
    expect(blendedCentroid).toBeLessThanOrEqual(320);
    expect(blendedCentroid % hopDurationMs).toBeCloseTo(0, 5);
    const recovery = meta.recoveryMs as Record<string, number>;
    expect(Number(recovery?.rmsMs ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Number(recovery?.centroidMs ?? 0)).toBeGreaterThan(0);
    const state = meta.state as Record<string, any>;
    expect(Number(state?.rms?.recoveryMs ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Number(state?.rms?.windowMs ?? 0)).toBeCloseTo(blendedWindow, 5);
  });

  it('AudioAnomalyScheduleHotReload applies updated schedules immediately', () => {
    const nightTs = new Date(2024, 0, 2, 22, 30).getTime();
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        minIntervalMs: 0,
        thresholds: {
          default: {
            rms: 0.9,
            rmsWindowMs: hopDurationMs,
            minTriggerDurationMs: hopDurationMs
          }
        },
        rmsThreshold: 0.9,
        centroidJumpThreshold: 9999,
        nightHours: { start: 23, end: 6 }
      },
      bus
    );

    const reloadSchedule = {
      night: {
        rms: 0.18,
        rmsWindowMs: hopDurationMs,
        minTriggerDurationMs: hopDurationMs
      }
    } satisfies AudioAnomalyThresholdSchedule;
    const reloadNightHours = { start: 21, end: 6 } satisfies NightHoursConfig;

    detector.updateOptions({
      thresholds: reloadSchedule,
      nightHours: reloadNightHours,
      rmsWindowMs: hopDurationMs,
      centroidWindowMs: hopDurationMs,
      minTriggerDurationMs: hopDurationMs
    });

    // Mutate the original objects after updateOptions to verify cloning behaviour.
    reloadSchedule.night!.rms = 0.45;
    reloadNightHours.start = 12;

    const loudFrame = createConstantFrame(frameSize, 0.5);
    for (let i = 0; i < 6; i += 1) {
      detector.handleChunk(loudFrame, nightTs + i * hopDurationMs);
    }

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, any>;
    const thresholds = meta.thresholds as Record<string, any>;
    expect(thresholds.profile).toBe('night');
    expect(thresholds.rms).toBeCloseTo(0.18, 5);
    expect(thresholds.rmsWindowMs).toBeCloseTo(hopDurationMs, 5);
    expect(thresholds.minTriggerDurationMs).toBeCloseTo(hopDurationMs, 5);
    const state = meta.state as Record<string, any>;
    expect(Number(state?.rms?.windowMs ?? 0)).toBeCloseTo(hopDurationMs, 5);
  });

  it('AudioAnomalyWindowSustain requires consecutive frames to trigger', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        minIntervalMs: 0,
        thresholds: {
          day: {
            rms: 0.18,
            rmsWindowMs: hopDurationMs * 4,
            minTriggerDurationMs: hopDurationMs * 3
          }
        },
        centroidJumpThreshold: 4000
      },
      bus
    );

    const quietFrame = createConstantFrame(frameSize, 0.05);
    const loudFrame = createConstantFrame(frameSize, 0.45);
    let ts = dayTs;

    detector.handleChunk(quietFrame, ts);
    ts += hopDurationMs;
    detector.handleChunk(loudFrame, ts);
    ts += hopDurationMs;
    detector.handleChunk(loudFrame, ts);
    ts += hopDurationMs;
    detector.handleChunk(quietFrame, ts);
    ts += hopDurationMs;
    detector.handleChunk(loudFrame, ts);
    ts += hopDurationMs;
    detector.handleChunk(loudFrame, ts);
    ts += hopDurationMs;
    detector.handleChunk(loudFrame, ts);

    expect(events).toHaveLength(1);
    const meta = events[0].meta as Record<string, any>;
    expect(meta.durationAboveThresholdMs).toBeCloseTo(3 * hopDurationMs, 5);
    const accumulation = meta.accumulationMs as Record<string, number>;
    expect(accumulation.rmsFrames).toBeGreaterThanOrEqual(3);
    expect(accumulation.rmsFrames).toBeLessThanOrEqual(4);
    const state = meta.state as Record<string, any>;
    expect(state.rms.sustainFrames).toBeGreaterThanOrEqual(3);
    expect(state.rms.recoveryFrames).toBe(0);
  });

  it('AudioAnomalyNightProfile smooths blend around night boundary', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        minIntervalMs: 0,
        thresholds: {
          day: {
            rms: 0.4,
            rmsWindowMs: hopDurationMs * 4,
            minTriggerDurationMs: hopDurationMs * 2
          },
          night: {
            rms: 0.16,
            rmsWindowMs: hopDurationMs * 5,
            minTriggerDurationMs: hopDurationMs * 2
          },
          blendMinutes: 60
        },
        nightHours: { start: 22, end: 6 }
      },
      bus
    );

    const warmFrame = createConstantFrame(frameSize, 0.08);
    const loudFrame = createConstantFrame(frameSize, 0.5);

    const firstTs = new Date(2024, 0, 1, 21, 45).getTime();
    const warmStart = firstTs - hopDurationMs * 4;
    for (let i = 0; i < 4; i += 1) {
      detector.handleChunk(warmFrame, warmStart + i * hopDurationMs);
    }
    for (let i = 0; i < 5; i += 1) {
      detector.handleChunk(loudFrame, firstTs + i * hopDurationMs);
    }

    expect(events).toHaveLength(1);
    const firstMeta = events.pop()?.meta as Record<string, any>;
    const firstWeights = firstMeta.thresholds?.weights as Record<string, number>;
    expect(firstWeights.day ?? 0).toBeGreaterThan(firstWeights.night ?? 0);

    const secondTs = new Date(2024, 0, 1, 22, 15).getTime();
    const nightWarmStart = secondTs - hopDurationMs * 3;
    for (let i = 0; i < 3; i += 1) {
      detector.handleChunk(warmFrame, nightWarmStart + i * hopDurationMs);
    }
    for (let i = 0; i < 5; i += 1) {
      detector.handleChunk(loudFrame, secondTs + i * hopDurationMs);
    }

    expect(events).toHaveLength(1);
    const secondMeta = events[0].meta as Record<string, any>;
    const secondWeights = secondMeta.thresholds?.weights as Record<string, number>;
    expect(secondWeights.night ?? 0).toBeGreaterThan(secondWeights.day ?? 0);
    expect(secondMeta.thresholds?.profile).toBe('transition');
  });

  it('AudioAnomalyHotReload resets buffers and applies new window lengths', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        minIntervalMs: 500,
        rmsThreshold: 0.25,
        centroidJumpThreshold: 200,
        minTriggerDurationMs: 160,
        rmsWindowMs: 240,
        centroidWindowMs: 260
      },
      bus
    );

    const warmFrame = createConstantFrame(frameSize, 0.18);
    const loudFrame = createConstantFrame(frameSize, 0.45);

    detector.handleChunk(warmFrame, dayTs);
    for (let i = 1; i <= 6; i += 1) {
      detector.handleChunk(loudFrame, dayTs + i * hopDurationMs);
    }

    expect(events.length).toBe(1);
    events.length = 0;

    detector.updateOptions({
      rmsWindowMs: 480,
      centroidWindowMs: 520,
      minTriggerDurationMs: 320,
      thresholds: {
        night: { rms: 0.12, centroidJump: 140, rmsWindowMs: 520 }
      },
      nightHours: { start: 22, end: 6 }
    });

    const nightTs = new Date(2024, 0, 2, 1, 0).getTime();
    const quietFrame = createConstantFrame(frameSize, 0.05);
    const burstFrame = createConstantFrame(frameSize, 0.4);

    detector.handleChunk(quietFrame, nightTs);
    for (let i = 1; i <= 9; i += 1) {
      detector.handleChunk(burstFrame, nightTs + i * hopDurationMs);
      if (i < 9) {
        expect(events.length).toBe(0);
      }
    }

    for (let i = 10; i <= 12; i += 1) {
      detector.handleChunk(burstFrame, nightTs + i * hopDurationMs);
    }

    expect(events.length).toBe(1);
    const meta = events[0].meta as Record<string, any>;
    expect(meta.thresholds?.profile).toBe('night');
    expect(Number(meta.thresholds?.rmsWindowMs)).toBeCloseTo(512, 5);
    expect(Number(meta.durationAboveThresholdMs)).toBeGreaterThanOrEqual(320);
    const state = meta.state as Record<string, any>;
    expect(Number(state?.rms?.windowMs ?? 0)).toBeCloseTo(512, 5);
    const accumulation = meta.accumulationMs as Record<string, number>;
    expect(Number(accumulation?.rmsMs ?? 0)).toBeGreaterThanOrEqual(320);
  });
});

function createConstantFrame(length: number, amplitude: number): Int16Array {
  const frame = new Int16Array(length);
  const value = Math.round(amplitude * 32767);
  frame.fill(value);
  return frame;
}

function computeRms(buffer: Float32Array): number {
  if (buffer.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sumSquares += buffer[i] * buffer[i];
  }
  return Math.sqrt(sumSquares / buffer.length);
}

function estimateSpectralCentroid(buffer: Float32Array, sampleRate: number): number {
  let zeroCrossings = 0;
  for (let i = 1; i < buffer.length; i += 1) {
    const prev = buffer[i - 1];
    const current = buffer[i];
    if ((prev <= 0 && current > 0) || (prev >= 0 && current < 0)) {
      zeroCrossings += 1;
    }
  }

  const durationSeconds = buffer.length / sampleRate;
  if (durationSeconds === 0) {
    return 0;
  }
  return (zeroCrossings / 2 / durationSeconds) * (1 / 2);
}

