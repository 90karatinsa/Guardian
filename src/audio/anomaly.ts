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
  rmsWindowMs?: number;
  centroidWindowMs?: number;
  minTriggerDurationMs?: number;
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

type ResolvedThresholds = {
  profile: 'default' | 'day' | 'night';
  rms: number;
  centroidJump: number;
  rmsWindowMs: number;
  centroidWindowMs: number;
  minTriggerDurationMs: number;
};

export class AudioAnomalyDetector {
  private lastEventTs = 0;
  private buffer: number[] = [];
  private frameSize: number;
  private hopSize: number;
  private window: Float32Array;
  private frameDurationMs: number;
  private hopDurationMs: number;
  private rmsDurationMs = 0;
  private centroidDurationMs = 0;
  private rmsRecoveryMs = 0;
  private centroidRecoveryMs = 0;
  private rmsWindowFrames: number;
  private centroidWindowFrames: number;
  private readonly rmsValues: number[] = [];
  private readonly centroidValues: number[] = [];
  private processedFrames = 0;
  private defaultRmsWindowMs: number;
  private defaultCentroidWindowMs: number;
  private defaultMinTriggerDurationMs: number;
  private currentThresholds: ResolvedThresholds | null = null;

  constructor(
    private options: AudioAnomalyOptions,
    private readonly bus: EventEmitter = eventBus
  ) {
    this.options = {
      ...options,
      thresholds: cloneThresholdSchedule(options.thresholds),
      nightHours: options.nightHours ? { ...options.nightHours } : undefined
    };

    this.defaultRmsWindowMs = this.options.rmsWindowMs ?? DEFAULT_RMS_WINDOW_MS;
    this.defaultCentroidWindowMs =
      this.options.centroidWindowMs ?? DEFAULT_CENTROID_WINDOW_MS;
    this.defaultMinTriggerDurationMs =
      this.options.minTriggerDurationMs ?? DEFAULT_MIN_TRIGGER_DURATION_MS;

    this.updateWindowGeometry(this.options);
    this.rmsWindowFrames = Math.max(
      1,
      Math.round(this.defaultRmsWindowMs / this.hopDurationMs)
    );
    this.centroidWindowFrames = Math.max(
      1,
      Math.round(this.defaultCentroidWindowMs / this.hopDurationMs)
    );
    this.currentThresholds = {
      profile: 'default',
      rms: this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD,
      centroidJump: this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP,
      rmsWindowMs: this.defaultRmsWindowMs,
      centroidWindowMs: this.defaultCentroidWindowMs,
      minTriggerDurationMs: this.defaultMinTriggerDurationMs
    };
  }

  updateOptions(options: Partial<Omit<AudioAnomalyOptions, 'source'>>) {
    const hasChanges =
      options.sampleRate !== undefined ||
      options.frameSize !== undefined ||
      options.hopSize !== undefined ||
      options.frameDurationMs !== undefined ||
      options.hopDurationMs !== undefined ||
      options.rmsThreshold !== undefined ||
      options.centroidJumpThreshold !== undefined ||
      options.minIntervalMs !== undefined ||
      options.thresholds !== undefined ||
      options.nightHours !== undefined ||
      options.minTriggerDurationMs !== undefined ||
      options.rmsWindowMs !== undefined ||
      options.centroidWindowMs !== undefined;

    if (!hasChanges) {
      return;
    }

    const thresholds = options.thresholds ? cloneThresholdSchedule(options.thresholds) : undefined;
    const nightHours = options.nightHours ? { ...options.nightHours } : undefined;
    const next: AudioAnomalyOptions = {
      ...this.options,
      ...options,
      thresholds: thresholds ?? this.options.thresholds,
      nightHours: nightHours ?? this.options.nightHours
    };

    if (options.rmsWindowMs !== undefined) {
      this.defaultRmsWindowMs = options.rmsWindowMs ?? this.defaultRmsWindowMs;
    }

    if (options.centroidWindowMs !== undefined) {
      this.defaultCentroidWindowMs = options.centroidWindowMs ?? this.defaultCentroidWindowMs;
    }

    if (options.minTriggerDurationMs !== undefined) {
      this.defaultMinTriggerDurationMs =
        options.minTriggerDurationMs ?? this.defaultMinTriggerDurationMs;
    }

    this.options = next;

    const geometryChanged =
      options.sampleRate !== undefined ||
      options.frameSize !== undefined ||
      options.hopSize !== undefined ||
      options.frameDurationMs !== undefined ||
      options.hopDurationMs !== undefined;

    if (geometryChanged) {
      this.updateWindowGeometry(next);
    } else {
      this.rmsWindowFrames = Math.max(
        1,
        Math.round(this.defaultRmsWindowMs / this.hopDurationMs)
      );
      this.centroidWindowFrames = Math.max(
        1,
        Math.round(this.defaultCentroidWindowMs / this.hopDurationMs)
      );
    }

    this.resetWindows();
    this.currentThresholds = null;
  }

