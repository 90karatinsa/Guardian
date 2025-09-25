import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import eventBus from '../eventBus.js';
import metrics from '../metrics/index.js';
import { EventPayload } from '../types.js';
import {
  GrayscaleFrame,
  readFrameAsGrayscale,
  gaussianBlur,
  medianFilter,
  frameDiffStats
} from './utils.js';

export interface MotionDetectorOptions {
  source: string;
  diffThreshold?: number;
  areaThreshold?: number;
  minIntervalMs?: number;
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
  areaSmoothing?: number;
  areaInflation?: number;
  areaDeltaThreshold?: number;
}

const DEFAULT_DIFF_THRESHOLD = 25;
const DEFAULT_AREA_THRESHOLD = 0.02;
const DEFAULT_MIN_INTERVAL_MS = 2000;
const DEFAULT_DEBOUNCE_FRAMES = 2;
const DEFAULT_BACKOFF_FRAMES = 3;
const DEFAULT_NOISE_MULTIPLIER = 3;
const DEFAULT_NOISE_SMOOTHING = 0.2;
const DEFAULT_AREA_SMOOTHING = 0.2;
const DEFAULT_AREA_INFLATION = 1.5;
const DEFAULT_AREA_DELTA_THRESHOLD = 0.02;

export class MotionDetector {
  private previousFrame: GrayscaleFrame | null = null;
  private baselineFrame: GrayscaleFrame | null = null;
  private lastEventTs = 0;
  private noiseLevel = 0;
  private areaBaseline = 0;
  private areaTrendMomentum = 0;
  private activationFrames = 0;
  private backoffFrames = 0;
  private suppressedFrames = 0;

  constructor(
    private options: MotionDetectorOptions,
    private readonly bus: EventEmitter = eventBus
  ) {}

  updateOptions(options: Partial<Omit<MotionDetectorOptions, 'source'>>) {
    this.options = { ...this.options, ...options };
  }

