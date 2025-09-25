import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import PoseEstimator, { PoseFrame } from '../src/video/poseEstimator.js';

const runMock = vi.fn();

vi.mock('onnxruntime-node', () => {
  class Tensor<T> {
    constructor(
      public readonly type: string,
      public readonly data: T,
      public readonly dims: number[]
    ) {}
  }

  return {
    InferenceSession: {
      create: vi.fn(async () => ({
        inputNames: ['poses'],
        outputNames: ['forecast'],
        run: runMock
      }))
    },
    Tensor
  };
});

const ort = await import('onnxruntime-node');

describe('PoseEstimatorForecast', () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it('generates forecast events from pose history and motion metadata', async () => {
    const bus = new EventEmitter();
    const events: unknown[] = [];
    bus.on('event', event => {
      events.push(event);
    });

    const horizon = 900;
    const estimator = await PoseEstimator.create({
      source: 'video:test-pose',
      modelPath: 'models/pose.onnx',
      forecastHorizonMs: horizon,
      smoothingWindow: 3,
      minMovement: 0.05,
      bus
    });

    const tensorData = new Float32Array([0.1, 0.05, -0.02, 0.02, 0.03, 0.01]);
    runMock.mockResolvedValueOnce({
      forecast: new ort.Tensor('float32', tensorData, [1, tensorData.length])
    });

    const frames: PoseFrame[] = [
      { ts: 1, keypoints: buildKeypoints([0.1, 0.2, 0.3]) },
      { ts: 2, keypoints: buildKeypoints([0.15, 0.25, 0.35]) },
      { ts: 3, keypoints: buildKeypoints([0.2, 0.3, 0.4]) }
    ];
    frames.forEach(frame => estimator.ingest(frame));

    const motionMeta = { areaPct: 0.18, diffThreshold: 12 } as Record<string, unknown>;
    const forecast = await estimator.forecast(motionMeta, 42);

    expect(forecast).not.toBeNull();
    const resolved = forecast!;
    expect(resolved.horizonMs).toBe(horizon);
    expect(resolved.velocity).toEqual([0.1, 0.05, -0.02]);
    expect(resolved.acceleration).toEqual([0.02, 0.03, 0.01]);
    expect(resolved.movementFlags).toEqual([true, true, false]);
    expect(resolved.confidence).toBeCloseTo(2 / 3, 5);

    expect(events).toHaveLength(1);
    const event = events[0] as {
      detector: string;
      meta?: Record<string, unknown>;
    };
    expect(event.detector).toBe('pose');
    expect(event.meta?.horizonMs).toBe(horizon);
    expect(event.meta?.movementFlags).toEqual([true, true, false]);
    expect(event.meta?.motion).toEqual(motionMeta);
    expect(Array.isArray(event.meta?.frames)).toBe(true);
    expect((event.meta?.frames as unknown[]).length).toBe(3);

    const merged = estimator.mergeIntoMotionMeta({
      existing: true
    });
    expect(merged?.poseForecast).toMatchObject({
      horizonMs: horizon,
      movementFlags: [true, true, false]
    });
  });
});

function buildKeypoints(values: number[]) {
  return values.map(value => ({ x: value, y: value + 0.05, z: value / 2, confidence: 0.9 }));
}
