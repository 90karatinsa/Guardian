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
        return;
      }

      const smoothing = this.options.smoothingFactor ?? DEFAULT_SMOOTHING;
      const baseDebounce = this.options.debounceFrames ?? DEFAULT_DEBOUNCE_FRAMES;
      const baseBackoff = this.options.backoffFrames ?? DEFAULT_BACKOFF_FRAMES;
      const noiseMultiplier = this.options.noiseMultiplier ?? DEFAULT_NOISE_MULTIPLIER;
      const baseNoiseSmoothing = this.options.noiseSmoothing ?? DEFAULT_NOISE_SMOOTHING;

      const deltaThreshold = this.options.deltaThreshold ?? DEFAULT_DELTA_THRESHOLD;
      const delta = Math.abs(luminance - this.baseline);
      const currentNoiseLevel = this.noiseLevel === 0 ? delta : this.noiseLevel;
      const adaptiveThreshold = Math.max(deltaThreshold, currentNoiseLevel * noiseMultiplier);
      const effectiveNoiseSmoothing = clamp(
        delta > adaptiveThreshold ? baseNoiseSmoothing * 1.2 : baseNoiseSmoothing * 0.8,
        0.05,
        0.5
      );
      const intensityRatio = adaptiveThreshold === 0 ? 0 : delta / adaptiveThreshold;
      const effectiveDebounce = intensityRatio >= 1.5 ? baseDebounce : Math.max(baseDebounce, Math.round(baseDebounce * 1.5));
      const effectiveBackoff = intensityRatio >= 2 ? baseBackoff : Math.max(baseBackoff, Math.round(baseBackoff * 1.5));
      const effectiveSmoothing = clamp(
        delta < adaptiveThreshold ? smoothing * 0.8 : smoothing * 1.05,
        0.01,
        0.5
      );

      if (this.isWithinNormalHours(ts)) {
        this.updateBaseline(luminance, effectiveSmoothing);
        this.resetDebounce();
        return;
      }

      if (delta < adaptiveThreshold) {
        if (this.noiseLevel === 0) {
          this.noiseLevel = delta;
        } else {
          this.noiseLevel =
            this.noiseLevel * (1 - effectiveNoiseSmoothing) + delta * effectiveNoiseSmoothing;
        }
        this.updateBaseline(luminance, effectiveSmoothing);
        this.resetDebounce(false);
        if (this.backoffFrames > 0) {
          this.backoffFrames -= 1;
        }
        return;
      }

      this.noiseLevel = Math.max(this.noiseLevel * (1 - effectiveNoiseSmoothing), deltaThreshold);

      if (this.backoffFrames > 0) {
        this.backoffFrames -= 1;
        return;
      }

      this.pendingFrames += 1;
      if (this.pendingFrames < effectiveDebounce) {
        return;
      }

      const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
      if (ts - this.lastEventTs < minInterval) {
        this.pendingFrames = 0;
        return;
      }

      this.lastEventTs = ts;
      this.pendingFrames = 0;
      this.backoffFrames = effectiveBackoff;
      const previousBaseline = this.baseline;
      this.baseline =
        this.baseline * (1 - effectiveSmoothing) + luminance * effectiveSmoothing;
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
          deltaThreshold,
          adaptiveThreshold,
          noiseLevel: this.noiseLevel,
          effectiveDebounceFrames: effectiveDebounce,
          effectiveBackoffFrames: effectiveBackoff,
          noiseSmoothing: effectiveNoiseSmoothing,
          smoothingFactor: effectiveSmoothing,
          noiseMultiplier
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

  private resetDebounce(fullReset = true) {
    if (fullReset) {
      this.pendingFrames = 0;
    } else if (this.pendingFrames > 0) {
      this.pendingFrames -= 1;
    }
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
