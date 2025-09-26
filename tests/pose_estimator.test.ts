import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import PoseEstimator, { PoseFrame } from '../src/video/poseEstimator.js';
import metrics from '../src/metrics/index.js';

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
    metrics.reset();
  });

  it('PoseForecastThreatFusion generates motion snapshots with future movement context', async () => {
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

    const motionMeta = {
      areaPct: 0.18,
      diffThreshold: 12,
      framesActive: 4,
      history: [
        { ts: 0, areaPct: 0.05, adaptiveDiffThreshold: 11, reason: 'suppressed' },
        { ts: 1, areaPct: 0.12, adaptiveDiffThreshold: 12, reason: 'candidate' }
      ]
    } as Record<string, unknown>;
    const forecast = await estimator.forecast(motionMeta, 42);

    expect(forecast).not.toBeNull();
    const resolved = forecast!;
    expect(resolved.horizonMs).toBe(horizon);
    expect(resolved.velocity).toEqual([0.1, 0.05, -0.02]);
    expect(resolved.acceleration).toEqual([0.02, 0.03, 0.01]);
    expect(resolved.velocityMagnitude).toHaveLength(1);
    expect(resolved.accelerationMagnitude).toHaveLength(1);
    expect(resolved.smoothedVelocity).toEqual(resolved.velocityMagnitude);
    expect(resolved.smoothedAcceleration).toEqual(resolved.accelerationMagnitude);
    expect(resolved.movementFlags).toEqual([true]);
    expect(resolved.confidence).toBeCloseTo(1, 5);
    expect(resolved.movingJointCount).toBe(1);
    expect(resolved.movingJointRatio).toBeGreaterThan(0);
    expect(resolved.history).toHaveLength(frames.length);
    expect(resolved.dominantJoint).toBe(0);
    expect(resolved.threatSummary).toBeNull();

    expect(events).toHaveLength(1);
    const event = events[0] as {
      detector: string;
      meta?: Record<string, unknown>;
    };
    expect(event.detector).toBe('pose');
    expect(event.meta?.horizonMs).toBe(horizon);
    expect(event.meta?.movementFlags).toEqual([true]);
    expect(event.meta?.motion).toMatchObject({
      areaPct: 0.18,
      diffThreshold: 12,
      framesActive: 4,
      futureMovementFlags: [true],
      movingJointCount: 1,
      forecastConfidence: resolved.confidence,
      horizonMs: horizon
    });
    expect(Array.isArray((event.meta?.motion as Record<string, unknown>).history)).toBe(true);
    expect(event.meta?.velocityMagnitude).toHaveLength(1);
    expect(event.meta?.movingJointCount).toBe(1);
    expect(event.meta?.dominantJoint).toBe(resolved.dominantJoint);
    expect(event.meta?.threats).toBeNull();
    expect(Array.isArray(event.meta?.frames)).toBe(true);
    expect((event.meta?.frames as unknown[]).length).toBe(3);
    expect(Array.isArray(event.meta?.poseHistory)).toBe(true);
    expect((event.meta?.poseHistory as Array<{ keypoints: unknown[] }>)[0]?.keypoints.length).toBeGreaterThan(0);

    const merged = estimator.mergeIntoMotionMeta({
      existing: true
    });
    expect(merged?.poseForecast).toMatchObject({
      horizonMs: horizon,
      movementFlags: [true],
      movingJointCount: 1,
      movingJointRatio: 1
    });
    const motionDetails = merged?.motion as Record<string, unknown>;
    expect(motionDetails.futureMovementFlags).toEqual([true]);
    expect(Array.isArray(motionDetails.futureVelocityMagnitude)).toBe(true);
    expect(Array.isArray(motionDetails.futureAccelerationMagnitude)).toBe(true);
    expect(Array.isArray(merged?.poseHistory)).toBe(true);
    expect(merged?.poseThreatSummary).toBeUndefined();

    const snapshot = metrics.snapshot();
    expect(snapshot.detectors.pose?.gauges?.movingJointCount).toBe(1);
    expect(snapshot.detectors.pose?.gauges?.movingJointRatio).toBeCloseTo(1, 5);
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
