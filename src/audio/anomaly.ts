import { EventEmitter } from 'node:events';
import Meyda from 'meyda';
import eventBus from '../eventBus.js';
import { EventPayload } from '../types.js';

export interface AudioAnomalyOptions {
  source: string;
  sampleRate?: number;
  rmsThreshold?: number;
  centroidJumpThreshold?: number;
  minIntervalMs?: number;
  frameSize?: number;
  hopSize?: number;
  frameDurationMs?: number;
  hopDurationMs?: number;
  minTriggerDurationMs?: number;
  rmsWindowMs?: number;
  centroidWindowMs?: number;
  thresholds?: AudioAnomalyThresholdSchedule;
  nightHours?: NightHoursConfig;
}

export interface AudioAnomalyThresholds {
  rms?: number;
  centroidJump?: number;
}

export interface AudioAnomalyThresholdSchedule {
  default?: AudioAnomalyThresholds;
  day?: AudioAnomalyThresholds;
  night?: AudioAnomalyThresholds;
}

export interface NightHoursConfig {
  start: number;
  end: number;
}

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_RMS_THRESHOLD = 0.2;
const DEFAULT_CENTROID_JUMP = 150;
const DEFAULT_MIN_INTERVAL_MS = 1500;
const DEFAULT_FRAME_SIZE = 1024;
const DEFAULT_MIN_TRIGGER_DURATION_MS = 100;
const DEFAULT_RMS_WINDOW_MS = 200;
const DEFAULT_CENTROID_WINDOW_MS = 300;

export class AudioAnomalyDetector {
  private lastEventTs = 0;
  private buffer: number[] = [];
  private readonly frameSize: number;
  private readonly hopSize: number;
  private readonly window: Float32Array;
  private readonly frameDurationMs: number;
  private readonly hopDurationMs: number;
  private rmsDurationMs = 0;
  private centroidDurationMs = 0;
  private readonly rmsWindowFrames: number;
  private readonly centroidWindowFrames: number;
  private readonly rmsValues: number[] = [];
  private readonly centroidValues: number[] = [];

  constructor(
    private readonly options: AudioAnomalyOptions,
    private readonly bus: EventEmitter = eventBus
  ) {
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    if (options.frameSize && options.frameSize > 0) {
      this.frameSize = Math.max(1, Math.floor(options.frameSize));
    } else if (options.frameDurationMs && options.frameDurationMs > 0) {
      this.frameSize = Math.max(1, Math.round((sampleRate * options.frameDurationMs) / 1000));
    } else {
      this.frameSize = DEFAULT_FRAME_SIZE;
    }

    const configuredHopDuration = options.hopDurationMs ?? null;
    let configuredHop = options.hopSize;
    if (!configuredHop && configuredHopDuration && configuredHopDuration > 0) {
      configuredHop = Math.round((sampleRate * configuredHopDuration) / 1000);
    }

    if (!configuredHop || configuredHop <= 0) {
      configuredHop = Math.floor(this.frameSize / 2);
    }

    this.hopSize = Math.min(this.frameSize, Math.max(1, configuredHop));
    this.window = createHanningWindow(this.frameSize);
    this.frameDurationMs = (this.frameSize / sampleRate) * 1000;
    this.hopDurationMs = (this.hopSize / sampleRate) * 1000;
    const rmsWindowMs = options.rmsWindowMs ?? DEFAULT_RMS_WINDOW_MS;
    const centroidWindowMs = options.centroidWindowMs ?? DEFAULT_CENTROID_WINDOW_MS;
    this.rmsWindowFrames = Math.max(1, Math.round(rmsWindowMs / this.hopDurationMs));
    this.centroidWindowFrames = Math.max(1, Math.round(centroidWindowMs / this.hopDurationMs));
  }

