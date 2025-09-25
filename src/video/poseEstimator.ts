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
  movementFlags: boolean[];
  confidence: number;
  movingJointCount?: number;
  dominantJoint?: number | null;
  threatSummary?: ThreatSummary | null;
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

      const forecast = interpretForecast(output, {
        horizonMs: this.options.forecastHorizonMs ?? DEFAULT_HORIZON_MS,
        minMovement: this.options.minMovement ?? DEFAULT_MIN_MOVEMENT
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
          confidence: enrichedForecast.confidence,
          movingJointCount: enrichedForecast.movingJointCount,
          dominantJoint: enrichedForecast.dominantJoint,
          motion: combinedMotion,
          threats: threatSummary,
          frames: history.map(frame => ({ ts: frame.ts, keypoints: frame.keypoints.length }))
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
  options: { horizonMs: number; minMovement: number }
): PoseForecast {
  const data = output.data as Float32Array | number[] | undefined;
  if (!data || data.length === 0) {
    return {
      horizonMs: options.horizonMs,
      velocity: [],
      acceleration: [],
      movementFlags: [],
      confidence: 0
    };
  }

  const values = Array.from(data, value => roundFloat(Number(value)));
  const joints = Math.floor(values.length / 2);
  const velocity = values.slice(0, joints);
  const acceleration = values.slice(joints);

  const movementFlags = velocity.map((value, index) => {
    const accel = Math.abs(acceleration[index] ?? 0);
    return Math.abs(value) + accel > options.minMovement;
  });

  const confidence = movementFlags.reduce((acc, flag) => acc + (flag ? 1 : 0), 0) / (movementFlags.length || 1);

  return {
    horizonMs: options.horizonMs,
    velocity,
    acceleration,
    movementFlags,
    confidence
  };
}

function enrichForecast(forecast: PoseForecast, threatSummary: ThreatSummary | null): PoseForecast {
  const movementFlags = [...forecast.movementFlags];
  const movingJointCount = movementFlags.filter(Boolean).length;
  let dominantJoint: number | null = null;
  let dominantMagnitude = -Infinity;
  for (let i = 0; i < movementFlags.length; i += 1) {
    const velocity = Math.abs(forecast.velocity[i] ?? 0);
    const acceleration = Math.abs(forecast.acceleration[i] ?? 0);
    const magnitude = velocity + acceleration;
    if (magnitude > dominantMagnitude) {
      dominantMagnitude = magnitude;
      dominantJoint = magnitude > 0 ? i : dominantJoint;
    }
  }

  return {
    ...forecast,
    movementFlags,
    movingJointCount,
    dominantJoint: typeof dominantJoint === 'number' ? dominantJoint : null,
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
    dominantJoint: typeof forecast.dominantJoint === 'number' ? forecast.dominantJoint : null,
    forecastConfidence: forecast.confidence,
    horizonMs: forecast.horizonMs
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

export default PoseEstimator;
