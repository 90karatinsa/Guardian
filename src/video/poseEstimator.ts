import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import * as ort from 'onnxruntime-node';
import eventBus from '../eventBus.js';
import logger from '../logger.js';
import metrics from '../metrics/index.js';
import { EventPayload } from '../types.js';
import { summarizeThreatMetadata, type ThreatSummary } from './objectClassifier.js';

export type PoseKeypoint = {
  x: number;
  y: number;
  z?: number;
  confidence?: number;
};

export type PoseFrame = {
  ts: number;
  keypoints: PoseKeypoint[];
};

export type PoseForecast = {
  horizonMs: number;
  velocity: number[];
  acceleration: number[];
  velocityMagnitude: number[];
  accelerationMagnitude: number[];
  smoothedVelocity: number[];
  smoothedAcceleration: number[];
  movementFlags: boolean[];
  confidence: number;
  movingJointCount?: number;
  movingJointRatio?: number;
  dominantJoint?: number | null;
  threatSummary?: ThreatSummary | null;
  history: PoseFrame[];
};

export interface PoseEstimatorOptions {
  source: string;
  modelPath: string;
  forecastHorizonMs?: number;
  smoothingWindow?: number;
  minMovement?: number;
  historySize?: number;
  bus?: EventEmitter;
}

type InferenceSessionLike = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
};

const DEFAULT_HORIZON_MS = 1500;
const DEFAULT_SMOOTHING = 3;
const DEFAULT_MIN_MOVEMENT = 0.1;
const DEFAULT_HISTORY = 12;

export class PoseEstimator {
  private session: InferenceSessionLike | null = null;
  private inputName: string | null = null;
  private outputName: string | null = null;
  private readonly history: PoseFrame[] = [];
  private readonly bus: EventEmitter;
  private lastForecast: PoseForecast | null = null;
  private lastMotionSnapshot: Record<string, unknown> | null = null;
  private lastThreatSummary: ThreatSummary | null = null;

  private constructor(private readonly options: PoseEstimatorOptions) {
    this.bus = options.bus ?? eventBus;
  }

  static async create(options: PoseEstimatorOptions) {
    const estimator = new PoseEstimator(options);
    await estimator.ensureSession();
    return estimator;
  }

  ingest(frame: PoseFrame) {
    const maxHistory = this.options.historySize ?? DEFAULT_HISTORY;
    this.history.push(frame);
    while (this.history.length > maxHistory) {
      this.history.shift();
    }
  }

  async forecast(motionMeta: Record<string, unknown> | undefined, ts = Date.now()) {
    const start = performance.now();
    metrics.incrementDetectorCounter('pose', 'invocations');
    try {
      await this.ensureSession();
      if (!this.session || !this.inputName || !this.outputName) {
        metrics.recordDetectorError('pose', 'session-unavailable');
        return null;
      }

      const window = this.options.smoothingWindow ?? DEFAULT_SMOOTHING;
      const history = this.history.slice(-Math.max(window, 1));

      if (history.length === 0) {
        metrics.incrementDetectorCounter('pose', 'skipped');
        return null;
      }

      const tensor = buildPoseTensor(history);
      const feeds: Record<string, ort.Tensor> = {
        [this.inputName]: tensor
      };

      const results = await this.session.run(feeds);
      const output = results[this.outputName];

      if (!output) {
        metrics.recordDetectorError('pose', 'missing-output');
        return null;
      }

      const smoothingFactor = clamp(
        2 / Math.max(2, (this.options.smoothingWindow ?? DEFAULT_SMOOTHING) + 1),
        0.05,
        0.8
      );

      const forecast = interpretForecast(output, {
        horizonMs: this.options.forecastHorizonMs ?? DEFAULT_HORIZON_MS,
        minMovement: this.options.minMovement ?? DEFAULT_MIN_MOVEMENT,
        previous: this.lastForecast,
        smoothingFactor,
        historyFrames: history
      });
      const threatSummary = summarizeThreatMetadata(motionMeta);
      const enrichedForecast = enrichForecast(forecast, threatSummary);
      const combinedMotion = mergeMotionMeta(motionMeta, enrichedForecast, threatSummary);

      this.lastForecast = enrichedForecast;
      this.lastMotionSnapshot = combinedMotion;
      this.lastThreatSummary = threatSummary;
      metrics.incrementDetectorCounter('pose', 'forecasts');
      metrics.incrementDetectorCounter('pose', 'frames', history.length);
      const movementCount = forecast.movementFlags.filter(Boolean).length;
      if (movementCount > 0) {
        metrics.incrementDetectorCounter('pose', 'movementFlags', movementCount);
      }
      metrics.setDetectorGauge('pose', 'movingJointCount', movementCount);
      const movementRatio = forecast.movingJointRatio ?? (forecast.movementFlags.length
        ? movementCount / forecast.movementFlags.length
        : 0);
      metrics.setDetectorGauge('pose', 'movingJointRatio', movementRatio);

      const payload: EventPayload = {
        ts,
        source: this.options.source,
        detector: 'pose',
        severity: 'info',
        message: 'Pose forecast generated',
        meta: {
          horizonMs: enrichedForecast.horizonMs,
          velocity: enrichedForecast.velocity,
          acceleration: enrichedForecast.acceleration,
          movementFlags: enrichedForecast.movementFlags,
          velocityMagnitude: enrichedForecast.velocityMagnitude,
          accelerationMagnitude: enrichedForecast.accelerationMagnitude,
          smoothedVelocity: enrichedForecast.smoothedVelocity,
          smoothedAcceleration: enrichedForecast.smoothedAcceleration,
          confidence: enrichedForecast.confidence,
          movingJointCount: enrichedForecast.movingJointCount,
          movingJointRatio: enrichedForecast.movingJointRatio,
          dominantJoint: enrichedForecast.dominantJoint,
          motion: combinedMotion,
          threats: threatSummary,
          frames: history.map(frame => ({ ts: frame.ts, keypoints: frame.keypoints.length })),
          poseHistory: enrichedForecast.history.map(frame => ({
            ts: frame.ts,
            keypoints: frame.keypoints.map(point => ({
              x: roundFloat(point.x),
              y: roundFloat(point.y),
              z: typeof point.z === 'number' ? roundFloat(point.z) : undefined,
              confidence: typeof point.confidence === 'number' ? roundFloat(point.confidence) : undefined
            }))
          }))
        }
      };

      this.bus.emit('event', payload);
      return enrichedForecast;
    } catch (error) {
      metrics.recordDetectorError('pose', (error as Error).message ?? 'forecast-failed');
      throw error;
    } finally {
      metrics.observeDetectorLatency('pose', performance.now() - start);
    }
  }

