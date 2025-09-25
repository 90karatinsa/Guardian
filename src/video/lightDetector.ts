import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import eventBus from '../eventBus.js';
import metrics from '../metrics/index.js';
import { EventPayload } from '../types.js';
import {
  averageLuminance,
  readFrameAsGrayscale,
  gaussianBlur,
  medianFilter
} from './utils.js';

export interface LightDetectorOptions {
  source: string;
  deltaThreshold?: number;
  normalHours?: Array<{ start: number; end: number }>;
  smoothingFactor?: number;
  minIntervalMs?: number;
  debounceFrames?: number;
  backoffFrames?: number;
  noiseMultiplier?: number;
  noiseSmoothing?: number;
}

const DEFAULT_DELTA_THRESHOLD = 30;
const DEFAULT_SMOOTHING = 0.2;
const DEFAULT_MIN_INTERVAL_MS = 60000;
const DEFAULT_DEBOUNCE_FRAMES = 2;
const DEFAULT_BACKOFF_FRAMES = 3;
const DEFAULT_NOISE_MULTIPLIER = 2.5;
const DEFAULT_NOISE_SMOOTHING = 0.1;

export class LightDetector {
  private baseline: number | null = null;
  private lastEventTs = 0;
  private noiseLevel = 0;
  private pendingFrames = 0;
  private backoffFrames = 0;
  private suppressedFrames = 0;
  private deltaTrend = 0;

  constructor(
    private readonly options: LightDetectorOptions,
    private readonly bus: EventEmitter = eventBus
  ) {}

