import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import AudioAnomalyDetector from '../src/audio/anomaly.js';

interface CapturedEvent {
  detector: string;
  meta?: Record<string, unknown>;
}

vi.mock('meyda', () => {
  return {
    default: {
      extract: (
        features: string[],
        buffer: Float32Array,
        options: { sampleRate?: number }
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
    }
  };
});

describe('AudioAnomalyAdaptiveWindow', () => {
  const sampleRate = 16000;
  const frameSize = 1024;
  const hopSize = 512;
  const frameDurationMs = (frameSize / sampleRate) * 1000;
  const hopDurationMs = (hopSize / sampleRate) * 1000;
  let bus: EventEmitter;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new EventEmitter();
    events = [];
    bus.on('event', payload => {
      events.push({ detector: payload.detector, meta: payload.meta });
    });
  });

  it('AudioAnomalyAdaptiveWindow suppresses bursts shorter than configured window', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        rmsThreshold: 0.5,
        centroidJumpThreshold: 5000,
        minIntervalMs: 0,
        minTriggerDurationMs: 150,
        rmsWindowMs: 200
      },
      bus
    );

    const spike = combineFrames(
      createConstantFrame(frameSize / 2, 0.9),
      createConstantFrame(frameSize / 2, 0.05)
    );

    detector.handleChunk(spike, 0);
    detector.handleChunk(createConstantFrame(frameSize, 0), 80);

    expect(events).toHaveLength(0);
  });

  it('AudioAnomalyAdaptiveWindow emits after sustained RMS elevation and reports baselines', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        rmsThreshold: 0.4,
        centroidJumpThreshold: 5000,
        minIntervalMs: 0,
        minTriggerDurationMs: 100,
        rmsWindowMs: 150
      },
      bus
    );

    const loud = createConstantFrame(frameSize, 0.9);

    detector.handleChunk(loud, 0);
    detector.handleChunk(loud, 120);

    expect(events).toHaveLength(1);
    expect(events[0].detector).toBe('audio-anomaly');
    expect(events[0].meta?.triggeredBy).toBe('rms');
    expect(Number(events[0].meta?.durationAboveThresholdMs)).toBeGreaterThanOrEqual(100);
    const windowMeta = events[0].meta?.window as Record<string, number>;
    expect(Number(windowMeta?.frameDurationMs)).toBeCloseTo(frameDurationMs, 3);
    expect(Number(windowMeta?.hopDurationMs)).toBeCloseTo(hopDurationMs, 3);
    const thresholds = events[0].meta?.thresholds as Record<string, number>;
    expect(Number(thresholds?.rms)).toBeCloseTo(0.4, 3);
    const baselines = events[0].meta?.baselines as Record<string, number>;
    expect(Number(baselines?.rms)).toBeLessThan(Number(events[0].meta?.rms));
  });

  it('AudioAnomalyAdaptiveWindow applies night thresholds to centroid jumps', () => {
    const detector = new AudioAnomalyDetector(
      {
        source: 'audio:test',
        sampleRate,
        frameDurationMs,
        hopDurationMs,
        rmsThreshold: 0.6,
        centroidJumpThreshold: 200,
        minIntervalMs: 500,
        minTriggerDurationMs: 120,
        centroidWindowMs: 160,
        thresholds: {
          night: { centroidJump: 40 }
        },
        nightHours: { start: 20, end: 6 }
      },
      bus
    );

    const toneLow = generateSineWave(sampleRate, 200, 0.2, frameSize);
    const toneHigh = generateSineWave(sampleRate, 2200, 0.2, frameSize);

    const eveningTs = new Date('2023-01-01T22:00:00.000Z').getTime();

    detector.handleChunk(toneLow, eveningTs);
    detector.handleChunk(toneHigh, eveningTs + 120);
    detector.handleChunk(toneHigh, eveningTs + 240);

    expect(events).toHaveLength(1);
    expect(events[0].meta?.triggeredBy).toBe('centroid');
    const thresholds = events[0].meta?.thresholds as Record<string, number>;
    expect(Number(thresholds?.centroidJump)).toBeCloseTo(40, 3);
  });
});

function generateSineWave(sampleRate: number, frequency: number, amplitude: number, length: number) {
  const result = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    result[i] = Math.round(value * 32767);
  }
  return result;
}

function createConstantFrame(length: number, amplitude: number): Int16Array {
  const frame = new Int16Array(length);
  const value = Math.round(amplitude * 32767);
  frame.fill(value);
  return frame;
}

function combineFrames(...frames: Int16Array[]): Int16Array {
  const totalLength = frames.reduce((acc, frame) => acc + frame.length, 0);
  const combined = new Int16Array(totalLength);
  let offset = 0;
  for (const frame of frames) {
    combined.set(frame, offset);
    offset += frame.length;
  }
  return combined;
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

  if (zeroCrossings === 0) {
    return 0;
  }

  return (zeroCrossings * sampleRate) / (2 * buffer.length);
}