  mergeIntoMotionMeta(meta: Record<string, unknown> | undefined) {
    if (!this.lastForecast) {
      return meta;
    }
    const base = meta && typeof meta === 'object' ? { ...meta } : {};
    if (this.lastMotionSnapshot) {
      const motionMeta =
        base.motion && typeof base.motion === 'object'
          ? { ...(base.motion as Record<string, unknown>) }
          : {};
      base.motion = { ...motionMeta, ...this.lastMotionSnapshot };
    }
    base.poseForecast = { ...this.lastForecast };
    if (this.lastForecast?.history) {
      base.poseHistory = this.lastForecast.history.map(frame => ({
        ts: frame.ts,
        keypoints: frame.keypoints.map(point => ({ ...point }))
      }));
    }
    if (this.lastThreatSummary) {
      base.poseThreatSummary = this.lastThreatSummary;
    }
    return base;
  }

  private async ensureSession() {
    if (this.session) {
      return;
    }

    try {
      const session = await ort.InferenceSession.create(this.options.modelPath);
      this.session = session as InferenceSessionLike;
    } catch (error) {
      logger.warn({ err: error, modelPath: this.options.modelPath }, 'Falling back to mock pose estimator');
      this.session = createMockSession();
    }

    this.inputName = this.session.inputNames[0] ?? null;
    this.outputName = this.session.outputNames[0] ?? null;
  }
}

function buildPoseTensor(history: PoseFrame[]) {
  const joints = history[0]?.keypoints.length ?? 0;
  const features = 4; // x, y, z, confidence
  const frames = history.length;
  const data = new Float32Array(frames * joints * features);

  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frame = history[frameIndex];
    for (let jointIndex = 0; jointIndex < joints; jointIndex += 1) {
      const keypoint = frame.keypoints[jointIndex] ?? { x: 0, y: 0, z: 0, confidence: 0 };
      const baseIndex = frameIndex * joints * features + jointIndex * features;
      data[baseIndex] = keypoint.x;
      data[baseIndex + 1] = keypoint.y;
      data[baseIndex + 2] = keypoint.z ?? 0;
      data[baseIndex + 3] = keypoint.confidence ?? 0;
    }
  }

  return new ort.Tensor('float32', data, [1, frames, joints, features]);
}

