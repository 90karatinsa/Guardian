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

  it('PoseForecastConfidence generates motion snapshots with future movement context', async () => {
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

    const motionMeta = { areaPct: 0.18, diffThreshold: 12, framesActive: 4 } as Record<string, unknown>;
    const forecast = await estimator.forecast(motionMeta, 42);

    expect(forecast).not.toBeNull();
    const resolved = forecast!;
    expect(resolved.horizonMs).toBe(horizon);
    expect(resolved.velocity).toEqual([0.1, 0.05, -0.02]);
    expect(resolved.acceleration).toEqual([0.02, 0.03, 0.01]);
    expect(resolved.movementFlags).toEqual([true, true, false]);
    expect(resolved.confidence).toBeCloseTo(2 / 3, 5);
    expect(resolved.movingJointCount).toBe(2);
    expect(typeof resolved.dominantJoint === 'number').toBe(true);
    expect(resolved.threatSummary).toBeNull();

    expect(events).toHaveLength(1);
    const event = events[0] as {
      detector: string;
      meta?: Record<string, unknown>;
    };
    expect(event.detector).toBe('pose');
    expect(event.meta?.horizonMs).toBe(horizon);
    expect(event.meta?.movementFlags).toEqual([true, true, false]);
    expect(event.meta?.motion).toMatchObject({
      areaPct: 0.18,
      diffThreshold: 12,
      framesActive: 4,
      futureMovementFlags: [true, true, false],
      movingJointCount: 2,
      forecastConfidence: resolved.confidence,
      horizonMs: horizon
    });
    expect(event.meta?.movingJointCount).toBe(2);
    expect(event.meta?.dominantJoint).toBe(resolved.dominantJoint);
    expect(event.meta?.threats).toBeNull();
    expect(Array.isArray(event.meta?.frames)).toBe(true);
    expect((event.meta?.frames as unknown[]).length).toBe(3);

    const merged = estimator.mergeIntoMotionMeta({
      existing: true
    });
    expect(merged?.poseForecast).toMatchObject({
      horizonMs: horizon,
      movementFlags: [true, true, false],
      movingJointCount: 2
    });
    expect((merged?.motion as Record<string, unknown>).futureMovementFlags).toEqual([
      true,
      true,
      false
    ]);
    expect(merged?.poseThreatSummary).toBeUndefined();
  });

  it('PoseThreatCorrelation embeds object classifier threat summaries', async () => {
    const bus = new EventEmitter();
    const events: unknown[] = [];
    bus.on('event', event => events.push(event));

    const estimator = await PoseEstimator.create({
      source: 'video:test-pose',
      modelPath: 'models/pose.onnx',
      bus
    });

    const tensorData = new Float32Array([0.04, 0.02, 0.08, 0.01, 0.02, 0.03]);
    runMock.mockResolvedValueOnce({
      forecast: new ort.Tensor('float32', tensorData, [1, tensorData.length])
    });

    const frames: PoseFrame[] = [
      { ts: 1, keypoints: buildKeypoints([0.05, 0.25]) },
      { ts: 2, keypoints: buildKeypoints([0.15, 0.35]) }
    ];
    frames.forEach(frame => estimator.ingest(frame));

    const motionMeta = {
      areaPct: 0.22,
      objects: [
        { label: 'person', threatScore: 0.82, threat: true },
        { label: 'package', threatScore: 0.15 }
      ],
      threat: { label: 'person', score: 0.9 }
    } as Record<string, unknown>;

    const forecast = await estimator.forecast(motionMeta, 99);
    expect(forecast?.threatSummary?.maxThreatScore).toBeCloseTo(0.9, 5);
    expect(forecast?.threatSummary?.totalDetections).toBe(3);

    const event = events[0] as {
      meta?: Record<string, unknown>;
    };
    expect(event.meta?.threats).toMatchObject({
      maxThreatScore: 0.9,
      maxThreatLabel: 'person',
      totalDetections: 3
    });
    expect((event.meta?.motion as Record<string, unknown>).threatCorrelation).toEqual({
      maxThreatScore: 0.9,
      maxThreatLabel: 'person',
      totalDetections: 3
    });

    const merged = estimator.mergeIntoMotionMeta({ baseline: true });
    expect(merged?.poseForecast?.threatSummary?.maxThreatScore).toBeCloseTo(0.9, 5);
    expect(merged?.poseThreatSummary?.maxThreatLabel).toBe('person');
  });
});

function buildKeypoints(values: number[]) {
  return values.map(value => ({ x: value, y: value + 0.05, z: value / 2, confidence: 0.9 }));
}