  handleFrame(frame: Buffer, ts = Date.now()) {
    const start = performance.now();
    try {
      const grayscale = readFrameAsGrayscale(frame);
      const blurred = gaussianBlur(grayscale);
      const smoothed = medianFilter(blurred);

      if (!this.previousFrame) {
        this.previousFrame = smoothed;
        this.baselineFrame = smoothed;
        this.areaBaseline = 0;
        this.noiseLevel = 0;
        this.areaTrendMomentum = 0;
        this.activationFrames = 0;
        this.backoffFrames = 0;
        this.suppressedFrames = 0;
        return;
      }

      const diffThreshold = this.options.diffThreshold ?? DEFAULT_DIFF_THRESHOLD;
      const areaThreshold = this.options.areaThreshold ?? DEFAULT_AREA_THRESHOLD;
      const baseDebounce = this.options.debounceFrames ?? DEFAULT_DEBOUNCE_FRAMES;
      const baseBackoff = this.options.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
      const noiseMultiplier = this.options.noiseMultiplier ?? DEFAULT_NOISE_MULTIPLIER;
      const baseNoiseSmoothing = this.options.noiseSmoothing ?? DEFAULT_NOISE_SMOOTHING;
      const baseAreaSmoothing = this.options.areaSmoothing ?? DEFAULT_AREA_SMOOTHING;
      const areaInflation = this.options.areaInflation ?? DEFAULT_AREA_INFLATION;
      const areaDeltaThreshold =
        this.options.areaDeltaThreshold ?? DEFAULT_AREA_DELTA_THRESHOLD;

      const referenceFrame = this.baselineFrame ?? this.previousFrame;
      const stats = frameDiffStats(referenceFrame, smoothed);
      this.previousFrame = smoothed;

      const priorNoiseFloor = this.noiseLevel === 0 ? stats.meanDelta : this.noiseLevel;
      const noiseRatio = priorNoiseFloor === 0 ? 1 : stats.meanDelta / Math.max(priorNoiseFloor, 1);
      const noiseDelta = stats.meanDelta - priorNoiseFloor;

      const effectiveNoiseSmoothing = clamp(
        baseNoiseSmoothing * (noiseDelta > 0
          ? 1 + Math.min(Math.max(noiseRatio - 1, 0), 1) * 0.6
          : 0.6),
        0.05,
        0.5
      );

      const updatedNoiseFloor =
        priorNoiseFloor === 0
          ? stats.meanDelta
          : priorNoiseFloor * (1 - effectiveNoiseSmoothing) + stats.meanDelta * effectiveNoiseSmoothing;
      this.noiseLevel = updatedNoiseFloor;

      const noiseSuppressionFactor = clamp(
        noiseRatio > 1 ? 1 + (noiseRatio - 1) * 0.8 : 1 - Math.min(0.3, (1 - noiseRatio) * 0.5),
        0.6,
        3
      );

      const dynamicDiffThreshold = Math.max(diffThreshold, updatedNoiseFloor * noiseMultiplier);
      const adaptiveDiffThreshold = clamp(
        dynamicDiffThreshold * noiseSuppressionFactor,
        diffThreshold,
        diffThreshold * noiseMultiplier * 2.5
      );

      let changedPixels = 0;
      for (let i = 0; i < stats.totalPixels; i += 1) {
        if (stats.deltas[i] >= adaptiveDiffThreshold) {
          changedPixels += 1;
        }
      }

      const areaPct = changedPixels / stats.totalPixels;
      const previousBaseline = this.areaBaseline;
      const areaTrend = previousBaseline === 0 ? areaPct : areaPct - previousBaseline;
      const trendSmoothing = clamp(
        (this.options.areaSmoothing ?? DEFAULT_AREA_SMOOTHING) * 0.65,
        0.05,
        0.35
      );
      this.areaTrendMomentum =
        previousBaseline === 0
          ? areaTrend
          : this.areaTrendMomentum * (1 - trendSmoothing) + areaTrend * trendSmoothing;
      const stabilizedAreaTrend = previousBaseline === 0 ? areaTrend : this.areaTrendMomentum;
      const normalizedAreaTrend = clamp(
        previousBaseline === 0
          ? areaPct / Math.max(areaThreshold, 0.01)
          : stabilizedAreaTrend / Math.max(areaThreshold, 0.01),
        -2,
        2
      );

      const effectiveAreaSmoothing = clamp(
        baseAreaSmoothing * (areaTrend > 0 ? 1 + Math.min(normalizedAreaTrend, 1) * 0.3 : 0.7),
        0.05,
        0.5
      );

      const nextBaseline =
        previousBaseline === 0
          ? areaPct * effectiveAreaSmoothing
          : previousBaseline * (1 - effectiveAreaSmoothing) + areaPct * effectiveAreaSmoothing;

      const baselineForThreshold = previousBaseline === 0 ? nextBaseline : previousBaseline;
      const adaptiveAreaThreshold = Math.max(areaThreshold, baselineForThreshold * areaInflation);

      const adjustedAreaDeltaThreshold =
        areaDeltaThreshold *
        (noiseSuppressionFactor > 1.5 ? Math.min(noiseSuppressionFactor, 2.5) : 1);

      const hasSignificantArea =
        areaPct >= adaptiveAreaThreshold || stabilizedAreaTrend >= adjustedAreaDeltaThreshold;

      const debounceMultiplier = clamp(
        noiseSuppressionFactor > 1 ? 1 + (noiseSuppressionFactor - 1) * 0.7 : 1,
        1,
        3
      );
      const relaxationMultiplier = normalizedAreaTrend < 0 ? 1.15 : 1;
      const effectiveDebounceFrames = Math.max(
        baseDebounce,
        Math.round(baseDebounce * debounceMultiplier * relaxationMultiplier)
      );

      const backoffMultiplier = clamp(
        noiseSuppressionFactor > 1
          ? 1 + (noiseSuppressionFactor - 1)
          : 1 + Math.max(0, -normalizedAreaTrend) * 0.5,
        1,
        4
      );
      const effectiveBackoffFrames = Math.max(
        baseBackoff,
        Math.round(baseBackoff * backoffMultiplier)
      );

      this.areaBaseline = nextBaseline;
      this.baselineFrame = smoothed;

      if (!hasSignificantArea) {
        this.activationFrames = 0;
        if (this.backoffFrames > 0) {
          this.backoffFrames -= 1;
        }
        this.suppressedFrames += 1;
        metrics.incrementDetectorCounter('motion', 'suppressedFrames', 1);
        return;
      }

      const suppressedFramesSnapshot = this.suppressedFrames;
      this.suppressedFrames = 0;
      if (suppressedFramesSnapshot > 0) {
        metrics.incrementDetectorCounter(
          'motion',
          'suppressedFramesBeforeTrigger',
          suppressedFramesSnapshot
        );
      }

      if (this.backoffFrames > 0) {
        this.backoffFrames -= 1;
        this.activationFrames = 0;
        return;
      }

      this.activationFrames += 1;
      if (this.activationFrames < effectiveDebounceFrames) {
        return;
      }

      this.activationFrames = 0;

      if (ts - this.lastEventTs < (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) {
        return;
      }

      this.lastEventTs = ts;
      this.backoffFrames = effectiveBackoffFrames;

      const payload: EventPayload = {
        ts,
        detector: 'motion',
        source: this.options.source,
        severity: 'warning',
        message: 'Motion detected',
        meta: {
          areaPct,
          areaThreshold,
          diffThreshold,
          adaptiveDiffThreshold,
          adaptiveAreaThreshold,
          areaBaseline: this.areaBaseline,
          noiseLevel: this.noiseLevel,
          noiseFloor: updatedNoiseFloor,
          noiseRatio,
          noiseSuppressionFactor,
          areaTrend,
          stabilizedAreaTrend,
          areaDeltaThreshold: adjustedAreaDeltaThreshold,
          normalizedAreaTrend,
          effectiveDebounceFrames,
          effectiveBackoffFrames,
          noiseSmoothing: effectiveNoiseSmoothing,
          areaSmoothing: effectiveAreaSmoothing,
          noiseMultiplier,
          areaInflation,
          debounceMultiplier,
          backoffMultiplier,
          suppressedFramesBeforeTrigger: suppressedFramesSnapshot
        }
      };

      this.bus.emit('event', payload);
    } finally {
      metrics.observeDetectorLatency('motion', performance.now() - start);
    }
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default MotionDetector;