  handleChunk(samples: Int16Array, ts = Date.now()) {
    const sampleRate = this.options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const normalized = normalizeSamples(samples);
    for (let i = 0; i < normalized.length; i += 1) {
      this.buffer.push(normalized[i]);
    }

    const minInterval = this.options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const frameDurationMs = this.frameDurationMs;
    const hopDurationMs = this.hopDurationMs;

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

      this.processedFrames += 1;

      const thresholds = this.resolveThresholds(ts);
      const minTriggerDuration = thresholds.minTriggerDurationMs;
      const baselineRms = computeAverage(this.rmsValues);
      const baselineCentroid = computeAverage(this.centroidValues);
      const rmsDelta = Math.max(0, rms - baselineRms);
      const centroidDelta = Math.abs(centroid - baselineCentroid);
      const triggeredByRms = rmsDelta >= thresholds.rms;
      const triggeredByCentroid = centroidDelta >= thresholds.centroidJump;

      if (triggeredByRms) {
        this.rmsDurationMs += hopDurationMs;
        this.rmsRecoveryMs = 0;
      } else {
        this.rmsDurationMs = Math.max(0, this.rmsDurationMs - hopDurationMs);
        this.rmsRecoveryMs += hopDurationMs;
      }

      if (triggeredByCentroid) {
        this.centroidDurationMs += hopDurationMs;
        this.centroidRecoveryMs = 0;
      } else {
        this.centroidDurationMs = Math.max(0, this.centroidDurationMs - hopDurationMs);
        this.centroidRecoveryMs += hopDurationMs;
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
      const accumulationSnapshot = {
        rmsMs: this.rmsDurationMs,
        centroidMs: this.centroidDurationMs
      };
      const recoverySnapshot = {
        rmsMs: this.rmsRecoveryMs,
        centroidMs: this.centroidRecoveryMs
      };

      const stateSnapshot = {
        rms: {
          durationMs: this.rmsDurationMs,
          recoveryMs: this.rmsRecoveryMs,
          windowMs: this.rmsWindowFrames * this.hopDurationMs
        },
        centroid: {
          durationMs: this.centroidDurationMs,
          recoveryMs: this.centroidRecoveryMs,
          windowMs: this.centroidWindowFrames * this.hopDurationMs
        }
      };

      this.lastEventTs = ts;
      this.rmsDurationMs = 0;
      this.centroidDurationMs = 0;
      this.rmsRecoveryMs = 0;
      this.centroidRecoveryMs = 0;

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
            minTriggerDurationMs: thresholds.minTriggerDurationMs,
            rmsWindowMs: thresholds.rmsWindowMs,
            centroidWindowMs: thresholds.centroidWindowMs,
            profile: thresholds.profile
          },
          triggeredBy,
          window: {
            frameSize: this.frameSize,
            hopSize: this.hopSize,
            frameDurationMs: this.frameDurationMs,
            hopDurationMs: this.hopDurationMs,
            processedFrames: this.processedFrames
          },
          durationAboveThresholdMs: triggeredDurationMs,
          accumulationMs: accumulationSnapshot,
          recoveryMs: recoverySnapshot,
          state: stateSnapshot
        }
      };

      this.bus.emit('event', payload);
      break;
    }
  }

  private updateWindowGeometry(options: AudioAnomalyOptions) {
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
    if ((!configuredHop || configuredHop <= 0) && configuredHopDuration && configuredHopDuration > 0) {
      configuredHop = Math.round((sampleRate * configuredHopDuration) / 1000);
    }

    if (!configuredHop || configuredHop <= 0) {
      configuredHop = Math.floor(this.frameSize / 2);
    }

    this.hopSize = Math.min(this.frameSize, Math.max(1, configuredHop));
    this.window = createHanningWindow(this.frameSize);
    this.frameDurationMs = (this.frameSize / sampleRate) * 1000;
    this.hopDurationMs = (this.hopSize / sampleRate) * 1000;
    this.rmsWindowFrames = Math.max(
      1,
      Math.round(this.defaultRmsWindowMs / this.hopDurationMs)
    );
    this.centroidWindowFrames = Math.max(
      1,
      Math.round(this.defaultCentroidWindowMs / this.hopDurationMs)
    );
    this.processedFrames = 0;
  }

  private resetWindows() {
    this.buffer.length = 0;
    this.rmsValues.length = 0;
    this.centroidValues.length = 0;
    this.rmsDurationMs = 0;
    this.centroidDurationMs = 0;
    this.rmsRecoveryMs = 0;
    this.centroidRecoveryMs = 0;
    this.lastEventTs = 0;
    this.processedFrames = 0;
  }

  private resolveThresholds(ts: number): ResolvedThresholds {
    const baseRms = this.options.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    const baseCentroid = this.options.centroidJumpThreshold ?? DEFAULT_CENTROID_JUMP;
    const schedule = this.options.thresholds;
    const baseRmsWindowMs = this.defaultRmsWindowMs;
    const baseCentroidWindowMs = this.defaultCentroidWindowMs;
    const baseMinTrigger = this.defaultMinTriggerDurationMs;

    if (!schedule) {
      return this.applyThresholdProfile({
        profile: 'default',
        rms: baseRms,
        centroidJump: baseCentroid,
        rmsWindowMs: baseRmsWindowMs,
        centroidWindowMs: baseCentroidWindowMs,
        minTriggerDurationMs: baseMinTrigger
      });
    }

    const isNight = this.isNight(ts);
    const hasNight = Boolean(schedule.night);
    const hasDay = Boolean(schedule.day);
    const usingNight = isNight && hasNight;
    const usingDay = !isNight && hasDay;
    const profile: ResolvedThresholds['profile'] = usingNight
      ? 'night'
      : usingDay
        ? 'day'
        : 'default';
    const chosen = usingNight
      ? schedule.night ?? schedule.default ?? {}
      : usingDay
        ? schedule.day ?? schedule.default ?? {}
        : schedule.default ?? {};

    return this.applyThresholdProfile({
      profile,
      rms: chosen.rms ?? baseRms,
      centroidJump: chosen.centroidJump ?? baseCentroid,
      rmsWindowMs: chosen.rmsWindowMs ?? baseRmsWindowMs,
      centroidWindowMs: chosen.centroidWindowMs ?? baseCentroidWindowMs,
      minTriggerDurationMs: chosen.minTriggerDurationMs ?? baseMinTrigger
    });
  }

  private applyThresholdProfile(resolved: ResolvedThresholds): ResolvedThresholds {
    const previous = this.currentThresholds;
    if (!previous) {
      const applied = { ...resolved } as ResolvedThresholds;
      this.currentThresholds = applied;
      this.rmsWindowFrames = Math.max(1, Math.round(applied.rmsWindowMs / this.hopDurationMs));
      this.centroidWindowFrames = Math.max(
        1,
        Math.round(applied.centroidWindowMs / this.hopDurationMs)
      );
      return applied;
    }

    const profileChanged = previous.profile !== resolved.profile;
    const rmsWindowFrames = Math.max(1, Math.round(resolved.rmsWindowMs / this.hopDurationMs));
    const centroidWindowFrames = Math.max(
      1,
      Math.round(resolved.centroidWindowMs / this.hopDurationMs)
    );
    const windowChanged =
      rmsWindowFrames !== this.rmsWindowFrames || centroidWindowFrames !== this.centroidWindowFrames;

    if (windowChanged) {
      this.rmsWindowFrames = rmsWindowFrames;
      this.centroidWindowFrames = centroidWindowFrames;
      this.resetWindows();
    } else {
      this.rmsWindowFrames = rmsWindowFrames;
      this.centroidWindowFrames = centroidWindowFrames;
      if (profileChanged) {
        this.resetWindows();
      }
    }
    const applied = { ...resolved } as ResolvedThresholds;
    this.currentThresholds = applied;
    return applied;
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

function cloneThresholdSchedule(
  schedule?: AudioAnomalyThresholdSchedule
): AudioAnomalyThresholdSchedule | undefined {
  if (!schedule) {
    return undefined;
  }

  const cloneEntry = (entry?: AudioAnomalyThresholds) =>
    entry
      ? {
          ...entry
        }
      : undefined;

  const cloned: AudioAnomalyThresholdSchedule = {};
  const defaultEntry = cloneEntry(schedule.default);
  if (defaultEntry) {
    cloned.default = defaultEntry;
  }
  const dayEntry = cloneEntry(schedule.day);
  if (dayEntry) {
    cloned.day = dayEntry;
  }
  const nightEntry = cloneEntry(schedule.night);
  if (nightEntry) {
    cloned.night = nightEntry;
  }
  return cloned;
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