  handleFrame(frame: Buffer, ts = Date.now()) {
    const start = performance.now();
    try {
      const grayscale = readFrameAsGrayscale(frame);
      const blurred = gaussianBlur(grayscale);
      const smoothed = medianFilter(blurred);
      const luminance = averageLuminance(smoothed);

      if (this.baseline === null) {
        this.baseline = luminance;
        this.noiseLevel = 0;
        this.pendingFrames = 0;
        this.backoffFrames = 0;
        this.suppressedFrames = 0;
        this.deltaTrend = 0;
        return;
      }

      const smoothing = this.options.smoothingFactor ?? DEFAULT_SMOOTHING;
      const baseDebounce = this.options.debounceFrames ?? DEFAULT_DEBOUNCE_FRAMES;
      const baseBackoff = this.options.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
      const noiseMultiplier = this.options.noiseMultiplier ?? DEFAULT_NOISE_MULTIPLIER;
      const baseNoiseSmoothing = this.options.noiseSmoothing ?? DEFAULT_NOISE_SMOOTHING;

      const deltaThreshold = this.options.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD;
      const delta = Math.abs(luminance - this.baseline);
      const noiseFloor = this.noiseLevel === 0 ? delta : this.noiseLevel;
      const noiseRatio = noiseFloor === 0 ? 1 : delta / Math.max(noiseFloor, 1);
      const deltaTrendSmoothing = clamp(baseNoiseSmoothing * 1.2, 0.05, 0.35);
      this.deltaTrend =
        this.deltaTrend === 0
          ? delta
          : this.deltaTrend * (1 - deltaTrendSmoothing) + delta * deltaTrendSmoothing;
      const stabilizedDelta = Math.max(delta, this.deltaTrend);

      const effectiveNoiseSmoothing = clamp(
        baseNoiseSmoothing * (noiseRatio > 1 ? 1 + Math.min(noiseRatio - 1, 1) * 0.6 : 0.65),
        0.05,
        0.5
      );

      const updatedNoiseFloor =
        noiseFloor === 0
          ? delta
          : noiseFloor * (1 - effectiveNoiseSmoothing) + delta * effectiveNoiseSmoothing;

      const baseAdaptiveThreshold = Math.max(deltaThreshold, noiseFloor * noiseMultiplier);
      const noiseSuppressionFactor = clamp(
        noiseRatio > 1 ? 1 + (noiseRatio - 1) * 0.7 : 1 - Math.min(0.35, (1 - noiseRatio) * 0.5),
        0.6,
        3
      );
      const adaptiveThreshold = baseAdaptiveThreshold * noiseSuppressionFactor;
      const intensityRatio = adaptiveThreshold === 0 ? 0 : stabilizedDelta / adaptiveThreshold;

      const effectiveSmoothing = clamp(
        delta < adaptiveThreshold
          ? smoothing * 0.75
          : smoothing * (1 + Math.min(noiseRatio - 1, 1) * 0.25),
        0.01,
        0.5
      );

      const debounceMultiplier = clamp(noiseSuppressionFactor, 1, 1.5);
      const effectiveDebounce = Math.max(
        baseDebounce,
        Math.round(baseDebounce * debounceMultiplier)
      );
      const backoffMultiplier = clamp(
        noiseSuppressionFactor > 1 ? 1 + (noiseSuppressionFactor - 1) * 0.5 : 1.2,
        1,
        3
      );
      const effectiveBackoff = Math.max(
        baseBackoff,
        Math.round(baseBackoff * backoffMultiplier)
      );

      if (this.isWithinNormalHours(ts)) {
        this.updateBaseline(luminance, effectiveSmoothing);
        this.pendingFrames = 0;
        this.backoffFrames = 0;
        this.suppressedFrames = 0;
        this.noiseLevel = updatedNoiseFloor;
        return;
      }

      if (stabilizedDelta < adaptiveThreshold) {
        this.updateBaseline(luminance, effectiveSmoothing);
        if (this.pendingFrames > 0) {
          this.pendingFrames = Math.max(0, this.pendingFrames - 1);
        }
        if (this.backoffFrames > 0) {
          this.backoffFrames -= 1;
        }
        this.noiseLevel = updatedNoiseFloor;
        this.suppressedFrames += 1;
        metrics.incrementDetectorCounter('light', 'suppressedFrames', 1);
        return;
      }

      const suppressedFramesSnapshot = this.suppressedFrames;
      this.suppressedFrames = 0;
      if (suppressedFramesSnapshot > 0) {
        metrics.incrementDetectorCounter(
          'light',
          'suppressedFramesBeforeTrigger',
          suppressedFramesSnapshot
        );
      }

      this.noiseLevel = Math.max(
        this.noiseLevel * (1 - effectiveNoiseSmoothing),
        Math.min(deltaThreshold, stabilizedDelta)
      );

      if (this.backoffFrames > 0) {
        this.backoffFrames -= 1;
        this.pendingFrames = 0;
        return;
      }

      this.pendingFrames += 1;
      if (this.pendingFrames < effectiveDebounce) {
        return;
      }

      const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
      if (ts - this.lastEventTs < minInterval) {
        this.pendingFrames = 0;
        this.backoffFrames = Math.max(this.backoffFrames, Math.ceil(effectiveBackoff / 2));
        return;
      }

      this.lastEventTs = ts;
      this.pendingFrames = 0;
      this.backoffFrames = effectiveBackoff;
      const previousBaseline = this.baseline;
      this.baseline = this.baseline * (1 - effectiveSmoothing) + luminance * effectiveSmoothing;
      const updatedBaseline = this.baseline;

      const payload: EventPayload = {
        ts,
        detector: 'light',
        source: this.options.source,
        severity: 'warning',
        message: 'Unexpected light level change detected',
        meta: {
          baseline: updatedBaseline,
          previousBaseline,
          luminance,
          delta,
          stabilizedDelta,
          deltaThreshold,
          adaptiveThreshold,
          rawAdaptiveThreshold: baseAdaptiveThreshold,
          intensityRatio,
          noiseLevel: this.noiseLevel,
          noiseFloor: updatedNoiseFloor,
          noiseRatio,
          noiseSuppressionFactor,
          effectiveDebounceFrames: effectiveDebounce,
          effectiveBackoffFrames: effectiveBackoff,
          noiseSmoothing: effectiveNoiseSmoothing,
          smoothingFactor: effectiveSmoothing,
          noiseMultiplier,
          debounceMultiplier,
          backoffMultiplier,
          suppressedFramesBeforeTrigger: suppressedFramesSnapshot
        }
      };

      this.bus.emit('event', payload);
    } finally {
      metrics.observeDetectorLatency('light', performance.now() - start);
    }
  }

  private updateBaseline(luminance: number, smoothing: number) {
    this.baseline = this.baseline! * (1 - smoothing) + luminance * smoothing;
  }

  private isWithinNormalHours(ts: number) {
    const hours = this.options.normalHours;
    if (!hours || hours.length === 0) {
      return false;
    }

    const currentHour = new Date(ts).getHours();

    return hours.some(range => isHourWithinRange(currentHour, range.start, range.end));
  }
}

function isHourWithinRange(hour: number, start: number, end: number): boolean {
  const normalizedStart = normalizeHour(start);
  const normalizedEnd = normalizeHour(end);
  const normalizedHour = normalizeHour(hour);

  if (normalizedStart <= normalizedEnd) {
    return normalizedHour >= normalizedStart && normalizedHour < normalizedEnd;
  }

  // Overnight window (e.g. 22-6)
  return normalizedHour >= normalizedStart || normalizedHour < normalizedEnd;
}

function normalizeHour(hour: number) {
  return ((Math.floor(hour) % 24) + 24) % 24;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default LightDetector;