  handleChunk(samples: Int16Array, ts = Date.now()) {
    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const normalized = normalizeSamples(samples);
    for (let i = 0; i < normalized.length; i += 1) {
      this.buffer.push(normalized[i]);
    }

    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const minTriggerDuration =
      this.options.minTriggerDurationMs ?? DEFAULT_MIN_TRIGGER_DURATION_MS;
    const frameDurationMs = this.frameDurationMs;

    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.slice(0, this.frameSize);
      const windowed = applyWindow(frame, this.window);
      const features = Meyda.extract(['rms', 'spectralCentroid'], windowed, {
        sampleRate,
        bufferSize: this.frameSize
      });

      if (!features) {
        this.buffer.splice(0, this.hopSize);
        continue;
      }

      const rms = features.rms ?? 0;
      const centroid = features.spectralCentroid ?? 0;

      const thresholds = this.resolveThresholds(ts);
      const baselineRms = computeAverage(this.rmsValues);
      const baselineCentroid = computeAverage(this.centroidValues);
      const rmsDelta = Math.max(0, rms - baselineRms);
      const centroidDelta = Math.abs(centroid - baselineCentroid);
      const triggeredByRms = rmsDelta >= thresholds.rms;
      const triggeredByCentroid = centroidDelta >= thresholds.centroidJump;

      if (triggeredByRms) {
        this.rmsDurationMs += frameDurationMs;
      } else {
        this.rmsDurationMs = 0;
      }

      if (triggeredByCentroid) {
        this.centroidDurationMs += frameDurationMs;
      } else {
        this.centroidDurationMs = 0;
      }

      this.buffer.splice(0, this.hopSize);
      const rmsBaselineUpdate = triggeredByRms
        ? baselineRms + (rms - baselineRms) * 0.25
        : rms;
      const centroidBaselineUpdate = triggeredByCentroid
        ? baselineCentroid + (centroid - baselineCentroid) * 0.25
        : centroid;
      this.pushValue(this.rmsValues, rmsBaselineUpdate, this.rmsWindowFrames);
      this.pushValue(this.centroidValues, centroidBaselineUpdate, this.centroidWindowFrames);

      const rmsExceeded = this.rmsDurationMs >= minTriggerDuration;
      const centroidExceeded = this.centroidDurationMs >= minTriggerDuration;

      if (!rmsExceeded && !centroidExceeded) {
        continue;
      }

      if (ts - this.lastEventTs < minInterval) {
        continue;
      }

      const triggeredBy = rmsExceeded ? 'rms' : 'centroid';
      const triggeredDurationMs = rmsExceeded ? this.rmsDurationMs : this.centroidDurationMs;

      this.lastEventTs = ts;
      this.rmsDurationMs = 0;
      this.centroidDurationMs = 0;

      const payload: EventPayload = {
        ts,
        detector: 'audio-anomaly',
        source: this.options.source,
        severity: triggeredBy === 'rms' ? 'critical' : 'warning',
        message: triggeredBy === 'rms' ? 'High audio level detected' : 'Abrupt spectral change detected',
        meta: {
          rms,
          centroid,
          baselines: {
            rms: baselineRms,
            centroid: baselineCentroid
          },
          thresholds: {
            rms: thresholds.rms,
            centroidJump: thresholds.centroidJump,
            minTriggerDurationMs: minTriggerDuration,
            rmsWindowMs: this.rmsWindowFrames * this.hopDurationMs,
            centroidWindowMs: this.centroidWindowFrames * this.hopDurationMs
          },
          triggeredBy,
          window: {
            frameSize: this.frameSize,
            hopSize: this.hopSize,
            frameDurationMs: this.frameDurationMs,
            hopDurationMs: this.hopDurationMs
          },
          durationAboveThresholdMs: triggeredDurationMs
        }
      };

      this.bus.emit('event', payload);
      break;
    }
  }

  private resolveThresholds(ts: number): Required<AudioAnomalyThresholds> {
    const baseRms = this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    const baseCentroid = this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP;
    const schedule = this.options.thresholds;

    if (!schedule) {
      return { rms: baseRms, centroidJump: baseCentroid };
    }

    const isNight = this.isNight(ts);
    const chosen = (isNight ? schedule.night : schedule.day) ?? schedule.default ?? {};

    return {
      rms: chosen.rms ?? baseRms,
      centroidJump: chosen.centroidJump ?? baseCentroid
    };
  }

  private isNight(ts: number) {
    const hoursConfig = this.options.nightHours;

    if (!hoursConfig) {
      return false;
    }

    const date = new Date(ts);
    const hour = date.getHours() + date.getMinutes() / 60;
    const start = clamp(hoursConfig.start, 0, 24);
    const end = clamp(hoursConfig.end, 0, 24);

    if (start === end) {
      return true;
    }

    if (start < end) {
      return hour >= start && hour < end;
    }

    return hour >= start || hour < end;
  }

  private pushValue(store: number[], value: number, maxLength: number) {
    store.push(value);
    if (store.length > maxLength) {
      store.splice(0, store.length - maxLength);
    }
  }
}

function normalizeSamples(samples: Int16Array): Float32Array {
  const normalized = new Float32Array(samples.length);
  const scale = 1 / 32768;
  for (let i = 0; i < samples.length; i += 1) {
    normalized[i] = samples[i] * scale;
  }
  return normalized;
}

function createHanningWindow(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1 || 1)));
  }
  return window;
}

function applyWindow(frame: number[], window: Float32Array): Float32Array {
  const result = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    result[i] = frame[i] * window[i];
  }
  return result;
}

function computeAverage(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  let sum = 0;
  for (const value of values) {
    sum += value;
  }

  return sum / values.length;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default AudioAnomalyDetector;