function interpretForecast(
  output: ort.OnnxValue,
  options: {
    horizonMs: number;
    minMovement: number;
    previous?: PoseForecast | null;
    smoothingFactor?: number;
    historyFrames?: PoseFrame[];
  }
): PoseForecast {
  const data = output.data as Float32Array | number[] | undefined;
  const historyFrames = Array.isArray(options.historyFrames) ? options.historyFrames : [];
  const history = historyFrames.map(frame => ({
    ts: frame.ts,
    keypoints: frame.keypoints.map(point => ({ ...point }))
  }));
  if (!data || data.length === 0) {
    return {
      horizonMs: options.horizonMs,
      velocity: [],
      acceleration: [],
      velocityMagnitude: [],
      accelerationMagnitude: [],
      smoothedVelocity: [],
      smoothedAcceleration: [],
      movementFlags: [],
      confidence: 0,
      history
    };
  }

  const values = Array.from(data, value => roundFloat(Number(value)));
  const joints = Math.floor(values.length / 2);
  const velocity = values.slice(0, joints);
  const acceleration = values.slice(joints);

  const axes = velocity.length % 3 === 0 ? 3 : 1;
  const velocityVectors = chunkSeries(velocity, axes);
  const accelerationVectors = chunkSeries(acceleration, axes);
  const velocityMagnitude = velocityVectors.map(vectorMagnitude);
  const accelerationMagnitude = accelerationVectors.map(vectorMagnitude);

  const smoothingFactor = clamp(options.smoothingFactor ?? 0.5, 0.05, 0.9);
  const previousVelocity = options.previous?.smoothedVelocity ?? options.previous?.velocityMagnitude ?? [];
  const previousAcceleration =
    options.previous?.smoothedAcceleration ?? options.previous?.accelerationMagnitude ?? [];

  const smoothedVelocity = smoothSeries(velocityMagnitude, previousVelocity, smoothingFactor);
  const smoothedAcceleration = smoothSeries(accelerationMagnitude, previousAcceleration, smoothingFactor);

  const movementFlags = smoothedVelocity.map((value, index) => {
    const accel = Math.abs(smoothedAcceleration[index] ?? 0);
    return value + accel > options.minMovement;
  });

  const movingJointCount = movementFlags.filter(Boolean).length;
  const movingJointRatio = movementFlags.length === 0 ? 0 : movingJointCount / movementFlags.length;
  const confidence = movementFlags.length === 0 ? 0 : movingJointCount / movementFlags.length;

  const dominantJoint = resolveDominantJoint(smoothedVelocity, smoothedAcceleration);

  return {
    horizonMs: options.horizonMs,
    velocity,
    acceleration,
    velocityMagnitude,
    accelerationMagnitude,
    smoothedVelocity,
    smoothedAcceleration,
    movementFlags,
    confidence,
    movingJointCount,
    movingJointRatio,
    dominantJoint,
    history
  };
}

function enrichForecast(forecast: PoseForecast, threatSummary: ThreatSummary | null): PoseForecast {
  return {
    ...forecast,
    movementFlags: [...forecast.movementFlags],
    movingJointCount: forecast.movingJointCount,
    movingJointRatio: forecast.movingJointRatio,
    dominantJoint: typeof forecast.dominantJoint === 'number' ? forecast.dominantJoint : null,
    threatSummary
  };
}

function mergeMotionMeta(
  motionMeta: Record<string, unknown> | undefined,
  forecast: PoseForecast,
  threatSummary: ThreatSummary | null
) {
  const base = motionMeta && typeof motionMeta === 'object' ? { ...motionMeta } : {};
  const snapshot: Record<string, unknown> = {
    ...base,
    futureMovementFlags: [...forecast.movementFlags],
    movingJointCount: forecast.movingJointCount ?? forecast.movementFlags.filter(Boolean).length,
    movingJointRatio: forecast.movingJointRatio ?? null,
    dominantJoint: typeof forecast.dominantJoint === 'number' ? forecast.dominantJoint : null,
    forecastConfidence: forecast.confidence,
    horizonMs: forecast.horizonMs,
    futureVelocityMagnitude: [...forecast.smoothedVelocity],
    futureAccelerationMagnitude: [...forecast.smoothedAcceleration]
  };

  if (threatSummary) {
    snapshot.threatCorrelation = {
      maxThreatScore: threatSummary.maxThreatScore,
      maxThreatLabel: threatSummary.maxThreatLabel,
      totalDetections: threatSummary.totalDetections
    };
  }

  return snapshot;
}

function createMockSession(): InferenceSessionLike {
  return {
    inputNames: ['poses'],
    outputNames: ['forecast'],
    async run() {
      const data = new Float32Array([0.05, 0.12, 0.03, 0.08, 0.01, 0.02]);
      return {
        forecast: new ort.Tensor('float32', data, [1, data.length])
      };
    }
  };
}

function roundFloat(value: number, precision = 6) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function chunkSeries(series: number[], chunkSize: number) {
  const size = Math.max(1, chunkSize);
  const result: number[][] = [];
  for (let i = 0; i < series.length; i += size) {
    result.push(series.slice(i, i + size));
  }
  if (result.length === 0) {
    result.push([]);
  }
  return result;
}

function vectorMagnitude(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sumSq = values.reduce((acc, value) => acc + value * value, 0);
  return roundFloat(Math.sqrt(Math.max(0, sumSq)));
}

function smoothSeries(current: number[], previous: number[], smoothingFactor: number) {
  if (!previous || previous.length === 0) {
    return current.map(value => roundFloat(value));
  }
  return current.map((value, index) => {
    const prev = Number.isFinite(previous[index]) ? previous[index]! : value;
    const smoothed = prev * (1 - smoothingFactor) + value * smoothingFactor;
    return roundFloat(smoothed);
  });
}

function resolveDominantJoint(smoothedVelocity: number[], smoothedAcceleration: number[]) {
  let dominantIndex: number | null = null;
  let dominantMagnitude = -Infinity;
  for (let i = 0; i < smoothedVelocity.length; i += 1) {
    const magnitude = Math.abs(smoothedVelocity[i] ?? 0) + Math.abs(smoothedAcceleration[i] ?? 0);
    if (magnitude > dominantMagnitude) {
      dominantMagnitude = magnitude;
      dominantIndex = magnitude > 0 ? i : dominantIndex;
    }
  }
  return dominantIndex;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export default PoseEstimator;
