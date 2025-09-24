import { EventEmitter } from 'node:events';
import eventBus from '../eventBus.js';
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
  private activationFrames = 0;
  private backoffFrames = 0;

  constructor(
    private options: MotionDetectorOptions,
    private readonly bus: EventEmitter = eventBus
  ) {}

  updateOptions(options: Partial<Omit<MotionDetectorOptions, 'source'>>) {
    this.options = { ...this.options, ...options };
  }

  handleFrame(frame: Buffer, ts = Date.now()) {
    const grayscale = readFrameAsGrayscale(frame);
    const blurred = gaussianBlur(grayscale);
    const smoothed = medianFilter(blurred);

    if (!this.previousFrame) {
      this.previousFrame = smoothed;
      this.baselineFrame = smoothed;
      return;
    }

    const diffThreshold = this.options.diffThreshold ?? DEFAULT_DIFF_THRESHOLD;
    const areaThreshold = this.options.areaThreshold ?? DEFAULT_AREA_THRESHOLD;
    const debounceFrames = this.options.debounceFrames ?? DEFAULT_DEBOUNCE_FRAMES;
    const backoffFrames = this.options.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
    const noiseMultiplier = this.options.noiseMultiplier ?? DEFAULT_NOISE_MULTIPLIER;
    const noiseSmoothing = this.options.noiseSmoothing ?? DEFAULT_NOISE_SMOOTHING;
    const areaSmoothing = this.options.areaSmoothing ?? DEFAULT_AREA_SMOOTHING;
    const areaInflation = this.options.areaInflation ?? DEFAULT_AREA_INFLATION;
    const areaDeltaThreshold =
      this.options.areaDeltaThreshold ?? DEFAULT_AREA_DELTA_THRESHOLD;

    const referenceFrame = this.baselineFrame ?? this.previousFrame;
    const stats = frameDiffStats(referenceFrame, smoothed);
    this.previousFrame = smoothed;

    const currentNoiseLevel = this.noiseLevel === 0 ? stats.meanDelta : this.noiseLevel;
    const adaptiveDiffThreshold = Math.max(diffThreshold, currentNoiseLevel * noiseMultiplier);

    let changedPixels = 0;
    for (let i = 0; i < stats.totalPixels; i += 1) {
      if (stats.deltas[i] >= adaptiveDiffThreshold) {
        changedPixels += 1;
      }
    }

    const areaPct = changedPixels / stats.totalPixels;

    const baselineForThreshold = this.areaBaseline;
    const adaptiveAreaThreshold = Math.max(
      areaThreshold,
      baselineForThreshold * areaInflation
    );

    const nextBaseline =
      baselineForThreshold === 0
        ? areaPct * areaSmoothing
        : baselineForThreshold * (1 - areaSmoothing) + areaPct * areaSmoothing;

    const areaDelta = baselineForThreshold === 0 ? areaPct : areaPct - baselineForThreshold;
    const hasSignificantArea =
      areaPct >= adaptiveAreaThreshold || areaDelta >= areaDeltaThreshold;

    if (!hasSignificantArea) {
      if (this.noiseLevel === 0) {
        this.noiseLevel = stats.meanDelta;
      } else {
        this.noiseLevel =
          this.noiseLevel * (1 - noiseSmoothing) + stats.meanDelta * noiseSmoothing;
      }

      this.areaBaseline = nextBaseline;
      this.baselineFrame = smoothed;
      this.activationFrames = 0;
      if (this.backoffFrames > 0) {
        this.backoffFrames -= 1;
      }
      return;
    }

    this.noiseLevel =
      this.noiseLevel * (1 - noiseSmoothing) + stats.meanDelta * noiseSmoothing;

    this.areaBaseline = nextBaseline;

    if (this.backoffFrames > 0) {
      this.backoffFrames -= 1;
      return;
    }

    this.activationFrames += 1;
    if (this.activationFrames < debounceFrames) {
      return;
    }

    this.activationFrames = 0;

    if (ts - this.lastEventTs < (this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) {
      return;
    }

    this.lastEventTs = ts;
    this.backoffFrames = backoffFrames;

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
        noiseLevel: this.noiseLevel,
        areaDelta,
        areaDeltaThreshold
      }
    };

    this.bus.emit('event', payload);
  }
}

export default MotionDetector;
