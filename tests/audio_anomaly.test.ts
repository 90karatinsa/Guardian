import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import AudioAnomalyDetector from '../src/audio/anomaly.js';

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
    expect(Number(thresholds?.rmsWindowMs)).toBeCloseTo(180, 1);
    expect(Number(thresholds?.minTriggerDurationMs)).toBeCloseTo(120, 1);
    const state = eventMeta.state as Record<string, any>;
    expect(Number(state?.rms?.durationMs ?? 0)).toBeGreaterThanOrEqual(120);
    const windowMs = Number(state?.rms?.windowMs ?? 0);
    expect(windowMs).toBeGreaterThanOrEqual(180);
    expect(windowMs).toBeLessThanOrEqual(200);
    expect(Number(state?.centroid?.recoveryMs ?? 0)).toBeGreaterThanOrEqual(0);
    const recovery = eventMeta.recoveryMs as Record<string, number>;
    expect(Number(recovery?.rmsMs ?? 0)).toBe(0);

    expect(extractSpy).toHaveBeenCalled();
    const firstCall = extractSpy.mock.calls[0];
    expect(firstCall?.[0]).toContain('rms');
    expect(firstCall?.[2]?.bufferSize).toBe(frameSize);
  });

  it('AudioAnomalyScheduleSwitch resets windows on night schedule and tracks recovery', () => {
    const nightTs = new Date(2024, 0, 1, 23, 30).getTime();
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
          }
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

    detector.handleChunk(nightWarmup, nightTs);
    detector.handleChunk(nightWarmup, nightTs + hopDurationMs);
    for (let i = 2; i <= 9; i += 1) {
      const ts = nightTs + i * hopDurationMs;
      detector.handleChunk(nightLoud, ts);
    }

    expect(events).toHaveLength(1);
    const meta = events[0].meta ?? {};
    expect(meta.triggeredBy).toBe('rms');
    const thresholds = meta.thresholds as Record<string, unknown>;
    expect(thresholds?.profile).toBe('night');
    expect(Number(thresholds?.rms)).toBeCloseTo(0.12, 2);
    expect(Number(thresholds?.rmsWindowMs)).toBeCloseTo(320, 1);
    const recovery = meta.recoveryMs as Record<string, number>;
    expect(Number(recovery?.rmsMs ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Number(recovery?.centroidMs ?? 0)).toBeGreaterThan(0);
    const state = meta.state as Record<string, any>;
    expect(Number(state?.rms?.recoveryMs ?? 0)).toBeGreaterThanOrEqual(0);
    expect(Number(state?.rms?.windowMs ?? 0)).toBeCloseTo(320, 1);
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

